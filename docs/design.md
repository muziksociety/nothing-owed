# Design note

## Goal

An agent that says "I'll send it when it's done" should either send it or say why not. The agent cannot do this on its own: it runs only when a message arrives, and between turns nothing happens.

## Non-goals

- Detecting promises. We do not classify replies.
- Running the follow-up work. The check turn judges and delivers; long work stays wherever the agent runs it.
- Guaranteeing exactly-once delivery of arbitrary content. That is the transport's job.

## The loop

```
noteReply(c, text)
  -> pending check for c exists?  yes: append reply, due = now + delay
                                  no:  create check, due = now + delay
timer fires (earliest due)
  -> isUserBusy(c)?  yes: due = now + busyRetry (no recheck used)
  -> prompt = replies since last check + delivered(c, firstReply.at - lookback)
  -> text = runTurn(c, prompt)            (same session)
  -> parseOutcome(text)
       nothing  -> done
       running  -> rechecks < max ? requeue (rechecks + 1) : done
       deliver  -> deliver(c, text), done
       failed   -> done (event only)
```

## Decisions

**One check per conversation per quiet period.** A reply merges into the pending check and moves its due time. Cost scales with conversations that go quiet, not with message count.

**The delivered list comes from the host.** The model's context contains what it wrote, including text that never left the process (a background turn, a failed send, a crash between generation and delivery). The only reliable record of what the user saw is the transport's success log. The earlier prompt version without it caught 3 of 4 owed cases in the replay; with it, 4 of 4.

**The window starts before the first reply.** A streamed reply reaches the user before its turn ends and before `noteReply` is called, so the delivered window opens `deliveredLookbackMs` earlier.

**Same session, not a fresh one.** The agent needs its own context to know what it meant. A fresh model with a transcript excerpt would be an extractor with extra steps.

**`STILL_RUNNING` is a third answer.** Without it, an agent waiting on background work that reports on its own has two bad choices: say nothing (and lose the debt) or send "still working" every ten minutes. The recheck is capped; the last check asks for a one-line status so the user is never left with silence.

**Check replies never re-arm.** Otherwise a check that delivers would schedule a check that delivers. The scheduler ignores `noteReply` calls made while it is delivering a check reply in the same conversation, so hosts that route every outgoing message through one function are safe. Replies of kind `check`, `report` or `system` are ignored too.

**User turns win.** A check that fires while the user is mid-conversation would interleave with a live turn in the same session. `isUserBusy` makes it wait. Waiting does not use up rechecks.

**Failures are silent.** A check that errors, times out or returns an empty or canned failure text sends nothing to the user. It surfaces through `onEvent` so the host can log it. A missed check is a missed safety net, not a new problem for the user.

**Persistence.** Pending checks are saved on every change. On `start()`, checks that were `running` when the process stopped return to `pending` and run again. The built-in delivered log can persist too (`createDeliveredLog({ path })`), because a reloaded check needs the delivered list from before the restart.

## Cost accounting

`runTurn` may return `{ text, usage, costUsd }`. The scheduler passes these to `onUsage` and emits a `usage` event. Compute cost from the check turn's own token counts: on a resumed session, some runtimes report a total cost that includes earlier turns of the session.

## Open questions

- Warm-cache cost per check in live use (being measured).
- Whether a per-conversation daily cap on checks is worth adding as an option.
