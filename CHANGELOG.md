# Changelog

## [0.31.0] - 2026-07-13

### Changed

- Accepted deterministic tool-output compaction whenever the candidate actually shrinks the input, matching upstream Headroom 0.31.0's `min_ratio = 1.0` acceptance gate instead of the previous 15% minimum savings floor.
- Kept the existing lossless-first async dispatch invariant: headroom-lite runs deterministic/lossless compression before any optional lossy service call.
- Switched verified lossless fold acceptance to the deterministic token estimator so folds that save tokens are kept even when they do not save characters.

### Added

- All HTTP responses now carry `x-headroom-implementation: headroom-lite` so callers can distinguish headroom-lite from upstream headroom at the protocol level. The `/v1/compress` response body also includes a `"service": "headroom-lite"` field. Upstream passthrough responses are byte-piped and left unstamped.
- Ported deterministic headroom v0.31.0 content-transform guards for headroom-lite:
  - diff filtering now normalizes mixed line endings and trailing hunk whitespace before returning kept diff sections;
  - JSON object-array compaction now passes ragged rows and nested object cells through instead of emitting misaligned or lossy CSV-schema output;
  - tool-output JSON compaction now detects whitespace-delimited JSON object sequences such as `{"a":1} {"b":2}`;
  - JSON array compaction accepts opt-in `auditSafe` / `protectedPatterns` options and fails closed when matching rows cannot be preserved verbatim.

### Fixed

- Hardened telemetry ledger locking so stale-lock takeover is atomic, owner-fenced, claim-cleaned, and lock release is owner-checked (Fixes #12).
- Preserved pending telemetry deltas across failed persisted-state writes so the next flush retries them (Fixes #13).
- Recorded `/v1/compress` telemetry for rejected/error responses via response-finish observation (Fixes #14).
- Opened the temp ledger file read/write (`r+`) before `fsync` so durable writes succeed on Windows, whose `FlushFileBuffers` requires a write-capable handle.
- Added temp-file `fsync` before atomic ledger-file rename plus best-effort parent-directory `fsync` after it (ported from headroom #1764).

### Not included

- Upstream A7/Kompress lossy-after-fold work is intentionally excluded because it is ML-based and outside headroom-lite's deterministic, zero-ML core scope.
- CJK-aware code symbol matching: skipped because headroom-lite has no deterministic code symbol/relevance extractor equivalent; the only code classifier is for the optional lossy path.
- Skipped headroom #1817/#1665/#1800: headroom-lite already keeps ledger persistence off the compress hot path, and has no cache-read savings or cache-write premium ledger fields to persist/adjust.

## [0.1.0] - 2026-07-10

Initial release.

### Added

- Standalone Node.js HTTP sidecar with:
  - `POST /v1/compress`
  - `GET /health`
  - `GET /livez`
- Zero-runtime-dependency deterministic compression pipeline composed from:
  - lossless compaction
  - cross-turn verbatim deduplication
  - adaptive recent-tail protection
- Ported tests for all three deterministic compression modules.
- End-to-end HTTP tests covering the sidecar contract and health endpoints.

### Notes

- Token counts are deterministic estimates derived from the JSON message payload.
- The server caps adaptive-sizer input to avoid routing very large conversations through the documented `O(n²)` simhash clustering path.

### Known issues

- `cross-turn-dedup.mjs`: pointer line numbers can overrun displayed content in a multi-fold-chain edge case. The inherited limitation comment is preserved in source and the issue remains open.
- `adaptive-sizer.mjs`: `countUniqueSimhash` still uses greedy `O(n²)` clustering. The inherited limitation comment is preserved in source; the live path currently mitigates this with an input-size cap rather than rewriting the algorithm.
