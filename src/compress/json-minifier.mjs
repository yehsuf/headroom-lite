/**
 * Minify a JSON string by removing insignificant whitespace.
 * Returns original string if:
 *   - Not valid JSON (parse fails)
 *   - Result would be larger than original (shouldn't happen but defensive)
 *   - Input is not "large" (< MIN_JSON_BYTES — no point minifying small objects)
 *
 * Preserves string content exactly (including embedded whitespace in values).
 * This is pure lossless — JSON.parse(minify(s)) deep-equals JSON.parse(s).
 */
export const MIN_JSON_BYTES = 200; // don't bother minifying small objects

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
    return text; // not valid JSON, leave untouched
  }
}
