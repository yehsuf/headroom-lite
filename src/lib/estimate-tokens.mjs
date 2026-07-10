/**
 * Deterministic token-ish estimator for before/after reporting only.
 *
 * This intentionally counts just the textual message leaves that the
 * compression pipeline operates on and ignores JSON punctuation, keys, and
 * other structural noise. The result is useful for relative savings reporting,
 * but it is not a provider tokenizer and must not be treated as billing- or
 * context-window-accurate.
 */
const TOKENISH_RE = /[\p{L}\p{N}_]+|[^\s]/gu;
const WORDISH_RE = /^[\p{L}\p{N}_]+$/u;
const SKIP_MUTATION_KEYS = new Set(['arguments', 'input', 'partial_json', 'input_json']);
const SKIP_SUBTREES = new Set(['cache_control', 'signature', ...SKIP_MUTATION_KEYS]);
const SKIP_TEXT_KEYS = new Set([
  'role',
  'type',
  'id',
  'name',
  'model',
  'tool_use_id',
  'tool_call_id',
  'stop_reason',
  'finish_reason',
  'status',
  'mime_type',
]);
const SAFE_TEXT_KEYS = new Set([
  'content',
  'text',
  'result',
  'output',
  'stdout',
  'stderr',
  'message',
]);

export function estimateTokenCount(value) {
  const text = typeof value === 'string'
    ? value
    : (typeof value === 'number' || typeof value === 'boolean')
      ? String(value)
      : JSON.stringify(value);
  if (!text) return 0;

  const parts = text.match(TOKENISH_RE);
  if (!parts) return 0;

  let total = 0;
  for (const part of parts) {
    total += WORDISH_RE.test(part) ? Math.max(1, Math.ceil(part.length / 4)) : 1;
  }
  return total;
}

function shouldCountText(text, key, parentKey) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (typeof key === 'string' && (SKIP_TEXT_KEYS.has(key) || SKIP_MUTATION_KEYS.has(key))) {
    return false;
  }

  if (typeof key === 'number' && typeof parentKey === 'string' && SKIP_MUTATION_KEYS.has(parentKey)) {
    return false;
  }

  if (typeof key === 'string' && SAFE_TEXT_KEYS.has(key)) return true;
  if (typeof key === 'number' && typeof parentKey === 'string' && SAFE_TEXT_KEYS.has(parentKey)) {
    return true;
  }

  return text.includes('\n') || text.length >= 160;
}

function walkMessageNode(node, texts, parentKey = null, key = null) {
  if (typeof node === 'string') {
    if (shouldCountText(node, key, parentKey)) texts.push(node);
    return;
  }

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      walkMessageNode(node[index], texts, parentKey, index);
    }
    return;
  }

  if (node && typeof node === 'object') {
    for (const [childKey, childValue] of Object.entries(node)) {
      if (SKIP_SUBTREES.has(childKey)) continue;
      walkMessageNode(childValue, texts, childKey, childKey);
    }
  }
}

function collectMessageTexts(messages) {
  const texts = [];
  walkMessageNode(messages, texts);
  return texts;
}

export function estimateMessageTokens(messages) {
  return collectMessageTexts(messages)
    .reduce((total, text) => total + estimateTokenCount(text), 0);
}
