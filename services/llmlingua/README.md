# headroom-lingua-service

LLMLingua compression microservice for **headroom-lite**. A small stdlib HTTP
service (no framework dependencies for the stub) that the Node.js
`headroom-lite` client calls to compress oversized message content when
approaching the model context limit.

For the full integration guide, env reference, and macOS launchd setup, see
[`docs/llmlingua.md`](../../docs/llmlingua.md).

## Status

- **PR2** — stub service scaffolding. `StubBackend` deterministic
  compression only. `LLMLingua2Backend` / `SecurityLinguaBackend` are
  placeholders raising `NotImplementedError`.
- **PR3** — wire up real `microsoft/llmlingua-2-*` via the `llmlingua`
  package (optional install).
- **PR4** — wire up SecurityLingua.
- **PR5 (this)** — documentation: integration guide, env reference, launchd example.

## Install

### Stub only (no ML dependencies):

```bash
cd services/llmlingua
pip install -e ".[dev]"
```

### With real LLMLingua-2 model (CPU-only recommended for a proxy):

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install llmlingua==0.2.2
cd services/llmlingua
pip install -e ".[llmlingua2]"
```

### With SecurityLingua (PR4, git-only):

```bash
pip install git+https://github.com/microsoft/LLMLingua.git
```

## Run

```bash
# Stub backend (no model required)
headroom-lingua                                     # 127.0.0.1:8791, stub
headroom-lingua --backend stub --port 8791
HEADROOM_LITE_LOSSY_BACKEND=stub headroom-lingua

# Real LLMLingua-2 backend
headroom-lingua --backend llmlingua2 --port 8791

# Pre-warm model on startup (avoids cold start on first request)
headroom-lingua --backend llmlingua2 --prewarm
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_LINGUA_HOST` | `127.0.0.1` | Bind address |
| `HEADROOM_LINGUA_PORT` | `8791` | Bind port |
| `HEADROOM_LITE_LOSSY_BACKEND` | `stub` | `stub` \| `llmlingua2` \| `securitylingua` |
| `HEADROOM_LITE_LOSSY_MODEL` | (bert-base-multilingual) | HuggingFace model ID |
| `RUN_LLMLINGUA_MODEL_TESTS` | (unset) | Set to `1` to run real model smoke tests |

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
