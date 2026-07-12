# Task 2 Report

- Status: DONE_WITH_CONCERNS
- Commit(s): `a81c497` (`feat: expose headroom compatible telemetry endpoints`)

## Files changed
- `src/server.mjs`
- `test/server.test.mjs`
- `.superpowers/sdd/task-2-report.md` (report only; written after the code commit)

## TDD / test execution
1. Initial red phase:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: FAIL — missing `/readyz`, `/stats-history`, `/metrics`, versioned `/stats` fields, and proxy/compression telemetry integration (`7` failed, `4` passed).
2. Red phase for history persistence regression:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: FAIL — `/stats-history?series=hourly` stayed empty after a successful `/v1/compress` request (`1` failed).
3. Red phase for server-scoped flat stats regression:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: FAIL — a second server instance reported another server's flat `compress_requests` counter (`1` failed).
4. Red phase for upstream 5xx proxy outcome regression:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: FAIL — upstream `503` responses were recorded as `ok` instead of `error` (`1` failed).
5. Final targeted verification:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
   - Result: PASS — `14` tests passed, `0` failed.
6. Final full-suite verification:
   - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
   - Result: PASS — `406` tests passed, `0` failed, `0` skipped.

## Diff inspected
- Reviewed the final `git diff --stat -- src/server.mjs test/server.test.mjs` and full `git diff -- src/server.mjs test/server.test.mjs` output before commit.

## Concerns
- Default `createServer()` / `startServer()` calls without an injected `telemetryLedger` still share a process-global default ledger/state bundle, so multiple default servers in the same process can share observability data; injected-ledger servers are isolated and covered by regression tests.
- This report was written after commit `a81c497`, so it is intentionally not included in the committed task diff.

## Review Fix
- Commit: `bb85261` (`fix: isolate default server telemetry state`)
- Findings addressed:
  1. Default `createServer()` / `startServer()` instances now create isolated telemetry ledger and legacy stats state bundles while preserving injected-ledger behavior.
  2. `GET /stats-history` now rejects unexpected query keys instead of only rejecting invalid `format` / `series` values.
- TDD / verification:
  1. Red phase:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
     - Result: FAIL — `/stats-history?series=hourly&unexpected=1` returned `200`, and a second default `startServer()` instance observed shared compression counters from the first default server (`2` failed, `13` passed).
  2. Final targeted verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
     - Result: PASS — `15` tests passed, `0` failed.
  3. Final full-suite verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
     - Result: PASS — `407` tests passed, `0` failed, `0` skipped.
- Diff inspected:
  - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && git --no-pager diff --stat -- src/server.mjs test/server.test.mjs && git --no-pager diff -- src/server.mjs test/server.test.mjs`

## Concurrency and History Fix
- Findings addressed:
  1. Default servers that share `HOME` and the default telemetry path now merge their unflushed session deltas into the latest persisted lifetime/history snapshot instead of clobbering one another on close.
  2. `GET /stats-history?series=hourly` now coalesces persisted and pending rows with the same `series` + `bucket_start` into a single canonical row for both JSON and CSV responses.
- TDD / verification:
  1. Red phase:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
     - Result: FAIL — persisted hourly history returned duplicate `compression.requests` rows for the same bucket, and a second default server zeroed the shared lifetime aggregate after both default servers closed (`15` passed, `2` failed).
  2. Final targeted verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/server.test.mjs`
     - Result: PASS — `17` tests passed, `0` failed.
  3. Final full-suite verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
     - Result: PASS — `409` tests passed, `0` failed, `0` skipped.
- Diff inspected:
  - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && git --no-pager diff --stat -- src/server.mjs src/observability/ledger.mjs test/server.test.mjs .superpowers/sdd/task-2-report.md && git --no-pager diff -- src/server.mjs src/observability/ledger.mjs test/server.test.mjs .superpowers/sdd/task-2-report.md`

## Final Compatibility Fix
- Findings addressed:
  1. `getStats()` without arguments once again reads from a stable live module-level legacy stats state instead of allocating a fresh zeroed snapshot per call, while each server instance still keeps explicit isolated `statsState`.
  2. Durable telemetry flushes now serialize the load/merge/write/rename critical section with a dependency-free inter-process lock, bounded retry/timeout, stale-lock recovery, and atomic rename-preserved writes so concurrent Node processes do not lose either delta.
- TDD / verification:
  1. Red phase:
       - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/observability-ledger.test.mjs && node --test test/server.test.mjs`
       - Result: FAIL — the new multiprocess ledger regression persisted only one process delta, and the no-argument `getStats()` regression stayed pinned at `uptime_seconds === 0` instead of advancing (`31` passed, `2` failed).
  2. Final targeted verification:
       - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/observability-ledger.test.mjs && node --test test/server.test.mjs`
       - Result: PASS — `33` tests passed, `0` failed.
  3. Final full-suite verification:
       - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
       - Result: PASS — `411` tests passed, `0` failed, `0` skipped.
- Diff inspected:
  - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && git --no-pager diff --stat -- src/server.mjs src/observability/ledger.mjs test/server.test.mjs test/observability-ledger.test.mjs .superpowers/sdd/task-2-report.md && git --no-pager diff -- src/server.mjs src/observability/ledger.mjs test/server.test.mjs test/observability-ledger.test.mjs .superpowers/sdd/task-2-report.md`

## Lock and Query Fix
- Findings addressed:
  1. Persistence locks now record the owning PID and heartbeat under the lock directory, so contenders only reclaim stale locks when the recorded owner is gone instead of stealing from a healthy holder that runs longer than five seconds.
  2. `GET /stats-history` now defaults `series` only when the query key is absent; explicit empty or whitespace-only `series` values return the existing `400` validation error.
- TDD / verification:
  1. Red phase:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/observability-ledger.test.mjs && node --test test/server.test.mjs`
     - Result: FAIL — the renewed-lock contender regression entered while the holder was still past the stale threshold, and empty / whitespace `series` values were accepted instead of rejected.
  2. Final targeted verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && node --test test/observability-ledger.test.mjs && node --test test/server.test.mjs`
     - Result: PASS — `34` tests passed, `0` failed.
  3. Final full-suite verification:
     - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && npm test`
     - Result: PASS — `412` tests passed, `0` failed, `0` skipped.
- Diff inspected:
  - Command: `cd /Users/ysufrin/Work/headroom-lite-wt-feat-observability-endpoints && git --no-pager diff --stat -- src/observability/ledger.mjs src/server.mjs test/observability-ledger.test.mjs test/server.test.mjs .superpowers/sdd/task-2-report.md && git --no-pager diff -- src/observability/ledger.mjs src/server.mjs test/observability-ledger.test.mjs test/server.test.mjs .superpowers/sdd/task-2-report.md`
