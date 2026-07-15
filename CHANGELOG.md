# Changelog

## [0.31.0] - 2026-07-13

### Changed

- Accepted deterministic tool-output compaction whenever the candidate actually shrinks the input, matching upstream Headroom 0.31.0's `min_ratio = 1.0` acceptance gate instead of the previous 15% minimum savings floor.
- Kept the existing lossless-first async dispatch invariant: headroom-lite runs deterministic/lossless compression before any optional lossy service call.
- Switched verified lossless fold acceptance to the deterministic token estimator so folds that save tokens are kept even when they do not save characters.

### Not included

- Upstream A7/Kompress lossy-after-fold work is intentionally excluded because it is ML-based and outside headroom-lite's deterministic, zero-ML core scope.

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
