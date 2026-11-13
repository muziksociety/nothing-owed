# Design note

## Goal

An agent that says "I'll send it when it's done" should either send it or say why not. The agent cannot do this on its own: it runs only when a message arrives, and between turns nothing happens.

## Non-goals

- Detecting promises. We do not classify replies.
- Running the follow-up work. The check turn judges and delivers; long work stays wherever the agent runs it. The host only tells us when it starts and ends.
- Guaranteeing exactly-once delivery of arbitrary content. That is the transport's job. We retry what we produced, at least once, until the transport confirms it or we give up.

## The loop

```
noteUserMessage(c)        -> counter[c] += 1
noteReply(c, text)        -> counter[c] += 1; reply.seq = counter[c]
  -> pending check for c exists?  yes: append reply (keep reply 1 + newest), due unchanged
                                  no:  create check, due = now + delay
timer fires (earliest due: pending check, parked timeout, or delivery retry)
  -> isUserBusy(c)?  yes: due = now + busyRetry (no recheck used)
  -> prompt = replies with "N messages back" + delivered(c, firstReply.at - lookback)
  -> text = runTurn(c, prompt)            (same session)
  -> parse(text)
       nothing          -> done
       deliver          -> deliver(c, text), done
       deliver_running  -> deliver(c, text minus marker), then as running
       running          -> open tracked job for c?  yes: park on those jobs
                                                    no:  rechecks < maxRechecks + backoff steps ?
                                                           requeue (delay, then 15/30/60/120 min) : done
       failed           -> done (event only)
finishJob(j)
  -> onJobFinished(c, job)  or  report turn -> deliver
  -> checks parked on j with no other open job -> pending, due now -> run once
parked longer than jobTimeout
  -> run once with the last-check prompt (one-line status), park one more period, then end
deliver() throws
  -> keep { text, attempts } in the outbox; resend in retryMs (or err.retryAfterMs)
  -> permanent error or attempts = max -> delivery_failed; next delivery to c is preceded by "Missed: ..."
```

## Decisions

**Fixed window, no extension.** The first reply with no pending check sets the due time; later replies join the list and never move it. v0.1 moved the due time with every reply ("one check per quiet period"). That was cheaper, but it let a long conversation push an owed delivery back forever: a user chatting non-stop for an hour never got the thing promised in minute two. The fixed window costs about one check per 5 minutes of active conversation. We accept that for accountability.

**Keep the first reply.** When a check's list overflows `maxReplies`, it keeps reply 1 plus the newest ones. In a long window, the first reply is often the one that made the promise; dropping it would hide the debt the check exists for.

**Messages back, not just timestamps.** A model can rarely map a clock time to a point in its own history, but "8 messages back" it can find. Each reply carries `seq`, the conversation's message count right after it; the prompt shows `counter - seq + 1`, so the newest message is "1 message back". User messages (`noteUserMessage`) and every message the user saw count: normal replies, check replies and job reports. `system` replies do not. The counter persists with the store. The package counts its own deliveries; a `noteReply` call routed back through the host during one of them is ignored, so it is never counted twice.

**`STILL_RUNNING` is a third answer, and a trailing line.** Without it, an agent waiting on background work has two bad choices: say nothing (and lose the debt) or send "still working" every few minutes. With two promises, one ready and one running, the agent delivers the ready one and ends with a `STILL_RUNNING` line; the scheduler delivers the text and requeues the same record. On the last check the marker is stripped and nothing is requeued.

**Jobs are tracked in code, not in the model.** Timed rechecks are fine for short work but waste a model wake every 5 minutes on an hour-long job, and they rely on the model remembering the job exists. The host already knows when it starts long work and for which conversation, so it says so (`trackJob`, `finishJob`, `wrapJob`). A `running` answer with an open job parks the check: no wakes until the job ends. The job's end triggers one report turn (or the host's `onJobFinished`), then the parked check runs once to catch anything else. Report replies are kind `report` and never schedule a check.

**Back-off for untracked work.** Work the host never tracked can still run for hours. After `maxRechecks` rechecks at `delayMs`, the check backs off: 15, 30, 60, then 120 minutes (`backoffMs`), and the last step asks for a one-line status and ends. Six wakes in the first half hour catch short work; the ladder keeps a 3-hour job from costing 36 wakes. The step count lives in the record, so a restart continues the ladder.

**Safety net for jobs that never end.** A host can forget `finishJob`, or a job can hang. After `jobTimeoutMs` (2 hours) the parked check runs once with the last-check prompt, so the user hears a one-line status, then parks one more period and ends. No endless parking, no endless nagging.

**Delivery retry resends, never regenerates.** `deliver()` is done only when it resolves; the host must throw when the platform did not confirm the send. A failed check reply or report goes to an outbox in the store with its attempt count, and is resent every `retryMs` up to `maxDeliveryAttempts`. Regenerating would cost a model turn per attempt and might produce a different answer; the text is already written. `isPermanentError` stops at once (a blocked user, a deleted chat), `err.retryAfterMs` honors a platform's rate limit. After a give-up, the user gets one short `Missed:` line before the next delivery in that conversation, so a lost message is at least visible.

**The delivered list comes from the host.** The model's context contains what it wrote, including text that never left the process (a background turn, a failed send, a crash between generation and delivery). The only reliable record of what the user saw is the transport's success log. The earlier prompt version without it caught 3 of 4 owed cases in the replay; with it, 4 of 4.

**The window starts before the first reply.** A streamed reply reaches the user before its turn ends and before `noteReply` is called, so the delivered window opens `deliveredLookbackMs` earlier.

**Same session, not a fresh one.** The agent needs its own context to know what it meant. A fresh model with a transcript excerpt would be an extractor with extra steps.

**Check replies never re-arm.** Otherwise a check that delivers would schedule a check that delivers. The scheduler ignores `noteReply` calls made while it is delivering its own reply in the same conversation, so hosts that route every outgoing message through one function are safe. Replies of kind `check`, `report` or `system` never schedule either.

**User turns win.** A check that fires while the user is mid-conversation would interleave with a live turn in the same session. `isUserBusy` makes it wait. Waiting does not use up rechecks. The report turn does not consult `isUserBusy`: the host calls `finishJob` and so picks the moment.

**Failures are silent.** A check that errors, or returns an empty or canned failure text, sends nothing to the user. It surfaces through `onEvent` so the host can log it. A missed check is a missed safety net, not a new problem for the user.

**Persistence.** The whole state is saved on every change as `{ version: 2, records, counters, jobs, outbox, missed }`. A v0.1 store held a plain array of checks; `start()` still loads it. On `start()`, checks that were `running` return to `pending` and run again; parked checks stay parked while their jobs are open, and run at once if their jobs are gone. The built-in delivered log can persist too (`createDeliveredLog({ path })`), because a reloaded check needs the delivered list from before the restart.

## Cost accounting

`runTurn` may return `{ text, usage, costUsd }`. The scheduler passes these to `onUsage` and emits a `usage` event, for check turns and report turns alike (`checkId` is null on a report turn, `jobId` is set). Compute cost from the turn's own token counts: on a resumed session, some runtimes report a total cost that includes earlier turns of the session.

The fixed window makes checks more frequent in long conversations than v0.1's quiet-period timer. Parking makes long jobs cheaper than timed rechecks. Retries cost no model turns.

## Open questions

- Warm-cache cost per check in live use (being measured).
- Whether a per-conversation daily cap on checks is worth adding as an option.
