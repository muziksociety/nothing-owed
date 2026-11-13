# nothing-owed

**A timer on every agent reply. When it fires, the agent checks its own conversation against what really reached the user, and delivers whatever it still owes. When the check cannot be done, code tells the user in plain words instead of going quiet.**

> **TIRED OF AI AGENTS PROMISING THINGS THEY NEVER DELIVER?**
>
> Your agent swore it would send the report "as soon as it lands"... and it never landed?
> Your assistant said "I'll get back to you" and then simply *ceased to exist between turns*?
>
> **WELL, LESS OFTEN NOW.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](./package.json)
[![CI](https://github.com/muziksociety/nothing-owed/actions/workflows/ci.yml/badge.svg)](https://github.com/muziksociety/nothing-owed/actions/workflows/ci.yml)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

```mermaid
flowchart TD
    R["Agent replies"] --> T["Check window opens:<br/>due 5 min later; more replies<br/>join it, never move it"]
    T --> B{"User mid-turn? Circuit open?<br/>Daily cap left? Turn slot free?"}
    B -->|"wait (cap: one line,<br/>then tomorrow)"| B
    B -->|go| C["Resume the SAME session with:<br/>replies + messages back + delivered list<br/>+ queued + failed-to-send lists"]
    C --> O{"Agent answers<br/>(3 min timeout)"}
    O -->|NOTHING_OWED| S["Send nothing. Done."]
    O -->|owed content| D["Deliver it"]
    O -->|"content + STILL_RUNNING"| D
    O -->|"DUE time (UTC)"| DT["Dated timer, max 10 in a chain,<br/>5 per conversation"] --> B
    O -->|"error, empty, junk, timeout"| RC
    O -->|STILL_RUNNING| J{"Tracked job<br/>open?"}
    D -->|part still running| J
    J -->|"yes (after one recheck)"| P["Park: no model wakes"]
    J -->|no| RC["Recheck: 6 x 5 min,<br/>then +15, +30, +60, +120"] --> B
    RC -->|"last step, no answer"| G["Code-written line:<br/>couldn't check / no longer watched"]
    E(["Code event: job ends<br/>(finishJob, wrapJob,<br/>or lost in a restart)"]) --> RT["Report turn, same session:<br/>waits for the user, retries"]
    RT -->|written| D
    RT -->|"failed, declined,<br/>or model down"| FB["Code-written report:<br/>title, status, first output line"]
    RT --> P2["Parked check runs once"] --> B
    P -.->|"2 h with no end"| ST["One status: says plainly<br/>it is no longer watched"]
    D --> X{"Platform confirmed<br/>the send?"}
    X -->|yes| V["Verify check 5 min later:<br/>did that reply promise more?<br/>(max 3 deep, then a line)"] --> B
    X -->|no| RS["Resend the same text every 5 min,<br/>max 12; then 'Missed:' + full text<br/>on its own timer (15 min, doubling to 6 h)"]
```

**Rule of thumb:** code holds every alarm (check windows, rechecks, dated timers, job-end events, delivery confirmation, turn and callback timeouts, the circuit breaker). The model is only woken to judge and to write. When the model cannot answer, code writes the line the user gets.

## The problem

*(Dramatic black-and-white footage of a person staring at a chat window.)*

LLM agents promise follow-ups they cannot keep, because nothing runs between turns. Claude, GPT, whoever: between your messages, your agent is not "working on it". It is not anything. It is a file on a disk.

Here is how it goes. A user sends a video link. The agent answers: *"Got it, I'll send you the summary when it's done."* It starts the work. The summary does get written, in a background turn whose output never went anywhere. The user waits. Nothing arrives. Ask the agent later and it will often say it already sent it, because the summary is right there in its context.

The agent did not lie. It just has no clock, and it cannot tell "I wrote it" from "the user received it".

### Real* testimonials

> "My agent said 'downloading now, full summary coming.' I'm still waiting."
> **A Real Human**, three weeks later

> "It told me it would 'circle back.' It has not circled. It has not even lined."
> **A Project Manager**, slowly losing faith

> "I asked if it sent the file. It said yes. With confidence. With *bullet points.*"
> **Someone Who Checked Their Inbox**

<sub>*Invented. Any resemblance to your own agent is, sadly, extremely likely.</sub>

## The fix

**How it works: we exploit the one thing your agent is truly reliable at. Forgetting.**

- The first reply the agent sends opens a check window for that conversation, due **5 minutes later**. More replies join the list but never move the due time, so a chatty conversation cannot push a debt back forever. (The check still waits for a user who is mid-turn, an open circuit breaker or a daily cap; see below.)
- When the check runs, resume the **same** session and show the agent what it replied since the last check, and what the host **actually delivered**, from the host's own send log.
- The agent answers `NOTHING_OWED`, `STILL_RUNNING`, `DUE <time>`, or the thing it owes, which goes to the user.

No promise detection, no phrase lists, no extractor model. It relies on the agent forgetting, and on the agent being good at judging its own conversation once it is shown the truth about delivery.

### But wait, there's more!

- **Zero dependencies.** Nothing to install but the thing itself.
- **Survives restarts.** Checks, dated timers, owed reports, retries, missed notices and the delivered log live next to each other in the store. Jobs that died with the old process are reported as lost, not waited on.
- **Polite.** If the user is mid-conversation, checks and job reports wait their turn.
- **Says so when it fails.** A check that keeps failing, a report the model will not write, a last check with nothing to say, a reached cap: each ends with a short code-written line, not with silence. Those lines never claim a promise was made, and a broken model setup does not spam users who were promised nothing: after 5 failed turns in a row a circuit breaker pauses the checks.
- **Reads its own replies back.** A delivered check reply can itself be a new promise ("ten more minutes"). It gets one follow-up check; the chain is capped at 3.
- **Knows about dates.** "I'll remind you tomorrow at 9" becomes a timer in code. Chains of dates are capped too.
- **Knows about long jobs.** Link a job to the conversation in code and the check sleeps until it ends. Then the user gets one report.
- **Keeps failed sends.** A failed send is kept and resent, not regenerated. If it never lands, a `Missed:` notice with the full text keeps trying on its own timer, and you can take it with `flushMissed()`. (The platform still has to be reachable at some point; nothing can deliver to a chat that is gone.)
- **Bounded.** Rechecks, verify chains, DUE chains, dated timers, turns per conversation per day, turns per day overall, turns at once, and every host callback have limits. The tests check each one.

**Operators are standing by.** *(They are a `setTimeout`.)*

<sub>Side effects may include: receiving the things you were promised. Consult your send log before use.</sub>

## Quick start

```sh
npm install nothing-owed
```

```js
import { createNothingOwed, createFileStore } from 'nothing-owed';

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'), // also keeps the delivered log, and a lock file
  runTurn: (conversationId, prompt, ctx) => agent.resume(conversationId, prompt, { signal: ctx.signal }), // same session
  deliver: (conversationId, text) => chat.send(conversationId, text), // throw if the platform did not confirm
  isUserBusy: (conversationId) => turnsInFlight.has(conversationId) || owed.isChecking(conversationId),
  timeZone: 'Europe/Madrid', // optional: the prompt shows the users' local time too
});
await owed.start();

// wherever the user writes to the agent:
owed.noteUserMessage('chat-42');       // counts messages, so the check can say "8 messages back"

// wherever your host sends the agent's reply to the user:
for (const line of owed.flushMissed('chat-42')) await chat.send('chat-42', line); // owed "Missed:" notices first
owed.noteDelivered('chat-42', text);   // it really reached the user
owed.noteReply('chat-42', text);       // the agent replied: opens (or joins) the check window

// wherever the agent starts long work for that conversation:
const result = await owed.wrapJob('chat-42', 'render-17', renderVideo(), { title: 'render' });

// on shutdown:
await owed.stop();                     // writes the final state
```

Two rules for `runTurn`:

- **Serialize it with your user turns.** A check turn resumes the same session as the user's turns. Do not run both at once: use `isUserBusy`, `onTurnStart` / `onTurnEnd` and `isChecking(id)` to keep them apart.
- **It must not send anything itself.** It returns the agent's text; the package decides whether it goes to the user and sends it through `deliver()`. If your agent runtime posts its replies to the chat on its own, turn that off for these turns.

What the package sends through `deliver()` it counts and logs as delivered itself. If your send path also calls `noteDelivered` or `noteReply` for those messages, that is fine: the same text within a minute is one entry, and the package recognizes its own deliveries coming back through `noteReply`. `deliver()` gets a third argument, `{ kind, checkId, jobId }`, if you want to tell them apart.

**One process per store.** The file store writes `<path>.lock` with its process id and refuses a second live process. Two processes on one store would overwrite each other's state.

Try it without an API key:

```sh
node examples/simulate.mjs
```

```text
[min   0.0] user   "Can you summarize this video? https://example.com/v/123"
[min   0.1] host   -> user: "Got it. I'll send the summary when it's done."
[min   0.1] timer  check window opened: fires in 5 min, later replies will not move it
[min   1.1] agent  wrote the summary in a background turn... but nothing sent it (dropped)
[min   5.1] check  fires; the agent audits its conversation (its first reply: 1 message back)
[min   5.1] host   -> user: "SUMMARY: three points: setup, demo, pricing. Verdict: worth a watch."
[min   5.1] check  owed item delivered
[min   5.1] timer  verify check in 5 min on what was just delivered
[min   5.6] user   "Now render the full video, please."
[min   5.6] host   -> user: "Starting the render. It takes a while; I will report when it is done."
[min   5.6] job    tracked: render
[min  10.1] check  fires; the agent audits its conversation (its first reply: 3 messages back)
[min  10.1] check  STILL_RUNNING
[min  15.2] check  fires; the agent audits its conversation (its first reply: 3 messages back)
[min  15.2] check  STILL_RUNNING
[min  15.2] check  an open job: parked on render-1, no wakes until it ends
[min  25.6] job    finished: done
[min  25.6] report the job ended; one report turn
[min  25.6] host   -> user: "Render finished: 4 clips, 2.1 GB. Nothing else is open."
[min  25.6] timer  verify check in 5 min on what was just delivered
[min  25.6] check  unparked: runs once now
[min  25.6] check  fires; the agent audits its conversation (its first reply: 4 messages back)
[min  25.6] check  NOTHING_OWED: nothing sent
[min  31.1] done   one dropped promise caught, one long job reported; 5 model wakes in total
```

## How it works

1. **`noteReply(conversationId, text)`** after each reply the agent sends. If that conversation has no pending check, one is created, due `delayMs` (5 minutes) later. If it has one, the reply joins its list and the due time stays put. After a check runs, the next reply opens a new window. A long list keeps reply 1 plus the newest ones; a long reply keeps its first and last 150 characters, because promises like to sit at the end.
   **`noteUserMessage(conversationId)`** for each user message. Together with replies it drives a per-conversation counter, so the prompt can show each reply as `(8 messages back, <time>)` and ask the agent to look the promise up in its own history.
2. **`noteDelivered(conversationId, text)`** whenever your transport confirms a message reached the user (or pass your own `getDelivered`). This is the ground truth. Record it at the transport layer, after the send succeeded, never from what the model says it sent. It never throws into your send path.
3. **When the check is due**, it asks `isUserBusy` and your send log first, without holding a turn slot, then waits for a slot (2 at once, growing by one per 25 waiting turns up to 8), then builds the prompt and calls `runTurn(conversationId, prompt, ctx)`. Every host callback times out after `callbackTimeoutMs` (30 s). The prompt shows the time now (UTC, and the users' local time with `timeZone`), the agent's replies, the newest 40 delivered messages since just before the first reply, anything queued for a retry ("do not write these again"), anything given up on ("write it again if still needed"), and whether the send log reaches back far enough. It says:

   > Only what is in this delivered list reached the user. Anything you wrote that is not in it, they never saw. Never say something was sent unless it is in this list.

4. **The answer is parsed** and acted on (see Outcomes). A turn that throws, comes back empty or as tool-call markup (`isJunk`), or runs past `turnTimeoutMs` (3 minutes; `ctx.signal` is aborted) is a failed check, and failed checks come back on the recheck ladder.
5. **Everything the package delivers gets one verify check** `delayMs` later, so a reply that is itself a promise ("the rest in ten minutes") is watched too. The chain stops after `maxVerifyDepth` (3) with a code-written line. There is no verify after a last-check status or after a delivery that also set a `DUE` timer (the timer is the follow-up). Replies you deliver yourself and note with `{ kind: 'check' }` or `{ kind: 'report' }` get the same single verify.
6. **Everything persists** in the store: checks, dated timers, owed report turns, counters, open jobs, retries, missed notices, caps and the circuit breaker; the built-in delivered log sits next to it. Writes are batched (100 ms); `stop()` writes the final state. `start()` reloads it and merges anything you noted before it finished loading. Stores from v0.1 to v0.3 still load.

The full prompt is in [`src/outcome.js`](./src/outcome.js). Override it with `buildPrompt` if you need to.

## Outcomes

| The agent answers | What happens |
|---|---|
| `NOTHING_OWED` | Nothing is sent. The check ends. |
| `STILL_RUNNING` | The only debt is background work that will report on its own. Nothing is sent. With an open tracked job the check comes back once more `delayMs` later, then parks until the job ends (see Long jobs). Without one it comes back `delayMs` later, `maxRechecks` (6) times, then backs off by `backoffMs` (15, 30, 60, 120 minutes). The final step asks for a one-line status that says plainly the work is no longer watched. |
| text, plus a `STILL_RUNNING` line | Part of the debt is ready, part is still running. The text (minus the marker) goes to the user, and the check comes back for the rest. |
| `DUE <UTC time ending in Z>`, alone or after text | A promise for a later time. Any text goes out now; a dated timer is stored, and at that time a check runs with the replies that made the promise. With `STILL_RUNNING` too, both happen. Times in the past or more than `maxDueMs` (30 days) away count as `STILL_RUNNING`. A chain of `DUE` answers stops after `maxDueDepth` (10), and a conversation holds at most 5 dated timers; past either, a code-written line. |
| anything else | It is the owed content. It goes to the user through `deliver()`, unless it is a word-for-word copy of something queued, given up on, or delivered since this check last ran (or in the last 10 minutes). Dated checks are never compared, so a daily reminder goes out every day. |
| empty, `...`, a `failTexts` entry, tool-call markup, an error, or a timeout | Nothing is sent now; the check comes back on the same ladder. If the last step still fails, the user gets the `giveUpText` line, *"I may have said I'd follow up on something, and I couldn't check it. Ask me if anything is still open."*, at most once per conversation per outage, and never while the circuit breaker is open (then the step waits for it to close). |

If the last check answers only `STILL_RUNNING`, code sends a line too, saying the work may still be running and is no longer watched.

Parsing is strict about what it sends and loose about how markers look:

- Markers count on the first line or among the last two lines, in any case, with quotes, bold, code marks, code fences, punctuation, a `Status:` label or a short note around them: `` `NOTHING_OWED` ``, `**Nothing owed.**`, `STILL_RUNNING (render)`. All marker lines are removed from what is sent.
- `DUE` is upper-case only and needs an ISO time with a zone (`Z` or an offset); it may sit in `<...>` and carry a short note. Any other `DUE` line counts as `STILL_RUNNING`. "Due 12 May..." in a sentence stays text.
- A last-line `NOTHING_OWED` means nothing is sent (what came before was reasoning). A first-line `NOTHING_OWED` with real content after it, or `NOTHING_OWED except ...`, delivers that content.
- A reply whose last sentence holds `NOTHING_OWED`, or is a short "nothing is owed" with no numbers in it, is nothing. `NOTHING_OWED` and `STILL_RUNNING` together keep the check open.
- A `STILL_RUNNING` inside a sentence is sent as "still running" and the check stays open. `<think>` blocks are removed. The same parser reads job reports.

## Long jobs

The agent says "the render takes an hour, I'll report when it's done". A timed recheck every five minutes would wake the model twelve times to hear "still running". So don't make the model remember the job: link it in code, where you start it.

```js
owed.trackJob(conversationId, jobId, { title: 'render' });   // when the work starts
owed.finishJob(jobId, { status: 'done', text: output });     // when it ends: 'done' | 'error' | 'stopped'

// or both at once, around any promise:
const output = await owed.wrapJob(conversationId, jobId, renderVideo(), { title: 'render' });
```

- A check that answers `STILL_RUNNING` while the conversation has an open tracked job comes back once more, then **parks** on it. No model wakes while parked. A *failed* check never parks: it takes the ladder, so an unrelated open job cannot delay a promise.
- `finishJob` and `wrapJob` resolve at once. In the background, the package queues **one report turn** in the same session (job title, status, its output, "tell the user what it produced and what is still open"). The report is stored, waits while the user is mid-turn, and a failed report turn is retried on the same ladder as a check. It is marked delivered in the store right before it is sent, so a crash after the send never sends it twice. Events tell you when it is done: `report_delivered`, `report_fallback`, `report_done`.
- If the report turn keeps failing, answers `NOTHING_OWED` or only `STILL_RUNNING`, or the circuit breaker says the model is down, the user gets a **code-written report**: `<title> <status>: <first line of the output, up to 300 characters>`.
- Pass `onJobFinished(conversationId, job)` to deliver the result yourself instead. Note what you send with `noteReply(id, text, { kind: 'report' })` so it gets its verify check.
- Then the parked check runs once, in case something else was owed. A check parked on two jobs waits for both.
- **Safety net:** a check parked longer than `jobTimeoutMs` (2 hours) runs once with the last-check prompt, so the user gets a one-line status that says plainly it is no longer watched, parks one more period, then ends.
- **Restarts:** a job in the store at `start()` died with the old process, as far as the package knows. It finishes as `lost` (*"the work was interrupted by a restart"*), which runs the normal report and unparks its checks. If your host really does keep jobs running across restarts, return their ids from `onStartJobs(jobs)`.

## Delivery retry and missed notices

`deliver()` counts as done only when it resolves. **Throw when the platform did not confirm the send** (for example, no message id came back). You may return `{ ids }`; they go into the `delivered` event. A `deliver()` that does not settle within `callbackTimeoutMs` counts as failed and goes to the outbox; if it later succeeds after all, the user can get that text twice.

A failed delivery is kept in the store and resent every `retryMs` (5 minutes), up to `maxDeliveryAttempts` (12). Retries resend the text already written; they never call `runTurn` again. Checks that run meanwhile see it in the prompt's queued list, and a word-for-word copy is not sent twice. An error with `retryAfterMs` sets the wait for that attempt; `isPermanentError(err)` returning true stops at once.

After a give-up you get a `delivery_failed` event and the full text becomes a **missed notice** with its own timer: 15 minutes later it tries to send `Missed: <full text>`, and while that fails the wait doubles up to 6 hours, until it lands or you take it with `flushMissed(conversationId)` (send those lines before your next normal message). It also goes out before any later package delivery in that conversation, one sender at a time. Checks list it as "failed to send - write it again if still needed". After a permanent error the notice waits for `flushMissed`.

## Caps and the circuit breaker

- **Per conversation:** `dailyCap` (60) model turns per UTC day. The last `dailyCapReserve` (10) are kept for window checks (a new reply) and dated checks. Past the cap, the check waits for the next day and the user gets one line a day: *"I've hit today's limit for checking on promises; I'll check again at 00:00 UTC."* Reports past the cap use the code-written report.
- **Overall:** `globalDailyCap` (1000) model turns per UTC day across all conversations; reaching it emits `global_daily_cap` once, for you.
- **Circuit breaker:** after `circuitFailures` (5) failed turns in a row, across conversations, model turns pause for 15 minutes, then one probe turn runs; each failed probe doubles the pause up to 2 hours. `circuit_open` and `circuit_closed` events tell you. While it is open, give-up lines wait (so a broken setup does not tell every user something went wrong with a promise they never got), and due reports go out as their code-written version.
- **Stuck busy:** if `isUserBusy` stays true for 30 minutes, you get one `busy_stuck` event; the check keeps waiting.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `runTurn(id, prompt, ctx)` | required | Resume the same conversation's session with `prompt`; return the reply text, or `{ text, usage, costUsd }`. `ctx` has `kind`, `reason`, `isLastCheck` and an abort `signal`. Serialize it with user turns; it must not send anything itself. |
| `deliver(id, text, meta)` | required | Send a package-made text. `meta` is `{ kind, checkId, jobId }`, kind `check`, `report`, `giveup`, `fallback` or `missed`. Throw if the send was not confirmed. |
| `getDelivered(id, sinceMs)` | built-in log | Your send log: `[{ at, text }]` for that conversation since `sinceMs`. |
| `isUserBusy(id)` | none | `true` while the user is mid-conversation; checks and reports wait `busyRetryMs` and try again. |
| `onTurnStart(id, ctx)`, `onTurnEnd(id, ctx)` | none | Called around every model turn, so you can serialize them with user turns. |
| `store` | memory | `createFileStore(path)`, `createMemoryStore()`, or any `{ load(), save(state) }` (optional `saveSync`, `lock`, `unlock`, `deliveredBacking`). |
| `timeZone` | UTC only | IANA zone of your users, for the "Now:" line. |
| `delayMs` | `300000` (5 min) | The check is due this long after the first reply of a window. Also the recheck and verify delay. |
| `maxRechecks` | `6` | Timed rechecks at `delayMs` after `STILL_RUNNING` or a failed turn. |
| `backoffMs` | `[15, 30, 60, 120]` min | Further recheck steps after those; the last asks for a one-line status. `[]` disables. |
| `giveUpText(ctx)` | built-in lines | The code-written lines; `ctx.reason` is `failed`, `still_running`, `verify_capped`, `daily_cap` (with `until`) or `due_limit`. |
| `turnTimeoutMs` | `180000` (3 min) | A turn that does not settle by then counts as failed; `ctx.signal` is aborted. `0` disables. |
| `callbackTimeoutMs` | `30000` | Timeout for `deliver`, `isUserBusy`, `getDelivered`, `onJobFinished`, `onStartJobs` and the turn hooks. `0` disables. |
| `isJunk(text)` | tool-call markup | A reply it flags is a failed check, never delivered. The default catches lines starting with `<｜`, and `invoke name=`, `<tool_call`, `<function_calls>`. |
| `maxVerifyDepth` | `3` | Verify checks in a row. |
| `maxDueMs`, `maxDueDepth`, `maxDatedPerConversation` | 30 days, `10`, `5` | Limits for `DUE`. |
| `maxConcurrent`, `maxConcurrentLimit` | `2`, `8` | Model turns at once; one more per 25 waiting, up to the limit. |
| `dailyCap`, `dailyCapReserve`, `globalDailyCap` | `60`, `10`, `1000` | Turn caps per conversation and overall. `0` disables. |
| `circuitFailures`, `circuitPauseMs`, `circuitMaxPauseMs` | `5`, 15 min, 2 h | The circuit breaker. `circuitFailures: 0` disables it. |
| `jobTimeoutMs` | `7200000` (2 h) | A check parked on jobs this long gets one status check, then one more period, then ends. |
| `onJobFinished(id, job)` | report turn | Deliver a finished job's result yourself. |
| `onStartJobs(jobs)` | keep none | Jobs found in the store at `start()`: return the ids your host still runs. |
| `retryMs`, `maxDeliveryAttempts` | 5 min, `12` | Delivery retries. |
| `missedRetryMs`, `missedMaxRetryMs` | 15 min, 6 h | The missed-notice timer. |
| `isPermanentError(err)` | never | `true` stops retrying at once. |
| `busyRetryMs`, `busyStuckMs` | 1 min, 30 min | Busy retry, and when to emit `busy_stuck`. |
| `deliveredLookbackMs` | `600000` | The delivered window opens this long before the first reply (a streamed reply can land before its turn ends). |
| `maxReplies`, `maxTextLength`, `maxDeliveredInPrompt`, `maxReportLength` | `12`, `300`, `40`, `1500` | Prompt bounds. |
| `saveDebounceMs`, `idlePruneMs` | 100 ms, 30 days | Batched writes; counters of conversations idle this long are dropped. |
| `userLabel`, `failTexts` | `"the user"`, `[]` | How the prompt names the user; canned error notices treated as failures. |
| `onEvent(event)`, `onUsage(info)` | none | Every event (see `index.d.ts`), and turn usage or cost. |
| `buildPrompt`, `buildReportPrompt`, `parseOutcome` | built-in | Replace the prompts or the parser. |
| `deliveredLog` | with the store | `createDeliveredLog({ path })` to keep it elsewhere. |
| `now`, `setTimer`, `clearTimer` | real clock | Inject for tests. |

Methods: `noteReply(id, text, { kind? })`, `noteUserMessage(id)`, `messageCount(id)`, `noteDelivered(id, text, at | { at, id })`, `flushMissed(id)`, `isChecking(id)`, `trackJob(id, jobId, { title })`, `finishJob(jobId, { status, text })`, `wrapJob(id, jobId, promiseOrFn, { title })`, `start()`, `stop()`, `flush()`, `tick()`, `idle()`, `pending()`, `parked()`, `dated()`, `jobs()`, `reports()`, `outbox()`, `missed()`, `circuit()`.

`noteReply` kinds: none or `reply` opens or joins a window; `check` and `report` (replies you delivered yourself) count and get one verify check; `giveup`, `fallback` and `missed` only count; `system` does neither.

Also exported: `buildPrompt()`, `buildReportPrompt()`, `parseOutcome()`, `parseCheckReply()`, `stripStillRunning()`, `clipText()`, `isJunkReply()`, `defaultGiveUpText()`, `fallbackReportText()`, `createFileStore()`, `createMemoryStore()`, `createDeliveredLog()`, `NOTHING_OWED`, `STILL_RUNNING`. Types are in [`index.d.ts`](./index.d.ts).

## Adapters

| Example | What it shows |
|---|---|
| [`examples/simulate.mjs`](./examples/simulate.mjs) | A dropped promise caught by a fake model. No API key. |
| [`examples/telegram-grammy`](./examples/telegram-grammy) | A grammY API transformer that logs every successful Bot API send (and edits of streamed messages, and captionless media as `[photo]`, `[document]`...) as delivered. One conversation per chat and forum topic. |
| [`examples/claude-agent-sdk`](./examples/claude-agent-sdk) | The check turn resumes the conversation's session by id with `query({ options: { resume } })`. |
| [`examples/claude-code-cli`](./examples/claude-code-cli) | The check turn is `claude -p --resume <session id> --output-format json`, with per-check cost from the token counts. |

## Results

**Small replay: 9 past conversations, one model, v0.1 prompt.** A later replay of the v0.3 prompt on 54 cases scored 49/54 with Claude and 41/54 with DeepSeek; the misses it found (marker combinations, tool-call markup sent as text, time zones, claims about files) are handled in v0.4's parser and prompt. **The v0.4 prompt has not been replayed on a real model yet.** Everything v0.4 adds on the code side is covered by tests on a fake clock with a fake model; whether a given model follows the new prompt lines is not measured.

| Test (v0.1 prompt, offline replay, tools sealed off) | Result |
|---|---|
| Owed cases caught | **4 / 4** (one of them as `STILL_RUNNING`) |
| False alarms on conversations where nothing was owed | **0 / 5** |
| Earlier prompt version, without the delivered list | 3 / 4 caught |
| Cost per check in the replay, cold cache | about **$0.53** |
| First live check, cold cache | **$0.36** |
| First live check, warm cache (it delivered a 763-character reply) | **$0.035** |
| Daily cost with the fixed window and verify checks | not measured |

The delivered list is what closed the gap from 3/4 to 4/4: without it, the agent sees a summary in its own context and assumes the user got it.

**Cost and the prompt cache.** The check turn re-reads the whole session, so prompt caching decides the price: in the table, a warm-cache check cost about a tenth of a cold one ($0.035 against $0.36). Many providers keep a prompt cache for about 5 minutes, and the default `delayMs` is also 5 minutes, so a check can land just after the cache expired and pay the cold price. If your provider offers a longer cache lifetime, or you can shorten `delayMs` a little below it, checks get much cheaper. Report `usage` from `runTurn` and track it with `onUsage`.

## How it compares

- **Commitment tracking (extractor model plus a ledger).** A second model reads each reply, extracts promises into a ledger, and a scheduler chases open items. It works, but it adds a model call per reply, an extraction schema, and a classifier that can miss promises phrased in a way it did not expect. nothing-owed has no extractor: every reply gets the same blind timer, and the agent that made the promise judges it, with its full context.
- **Durable workflow engines (Temporal, Inngest, and similar).** Great when the follow-up is a known step in code: they guarantee that step runs. They do not know about promises the model improvised in free text. You can run nothing-owed on top of one, using it as the timer and store.
- **Why a blind timer plus self-audit is simpler.** One timer per conversation, one extra turn per 5-minute window, no promise detection. The hard part, "is anything still owed?", goes to the party best placed to answer it, and the delivered list gives it the one fact it cannot know on its own.

## FAQ

**What does it cost?** One extra turn per conversation per 5-minute window, not per message, plus one verify turn after each message the package delivers. Most checks answer `NOTHING_OWED` with a few output tokens; the input is the resumed session, so the prompt cache matters most (see the cost note above). `dailyCap`, `globalDailyCap` and the circuit breaker bound the worst case.

Honest note: v0.1 waited for the conversation to go quiet, and that was cheaper: a long chat cost one check. Since v0.2 the check is due 5 minutes after the first reply even mid-conversation, so a 30-minute chat costs about six checks. That is on purpose: waiting for silence let a busy conversation push a promise back forever. Failed checks come back instead of being dropped, which costs more turns during an outage (the circuit breaker limits that). Long jobs, at least, are cheap: a parked check costs nothing until the job ends.

**What about false alarms?** In the replay above, 0 of 5 conversations where nothing was owed produced a message. The parser accepts the usual near misses of `NOTHING_OWED`, and treats tool-call markup as a failure. A long reply without a marker is still delivered, so a model that rambles will send a message. If you see that, add an example to your system prompt or tighten `buildPrompt`.

**Why not detect promises with phrases?** Promises come in every language and phrasing ("I'll ping you", "te aviso", "will report back", "give me ten minutes"), and many debts are implied rather than promised. A phrase list misses those and fires on harmless ones. The agent already knows what it meant.

**Can it loop?** Every chain has a cap, and the tests drive each one to its end on a fake clock: rechecks (`maxRechecks` plus the back-off steps), verify checks (`maxVerifyDepth`), `DUE` chains (`maxDueDepth`, 5 timers per conversation), parked checks (`jobTimeoutMs` plus one period), delivery retries (`maxDeliveryAttempts`), missed notices (doubling to 6 hours), and turns per conversation and overall per day. A word-for-word repeat of something just sent is not sent again.

**What if the user is talking to the agent when the check fires?** Pass `isUserBusy`. Checks and report turns wait and retry; your user's turns go first. A reply sent meanwhile joins the check. For a hard guarantee, serialize with `onTurnStart` / `onTurnEnd` and `isChecking`.

**Does the agent need tools during the check?** Not to judge. If it owes a result it can only produce with tools, let `runTurn` allow them, but keep the turn short: the prompt tells it not to sleep or poll, `turnTimeoutMs` ends it after 3 minutes, and it cannot send files from this turn (the prompt says so).

## License

[MIT](./LICENSE)

---

<sub>Not affiliated with Anthropic, OpenAI or any agent that owes you something.</sub>
