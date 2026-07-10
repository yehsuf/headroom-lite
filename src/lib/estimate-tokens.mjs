const TOKENISH_RE = /[\p{L}\p{N}_]+|[^\s]/gu;
const WORDISH_RE = /^[\p{L}\p{N}_]+$/u;

export function estimateTokenCount(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;

  const parts = text.match(TOKENISH_RE);
  if (!parts) return 0;

  let total = 0;
  for (const part of parts) {
    total += WORDISH_RE.test(part) ? Math.max(1, Math.ceil(part.length / 4)) : 1;
  }
  return total;
}

export function estimateMessageTokens(messages) {
  return estimateTokenCount(messages);
}
