/**
 * Tool-output compactor — lossless JSON array compression for tool_result blocks.
 *
 * Ports the deterministic subset of SmartCrusher's lossless path:
 *   - Object arrays with consistent keys  → CSV-schema (most compact)
 *   - String arrays > MIN_ITEMS           → head + tail + omitted marker
 *   - Number arrays > MIN_ITEMS           → head + tail + stats summary
 *
 * Never applied to: frozen messages, system/developer roles, the latest message,
 * tool_use inputs (arguments), or arrays < MIN_ITEMS (passthrough).
 *
 * Wire position in pipeline: after compactMessageText (text compaction) but before
 * cross-turn-dedup, so dedup can match the already-compacted tool output form.
 *
 * Reference: headroom/headroom/transforms/smart_crusher.py (lossless path);
 *            headroom-core/src/transforms/smart_crusher/crushers.rs crush_object.
 */

// Minimum items before compaction is attempted (mirrors SmartCrusher passthrough guard)
export const MIN_ITEMS = 9;
// Accept any positive shrink. Mirrors upstream headroom 0.31.0's min_ratio=1.0 gate.
const MIN_ACCEPTANCE_RATIO = 1.0;
// Head/tail item counts for string/number arrays
const HEAD_KEEP = 10;
const TAIL_KEEP = 5;
// Minimum fraction of keys an object must share to be considered "consistent schema"
const SCHEMA_CONSISTENCY_THRESHOLD = 0.6;

// ── CSV-schema helpers ────────────────────────────────────────────────────────

/**
 * Extract the dominant key set from an object array.
 * Returns null if array is too heterogeneous for CSV compaction.
 */
function dominantKeys(arr) {
  if (arr.length === 0) return null;

  // Count key frequency across all objects
  const freq = new Map();
  for (const obj of arr) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    for (const k of Object.keys(obj)) {
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }

  // Keys present in >= SCHEMA_CONSISTENCY_THRESHOLD fraction of objects
  const threshold = Math.ceil(arr.length * SCHEMA_CONSISTENCY_THRESHOLD);
  const keys = [...freq.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([k]) => k);

  // Need at least 2 consistent keys for CSV to be worthwhile
  return keys.length >= 2 ? keys : null;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Escape if contains comma, newline, or quote
  if (s.includes(',') || s.includes('\n') || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Convert a uniform object array to CSV-schema format.
 * Format: schema:[key1,key2,...]\nv1,v2\nv3,v4\n...
 * Returns null if not applicable or the candidate does not shrink the input.
 */
export function tryObjectArrayToCsv(arr) {
  const keys = dominantKeys(arr);
  if (!keys) return null;

  const header = `schema:[${keys.join(',')}]`;
  const rows = arr.map((obj) =>
    keys.map((k) => csvEscape(obj?.[k])).join(',')
  );

  const result = [header, ...rows].join('\n');
  const original = JSON.stringify(arr);
  if (result.length / original.length >= MIN_ACCEPTANCE_RATIO) return null;

  return result;
}

// ── String array compaction ───────────────────────────────────────────────────

/**
 * Compact a long string array: keep head + tail, omit middle.
 * Preserves error/anomaly strings (items containing error keywords).
 */
export function compactStringArray(arr) {
  if (arr.length <= MIN_ITEMS) return null;

  const n = arr.length;
  const headItems = arr.slice(0, HEAD_KEEP);
  const tailItems = arr.slice(Math.max(HEAD_KEEP, n - TAIL_KEEP));
  const omittedCount = n - headItems.length - tailItems.length;

  if (omittedCount <= 0) return null;

  const parts = [...headItems];
  parts.push(`[${omittedCount} items omitted]`);
  parts.push(...tailItems);

  const result = JSON.stringify(parts);
  const original = JSON.stringify(arr);
  if (result.length / original.length >= MIN_ACCEPTANCE_RATIO) return null;

  return result;
}

// ── Number array compaction ───────────────────────────────────────────────────

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

/**
 * Compact a long number array: head + tail + stats summary string.
 */
export function compactNumberArray(arr) {
  if (arr.length <= MIN_ITEMS) return null;

  const finite = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (finite.length === 0) return null;

  const n = arr.length;
  const headItems = arr.slice(0, HEAD_KEEP);
  const tailItems = arr.slice(Math.max(HEAD_KEEP, n - TAIL_KEEP));
  const omittedCount = n - headItems.length - tailItems.length;

  if (omittedCount <= 0) return null;

  const avg = mean(finite).toFixed(4);
  const med = median(finite).toFixed(4);
  const stats = `[${omittedCount} items omitted; min=${finite[0]},max=${finite[finite.length - 1]},mean=${avg},median=${med}]`;

  const parts = [...headItems, stats, ...tailItems];
  const result = JSON.stringify(parts);
  const original = JSON.stringify(arr);
  if (result.length / original.length >= MIN_ACCEPTANCE_RATIO) return null;

  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Attempt to compact a JSON array string from a tool result.
 * Returns the compacted string, or null if not applicable / no savings.
 */
export function compactJsonArray(text) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trimStart();
  // Quick gate: must look like a JSON array
  if (!trimmed.startsWith('[')) return null;

  let arr;
  try {
    arr = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!Array.isArray(arr) || arr.length <= MIN_ITEMS) return null;

  // Detect array type from first non-null element
  const sample = arr.find((x) => x !== null && x !== undefined);
  if (sample === undefined) return null;

  if (typeof sample === 'object' && !Array.isArray(sample)) {
    // Object array — try CSV-schema (most compact)
    return tryObjectArrayToCsv(arr);
  }

  if (typeof sample === 'string') {
    return compactStringArray(arr);
  }

  if (typeof sample === 'number') {
    return compactNumberArray(arr);
  }

  return null;
}

// ── Pipeline integration helpers ──────────────────────────────────────────────

/**
 * Walk messages and compact JSON arrays in tool_result content blocks.
 *
 * Only applied to:
 * - Messages with role 'tool' or content blocks with type 'tool_result'
 * - text/string content within those blocks
 * - Not the latest message (latestMessageIndex)
 *
 * Mutates messages in-place (caller passes a structuredClone).
 */
export function compactToolOutputs(messages, latestMessageIndex) {
  for (let i = 0; i < messages.length; i++) {
    if (i === latestMessageIndex) continue;

    const msg = messages[i];
    if (!msg) continue;

    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';

    // OpenAI format: role='tool'
    if (role === 'tool') {
      const content = msg.content;
      if (typeof content === 'string') {
        const compacted = compactJsonArray(content);
        if (compacted !== null) msg.content = compacted;
      }
      continue;
    }

    // Anthropic format: content blocks with type='tool_result'
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'tool_result') continue;
      if (block.cache_control) continue; // frozen — never touch

      // tool_result content can be a string or array of blocks
      if (typeof block.content === 'string') {
        const compacted = compactJsonArray(block.content);
        if (compacted !== null) block.content = compacted;
        continue;
      }

      if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (!inner || inner.type !== 'text' || typeof inner.text !== 'string') continue;
          if (inner.cache_control) continue;
          const compacted = compactJsonArray(inner.text);
          if (compacted !== null) inner.text = compacted;
        }
      }
    }
  }
}
