# headroom-lite roadmap

This repository is intentionally narrow in Phase 1: ship a deterministic, auditable replacement for Headroom's stateless `/v1/compress` sidecar contract first, then decide whether the extra complexity of a full proxy is worth it.

## Phase 1 — deterministic `/v1/compress` sidecar (built now)

**Status:** implemented in this repository  
**Complexity:** medium  
**Expected ongoing effort:** low-to-medium maintenance

Delivered scope:

- Standalone HTTP server using Node built-ins only.
- `POST /v1/compress` compatible with the existing sidecar caller contract:
  - request: `{ "messages": [...], "format": "...", "model": "..." }`
  - response: `{ "messages": [...], "tokens_before": <int>, "tokens_after": <int> }`
- `GET /health` and `GET /livez` for operational parity with existing Headroom health checks.
- Deterministic compression pipeline:
  1. format-aware lossless compaction on large text-bearing fields
  2. cross-turn deduplication on older large multiline payloads
  3. adaptive protection of the most recent historical payloads as conversation diversity rises
- Zero external runtime dependencies.
- Node built-in test coverage for algorithm modules and the HTTP surface.

Phase 1 intentionally does **not** attempt to proxy provider traffic directly. It is a sidecar only.

## Phase 2 — full API proxy for direct Claude Code / provider traffic (planned)

**Status:** planned, not built  
**Complexity:** high  
**Estimated effort:** several focused days for a careful prototype; 1-2+ weeks to harden

Required capabilities:

- Full request/response passthrough so callers can point `ANTHROPIC_BASE_URL` (or equivalent) at headroom-lite directly.
- Prompt-cache alignment logic:
  - freeze the stable prefix once earlier turns are written
  - only mutate the tail on later requests
  - preserve the "freeze stable prefix, mutate the tail" strategy that keeps provider prompt-cache hit rates high
- SSE streaming passthrough with **no** mid-stream compression. Streaming responses should be forwarded untouched; compressing partial streams is unsafe.
- Careful authentication passthrough:
  - if the inbound request already carries a valid provider bearer token, pass it through unchanged
  - do **not** strip it and attempt a subscription/BYOK token exchange
  - this avoids repeating the auth-regression class fixed upstream in `headroomlabs-ai/headroom#1879`
- Configuration for upstream base URLs, loopback bind/port, request size limits, and optional per-provider behavior toggles.
- Operational hardening:
  - request/response logging policy
  - timeout strategy
  - graceful shutdown
  - observability around compression savings vs. cache-hit preservation

Open design question for Phase 2:

- Should cache-state be global per process, or isolated per client/session to avoid unrelated request streams fighting over the frozen prefix?

## Phase 3 — optional higher-level prompt optimizations (future ideas)

**Status:** exploratory  
**Complexity:** medium to high depending on scope  
**Estimated effort:** 1+ weeks if both features are pursued seriously

Candidate features:

- **BM25-style tool-definition filtering**
  - Useful only if headroom-lite needs to operate fully standalone.
  - Open question: duplicate this here, or leave tool filtering to upstream caller stacks that already do it well?
  - Myelin already has its own `tool_filter.py`, so duplicating it here should be an explicit product decision, not an assumption.
- **ast-grep-based outlining of large tool results**
  - Similar in spirit to Headroom's `intercept_tool_results`.
  - Could compress massive read/test outputs before they ever reach the prompt.
  - Needs careful language-aware fallbacks and "never break the current task" guardrails.
- **Lossless-verified compaction of the current (latest) turn** _(optional, low priority)_
  - Today `compactToolOutputs` skips the latest message entirely, and this is
    deliberate: the compaction is lossy in the general case — object→CSV drops
    keys outside the ≥60% dominant set and flattens nested values to
    `[object Object]`, and the string/number-array paths elide middle items
    (`[N items omitted]`). Corrupting the fresh tool output the model is
    actively reasoning about is worse than leaving it uncompacted.
  - Idea: allow **only provably reversible** object-array→CSV compaction on the
    latest turn, gated by a strict round-trip check (CSV → inverse-parse →
    deep-equal the original array). Any mismatch, non-uniform schema, nested
    value, or string/number array falls back to the current skip.
  - Requires a new CSV **inverse parser** (does not exist yet) plus the
    round-trip guard.
  - Benefit is narrow: it only helps a uniform, scalar-only object array that
    lands as the very last message (measured ~0% today vs ~71% when the same
    array is historical). This shape is rare in real agent traffic, so treat it
    as polish, not a priority.

Open questions for Phase 3:

- Should tool-result outlining run inline on every request, or only above strict size thresholds?
- Should language-aware outlining be opt-in per repository, or always on once ast-grep is available?

## Priority recommendation

If this repo is only meant to replace the current Copilot-sidecar call path, Phase 1 is already the right stopping point.  
Only start Phase 2 if there is a real need to make headroom-lite the direct provider-facing proxy.  
Treat Phase 3 as optional polish after Phase 2 proves necessary.
