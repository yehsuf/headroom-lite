/**
 * Validate LLMLingua output before applying.
 * Reject if the compression is unsafe or degrades structure.
 */

/**
 * @param {string} original
 * @param {string} compressed
 * @param {string} kind
 * @returns {boolean} true if safe to apply
 */
export function validateCompressedText(original, compressed, kind) {
  if (!compressed || typeof compressed !== 'string') return false;
  if (compressed.length >= original.length) return false;

  // Check for unbalanced fenced code markers
  const origFences = (original.match(/^```/gm) || []).length;
  const compFences = (compressed.match(/^```/gm) || []).length;
  if (origFences % 2 === 0 && compFences % 2 !== 0) return false;

  // Stack traces / logs must retain final line + enough path:line anchors
  if (kind === 'stack_trace' || kind === 'log') {
    const origLines = original.split('\n');
    const compLines = compressed.split('\n');
    const lastOrigLine = origLines.filter((l) => l.trim()).at(-1) || '';
    if (lastOrigLine && !compressed.includes(lastOrigLine.slice(0, 40))) return false;
    const pathLineRe = /\S+:\d+/;
    const origPathLines = origLines.filter((l) => pathLineRe.test(l)).length;
    const compPathLines = compLines.filter((l) => pathLineRe.test(l)).length;
    if (origPathLines > 5 && compPathLines < origPathLines * 0.8) return false;
  }

  // Must not destroy all newline structure (if original had many lines)
  const origNewlines = (original.match(/\n/g) || []).length;
  const compNewlines = (compressed.match(/\n/g) || []).length;
  if (origNewlines > 10 && compNewlines === 0) return false;

  return true;
}
