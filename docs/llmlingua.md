# LLMLingua Lossy Compression — headroom-lite Integration

## What it does

LLMLingua-2 is a token-classification model that compresses prompts by removing
low-information tokens while preserving meaning. headroom-lite applies it ONLY to
messages outside the frozen cache prefix (the part Anthropic/OpenAI has already
cached — compressing those would corrupt the cache and negate all savings).

Lossless compression (dedup, tool-output compaction, JSON minification) always
runs first. Lossy compression is an additional opt-in stage.

## Prerequisites

- Python 3.10+
- ~700 MB disk for the BERT-base model
- headroom-lite running (node :8790)

## Install

### CPU-only (recommended for a proxy):

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install llmlingua==0.2.2
```

### For SecurityLingua (PR4, git-only):

```bash
pip install git+https://github.com/microsoft/LLMLingua.git
```

## Start the service

```bash
python -m headroom_lingua_service --port 8791 --backend llmlingua2

# Or with pre-warming (avoids cold start on first request):
python -m headroom_lingua_service --port 8791 --backend llmlingua2 --prewarm
```

## Enable in headroom-lite

```bash
HEADROOM_LITE_LOSSY=1 node src/server.mjs
```

## All env vars

### headroom-lite (Node.js side):

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_LITE_LOSSY` | `0` | `1` = enable lossy compression stage |
| `HEADROOM_LITE_LOSSY_SERVICE_URL` | `http://127.0.0.1:8791` | Python service URL |
| `HEADROOM_LITE_LOSSY_BACKEND` | `llmlingua2` | `stub` / `llmlingua2` / `securitylingua` |
| `HEADROOM_LITE_LOSSY_MODEL` | `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` | HuggingFace model ID |
| `HEADROOM_LITE_LOSSY_RATE` | `0.5` | `0.5` = keep 50% of tokens (2× compression) |
| `HEADROOM_LITE_LOSSY_TIMEOUT_MS` | `1500` | Abort if service takes longer |
| `HEADROOM_LITE_LOSSY_MIN_CHARS` | `1000` | Skip texts shorter than this |
| `HEADROOM_LITE_LOSSY_MAX_CHARS` | `60000` | Skip texts longer than this (prevent tail discard) |
| `HEADROOM_LITE_LOSSY_MAX_BATCH_CHARS` | `120000` | Total chars per batch |
| `HEADROOM_LITE_LOSSY_FAIL_CLOSED` | `0` | `1` = fail request if service unavailable |
| `HEADROOM_LITE_LOSSY_CODE` | `0` | `1` = also compress code/diff blocks (risky) |

### headroom-lingua-service (Python side):

| Variable | Default | Description |
|---|---|---|
| `HEADROOM_LINGUA_HOST` | `127.0.0.1` | Bind address |
| `HEADROOM_LINGUA_PORT` | `8791` | Bind port |
| `HEADROOM_LITE_LOSSY_BACKEND` | `stub` | Backend to use (`stub`/`llmlingua2`/`securitylingua`) |
| `HEADROOM_LITE_LOSSY_MODEL` | (bert-base-multilingual) | Model ID |
| `RUN_LLMLINGUA_MODEL_TESTS` | (unset) | Set to `1` to run real model smoke tests |

## Safety invariants

- Frozen prefix (`cache_control` messages) is **never** compressed
- `tool_use` input / arguments / `partial_json` is **never** compressed
- `role=tool` and `role=function` (OpenAI tool responses) are **never** compressed
- Signed thinking blocks are **never** compressed
- `system` and `developer` roles are **never** compressed
- Texts > 60 KB are skipped (prevents silent tail truncation)
- Fail-open by default: if service is down, headroom-lite forwards unmodified request

## Operational notes

- First request cold-starts the model (~5–15 s for bert-base-multilingual from disk)
- Subsequent requests: ~100–500 ms per 2 K-token prompt on CPU
- The Python service is long-running — start it once, keep it running
- headroom-lite polls `/health`; logs service state on startup

### macOS launchd (auto-start)

Copy the example plist, edit the Python path, and load it:

```bash
# Find your Python path
which python3

# Copy and edit the example
cp docs/com.myelin.llmlingua.plist.example ~/Library/LaunchAgents/com.myelin.llmlingua.plist
# Edit the ProgramArguments[0] string to match your `which python3` output

# Load
launchctl load ~/Library/LaunchAgents/com.myelin.llmlingua.plist

# Check status
launchctl list | grep llmlingua

# View logs
tail -f ~/.myelin/llmlingua.log
```

See [`docs/com.myelin.llmlingua.plist.example`](./com.myelin.llmlingua.plist.example) for the full template.

## Models

| Model | Size | Use case |
|---|---|---|
| `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` | 677 MiB | Default, fast, good quality |
| `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` | 2.1 GiB | Higher quality, 3× slower |
| `SecurityLingua/securitylingua-xlm-s2s` | 2.1 GiB | Security/jailbreak detection (PR4) |
