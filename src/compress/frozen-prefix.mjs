/**
 * Compute the frozen-prefix count for an Anthropic-style messages array.
 *
 * A message is "frozen" if it or any predecessor carries a cache_control
 * marker. frozen_count is the smallest N such that messages[0..N-1] are all
 * in the cache hot zone. Compressing frozen messages changes the cache key
 * and destroys prompt-cache hit rates.
 *
 * @param {Array} messages
 * @returns {number} Number of frozen messages (0 = all messages are live zone)
 */
export function computeFrozenCount(messages) {
  if (!Array.isArray(messages)) return 0;
  let frozenCount = 0;
  for (let i = 0; i < messages.length; i++) {
    if (hasCacheControl(messages[i])) frozenCount = i + 1;
  }
  return frozenCount;
}

function hasCacheControl(message) {
  if (!message || typeof message !== 'object') return false;
  // cache_control at message level (some SDKs place it here)
  if (message.cache_control != null) return true;
  // cache_control inside content blocks
  const { content } = message;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => block != null && typeof block === 'object' && block.cache_control != null,
  );
}
