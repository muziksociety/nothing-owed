# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
