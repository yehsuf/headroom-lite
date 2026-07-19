import { parseJsonSequence } from './tool-output-compactor.mjs';

/**
 * Minify a JSON string by removing insignificant whitespace.
 * Returns original string if:
 *   - Not valid JSON (parse fails)
 *   - Result would be larger than original (shouldn't happen but defensive)
 *   - Input is not "large" (< MIN_JSON_BYTES — no point minifying small objects)
 *
 * Preserves string content exactly (including embedded whitespace in values).
 * Lossless contract: JSON.parse(minify(s)) deep-equals JSON.parse(s) for single
 * JSON values; for whitespace-delimited sequences (e.g. `{"a":1} {"b":2}`),
 * lossless means each object can be re-parsed individually after splitting on
 * the `} {` boundary — NOT that a single JSON.parse of the full result succeeds.
 *
 * Also handles whitespace-delimited JSON object sequences (e.g. SerpAPI/Tavily
 * tool results: `{"a":1} {"b":2}`) by minifying each object individually and
 * rejoining with a single space. Lossless: sequence can be re-split on `} {`.
 */
export const MIN_JSON_BYTES = 200; // don't bother minifying small objects

/**
 * Minify a whitespace-delimited JSON object sequence: `{"a": 1} {"b": 2}` →
 * `{"a":1} {"b":2}`. Each object's internal whitespace is stripped; the
 * single-space separator between objects is preserved so the sequence remains
 * unambiguously splittable.
 *
 * Returns null when:
 *   - Text is not a valid 2+ object sequence
 *   - Result is not smaller than input (already compact)
 */
export function minifyJsonSequence(text) {
  if (typeof text !== 'string' || text.length < MIN_JSON_BYTES) return null;
  const trimmed = text.trimStart();
  const objects = parseJsonSequence(trimmed);
  if (!objects) return null;
  const minified = objects.map((obj) => JSON.stringify(obj)).join(' ');
  return minified.length < text.length ? minified : null;
}

export function minifyJson(text) {
  if (typeof text !== 'string' || text.length < MIN_JSON_BYTES) return text;
  // Quick check: does it look like JSON? Must start with { or [
  const trimmed = text.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return text;
  try {
    const parsed = JSON.parse(text);
    const minified = JSON.stringify(parsed);
    return minified.length < text.length ? minified : text;
  } catch {
    // Not a single valid JSON value — try whitespace-delimited sequence
    return minifyJsonSequence(text) ?? text;
  }
}
