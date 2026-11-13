# nothing-owed

**A timer on every agent reply. When it fires, the agent checks its own conversation against what really reached the user, and delivers whatever it still owes.**

> **TIRED OF AI AGENTS PROMISING THINGS THEY NEVER DELIVER?**
>
> Your agent swore it would send the report "as soon as it lands"... and it never landed?
> Your assistant said "I'll get back to you" and then simply *ceased to exist between turns*?
>
> **WELL, NOT ANYMORE.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](./package.json)
[![CI](https://github.com/muziksociety/nothing-owed/actions/workflows/ci.yml/badge.svg)](https://github.com/muziksociety/nothing-owed/actions/workflows/ci.yml)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

```mermaid
flowchart LR
    R["Agent replies<br/>in a conversation"] --> T["Check scheduled<br/>5 min later"]
    R2["More replies<br/>before it fires"] -->|join the list, never move the timer| T
    T --> B{"User mid-<br/>conversation?"}
    B -->|yes| W["Wait, try again"] --> B
    B -->|no| C["Resume the SAME session with:<br/>your replies + the host's<br/>delivered list"]
    C --> O{"Agent answers"}
    O -->|NOTHING_OWED| S["Send nothing"]
    O -->|STILL_RUNNING| J{"Tracked job<br/>still open?"}
    J -->|yes| P["Park: no wakes<br/>until the job ends,<br/>then report + check once"]
    J -->|no| RC["Re-check: 6 x 5 min,<br/>then +15, +30, +60;<br/>+120 asks for a status"] --> B
    O -->|anything else| D["Deliver it<br/>to the user<br/>(retried if the send fails)"]
```

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

- The first reply the agent sends opens a check window for that conversation: the check fires **5 minutes later, no matter what**.
- More replies join the list but never move the timer. A chatty conversation cannot push a debt back forever.
- When the check fires, resume the **same** session and show the agent two lists: what it replied since the last check, and what the host **actually delivered**, from the host's own send log.
- The agent answers `NOTHING_OWED`, `STILL_RUNNING`, or the thing it owes, which goes to the user.

No promise detection, no phrase lists, no extractor model. It relies on the agent forgetting, and on the agent being good at judging its own conversation once it is shown the truth about delivery.

### But wait, there's more!

- **Zero dependencies.** Nothing to install but the thing itself.
- **Survives restarts.** Pending checks live in a file. Your agent's promises outlive your process.
- **Polite.** If the user is mid-conversation, the check waits its turn.
- **Knows when to stop.** Capped rechecks, and a check's own reply never starts another check. No infinite nagging loops.
- **Knows about long jobs.** Link a job to the conversation in code and the check sleeps until it ends. Then the user gets one report. No polling, no "still working!" every five minutes.
- **Never drops a delivery.** A failed send is kept and resent, not regenerated. You pay for the words once.

**Operators are standing by.** *(They are a `setTimeout`.)*

<sub>Side effects may include: receiving the things you were promised. Consult your send log before use.</sub>

## Quick start

```sh
npm install nothing-owed
```

```js
import { createNothingOwed, createFileStore } from 'nothing-owed';

const owed = createNothingOwed({
  store: createFileStore('./data/pending-checks.json'),
  runTurn: (conversationId, prompt) => agent.resume(conversationId, prompt), // same session
  deliver: (conversationId, text) => chat.send(conversationId, text),
  isUserBusy: (conversationId) => turnsInFlight.has(conversationId),
});
await owed.start();

// wherever the user writes to the agent:
owed.noteUserMessage('chat-42');       // counts messages, so the check can say "8 messages back"

// wherever your host sends a message to the user:
owed.noteDelivered('chat-42', text);   // it really reached the user
owed.noteReply('chat-42', text);       // the agent replied: opens (or joins) the check window

// wherever the agent starts long work for that conversation:
const result = await owed.wrapJob('chat-42', 'render-17', renderVideo(), { title: 'render' });
```

Try it without an API key:

```sh
node examples/simulate.mjs
```

```text
[min   0.0] user   "Can you summarize this video? https://example.com/v/123"
[min   0.0] host   -> user: "Got it. I'll send the summary when it's done."
[min   0.0] timer  check window opened: fires in 5 min, later replies will not move it
[min   1.1] agent  wrote the summary in a background turn... but nothing sent it (dropped)
[min   5.1] check  fires; the agent audits its conversation (its first reply: 1 message back)
[min   5.1] host   -> user: "SUMMARY: three points: setup, demo, pricing. Verdict: worth a watch."
[min   5.1] check  owed item delivered
[min   5.8] user   "Now render the full video, please."
[min   5.8] host   -> user: "Starting the render. It takes a while; I will report when it is done."
[min   5.8] timer  check window opened: fires in 5 min, later replies will not move it
[min   5.8] job    tracked: render
[min  10.8] check  fires; the agent audits its conversation (its first reply: 1 message back)
[min  10.8] check  STILL_RUNNING with an open job: parked on render-1, no wakes until it ends
[min  25.8] job    finished: done
[min  25.8] report the job ended; one report turn
[min  25.8] host   -> user: "Render finished: 4 clips, 2.1 GB. Nothing else is open."
[min  25.8] check  unparked: runs once now
[min  25.8] check  fires; the agent audits its conversation (its first reply: 2 messages back)
[min  25.8] check  NOTHING_OWED: nothing sent
[min  25.8] done   one dropped promise caught, one long job reported; 4 model wakes in total
```

## How it works

1. **`noteReply(conversationId, text)`** after each reply the agent sends. If that conversation has no pending check, one is created, due `delayMs` (5 minutes) later. If it has one, the reply joins its list and the due time stays put. After a check runs, the next reply opens a new window. A long list keeps reply 1 plus the newest ones, so the promise that started it all never falls off.
   **`noteUserMessage(conversationId)`** for each user message. Together with replies it drives a per-conversation counter, so the prompt can show each reply as `(8 messages back, <time>)` and ask the agent to look the promise up in its own history.
2. **`noteDelivered(conversationId, text)`** whenever your transport confirms a message reached the user (or pass your own `getDelivered`). This is the ground truth. Record it at the transport layer, after the send succeeded, never from what the model says it sent.
3. **When the check is due**, it first yields if `isUserBusy(conversationId)` is true. Then it calls `runTurn(conversationId, prompt)`, which must resume the same session. The prompt lists the agent's replies and the delivered messages since just before the first of them, and says:

   > Only what is in this delivered list reached the user. Anything you wrote that is not in it, they never saw.

4. **The answer is parsed** (`parseOutcome`), and acted on (see below). The check's own reply never schedules a new check, and neither do replies you mark `{ kind: 'report' }` or `{ kind: 'system' }`.
5. **Everything persists** in the store: pending and parked checks, message counters, open jobs and deliveries waiting for a retry. After a restart, `start()` reloads them; a check that was running when the process stopped runs again. Store files from v0.1 still load.

The full prompt is in [`src/outcome.js`](./src/outcome.js). Override it with `buildPrompt` if you need to.

## Outcomes

| The agent answers | What happens |
|---|---|
| `NOTHING_OWED` | Nothing is sent. The check ends. |
| `STILL_RUNNING` | The only debt is background work that will report on its own. Nothing is sent. With an open tracked job the check parks until the job ends (see Long jobs). Without one it comes back `delayMs` later, `maxRechecks` (6) times, then backs off by `backoffMs` (15, 30, 60, 120 minutes). The final step asks for a one-line status and ends the check. |
| text, then a last line `STILL_RUNNING` | Part of the debt is ready, part is still running. The text (minus that line) goes to the user, and the same check comes back later (or parks) for the rest. |
| anything else | It is the owed content. It goes to the user through `deliver()`. |
| empty, `...`, a `failTexts` entry, or an error | Silent. The failure is reported through `onEvent`, never to the user. |

Parsing is forgiving: `` `NOTHING_OWED` ``, `**NOTHING_OWED**`, `nothing_owed.` all count. `NOTHING_OWED, but...` does not; it is delivered.

## Long jobs

The agent says "the render takes an hour, I'll report when it's done". A timed recheck every five minutes would wake the model twelve times to hear "still running". So don't make the model remember the job: link it in code, where you start it.

```js
owed.trackJob(conversationId, jobId, { title: 'render' });         // when the work starts
await owed.finishJob(jobId, { status: 'done', text: output });     // when it ends: 'done' | 'error' | 'stopped'

// or both at once, around any promise:
const output = await owed.wrapJob(conversationId, jobId, renderVideo(), { title: 'render' });
```

- A check that answers `STILL_RUNNING` while the conversation has an open tracked job **parks** on it. No model wakes while parked.
- When the job ends, the package runs **one report turn** in the same session (job title, status, its output clipped to 1500 characters, "tell the user what it produced and what is still open") and delivers the reply. Pass `onJobFinished(conversationId, job)` to deliver the result yourself instead.
- Then the parked check runs once, in case something else was owed. A check parked on two jobs waits for both.
- **Safety net:** a check parked longer than `jobTimeoutMs` (2 hours) runs once with the last-check prompt, so the user gets a one-line status, parks one more period, then ends.
- Open jobs and parked checks survive a restart.
- `finishJob` and `wrapJob` resolve after the report and the parked check have run. The report turn does not wait for `isUserBusy`: you call `finishJob`, so you choose when.

## Delivery retry

`deliver()` counts as done only when it resolves. **Throw when the platform did not confirm the send** (for example, no message id came back). You may return `{ ids }`; they go into the `delivered` event.

A failed check reply or job report is kept in the store and resent every `retryMs` (5 minutes), up to `maxDeliveryAttempts` (12). The attempt count survives a restart. Retries resend the text already written; they never call `runTurn` again. An error with `retryAfterMs` sets the wait for that attempt; `isPermanentError(err)` returning true stops at once. After a give-up you get a `delivery_failed` event, and the next delivery in that conversation is preceded, once, by a short `Missed: <first 120 characters>` line.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `runTurn(id, prompt, ctx)` | required | Resume the same conversation's session with `prompt`. Return the reply text, or `{ text, usage, costUsd }`. |
| `deliver(id, text)` | required | Send a check reply to the user. |
| `getDelivered(id, sinceMs)` | built-in log | Your send log: `[{ at, text }]` for that conversation since `sinceMs`. |
| `isUserBusy(id)` | none | Return `true` while the user is mid-conversation; the check waits `busyRetryMs` and tries again. |
| `store` | memory | `createFileStore(path)`, `createMemoryStore()`, or any `{ load(), save(records) }`. |
| `delayMs` | `300000` (5 min) | The check fires this long after the first reply of a window. Also the recheck delay. |
| `maxRechecks` | `6` | Timed `STILL_RUNNING` rechecks at `delayMs`. |
| `backoffMs` | `[15, 30, 60, 120]` min | Further recheck steps after those; the last asks for a one-line status and ends. `[]` disables. |
| `jobTimeoutMs` | `7200000` (2 h) | A check parked on jobs this long gets one status check, then one more period, then ends. |
| `onJobFinished(id, job)` | report turn | Deliver a finished job's result yourself instead of the built-in report turn. |
| `retryMs` | `300000` (5 min) | Wait between delivery retries. |
| `maxDeliveryAttempts` | `12` | Attempts before giving up on a delivery. |
| `isPermanentError(err)` | never | Return `true` to stop retrying at once. |
| `busyRetryMs` | `60000` | Retry delay while the user is busy. |
| `deliveredLookbackMs` | `600000` | The delivered window opens this long before the first merged reply (a streamed reply can land before its turn ends). |
| `maxReplies` | `12` | A check keeps reply 1 plus the newest N-1 replies. |
| `maxReportLength` | `1500` | A job's output is clipped to this length in the report prompt. |
| `maxTextLength` | `300` | Texts in the prompt are clipped to this length. |
| `userLabel` | `"the user"` | How the prompt names the user. |
| `failTexts` | `[]` | Canned error notices your runtime returns in place of a reply; treated as failures. |
| `onEvent(event)` | none | `scheduled`, `merged`, `check_started`, `yielded`, `nothing_owed`, `still_running`, `delivered`, `failed`, `parked`, `unparked`, `park_timeout`, `park_ended`, `job_tracked`, `job_finished`, `report_delivered`, `report_skipped`, `delivery_retry`, `delivery_recovered`, `delivery_failed`, `missed_notice`, `usage`, `error`, `started`, `stopped`. |
| `onUsage({ id, usage, costUsd })` | none | Fires when `runTurn` returns usage or cost. Use it to track what checks cost. |
| `buildPrompt`, `buildReportPrompt`, `parseOutcome` | built-in | Replace the check prompt, the report prompt or the parser. |
| `deliveredLog` | memory | `createDeliveredLog({ path })` to persist the built-in log. |
| `now`, `setTimer`, `clearTimer` | real clock | Inject for tests. |

Methods: `noteReply(id, text, { kind? })`, `noteUserMessage(id)`, `messageCount(id)`, `noteDelivered(id, text, at | { at, id })`, `trackJob(id, jobId, { title })`, `finishJob(jobId, { status, text })`, `wrapJob(id, jobId, promiseOrFn, { title })`, `start()`, `stop()`, `tick()` (run due work now), `idle()` (wait for running work), `pending()`, `parked()`, `jobs()`, `outbox()`.

Also exported: `buildPrompt()`, `buildReportPrompt()`, `parseOutcome()`, `parseCheckReply()`, `stripStillRunning()`, `createFileStore()`, `createMemoryStore()`, `createDeliveredLog()`, `NOTHING_OWED`, `STILL_RUNNING`. Types are in [`index.d.ts`](./index.d.ts).

## Adapters

| Example | What it shows |
|---|---|
| [`examples/simulate.mjs`](./examples/simulate.mjs) | A dropped promise caught by a fake model. No API key. |
| [`examples/telegram-grammy`](./examples/telegram-grammy) | A grammY API transformer that logs every successful Bot API send (and edits of streamed messages) as delivered. One conversation per chat and forum topic. |
| [`examples/claude-agent-sdk`](./examples/claude-agent-sdk) | The check turn resumes the conversation's session by id with `query({ options: { resume } })`. |
| [`examples/claude-code-cli`](./examples/claude-code-cli) | The check turn is `claude -p --resume <session id> --output-format json`, with per-check cost from the token counts. |

## Results

From a production chat assistant, measured before this package was extracted:

| Test | Result |
|---|---|
| Offline replay on real past conversations, tools sealed off: owed cases caught | **4 / 4** (one of them as `STILL_RUNNING`) |
| Same replay: false alarms on conversations where nothing was owed | **0 / 5** |
| Earlier prompt version, without the delivered list | 3 / 4 caught |
| Cost per check in the replay, cold cache | about **$0.53** |
| First live check, cold cache | **$0.36** |
| Live check, warm cache | expected to be a few cents (being measured) |

The delivered list is what closed the gap from 3/4 to 4/4: without it, the agent sees a summary in its own context and assumes the user got it.

Cost depends on your model and conversation length; the check turn re-reads the session, so prompt caching matters most. Report `usage` from `runTurn` and track it with `onUsage`.

## How it compares

- **Commitment tracking (extractor model plus a ledger).** A second model reads each reply, extracts promises into a ledger, and a scheduler chases open items. It works, but it adds a model call per reply, an extraction schema, and a classifier that can miss promises phrased in a way it did not expect. nothing-owed has no extractor: every reply gets the same blind timer, and the agent that made the promise judges it, with its full context.
- **Durable workflow engines (Temporal, Inngest, and similar).** Great when the follow-up is a known step in code: they guarantee that step runs. They do not know about promises the model improvised in free text. You can run nothing-owed on top of one, using it as the timer and store.
- **Why a blind timer plus self-audit is simpler.** One timer per conversation, one extra turn per 5-minute window, no promise detection. The hard part, "is anything still owed?", goes to the party best placed to answer it, and the delivered list gives it the one fact it cannot know on its own.

## FAQ

**What does it cost?** One extra turn per conversation per 5-minute window, not per message. Most checks answer `NOTHING_OWED` with a few output tokens; the input is the resumed session, so a warm prompt cache makes checks cheap. Tune `delayMs` to trade latency for fewer checks.

Honest note: v0.1 waited for the conversation to go quiet, and that was cheaper: a long chat cost one check. v0.2 checks 5 minutes after the first reply even mid-conversation, so a 30-minute chat costs about six checks. That is on purpose. Waiting for silence let a busy conversation push a promise back forever; the fixed window is there for accountability. Long jobs, at least, got cheaper: a parked check costs nothing until the job ends.

**What about false alarms?** In the replay above, 0 of 5 conversations where nothing was owed produced a message. The prompt asks for the exact token `NOTHING_OWED`; anything else is delivered, so a model that rambles will send a message. If you see that, add an example to your system prompt or tighten `buildPrompt`.

**Why not detect promises with phrases?** Promises come in every language and phrasing ("I'll ping you", "te aviso", "will report back", "give me ten minutes"), and many debts are implied rather than promised. A phrase list misses those and fires on harmless ones. The agent already knows what it meant.

**Can the check loop forever?** No. A check reply or job report never schedules a new check, timed `STILL_RUNNING` rechecks are capped at `maxRechecks` plus the `backoffMs` steps, parked checks end after `jobTimeoutMs` plus one more period, and delivery retries stop at `maxDeliveryAttempts`.

**What if the user is talking to the agent when the check fires?** Pass `isUserBusy`. The check waits and retries; your user's turns always go first. A reply sent meanwhile joins the check.

**Does the agent need tools during the check?** Not to judge. If it owes a result it can only produce with tools, let `runTurn` allow them, but keep the turn short: the prompt tells it not to sleep or poll.

## License

[MIT](./LICENSE)

---

<sub>Not affiliated with Anthropic, OpenAI or any agent that owes you something.</sub>
