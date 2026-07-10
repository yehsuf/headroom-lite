/**
 * Identify text leaves eligible for lossy compression.
 * NEVER includes messages before frozenCount.
 * NEVER includes tool arguments, partial_json, input_json, cache_control, or signed blocks.
 */

const SKIP_KEYS = new Set(['input', 'arguments', 'partial_json', 'input_json', 'cache_control']);

/**
 * Classify text kind for compression routing.
 * @param {string} text
 * @returns {'diff'|'search'|'stack_trace'|'code'|'log'|'prose'}
 */
export function classifyTextKind(text) {
  if (/^diff --git|^---\s+a\//m.test(text)) return 'diff';
  if (/^\s*(at\s+\S+\s*\()|(Traceback|Exception|Error):/m.test(text)) return 'stack_trace';
  if (/^(Results?|Found|Matches?):/m.test(text) || /\d+ results?\b/i.test(text)) return 'search';
  if (/^(function|class|def|import|export|const|let|var|public|private)\b/m.test(text)) return 'code';
  if (/(\d{4}-\d{2}-\d{2}|\[INFO\]|\[WARN\]|\[ERROR\]|\[DEBUG\])/.test(text)) return 'log';
  return 'prose';
}

/**
 * Walk messages and collect lossy candidates.
 * Returns an array of { id, text, kind, msgIdx, contentIdx, targetRate }
 */
export function collectLossyCandidates(messages, {
  format = 'anthropic',
  frozenCount = 0,
  compressLive = false,
  minChars = 1000,
  maxChars = 60000,
  compressCode = false,
} = {}) {
  const candidates = [];
  const latestIdx = messages.length - 1;

  for (let msgIdx = frozenCount; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg || typeof msg !== 'object') continue;
    if (!compressLive && msgIdx === latestIdx) continue;
    if (msg.role === 'system' || msg.role === 'developer') continue;

    const content = msg.content;
    if (typeof content === 'string') {
      if (content.length >= minChars) {
        const kind = classifyTextKind(content);
        if (_isEligibleKind(kind, compressCode)) {
          candidates.push({
            id: `m${msgIdx}:text`,
            text: content.slice(0, maxChars),
            kind,
            msgIdx,
            contentIdx: null,
            targetRate: 0.5,
          });
        }
      }
    } else if (Array.isArray(content)) {
      for (let ci = 0; ci < content.length; ci++) {
        const block = content[ci];
        if (!block || typeof block !== 'object') continue;
        // Skip blocks with cache_control or signature (frozen/signed)
        if (block.cache_control || block.signature) continue;
        const blockType = block.type || '';
        if (blockType === 'tool_use' || blockType === 'tool_result') continue;
        // Only process text-shaped blocks
        if (blockType !== 'text' && blockType !== '') continue;
        const text = block.text;
        if (typeof text !== 'string' || text.length < minChars) continue;
        if (SKIP_KEYS.has(blockType)) continue;
        const kind = classifyTextKind(text);
        if (_isEligibleKind(kind, compressCode)) {
          candidates.push({
            id: `m${msgIdx}:b${ci}:text`,
            text: text.slice(0, maxChars),
            kind,
            msgIdx,
            contentIdx: ci,
            targetRate: 0.5,
          });
        }
      }
    }
  }
  return candidates;
}

function _isEligibleKind(kind, compressCode) {
  if (kind === 'prose' || kind === 'log' || kind === 'stack_trace') return true;
  if (compressCode && (kind === 'code' || kind === 'diff' || kind === 'search')) return true;
  return false;
}
