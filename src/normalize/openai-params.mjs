/**
 * OpenAI request parameter normalization.
 *
 * GPT-5 and o-series models reject the legacy `max_tokens` parameter with a
 * 400 error. The current standard is `max_completion_tokens`. Clients using
 * the legacy field (including older SDK versions and proxy chains) would
 * silently fail against these models.
 *
 * This module provides a single normalization pass over the parsed request body
 * BEFORE it is forwarded to the upstream. It is intentionally minimal:
 *   - Only translates `max_tokens` → `max_completion_tokens` for OpenAI format.
 *   - Only acts when `max_completion_tokens` is not already present.
 *   - Never modifies Anthropic-format bodies (they use `max_tokens` correctly).
 *   - Returns the same object reference when no changes are needed (zero alloc).
 *
 * Ref: upstream fix(proxy/openai) GH #1774.
 */

/**
 * Normalize OpenAI-format request body parameters for model compatibility.
 *
 * @param {Record<string, unknown>} body - Parsed JSON request body.
 * @returns {Record<string, unknown>} Normalized body (may be the same object
 *   reference if no changes are needed).
 */
export function normalizeOpenAIParams(body) {
  if (!body || typeof body !== 'object') return body;

  // Translate max_tokens → max_completion_tokens for GPT-5/o-series compat.
  // Only when max_completion_tokens is absent — if both are present, let the
  // upstream handle it (avoid silently dropping an explicit caller intent).
  if ('max_tokens' in body && !('max_completion_tokens' in body)) {
    const { max_tokens, ...rest } = body;
    return { ...rest, max_completion_tokens: max_tokens };
  }

  return body;
}
