# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-13

Every promise is delivered, or the user is told plainly that it was not.

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
