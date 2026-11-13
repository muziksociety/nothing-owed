# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.4.3] - 2026-11-13

### Added

- `deliver()` may return `{ text }` (the text really sent, for example after a guard rewrite; the delivered log and the verify check use it) or `{ skipped: true }` (the host sent nothing: no delivered entry, no verify, no retry, a `delivery_skipped` event). Returning nothing keeps the old behaviour.

## [0.4.2] - 2026-11-13

### Fixed

- A short status sentence before a `DUE` line ("Nothing new owed tonight; the reminder comes in the morning.") is no longer sent to the user. Seen with DeepSeek in the replay. Replies over 400 characters or with a link are still sent.
- The prompt says text before `DUE` is sent, and asks for no status note.

### Docs

- README Results: DeepSeek replay of the v0.4.1 prompt.

## [0.4.1] - 2026-11-13

From a review of normal day-to-day flows.

### Changed

- `DUE` times without a zone, with a space instead of `T`, or with `UTC`/`GMT` are read as UTC (the
  prompt asks for UTC); explicit offsets are kept. They used to count as `STILL_RUNNING`.
- The report prompt lists what reached the user since the job ended. If the host noted a reply
  after the job ended and the report turn answers `NOTHING_OWED`, nothing is sent (event
  `report_skipped`); before, a fallback with the raw result followed the host's own message.
- The code-written report never shows raw JSON: the result's `text` or `summary`, else
  `<title> <status>.` (`finishJob` takes `summary`; `wrapJob` sets it).
- A first-line `NOTHING_OWED` followed by one short plain sentence is nothing; brackets and emoji
  around markers are ignored (`[STILL_RUNNING]` was sent as "[still running]").
- A normal reply joining a verify record resets its depth, so a normal chat never hits the verify
  cap.
- `timeZone` may be a function of the conversation.
- The quick start and the grammY and Agent SDK examples put user turns and `runTurn` through one
  queue per conversation; `isUserBusy` no longer uses `isChecking`. The README says the timers are
  unref'd, keeps the main option table short (the rest under "Advanced options"), and its
  simulation sample is the exact output of every run (the simulation now runs on a virtual clock).

## [0.4.0] - 2026-11-13

Fixes from a second independent review and from a replay of the v0.3 prompt on two real models.
The v0.4.1 prompt was replayed with Claude on 14 real cases (23/28 correct, 0 false alarms); see README Results.

### Changed

- **Missed notices have their own timer** (15 minutes, doubling to 6 hours) until they land or
  the host takes them with `flushMissed()`; no fresh model check after a give-up. The prompt lists
  them as "Failed to send - write it again if still needed", never as queued. One sender per
  conversation (they could go out twice).
- **The duplicate guard** only compares with copies delivered since the check last ran or in the
  last 10 minutes, plus queued and missed texts. Dated checks are never compared (a daily reminder
  was dropped on days 2 to 5); reports only against the same job.
- **Failed checks always take the recheck ladder**; they no longer park on an unrelated open job.
  `STILL_RUNNING` with an open job checks once more `delayMs` later, then parks.
- **The give-up line no longer claims a promise:** "I may have said I'd follow up on something,
  and I couldn't check it. Ask me if anything is still open." At most once per conversation per
  outage. All code-written lines go through `giveUpText(ctx)` with `ctx.reason` `failed`,
  `still_running`, `verify_capped`, `daily_cap` or `due_limit`.
- **Daily caps:** one code-written line per conversation per day when the cap is reached (it used
  to wait silently until UTC midnight); `dailyCapReserve` (10) keeps turns for window and dated
  checks.
- **`finishJob` and `wrapJob` resolve at once**; the report runs in the background (events
  `report_delivered`, `report_fallback`, `report_done`). A report is marked delivered in the store
  before it is sent, so a crash after the send never repeats it.
- **The delivered log lives with the store by default** (`<path>.delivered.json` next to a file
  store, a shared map in a memory store), so a restart does not resend what was delivered. File
  logs write on a 100 ms debounce and flush when the process exits.
- **State:** nothing is saved before `start()` has loaded (a note before it used to wipe the store);
  earlier notes are merged. Writes are debounced (`saveDebounceMs`, 100 ms) and `stop()` writes the
  final state synchronously when the store can; `stop()` now returns a promise. The file store
  saves atomically and asynchronously, never lets an older write land last, and takes a lock file
  that refuses a second live process. Store `version: 4`.
- **Parser:** code fences and `<think>` blocks are removed; markers count on the first line or among
  the last two, with a `Status:` label; all marker lines are stripped; `STILL_RUNNING` with `DUE`
  keeps both (the outcome `due` carries `running: true`); `DUE` is upper-case only, needs a zone,
  may sit in `<...>` with a short note; a first-line `NOTHING_OWED` followed by content, or
  `NOTHING_OWED except ...`, delivers the content; a STILL_RUNNING token in a sentence is sent as
  "still running"; contradicting markers keep the check open.
- **Prompt:** "Now (UTC): ..." or, with `timeZone`, "Now: <local> (<zone>), <UTC>"; DUE asked in UTC
  with `Z`; file entries like `[photo]` explained, no attachments from this turn, never claim a send
  that is not in the delivered list; "may be incomplete" when the send log does not reach back far
  enough.
- `noteDelivered` never throws into the host's send path.

### Added

- `callbackTimeoutMs` (30 s) for `deliver`, `isUserBusy`, `getDelivered`, `onJobFinished`,
  `onStartJobs` and the turn hooks; no turn slot is held while `isUserBusy` or `getDelivered`
  runs; a timed-out `deliver` goes to the outbox.
- Circuit breaker: `circuitFailures` (5), `circuitPauseMs` (15 min), `circuitMaxPauseMs` (2 h);
  events `circuit_open`, `circuit_closed`; `circuit()`.
- `maxDueDepth` (10) and `maxDatedPerConversation` (5); event `due_limit`.
- `globalDailyCap` (1000); event `global_daily_cap`.
- `maxConcurrentLimit` (8): turn slots grow by one per 25 waiting turns.
- `onTurnStart`, `onTurnEnd`, `isChecking()`.
- `isJunk` (default `isJunkReply()`): tool-call markup returned as text is a failed check.
- `timeZone`; `busyStuckMs` (30 min, event `busy_stuck`); `missedRetryMs`, `missedMaxRetryMs`;
  `idlePruneMs` (30 days); `saveDebounceMs`; `flush()`, `missed()`.
- The verify-chain cap sends a "no longer watched" line (once a day per conversation).
- No verify check after a delivery that also set a DUE timer.

## [0.3.0] - 2026-11-13 (not published)

Aimed at delivering every promise or telling the user plainly that it was not. A second review
found several ways it still lost or repeated messages; see 0.4.0.

### Changed

- **Failed checks come back.** A check turn that throws, returns empty, `...` or a `failTexts`
  entry, or times out now walks the same recheck ladder as `STILL_RUNNING` (it used to drop the
  debt). When the ladder runs out, the user gets a fixed code-written line (`giveUpText`).
- **The parser is strict about what it sends.** Markers count as the first or last line, in any
  case, with quotes, bold, code marks, punctuation or a short note around them. A reply under 200
  characters that mentions `NOTHING_OWED` is never sent. A first-line `STILL_RUNNING` with content is
  `deliver_running`. Job reports use the same parser.
- **The last check** (end of the ladder, and the job-timeout safety net) asks for a one-line status
  that says plainly the work is no longer watched, never "it will report". A last check that
  answers only `STILL_RUNNING` gets a code-written line instead of silence.
- **Report turns** are stored, wait for `isUserBusy`, retry like checks, and fall back to a
  code-written `<title> <status>: <first line of output>` when the turn fails or declines.
  `report_skipped` is replaced by `report_retry` and `report_fallback`.
- **Restarts:** jobs found in the store at `start()` finish as `lost` ("the work was interrupted by
  a restart") through the normal report path, unless `onStartJobs(jobs)` keeps them.
- **No delivering guard.** A normal `noteReply` during a package delivery is no longer dropped. The
  package recognizes its own text coming back, passes `{ kind, checkId, jobId }` to `deliver()`,
  and records its confirmed deliveries in the built-in delivered log itself.
- `noteReply` with kind `check` or `report` now schedules one verify check (it used to schedule
  nothing). New kinds `giveup`, `fallback`, `missed` only count.
- **Missed notices** keep the full text (was 120 characters), go out before package deliveries and
  through a fresh check scheduled after the give-up. `missedLength` is gone.
- Prompt texts longer than `maxTextLength` keep their first and last halves (was: the start only).
- The built-in delivered log treats the same text noted twice within a minute as one entry, and
  drops conversations idle longer than `maxAgeMs`.
- Store format `version: 3` adds `reports` and `turnsByDay`; `missed` holds arrays. v0.1 and v0.2
  stores load.

### Added

- Verify chain: every package delivery (check reply, split part, report, recovered retry) gets
  one follow-up check `delayMs` later, capped by `maxVerifyDepth` (3). Not after a last check.
- Dated promises: outcome `due` from a `DUE <ISO time>` line, alone or after content. Stored timer;
  at that time a check runs with the original replies. `maxDueMs` (30 days). `dated()`.
- `turnTimeoutMs` (3 min) with an `AbortSignal` in `ctx.signal`.
- `flushMissed(conversationId)` for the host to send owed `Missed:` notices before its next message.
- Queued deliveries and missed notices are listed in the check prompt ("do not write these
  again"), and an exact copy of a delivered or queued text is never sent (`duplicate_skipped`).
- The prompt shows the time now, and the newest `maxDeliveredInPrompt` (40) delivered messages with
  "(N older not shown)".
- `maxConcurrent` (2) model turns across conversations; `dailyCap` (60) turns per conversation per
  UTC day (`daily_cap`). One model turn per conversation per tick pass.
- `ctx.reason` on every turn: `window`, `recheck`, `verify`, `due`, `park_timeout` or `report`.
- Events: `verify_scheduled`, `verify_capped`, `dated`, `daily_cap`, `turn_timeout`,
  `duplicate_skipped`, `gave_up`, `job_lost`, `report_retry`, `report_fallback`.
- Methods `flushMissed()`, `dated()`, `reports()`. Exports `clipText()`, `defaultGiveUpText()`,
  `fallbackReportText()`.
- Scenario tests replaying each lost-promise timeline from the v0.2 review.

## [0.2.0] - 2026-11-13

### Changed

- **Fixed check window.** The first reply opens a window; the check fires `delayMs` later.
  Later replies join the list and never move the due time (they used to, which let a long
  conversation push an owed delivery back forever). The `merged` event keeps the unchanged `due`.
- Default `delayMs` is now 5 minutes (was 10). It is also the recheck delay.
- An overflowing reply list keeps reply 1 plus the newest `maxReplies - 1` (was: the newest only).
- The store now holds a versioned state object (`{ version: 2, records, counters, jobs, outbox,
  missed }`). v0.1 store files (a plain array) still load. Custom stores receive this object.
- `deliver()` counts as done only when it resolves. Throw when the platform did not confirm.
- `runTurn` context has `kind: 'check' | 'report'`.

### Added

- `noteUserMessage()` and `messageCount()`: a persisted per-conversation message counter. Each
  reply carries `seq`, and the prompt shows `(N messages back, <time>)` with a line asking the
  agent to look the promise up in its history.
- Split outcome `deliver_running`: a reply ending in a `STILL_RUNNING` line is delivered without
  that line and the same check is requeued. `parseCheckReply()` and `stripStillRunning()`.
- Job tracking: `trackJob()`, `finishJob()`, `wrapJob()`. A `STILL_RUNNING` check with an open
  job parks (no model wakes); when the job ends, one report turn is delivered (or `onJobFinished`
  is called), then the parked check runs once. `jobTimeoutMs` (default 2 h) safety net.
  `buildReportPrompt()`, `maxReportLength`.
- Delivery retry for check replies and reports: `retryMs` (5 min), `maxDeliveryAttempts` (12),
  `isPermanentError`, `err.retryAfterMs`, persisted attempt counts, a one-time `Missed:` line after
  a give-up. `deliver()` may return `{ ids }`.
- Back-off ladder for untracked work still running after `maxRechecks`: `backoffMs` (default 15,
  30, 60, 120 minutes); the last step asks for a one-line status and ends. Persists across
  restarts; `[]` disables it.
- Events: `parked`, `unparked`, `park_timeout`, `park_ended`, `job_tracked`, `job_finished`,
  `report_delivered`, `report_skipped`, `delivery_retry`, `delivery_recovered`, `delivery_failed`,
  `missed_notice`. `delivered` carries `ids` and `stillRunning`.
- Methods `parked()`, `jobs()`, `outbox()`.
- Scenario tests: whole timelines on a fake clock.

## [0.1.0] - 2026-11-13

### Added

- `createNothingOwed()`: one check per conversation per quiet period, merged across replies.
- Check prompt with the agent's replies and the host's delivered list (`buildPrompt`).
- Outcome parsing for `NOTHING_OWED`, `STILL_RUNNING`, delivery and failures (`parseOutcome`).
- `STILL_RUNNING` rechecks, capped (default 6), with a final one-line status check.
- Yield to a busy user (`isUserBusy`), silent failures, no re-arm from check replies.
- `createFileStore()` and `createMemoryStore()`; pending checks reload after a restart.
- Built-in delivered log (`createDeliveredLog()`), optionally file-backed, with edit-in-place by id.
- `onEvent` and `onUsage` hooks for logging and cost tracking.
- Examples: offline simulation, grammY transformer, Claude Agent SDK, Claude Code CLI.
- TypeScript definitions in `index.d.ts`.
