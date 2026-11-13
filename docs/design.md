# Design note

## Goal

An agent that says "I'll send it when it's done" should either send it, or the user should be told in plain words that the check could not be done. The agent cannot do this on its own: it runs only when a message arrives, and between turns nothing happens. So code holds every alarm, and the model is only woken to judge and to write.

## Non-goals

- Detecting promises. We do not classify replies.
- Running the follow-up work. The check turn judges and delivers; long work stays wherever the agent runs it. The host only tells us when it starts and ends.
- Guaranteeing exactly-once delivery of arbitrary content. That is the transport's job. We retry what we produced until the transport confirms it or we give up, and after a give-up we keep trying to say so. A `deliver()` that times out and then succeeds anyway can produce a duplicate.
- Running several processes on one store.

## The loop

```
noteUserMessage(c)        -> counter[c] += 1
noteReply(c, text)        -> counter[c] += 1; reply.seq = counter[c]; text keeps head + tail
  -> pending check for c exists?  yes: append reply (keep reply 1 + newest), due unchanged
                                      (a check waiting for tomorrow's cap comes back to now + delay)
                                  no:  create check, due = now + delay
noteReply(c, text, {kind: check|report}) -> counter += 1; one verify check (depth 1)
timer fires (earliest of: checks, dated timers, parked timeouts, owed reports, retries, missed notices)
  -> at most one model turn per conversation per pass; reports first; none while the circuit is open
  -> isUserBusy(c) (no turn slot held; 30 s timeout)?  yes: due = now + busyRetry
  -> host send log (no slot held; 30 s timeout; a timeout is a failed check)
  -> wait for a turn slot (2, plus one per 25 waiting, up to 8)
  -> daily cap (per conversation, with a reserve for window and dated checks; global)?
       reached: one code-written line a day, due = start of the next UTC day
  -> owed "Missed:" notices for c go out first (one sender per conversation)
  -> prompt = now (UTC, local with timeZone) + replies + newest 40 delivered + queued + failed to send
              (+ "may be incomplete" when the log does not reach back to the window start)
  -> text = runTurn(c, prompt, { signal })     (same session; turnTimeout -> abort, failed)
  -> junk (tool-call markup)? failed
  -> parse(text)
       nothing          -> done
       deliver          -> deliver(c, text) unless an exact copy is queued, missed, or delivered since
                           this check last ran or in the last 10 min (never compared on dated checks);
                           verify
       deliver_running  -> deliver(c, text minus markers), verify, then as running
       due <time>       -> deliver any text (no verify: the timer is the follow-up); dated timer
                           (past or > maxDue: running; chain > maxDueDepth or 6th timer: a line);
                           with STILL_RUNNING too: also as running
       failed           -> rechecks left? requeue (delay, then 15/30/60/120 min)
                           : circuit open? wait for it : one line per conversation per outage
       running          -> open job? first time: recheck at delay; then park
                           : rechecks left? requeue : last check -> status, or a line
verify: the delivered text joins the next check for c, delayMs later; depth + 1; past
        maxVerifyDepth: one line a day; never after a last check or a DUE delivery
5 failed turns in a row -> circuit open 15 min (doubling to 2 h per failed probe); reports due
        meanwhile go out as their code-written version
finishJob(j)   (resolves at once)
  -> onJobFinished(c, job)  or  an owed report (stored): waits for a busy user, retries like a
     check, is marked delivered in the store before the send; delivers the reply (verify) or,
     failed or declined, "<title> <status>: <first line>"
  -> checks parked on j with no other open job -> pending, due now -> run once
start() -> load the store (lock file), merge notes made earlier; jobs found there: onStartJobs keeps
           some, the rest finishJob(status 'lost')
parked longer than jobTimeout
  -> run once with the last-check prompt (status: no longer watched), park one more period, end
deliver() throws or times out
  -> keep { text, attempts } in the outbox; resend in retryMs (or err.retryAfterMs)
  -> permanent error or attempts = max -> delivery_failed; a missed notice with the full text,
     own timer 15 min doubling to 6 h (none after a permanent error); flushMissed(c) for the host
```

## Decisions

**Fixed window, no extension.** The first reply with no pending check sets the due time; later replies join the list and never move it. v0.1 moved it with every reply, which let a long conversation push an owed delivery back forever. The fixed window costs about one check per 5 minutes of active conversation.

**Keep the first reply, and the end of each reply.** An overflowing list keeps reply 1 plus the newest ones. A long reply keeps its first and last halves: a promise often sits at the end.

**Messages back, not just timestamps.** A model can rarely map a clock time to a point in its own history, but "8 messages back" it can find.

**A failed check is an unanswered check.** v0.2 dropped the debt when the check turn failed. Failed checks walk the recheck ladder, always: they do not park on an open job, because the job may have nothing to do with the promise (a failed check used to wait two hours behind an unrelated render). When the ladder runs out, code writes the line; the model is the part that is failing.

**A broken setup must not spam.** A wrong session id or a dead API key fails every check, including checks of conversations where nothing was promised. Sending each of those users "I couldn't check on what I promised" would be false and alarming. So after 5 failed turns in a row the circuit breaker pauses model turns (15 minutes, doubling per failed probe up to 2 hours); give-up lines wait for it, go at most once per conversation per outage, and no longer claim a promise ("I may have said I'd follow up on something, and I couldn't check it."). Reports due while it is open go out as their code-written version, because the job's own output is a fact, not a guess.

**Every host callback can hang; code times them out.** v0.3 timed out `runTurn` only; a hung `deliver`, `isUserBusy` or `getDelivered` blocked a conversation, or every turn slot. Now each has `callbackTimeoutMs`, and no turn slot is held while `isUserBusy` or `getDelivered` runs. A hung `deliver` goes to the outbox (if it lands later after all, that text can arrive twice; we accept that over a blocked conversation). A hung `isUserBusy` counts as busy.

**The package reads its own replies back.** Every package delivery schedules one verify check, carrying a depth; past `maxVerifyDepth` the user gets one "no longer watched" line a day. No verify after a last-check status, nor after a delivery that also set a `DUE` timer: the timer is the follow-up, and doing both turned "content + DUE every few minutes" into a branching tree of 57 messages a day.

**Dated promises get a timer in code, with limits.** `DUE <UTC time>` stores a timer; at that time a check runs with the replies that made the promise. Chains of `DUE` answers stop at `maxDueDepth` (10) and a conversation holds at most 5 timers; past that, one code-written line a day. A model answering "DUE in six minutes" forever used to cost 240 turns over three days.

**The duplicate guard is narrow on purpose.** An exact copy of something queued, given up on, or delivered since this check last ran (or in the last 10 minutes) is not sent. It used to compare with everything since the window start, which dropped a daily reminder on days 2 to 5 and the second of two identical "backup finished" reports. Dated checks are never compared; reports only against the same job.

**Missed notices have their own timer.** After a give-up, v0.3 scheduled a fresh model check that saw the text as "queued", answered `NOTHING_OWED`, and the text was lost. Now the full text is a missed notice retried by code (15 minutes, doubling to 6 hours) until it lands or the host takes it with `flushMissed()`. The prompt lists it as "failed to send - write it again if still needed", never as queued. One sender per conversation, so two deliveries starting together cannot send it twice.

**Daily caps say so.** A conversation that hit its cap used to wait silently until UTC midnight. Now it gets one line a day saying when checking resumes. The last 10 turns of the cap are kept for window and dated checks, so a fresh reply or a reminder is not starved by rechecks. `globalDailyCap` bounds all conversations together and tells the operator.

**The parser is strict about what it sends.** Markers count on the first line or among the last two, in any case and decoration, with a `Status:` label or a short note; all marker lines are stripped from what is sent; `STILL_RUNNING` and `DUE` together keep both. `DUE` is upper-case only and needs a zone. Code fences and `<think>` blocks are removed. Tool-call markup returned as text is junk, a failed check. Content after a first-line `NOTHING_OWED` is delivered (it used to be dropped).

**Jobs are tracked in code, not in the model.** A `running` answer with an open job checks once more, then parks: no wakes until the job ends. One recheck first, because the job may not be the only thing owed.

**A report is owed until it is delivered or replaced.** A finished job becomes a stored report record: it waits for `isUserBusy`, retries on the check ladder, falls back to `<title> <status>: <first line of output>`, and is marked delivered in the store right before the send, so a crash after the send never repeats it with new wording. `finishJob` and `wrapJob` resolve at once; events say when the report is done.

**Jobs do not survive a restart unless the host says so.** A job in the store at `start()` finishes as `lost` through the normal report path, unless `onStartJobs(jobs)` keeps it.

**The delivered log lives with the store.** With a memory-only log and a file store, a restart forgot what was delivered and the next check sent it again. Now the built-in log sits next to the store by default (`<path>.delivered.json` for the file store, a shared map for the memory store). The package logs its own confirmed deliveries; the same text noted twice within a minute is one entry. When a check's window starts before the log's horizon (2 days), the prompt says the list may be incomplete.

**State is loaded before it is saved.** v0.3 saved on every note, including notes made before `start()` had loaded, which wiped the store. Now nothing is saved before the load, earlier notes are merged into the loaded state, writes are batched (100 ms) and `stop()` writes the final state synchronously when the store can. The file store saves atomically, never lets an older async write land after a newer one, and takes a lock file against a second process.

**Bounds for scale.** Turn slots grow with the backlog (2, plus one per 25 waiting, up to 8): 300 conversations due at once used to wait 43 minutes for the median check; with 30-second turns it is now about 15. Counters of conversations idle for 30 days are pruned. A user who stays "busy" for 30 minutes produces one `busy_stuck` event; the check keeps waiting rather than interrupt.

**User turns win, and the host can enforce it.** `runTurn` resumes the same session as the user's turns, so the two must not run at once, and `runTurn` must not post anything itself. `isUserBusy` makes checks wait; `onTurnStart`, `onTurnEnd` and `isChecking()` let the host serialize turns for certain.

**The delivered list comes from the host.** The model's context contains what it wrote, including text that never left the process. The only reliable record of what the user saw is the transport's success log. The prompt also says what file entries such as `[photo]` mean, that this turn cannot send files, and never to claim a send that is not in the list.

**Same session, not a fresh one.** The agent needs its own context to know what it meant.

**Persistence.** `{ version: 4, records, reports, counters, jobs, outbox, missed, turnsByDay, globalTurns, notices, circuit, lastActive }`. Stores from v0.1 (a plain array) to v0.3 load.

## Cost accounting

`runTurn` may return `{ text, usage, costUsd }`. The scheduler passes these to `onUsage` and emits a `usage` event, for check turns and report turns alike. Compute cost from the turn's own token counts.

The check re-reads the session, so the prompt cache decides the price: in the first live checks, warm cost about a tenth of cold ($0.035 against $0.36). A 5-minute `delayMs` sits right at the common 5-minute cache lifetime, so checks can land on a cold cache. Verify checks add one turn per package delivery; failed checks come back during an outage, bounded by the circuit breaker; caps bound the rest.

## Open questions

- The v0.4 prompt has not been replayed on a real model. The v0.3 prompt scored 49/54 and 41/54 on two models in a 54-case replay; its misses are addressed but not re-measured.
- Warm-cache cost per check in live use, and the daily cost with verify checks.
- Whether check turns should run in a fork of the session, so they do not grow the conversation.
- Per-conversation store shards for very large deployments (today: one file, debounced).
