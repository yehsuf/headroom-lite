# Task 3 Report

- Status: DONE
- Commit(s): `3192931` (`feat: configure durable observability retention`)

## Files changed
- `README.md`
- `src/index.mjs`
- `src/server.mjs`
- `test/server.test.mjs`
- `.superpowers/sdd/task-3-report.md` (report only; written after the code commit)

## TDD / test execution
1. Red phase:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: FAIL — the new default-telemetry env-config test failed because `resolveStatsPath` / retention resolvers were not exported or wired yet (`1` failed, `21` passed).
2. Final targeted verification:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: PASS — `22` tests passed, `0` failed.
3. Final full-suite verification:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
   - Result: PASS — `416` tests passed, `0` failed, `0` skipped.

## Diff inspected
- Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && git --no-pager diff --stat -- src/index.mjs src/server.mjs README.md test/server.test.mjs && git --no-pager diff -- src/index.mjs src/server.mjs README.md test/server.test.mjs`

## Notes
- Added validated `HEADROOM_LITE_STATS_PATH`, `HEADROOM_LITE_STATS_MAX_POINTS`, and `HEADROOM_LITE_STATS_MAX_AGE_DAYS` handling for default telemetry creation while preserving the Task 2 default-path in-memory fallback.
- Exposed a close-safe server telemetry flush path so CLI shutdown can await the ledger flush before closing the HTTP server.
- Documented the full local observability endpoint profile, retention defaults, legacy compatibility fields, and capability semantics.

## Concerns
- None.

## Telemetry Path Fix

- Normalized `HEADROOM_LITE_STATS_PATH` so leading `~/` expands via `homedir()` and explicit resolved-default paths still qualify for the default in-memory fallback when persistence setup fails.
- Added regressions covering the explicit resolved-default fallback and `~/` expansion, including a guard that no literal workspace `~/` directory is created.

## Shutdown Drain Fix

- Root cause: CLI shutdown flushed telemetry before `server.close()` drained in-flight proxy responses, so `response.finish` telemetry for delayed requests could arrive after the pre-close flush and never persist.
- Replaced the pre-close override with a close-safe server API: `server.flushTelemetry()` for explicit best-effort snapshots and idempotent `server.closeAndFlushTelemetry()` for awaited shutdown drains plus the final post-close flush.
- Preserved signal handling while updating CLI shutdown to await `closeAndFlushTelemetry()`, and added a regression that starts shutdown during an in-flight delayed proxy request and verifies the persisted lifetime proxy telemetry after restart.
