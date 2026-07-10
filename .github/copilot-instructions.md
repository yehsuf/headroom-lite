<!-- CONSTITUTION v1 — Stable project context for GitHub Copilot CLI.
     Only stable facts belong here. Volatile state goes in the compact hint. -->

# headroom-lite

## Identity
- name: headroom-lite
- repo: yehsuf/headroom-lite
- purpose: Zero-ML, zero-dependency Node.js standalone HTTP proxy that deterministically compresses LLM context and forwards to upstream providers (Anthropic, OpenAI).

## Architecture invariants
- Zero external runtime npm dependencies.
- Authorization, x-api-key, x-goog-api-key headers forwarded byte-for-byte — never read, classified, or rewritten under any circumstance.
- SSE (text/event-stream) responses are always raw byte-piped — never buffered, never reparsed.
- Hop-by-hop headers stripped both directions per RFC 7230 §6.1, including dynamic Connection-header tokens.
- Client disconnect aborts upstream request immediately (socket.on('close') + !writableEnded guard).
- Messages with cache_control markers (frozen prefix) are never compressed — byte-exact pass-through.
- Compression transforms are deterministic and lossless — same input always produces same output.
- No ML models anywhere in the codebase.

## Standing rules
- Never act without explicit per-action approval for any repo/service/machine change.
- Every non-trivial change: implement → test → 3-model code review → fix → merge.
- Parallel agents MUST use separate git worktrees, never share a checkout directory.
- All tests must pass (node --test test/**/*.test.mjs) before merge.

## Technology
- Language / runtime: Node.js >=20, ESM only (.mjs extensions)
- Test command: node --test test/**/*.test.mjs
- Package: @yehsuf/headroom-lite, published to GitHub Packages on v* tag push
- Entry point: src/index.mjs (headroom-lite CLI)
- Server port default: 8790

## Key file map
- src/server.mjs — HTTP server, routing, handleCompress, feature flag resolution
- src/proxy.mjs — transparent HTTP reverse proxy (auth opaque, SSE raw-piped, RFC 7230)
- src/compress/pipeline.mjs — full compression pipeline entry point
- src/compress/frozen-prefix.mjs — cache_control marker detection (cache safety gate)
- src/compress/lossless-compaction.mjs — diff/log/search/text compactors
- src/compress/cross-turn-dedup.mjs — cross-turn deduplication with pointer text
- src/compress/adaptive-sizer.mjs — knee-detection for recent-message protection
- src/normalize/tools.mjs — tool definition normalization (sort alphabetically)
- src/analyze/volatile-detector.mjs — detects ISO timestamps, UUIDs, ID fields in frozen prefix
- src/analyze/drift-detector.mjs — SHA-256 session drift detector (10k session LRU cap)
