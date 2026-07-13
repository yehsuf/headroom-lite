/**
 * OpenAI Responses API `input`-array compression.
 *
 * The Responses API carries the conversation as an `input` array of typed items
 * (`{ type, ... }`) rather than a `messages` array. This module compresses the
 * large text in that array **losslessly** while preserving OpenAI's server-side
 * prompt cache: only the "live zone" is compressed, everything else is frozen
 * (byte-identical), mirroring upstream Headroom's
 * `crates/headroom-proxy/src/compression/live_zone_responses.rs`.
 *
 * Live zone (compressible):
 *   - the latest `function_call_output`, `local_shell_call_output`,
 *     `apply_patch_call_output` — the `output` string, and
 *   - the latest user-role `message` — its `content` text,
 *   each only when the target text is >= RESPONSES_MIN_BYTES.
 *
 * Everything else is passed through verbatim, including all earlier `*_output`
 * items, `reasoning`/`compaction` (`encrypted_content`), `function_call`
 * (`arguments`), `local_shell_call` (`action.command` argv), `apply_patch_call`
 * (`operation.diff`), `message.phase`, MCP/computer/built-in tool items, and any
 * unknown future `type`. A dedicated walker (not the generic tree walker) touches
 * only the two safe fields so opaque/structural data can never be mutated.
 */

import { compactTextLossless } from './pipeline.mjs';
import { estimateMessageTokens } from '../lib/estimate-tokens.mjs';

// Byte floor before a field is worth compacting (matches upstream OUTPUT_ITEM_MIN_BYTES).
export const RESPONSES_MIN_BYTES = 512;

const OUTPUT_KINDS = new Set([
  'function_call_output',
  'local_shell_call_output',
  'apply_patch_call_output',
]);

// Content-part types whose `text` field is plain, compressible model/user text.
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);

function bigEnough(value) {
  return typeof value === 'string' && Buffer.byteLength(value) >= RESPONSES_MIN_BYTES;
}

function itemRole(item) {
  return typeof item?.role === 'string' ? item.role.toLowerCase() : '';
}

/**
 * Single reverse-agnostic scan recording the latest index of each compressible
 * output kind and the latest user-role message.
 *
 * @param {Array} items
 * @returns {{ messageIdx: number, outputIdxByKind: Map<string, number> }}
 */
export function identifyLiveZone(items) {
  const outputIdxByKind = new Map();
  let messageIdx = -1;
  if (!Array.isArray(items)) return { messageIdx, outputIdxByKind };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && itemRole(item) === 'user') {
      messageIdx = i;
    } else if (OUTPUT_KINDS.has(item.type)) {
      outputIdxByKind.set(item.type, i);
    }
  }
  return { messageIdx, outputIdxByKind };
}

// Compact a message `content` (string, or array of content parts). Non-text
// parts and short text are returned untouched.
function compactContent(content) {
  if (bigEnough(content)) return compactTextLossless(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === 'object'
        && TEXT_PART_TYPES.has(part.type) && bigEnough(part.text)) {
        return { ...part, text: compactTextLossless(part.text) };
      }
      return part;
    });
  }
  return content;
}

/**
 * Compress a Responses API `input` array. Returns a new array; the input is not
 * mutated. Only live-zone `output`/`content` text >= RESPONSES_MIN_BYTES is
 * compacted (losslessly); all other bytes are preserved exactly.
 *
 * @param {Array} items
 * @param {{ compressLive?: boolean }} [options] - when true, also compress the
 *   very last item (the current turn); by default the current turn is protected.
 * @returns {{ items: Array, tokensBefore: number, tokensAfter: number, frozenCount: number }}
 */
export function compressResponsesInput(items, { compressLive = false } = {}) {
  if (!Array.isArray(items)) {
    return { items, tokensBefore: 0, tokensAfter: 0, frozenCount: 0 };
  }

  const output = structuredClone(items);
  const tokensBefore = estimateMessageTokens(items);

  const { messageIdx, outputIdxByKind } = identifyLiveZone(output);
  const liveIdx = new Set(outputIdxByKind.values());
  if (messageIdx >= 0) liveIdx.add(messageIdx);

  const lastIdx = output.length - 1;

  for (const idx of liveIdx) {
    // Protect the current turn (last item) unless the caller opted into live
    // compression — parity with the messages pipeline's latest-message guard.
    if (!compressLive && idx === lastIdx) continue;

    const item = output[idx];
    if (!item || typeof item !== 'object') continue;

    if (OUTPUT_KINDS.has(item.type)) {
      if (bigEnough(item.output)) item.output = compactTextLossless(item.output);
    } else if (item.type === 'message') {
      item.content = compactContent(item.content);
    }
  }

  return {
    items: output,
    tokensBefore,
    tokensAfter: estimateMessageTokens(output),
    frozenCount: output.length - liveIdx.size,
  };
}
