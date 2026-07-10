# headroom-lite

`headroom-lite` is a small, MIT-licensed, deterministic reimplementation of the **safe** part of Headroom's compression value: text compaction and cross-turn deduplication, with **zero ML models**, **zero silent model downloads**, and **zero runtime npm dependencies**.

It exists for environments where a security review rejected model-scored prompt compression, but the deterministic parts of the idea were still useful.

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

Environment variables:

- `HEADROOM_LITE_PORT` or `PORT` — listener port
- `HEADROOM_LITE_HOST` — listener host (default `127.0.0.1`)
- `HEADROOM_LITE_MAX_BODY_BYTES` — max accepted request body size in bytes (default `5242880`)

## HTTP API

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

### `GET /health`

Readiness-style JSON response.

### `GET /livez`

Liveness-style JSON response.

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

- **Phase 1:** deterministic `/v1/compress` sidecar — built now
- **Phase 2:** full provider-facing proxy with cache-aligned prefix freezing and careful auth passthrough
- **Phase 3:** optional standalone BM25 tool filtering and ast-grep-based large tool-result outlining

Details: [ROADMAP.md](./ROADMAP.md)

## License

[MIT](./LICENSE)
