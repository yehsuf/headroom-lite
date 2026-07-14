# headroom-lite

`headroom-lite` is a small, MIT-licensed, deterministic reimplementation of the **safe** part of Headroom's compression value: text compaction and cross-turn deduplication, with **zero ML models**, **zero silent model downloads**, and **zero runtime npm dependencies**.

It exists for environments where a security review rejected model-scored prompt compression, but the deterministic parts of the idea were still useful.

## Installation

headroom-lite is published as a GitHub Package. Install via npm:

```bash
npm install -g @yehsuf/headroom-lite
```

Or pin to a version:
```bash
npm install -g @yehsuf/headroom-lite@0.3.0
```

Requires a GitHub token with `read:packages` permission:
```bash
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc
echo "@yehsuf:registry=https://npm.pkg.github.com" >> ~/.npmrc
```

### Running as a service

```bash
# Single-provider (legacy mode — unchanged from v0.3.0)
HEADROOM_LITE_UPSTREAM=https://api.anthropic.com headroom-lite

# Multi-provider — each provider gets its own upstream
HEADROOM_LITE_UPSTREAM_ANTHROPIC=https://api.anthropic.com \
HEADROOM_LITE_UPSTREAM_OPENAI=https://api.openai.com \
HEADROOM_LITE_UPSTREAM_GITHUB_MODELS=https://models.github.ai/inference \
headroom-lite

# Point Claude Code at it (Anthropic path)
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 claude

# Health check — now reports the full upstreams map
curl http://127.0.0.1:8790/health
```

## Why this exists

Some Headroom deployments are flagged not because *all* compression is risky, but because one ML-backed compression path can silently pull an unreviewed third-party model and use it to rewrite prompt content.

This repository takes the opposite approach:

- deterministic only
- no HuggingFace/runtime model downloads
- no model inference of any kind
- minimal attack surface
- auditable Node.js source

The goal is to keep the practical "shrink repetitive history" value while removing the specific model-based risk that triggered review concerns in the first place.

## What it does today

Phase 1 is a standalone HTTP sidecar compatible with the narrow `/v1/compress` contract already used by existing caller code.

Compression pipeline:

1. **Lossless compaction first**
   - strips ANSI escape sequences from logs
   - collapses repeated lines
   - headings-ifies grep-style search output
   - removes redundant `index ...` lines from diffs
   - groups repeated directory prefixes in path listings
2. **Cross-turn dedup second**
   - older large multiline payloads can be replaced with pointers to earlier identical spans
   - newest message is kept verbatim
   - system/developer instructions are never lossy-compressed
3. **Adaptive recent-tail protection**
   - as history gets longer and more diverse, a small recent slice of historical large payloads is also left untouched

Returned `tokens_before` / `tokens_after` values are deterministic estimates over the JSON message payload, not provider-billed token counts. That trade-off is intentional: it avoids pulling in heavyweight tokenizer dependencies.

## What it does **not** do

- It is **not** a full Claude Code / provider HTTP proxy yet.
- It does **not** implement ML-based compression, by design.
- It does **not** rewrite or compress SSE streams mid-flight.
- It does **not** duplicate higher-level tool filtering or tool-result outlining yet.

See [ROADMAP.md](./ROADMAP.md) for the full planned progression.

## Running

Requirements:

- Node.js 20+

Start the server:

```bash
npm start
```

Default bind:

- host: `127.0.0.1`
- port: `8790`

Loopback-only is the default. Set `HEADROOM_LITE_HOST` explicitly if you need
to bind anywhere else.

Environment variables:

- `HEADROOM_LITE_PORT` or `PORT` — listener port
- `HEADROOM_LITE_HOST` — listener host (default `127.0.0.1`)
- `HEADROOM_LITE_MAX_BODY_BYTES` — max accepted request body size in bytes (default `5242880`)
- `HEADROOM_LITE_STATS_PATH` — durable local telemetry ledger path (default `~/.headroom-lite/telemetry.json`)
- `HEADROOM_LITE_STATS_MAX_POINTS` — retained history point cap (default `720`; `0` disables retained points)
- `HEADROOM_LITE_STATS_MAX_AGE_DAYS` — retained history age cap in days (default `30`; `0` disables retained history)

### Local observability profile

All observability data stays local to the machine running headroom-lite. The
ledger stores aggregate counters and sanitized label totals only — never raw
request bodies, auth headers, prompts, tool output, or provider responses.

- Default retention: keep at most `720` retained history points and at most `30`
  days of retained history, whichever limit is hit first.
- Default durable path: `~/.headroom-lite/telemetry.json`
- Read-only default-path fallback: if that default path cannot be created,
  headroom-lite keeps serving `/health`, `/readyz`, `/stats`, `/stats-history`,
  and `/metrics` from an in-memory ledger and reports
  `capabilities.persistence: false`.

Capability meanings:

| Capability | Meaning |
|---|---|
| `snapshot` | Versioned aggregate snapshot fields are available on the JSON status endpoints. |
| `history` | `GET /stats-history` is supported. |
| `csv` | `GET /stats-history?format=csv` is supported. |
| `prometheus` | `GET /metrics` is supported. |
| `flush` | Hourly flush plus graceful-shutdown flush is enabled. |
| `persistence` | The telemetry ledger is backed by a local JSON file instead of the in-memory fallback. |

### Provider routing

headroom-lite routes proxy requests by URL path. Each provider has a dedicated upstream env var; all fall back to the legacy `HEADROOM_LITE_UPSTREAM` if the specific var is unset.

| Provider | Path pattern | Format | Env var |
|---|---|---|---|
| Anthropic | `/v1/messages*`, `/v1/complete*` | `anthropic` | `HEADROOM_LITE_UPSTREAM_ANTHROPIC` |
| OpenAI | `/v1/chat/completions`, `/v1/responses*` | `openai` | `HEADROOM_LITE_UPSTREAM_OPENAI` |
| GitHub Models (root) | `/chat/completions*` | `openai` | `HEADROOM_LITE_UPSTREAM_GITHUB_MODELS` |
| GitHub Models (Azure) | `/openai/deployments/{id}/chat/completions` | `openai` | `HEADROOM_LITE_UPSTREAM_GITHUB_MODELS` |
| Legacy fallback | any path | — | `HEADROOM_LITE_UPSTREAM` |

**Precedence:** provider-specific var > legacy `HEADROOM_LITE_UPSTREAM` > 404.

**Auth invariant (non-negotiable):** `Authorization`, `x-api-key`, and all other auth headers are forwarded **byte-for-byte** to the upstream. headroom-lite never reads, classifies, or rewrites them. Routing is path-only.

**`format` field for `/v1/compress` callers:** Anthropic callers must send `"format": "anthropic"` to preserve cache-anchor logic. OpenAI / GitHub Models callers should send `"format": "openai"` (disables frozen-prefix protection, which is Anthropic-only). The field defaults to `"anthropic"` when absent.

### Proxy compression (`HEADROOM_LITE_COMPRESS_PROXY`)

When `HEADROOM_LITE_COMPRESS_PROXY=true`, headroom-lite reads and compresses JSON request bodies before forwarding them. SSE responses are always raw byte-piped regardless of this flag.

### Live-zone compression (`HEADROOM_LITE_COMPRESS=live`)

> **Power-user override. Read this before enabling.**

By default, the most recent message in the conversation is never lossy-compressed (preserves TTFT quality and context freshness). Setting `HEADROOM_LITE_COMPRESS=live` removes this protection — every message in the live zone becomes eligible for cross-turn deduplication and adaptive compaction.

**What live mode still protects (always, regardless of this flag):**
- Anthropic frozen-prefix messages (cache_control markers) — byte-exact pass-through
- `system` and `developer` role messages — never lossy
- Tool argument payloads, signed content, cache_control subtrees

```bash
# Enable live-zone compression
HEADROOM_LITE_COMPRESS=live headroom-lite
```

Any value other than `live` (including `safe`, `true`, or absent) uses the default protected mode.

## HTTP API

| Endpoint | Purpose | Example |
|---|---|---|
| `POST /v1/compress` | Deterministic compression sidecar contract. | `curl -s http://127.0.0.1:8790/v1/compress -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'` |
| `GET /health` | Health snapshot plus routing/config summary. | `curl -s http://127.0.0.1:8790/health` |
| `GET /readyz` | Readiness snapshot plus capability flags. | `curl -s http://127.0.0.1:8790/readyz` |
| `GET /livez` | Process liveness check. | `curl -s http://127.0.0.1:8790/livez` |
| `GET /stats` | Legacy flat counters plus versioned telemetry snapshot. | `curl -s http://127.0.0.1:8790/stats` |
| `GET /stats-history` | Retained aggregate history as JSON or CSV. | `curl -s 'http://127.0.0.1:8790/stats-history?series=hourly&format=json'` |
| `GET /metrics` | Prometheus exposition for the same local aggregates. | `curl -s http://127.0.0.1:8790/metrics` |
| Provider proxy routes | Transparent passthrough to configured upstreams. | `curl -s http://127.0.0.1:8790/v1/messages -H 'content-type: application/json' -d '{...}'` |

### `POST /v1/compress`

Request body:

```json
{
  "messages": [...],
  "format": "anthropic",
  "model": "claude-sonnet"
}
```

Response body:

```json
{
  "messages": [...],
  "tokens_before": 1234,
  "tokens_after": 987
}
```

Example:

```bash
curl -s http://127.0.0.1:8790/v1/compress \
  -H 'content-type: application/json' \
  -d '{
    "format":"openai",
    "model":"gpt-5",
    "messages":[
      {"role":"assistant","content":"line one\nline one\nline one\n"},
      {"role":"user","content":"Summarize that output."}
    ]
  }'
```

### Status and observability endpoints

- `GET /health`
  - Returns `status`, `service`, `schema_version`, `mode`, `max_body_bytes`,
    `compress_live`, the full `upstreams` map, `capabilities`, and `lossy`.
  - Legacy compatibility: `upstream` is still returned for one migration window
    alongside `upstreams`.
- `GET /readyz`
  - Returns `status: "ready"`, `service`, `schema_version`, and
    `capabilities`.
- `GET /livez`
  - Returns `status: "alive"` and `service`.
- `GET /stats`
  - Returns the versioned telemetry snapshot plus the legacy flat fields
    `uptime_seconds`, `proxy_requests`, `compress_requests`,
    `compress_tokens_before`, `compress_tokens_after`,
    `compress_tokens_saved`, and `compress_pct`.
- `GET /stats-history`
  - Accepts only `series` and `format` query parameters.
  - `series` must be one of `history`, `hourly`, `daily`, `weekly`, or
    `monthly` (`history` is an alias for the default hourly buckets).
  - `format` must be `json` or `csv`.
  - JSON responses include `schema_version`, `status`, `service`, `series`,
    and `rows`.
  - CSV responses use `series,bucket_start,value`.
- `GET /metrics`
  - Returns Prometheus text for the same aggregate-only counters and label
    totals exposed by `/stats`.

## Lossy Compression (Optional)

headroom-lite ships an optional lossy compression stage powered by
[LLMLingua-2](https://github.com/microsoft/LLMLingua). When enabled, a
separate Python microservice (`headroom-lingua-service`) classifies and
removes low-information tokens from message history — applied only to
content outside the frozen cache prefix, so cached tokens are never touched.

Lossless compression (dedup, tool-output compaction, JSON minification) always
runs first. Lossy compression is strictly opt-in:

```bash
# Start the Python service (separate process)
python -m headroom_lingua_service --port 8791 --backend llmlingua2

# Enable in headroom-lite
HEADROOM_LITE_LOSSY=1 node src/server.mjs
```

Full guide, env reference, and macOS launchd setup: **[docs/llmlingua.md](./docs/llmlingua.md)**

## Development

Run tests:

```bash
npm test
```

## Known issues

These are inherited from the already-ported deterministic modules and are **not** hidden here:

1. **cross-turn pointer line numbers can drift in a multi-fold-chain edge case.**  
   Specifically, pointer ranges can overrun the displayed text of a previously folded block.
2. **adaptive simhash clustering is still `O(n²)` on diverse input.**  
   The live path mitigates this with an input-size cap before calling the adaptive sizer, but the underlying module still needs a real LSH/bucketing upgrade before claiming large-scale production readiness.

Those limitations are also tracked in [CHANGELOG.md](./CHANGELOG.md).

## Roadmap summary

- **Phase 1:** deterministic `/v1/compress` sidecar — built
- **Phase 2:** full provider-facing proxy with cache-aligned prefix freezing and careful auth passthrough — built
- **Phase 2.1:** multi-provider routing (Anthropic, OpenAI, GitHub Models) — built
- **Phase 3:** optional standalone BM25 tool filtering and ast-grep-based large tool-result outlining

Details: [ROADMAP.md](./ROADMAP.md)

## License

[MIT](./LICENSE)
