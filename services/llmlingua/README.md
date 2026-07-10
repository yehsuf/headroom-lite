# headroom-lingua-service

LLMLingua compression microservice for **headroom-lite**. A small stdlib HTTP
service (no framework dependencies for the stub) that the Node.js
`headroom-lite` client calls to compress oversized message content when
approaching the model context limit.

## Status

- **PR2 (this)** — stub service scaffolding. `StubBackend` deterministic
  compression only. `LLMLingua2Backend` / `SecurityLinguaBackend` are
  placeholders raising `NotImplementedError`.
- **PR3** — wire up real `microsoft/llmlingua-2-*` via the `llmlingua`
  package (optional install).
- **PR4** — wire up SecurityLingua.

## Install

```bash
cd services/llmlingua
pip install -e ".[dev]"           # stub + tests
pip install -e ".[llmlingua2]"    # PR3+, pulls llmlingua package
```

## Run

```bash
headroom-lingua                                     # 127.0.0.1:8791, stub
headroom-lingua --backend stub --port 8791
HEADROOM_LITE_LOSSY_BACKEND=stub headroom-lingua
```

Environment:

- `HEADROOM_LINGUA_HOST` (default `127.0.0.1`)
- `HEADROOM_LINGUA_PORT` (default `8791`)
- `HEADROOM_LITE_LOSSY_BACKEND` — `stub` | `llmlingua2` | `securitylingua`
- `HEADROOM_LITE_LOSSY_MODEL` — HF model id

## API

### `GET /health`

```json
{
  "status": "ok",
  "backend": "stub",
  "model_name": "microsoft/llmlingua-2-...",
  "model_loaded": true
}
```

### `POST /v1/compress-texts`

Request:

```json
{
  "backend": "stub",
  "model_name": "microsoft/llmlingua-2-...",
  "target_rate": 0.5,
  "items": [
    { "id": "m0:text", "text": "...", "kind": "prose" }
  ]
}
```

Response:

```json
{
  "items": [
    {
      "id": "m0:text",
      "text": "...compressed...",
      "compressed": true,
      "original_chars": 1000,
      "compressed_chars": 500
    }
  ],
  "backend": "stub",
  "model_name": "microsoft/llmlingua-2-...",
  "model_loaded": false
}
```

`kind` is a hint — `prose | log | stack_trace | code`. The stub ignores it;
real backends may switch prompts/params on it.

## Tests

```bash
cd services/llmlingua
pip install -e ".[dev]"
python -m pytest tests/ -v
```
