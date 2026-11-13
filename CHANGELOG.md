# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
