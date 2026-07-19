# Changelog

## [0.31.0-3] - 2026-07-19

### Fixed

- **Cache key collision with multiple system messages** — `extractSystemText()` used `messages.find()` and only hashed the first system message. Pipelines that inject a second system message (per-request context block) produced identical cache keys when the first message was shared. Fix: collect all system messages with `filter()`, join in order with `\u0000` (NUL — cannot appear in normal prompt text, eliminating boundary-collision ambiguity). Order matters — swapping two system messages now produces different keys (ports upstream headroom GH #1827).

## [0.31.0-2] - 2026-07-19

### Added

- **Space-separated JSON sequence minification** — `minifyJson()` now handles whitespace-delimited JSON object sequences such as `{"id":1} {"id":2}` (common in SerpAPI/Tavily tool results). Previously `JSON.parse` failed on these and 0% compression was applied. Fix: on `JSON.parse` failure, falls through to `minifyJsonSequence()` which strips internal whitespace from each object in the sequence and rejoins with a single space. Lossless (ports upstream headroom GH #1742). Works for sequences of any count ≥2 — not subject to the >9-item array gate in Phase 2 CSV compaction.

## [0.31.0-1] - 2026-07-17

### Added

- **`GET /favicon.ico` → 204 No Content** — answered locally, never proxied to the upstream LLM provider (ports upstream headroom GH #1787).
- **`HEADROOM_LITE_MIN_TOKENS` env var** — when set to N > 0, `/v1/compress` skips compression and returns messages as-is if the estimated token count ≤ N. Default: 0 (always compress). Mirrors upstream `HEADROOM_MIN_TOKENS` semantics.
- **`tokens_saved` and `compression_ratio` in `/v1/compress` response** — parity with upstream headroom API contract. `compression_ratio = tokens_after / tokens_before` (< 1.0 = compressed, 1.0 = unchanged/skipped).

### Fixed

- **Stream-lock release on client disconnect** — `inboundRes.destroy()` is now called in `onClientSocketClose` so the response socket is cleaned up when the client drops mid-stream. Without this fix, `upstreamRes.destroy()` does not trigger `end` on the pipe target, leaving SSE/keep-alive response sockets open indefinitely after the client disconnects.
- **Graceful-shutdown idle-connection drain** — `closeIdleConnections()` is now called immediately after `server.close()` (not before) so Node stops accepting new connections before sweeping idle keep-alive sockets. Ensures `closeAndFlushTelemetry` resolves promptly on shutdown without hanging on in-flight requests.

### Not included (scope)

- TOIN/CCR pattern store — ML, out of scope for headroom-lite's deterministic core.

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
