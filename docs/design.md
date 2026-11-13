# Design note

## Goal

An agent that says "I'll send it when it's done" should either send it or the user should be told plainly that it did not. The agent cannot do this on its own: it runs only when a message arrives, and between turns nothing happens. So code holds every alarm, and the model is only woken to judge and to write.

## Non-goals

- Detecting promises. We do not classify replies.
- Running the follow-up work. The check turn judges and delivers; long work stays wherever the agent runs it. The host only tells us when it starts and ends.
- Guaranteeing exactly-once delivery of arbitrary content. That is the transport's job. We retry what we produced, at least once, until the transport confirms it or we give up, and after a give-up we say so.

## The loop

```
noteUserMessage(c)        -> counter[c] += 1
noteReply(c, text)        -> counter[c] += 1; reply.seq = counter[c]; text keeps head + tail
  -> pending check for c exists?  yes: append reply (keep reply 1 + newest), due unchanged
                                  no:  create check, due = now + delay
noteReply(c, text, {kind: check|report}) -> counter += 1; one verify check (depth 1)
timer fires (earliest due: pending check, dated timer, parked timeout, owed report, retry)
  -> at most one model turn per conversation per pass; reports first
  -> wait for a turn slot (maxConcurrent)
  -> isUserBusy(c)?  yes: due = now + busyRetry (no recheck used)
  -> daily cap used up?  yes: due = start of the next UTC day
  -> owed "Missed:" notices for c go out first
  -> prompt = time now + replies with "N messages back" + newest 40 delivered(c, firstReply.at - lookback)
              + queued (retries, missed notices: "do not write these again")
  -> text = runTurn(c, prompt, { signal })     (same session; turnTimeout -> abort, failed)
  -> parse(text)
       nothing          -> done
       deliver          -> deliver(c, text) unless an exact copy is delivered or queued; verify
       deliver_running  -> deliver(c, text minus marker), verify, then as running
       due <time>       -> deliver any text, verify; dated timer at <time> (past or > maxDue: running)
       running, failed  -> open tracked job for c?  yes: park on those jobs
                                                    no:  rechecks < maxRechecks + backoff steps ?
                                                           requeue (delay, then 15/30/60/120 min)
                                                         : last check -> status, or code line
verify: the delivered text joins the next check for c, delayMs later; depth + 1; stops past
        maxVerifyDepth; never after a last check
finishJob(j)
  -> onJobFinished(c, job)  or  an owed report (stored): waits for a busy user, retries like a
     check, delivers the reply (verify) or, failed or declined, "<title> <status>: <first line>"
  -> checks parked on j with no other open job -> pending, due now -> run once
start() finds jobs in the store -> onStartJobs keeps some; the rest finishJob(status 'lost')
parked longer than jobTimeout
  -> run once with the last-check prompt (status: no longer watched), park one more period, end
deliver() throws
  -> keep { text, attempts } in the outbox; resend in retryMs (or err.retryAfterMs)
  -> permanent error or attempts = max -> delivery_failed; missed[c] += full text;
     fresh check delayMs later (not after a permanent error); flushMissed(c) for the host
```

## Decisions

**Fixed window, no extension.** The first reply with no pending check sets the due time; later replies join the list and never move it. v0.1 moved the due time with every reply ("one check per quiet period"). That was cheaper, but it let a long conversation push an owed delivery back forever. The fixed window costs about one check per 5 minutes of active conversation. We accept that for accountability.

**Keep the first reply, and the end of each reply.** When a check's list overflows `maxReplies`, it keeps reply 1 plus the newest ones. A reply longer than `maxTextLength` keeps its first and last halves: "Here is the analysis... I will send the PDF tonight" puts the promise at the end, and v0.2 clipped it off.

**Messages back, not just timestamps.** A model can rarely map a clock time to a point in its own history, but "8 messages back" it can find. Each reply carries `seq`, the conversation's message count right after it; the prompt shows `counter - seq + 1`. User messages and every message the user saw count; `system` replies do not.

**A failed check is an unanswered check, not a finished one.** v0.2 dropped the debt when the check turn threw or came back empty: one model outage at the wrong minute and the promise was gone. Now `failed` walks the same ladder as `STILL_RUNNING`. If the ladder runs out with no answer, the user gets a fixed code-written line ("I could not check on what I promised you earlier. Ask me again if it is still open."). The model is not asked to write it, because the model is the part that is failing.

**Turns can hang; code times them out.** A `runTurn` that never settles used to block its conversation forever. `turnTimeoutMs` (3 minutes) makes it a failed check and aborts `ctx.signal`, so the host can kill the call.

**The package reads its own replies back.** A check reply is a message the user saw, and it can hold a new promise ("the rest in ten minutes"). v0.2 never looked at it again. Now every package delivery schedules one verify check `delayMs` later, carrying a depth; the chain stops at `maxVerifyDepth` (3). It never follows a last-check status, which by design says the work is no longer watched. A word-for-word repeat of something delivered or queued is not sent and starts nothing, so a model that keeps restating the same promise cannot loop.

**Dated promises get a timer in code.** "I'll remind you tomorrow at 9" used to sit through the 4-hour ladder and end with a status line. The agent can now answer `DUE <ISO time>`; the timer is stored, and at that time a check runs with the replies that made the promise. The prompt shows the time now so the agent can write one. Past times and times beyond `maxDueMs` (30 days) count as `STILL_RUNNING`, so a bad date cannot park a debt for a year.

**`STILL_RUNNING` is a third answer.** Without it, an agent waiting on background work has two bad choices: say nothing (and lose the debt) or send "still working" every few minutes. With two promises, one ready and one running, the agent delivers the ready one with a `STILL_RUNNING` first or last line; the scheduler delivers the text and requeues the same record.

**The parser is strict about what it sends.** v0.2 delivered anything that was not exactly the marker, so `NOTHING_OWED - all delivered` went to the user. Markers now count as the first or last line, in any case, decorated, with a short note. A reply under 200 characters that mentions `NOTHING_OWED` is never sent. A `DUE` line whose time does not parse is `running`, never content. Reports use the same parser.

**Jobs are tracked in code, not in the model.** The host knows when it starts long work and for which conversation, so it says so (`trackJob`, `finishJob`, `wrapJob`). A `running` or `failed` answer with an open job parks the check: no wakes until the job ends.

**A report is owed until it is delivered or replaced.** v0.2 ran the report turn at once, ignoring a busy user, and dropped it on failure. Now the finished job becomes a stored report record: it waits for `isUserBusy`, retries on the check ladder, and if the turn keeps failing or the model declines (`NOTHING_OWED`, a bare `STILL_RUNNING`), code sends `<title> <status>: <first line of output>`. The job's own output is the most honest fallback there is.

**Jobs do not survive a restart unless the host says so.** A job in the store at `start()` was started by the old process; in most hosts it died with it. v0.2 kept it open forever, and every later `STILL_RUNNING` in that conversation parked on the zombie. Now such jobs finish as `lost`, through the normal report path, unless `onStartJobs(jobs)` returns their ids.

**Back-off for untracked work.** After `maxRechecks` rechecks at `delayMs`, the check backs off: 15, 30, 60, then 120 minutes, and the last step asks for a one-line status that says plainly the work is no longer watched ("it will report" was a promise nothing kept). If that last check still has nothing but `STILL_RUNNING`, code sends its own line.

**Safety net for jobs that never end.** After `jobTimeoutMs` (2 hours) the parked check runs once with the last-check prompt, then parks one more period and ends.

**Delivery retry resends, never regenerates.** `deliver()` is done only when it resolves. A failed delivery goes to an outbox with its attempt count and is resent every `retryMs` up to `maxDeliveryAttempts`. Checks that run meanwhile see it in a "queued, do not write these again" list, and an exact copy is skipped. After a give-up the full text is kept as a `Missed:` notice (v0.2 kept 120 characters and waited for the next package delivery, which might never come). A fresh check `delayMs` later sends it first; the host can also take it with `flushMissed()` before its next message. No fresh check after a permanent error.

**The package logs its own deliveries.** v0.2's quick start never put the package's own deliveries in the delivered log, so the next check thought they were missing. The package now notes every confirmed delivery itself; the built-in log treats the same text noted twice within a minute as one entry, so hosts that also log it are fine.

**No delivering guard.** v0.2 ignored every `noteReply` in a conversation while the package was delivering there, which dropped a normal reply sent at that moment. Now the package recognizes only its own text coming back (the same text within a minute), and passes `{ kind }` to `deliver()` so hosts can mark it.

**Bounds.** At most `maxConcurrent` (2) model turns run at once across conversations, so a burst of due checks does not hit rate limits. `dailyCap` (60) bounds the turns per conversation per day. The delivered list in the prompt shows the newest 40 (v0.2 put 400 entries, 135,000 characters, into one prompt). The built-in log drops conversations idle longer than its `maxAgeMs`. One tick pass never runs two records of the same conversation, because they share one session.

**The delivered list comes from the host.** The model's context contains what it wrote, including text that never left the process. The only reliable record of what the user saw is the transport's success log. The earlier prompt version without it caught 3 of 4 owed cases in the replay; with it, 4 of 4.

**Same session, not a fresh one.** The agent needs its own context to know what it meant. A fresh model with a transcript excerpt would be an extractor with extra steps.

**Persistence.** The whole state is saved on every change as `{ version: 3, records, reports, counters, jobs, outbox, missed, turnsByDay }`. v0.1 (a plain array) and v0.2 stores load. On `start()`, checks and reports that were running return to pending; parked checks stay parked while their jobs are open; dated timers keep their time.

## Cost accounting

`runTurn` may return `{ text, usage, costUsd }`. The scheduler passes these to `onUsage` and emits a `usage` event, for check turns and report turns alike. Compute cost from the turn's own token counts: on a resumed session, some runtimes report a total cost that includes earlier turns of the session.

Verify checks add one turn per package delivery. Failed checks now come back, which costs turns during an outage; `maxConcurrent` and `dailyCap` bound that. Parking makes long jobs cheap. Retries cost no model turns.

## Open questions

- The v0.3 prompt (verify, `DUE`, queued list, the last-check wording) has not been replayed on a real model. Whether a given model writes valid `DUE` lines is unmeasured.
- Warm-cache cost per check in live use, and the daily cost with verify checks.
- Whether check turns should run in a fork of the session instead of the session itself, so they do not grow the conversation.
