# OpenAI Responses API `input`-array compression (headroom-lite)

**Date:** 2026-07-13
**Status:** approved-to-implement (user directed implementation start)
**Repos:** `yehsuf/headroom-lite` (sidecar) + `yehsuf/myelin` (mitm addon)

## Problem

GitHub Copilot migrated to the OpenAI **Responses API** (`POST /responses`,
`POST /v1/responses`). Its request body carries the conversation in an **`input`
array of typed items** (`{type, ...}`), not a `messages` array. Today:

- The myelin mitm addon **bails** on any body lacking `messages`
  (`copilot_addon.py` ~L837), so Responses requests are forwarded uncompressed.
- headroom-lite's `/v1/compress` **requires** `payload.messages`
  (`server.mjs` ~L101), and the pipeline only understands `role`-tagged messages.

Result: essentially all modern Copilot traffic bypasses compression.

## Goals

Compress the large text in Responses `input` items **losslessly** while
**preserving OpenAI's server-side prompt cache**, with zero new runtime deps and
full backward compatibility for existing `messages` callers.

## Key correctness constraint: live zone vs frozen prefix

OpenAI caches the request **prefix** server-side (keyed on the stable leading
bytes / `previous_response_id`). Compressing historical items changes those bytes
and **busts the cache** — saving display tokens but losing the cache discount
(net worse, exactly as with Anthropic `mode:cache`). Therefore we compress only
the **live zone** and freeze everything else, mirroring upstream Headroom
(`crates/headroom-proxy/src/compression/live_zone_responses.rs`):

**Live zone (compressible):**
- the **latest** `function_call_output`, **latest** `local_shell_call_output`,
  **latest** `apply_patch_call_output` — the `output` string field, and
- the **latest user-role `message`** — its `content` text,
each only when the target text is **>= 512 bytes** (`OUTPUT_ITEM_MIN_BYTES`).

**Frozen / passthrough verbatim (never mutated):**
- all earlier `*_call_output` items, all non-latest user messages;
- `reasoning.encrypted_content`, `compaction.encrypted_content` (opaque);
- `function_call.arguments` (model output, JSON string);
- `local_shell_call.action.command` (argv array - must not be stringified);
- `apply_patch_call.operation.diff` (V4A patch - re-serializing breaks apply);
- `message.phase` (Codex `commentary`/`final_answer`);
- MCP / computer / web_search / file_search / image_generation / **unknown**
  `type`s - passed through untouched.

We use a **dedicated walker** (not the generic `walkNode`) so only the two safe
fields (`output`, message text `content`) on live-zone items are ever touched.

## Design

### New module: `src/compress/responses.mjs`

- `RESPONSES_MIN_BYTES = 512`.
- `identifyLiveZone(items) -> { messageIdx, outputIdxByKind }` - single reverse
  scan; records the last index of each compressible kind and the last
  user-role `message`.
- `compressResponsesInput(items, { compressLive = false } = {}) ->
  { items, tokensBefore, tokensAfter, frozenCount }`:
  1. `structuredClone` the array.
  2. `tokensBefore = estimateMessageTokens(items)`.
  3. For each live-zone target field >= `RESPONSES_MIN_BYTES`, replace with
     `compactMessageText(text)` (the existing lossless compactor: diff/log/
     search/path/JSON-min/collapse-runs, tag-protected). Message `content` may
     be a string or a content-parts array (`[{type:'input_text',text}]`); only
     `text`/`input_text`/`output_text` string parts are compacted.
  4. Cross-turn dedup (`dedupBlocks`) runs over the collected live-zone text
     leaves (>=2) so a live output that repeats an earlier one is pointer-folded.
  5. `frozenCount` = number of items NOT in the live zone.
  6. In `compressLive` mode the latest-message protection is dropped (parity
     with the messages pipeline).

No changes to the lossless compactors - they operate on plain strings.

### `server.mjs` - accept `input` + `kind` (backward compatible)

- Validation accepts `payload.input` (array) when `payload.kind === 'responses'`,
  else keeps requiring `payload.messages`.
- Dispatch: `kind === 'responses'` -> `compressResponsesInput`; else the existing
  `compressMessagesAsync`.
- Response mirrors the request key: return `input` (not `messages`) for the
  Responses path, plus `tokens_before/after`, `frozen_count`.

### `copilot_addon.py` - extract, send, apply

- In the request hook, when there is no `messages` list but `data.get('input')`
  is a non-empty list, treat it as Responses: snapshot `input`, offload to a new
  `_compress_responses(input, fmt, model)` that POSTs
  `{input, kind:'responses', format, model}` and reads `result['input']`; write
  the result back to `data['input']`. Same GuardedPool / breaker / fail-open as
  `_compress_messages`. Everything else (SSE, block-bypass, cache) unchanged.

## Wire contract (additive)

```
POST /v1/compress
  { "input":[...], "kind":"responses", "format":"openai", "model":"..." }
->{ "input":[...], "tokens_before":N, "tokens_after":N, "frozen_count":N }
```
Old `{ "messages":[...] }` requests are unchanged (absence of `kind` = messages).

## Testing

- `responses.mjs` unit tests: live-zone identification; only latest of each kind
  compressed; earlier outputs + reasoning/compaction/arguments/command/diff/phase
  byte-identical; <512B outputs untouched; content-parts arrays handled; dedup of
  repeated live outputs; structural integrity (types/call_id/name preserved).
- `server.mjs`: `input`+`kind` request returns compressed `input`; missing both
  keys -> 400; old `messages` path unaffected.
- `copilot_addon.py`: a `/responses` request with `input` is compressed and
  written back; a body with neither key still bails.
- Full Node + Python suites; Mac + Linux + Windows; code review; PRs; ask before
  merge.

## Out of scope
- Output shaping (needs response-side/session state). Audit-safe
  `protected_patterns` and language-aware code compression (tree-sitter dep) -
  separate backlog.
