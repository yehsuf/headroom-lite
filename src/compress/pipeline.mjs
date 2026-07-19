import { computeOptimalK } from './adaptive-sizer.mjs';
import {
  DEFAULT_MIN_CHARS,
  DEFAULT_MIN_LINES,
  dedupBlocks,
} from './cross-turn-dedup.mjs';
import { filterDiffNoise } from './diff-noise-filter.mjs';
import { computeFrozenCount } from './frozen-prefix.mjs';
import { minifyJson } from './json-minifier.mjs';
import { compactLossless } from './lossless-compaction.mjs';
import { withTagProtection } from './tag-protector.mjs';
import { compactToolOutputs } from './tool-output-compactor.mjs';
import { estimateMessageTokens } from '../lib/estimate-tokens.mjs';

const SEARCH_ROW_RE = /^[^\n:]+:\d+:.*$/m;
const DIFF_INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: [0-7]+)?$/m;
const DIFF_HUNK_RE = /^@@ .* @@$/m;
const PATH_ROW_RE = /^(?:\.{0,2}\/)?(?:[^/\s:]+\/)+[^/\s:]+$/;
const ANSI_RE = /\x1b\[[0-9;]*m/;
const LOG_HINT_RE = /(?:^|\n)(?:info|warn|error|debug|trace)\b/i;

const NEVER_LOSSY_ROLES = new Set(['system', 'developer']);
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

// `computeOptimalK()` stays O(n^2) on diverse inputs. On a local adversarial
// corpus (~19KB per item), the slow path was already ~0.45s at 9-10 items and
// crossed ~0.50s by 12 items, so counts >= 10 stay on the fixed fallback.
const MAX_ADAPTIVE_SIZER_ITEMS = 10;
// protect_recent = 0: every historical message is eligible for cross-turn dedup.
// Agent-level session managers (e.g. myelin-compact) handle which context to
// preserve; the compression sidecar should not second-guess that by shielding
// recent turns. Aligns with upstream headroom coding-profile default (#2145).
const PROTECT_RECENT_AT_MEDIUM = 0;
const MIN_ADAPTIVE_RECENT = 0;
const MAX_ADAPTIVE_RECENT = 0;

function normalizeRole(value) {
  return typeof value === 'string' ? value.toLowerCase() : 'unknown';
}

function hasRepeatedAdjacentLines(text) {
  const lines = text.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === lines[index - 1]) return true;
  }
  return false;
}

function looksLikePathListing(text) {
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return false;
  return lines.filter((line) => PATH_ROW_RE.test(line)).length >= 2;
}

function detectPrimaryCompactionKind(text) {
  if (ANSI_RE.test(text) || (LOG_HINT_RE.test(text) && hasRepeatedAdjacentLines(text))) {
    return 'log';
  }
  if (DIFF_INDEX_RE.test(text) && DIFF_HUNK_RE.test(text)) return 'diff';
  if (SEARCH_ROW_RE.test(text)) return 'search';
  if (looksLikePathListing(text)) return 'paths';
  return null;
}

export function compactMessageText(text) {
  // Pre-process: filter diff noise before compaction (avoids compacting lockfile noise)
  let processed = detectPrimaryCompactionKind(text) === 'diff'
    ? filterDiffNoise(text)
    : text;

  // Pre-process: JSON minification (removes whitespace before lossless compaction)
  processed = minifyJson(processed);

  // Wrap the compaction steps with tag protection so XML-like tags are never mutated
  return withTagProtection(processed, (safeText) => {
    let output = safeText;
    const primaryKind = detectPrimaryCompactionKind(safeText);
    if (primaryKind !== null) output = compactLossless(output, primaryKind);
    if (output.includes('\n') && primaryKind !== 'log') output = compactLossless(output, 'text');
    return output;
  });
}

/**
 * Strictly lossless variant of compactMessageText: applies ONLY the
 * round-trip-verified `compactLossless` transforms (log/search/paths/diff-index
 * stripping + run-collapsing). It deliberately omits `filterDiffNoise` (which
 * DELETES lockfile/binary/whitespace diff sections) and `minifyJson` (which
 * discards original JSON formatting). Use this for content the model is actively
 * consuming — e.g. Responses API tool `output` fields — where dropping a
 * lockfile diff or reformatting JSON would be data loss, not noise removal.
 */
export function compactTextLossless(text) {
  return withTagProtection(text, (safeText) => {
    let output = safeText;
    const primaryKind = detectPrimaryCompactionKind(safeText);
    if (primaryKind !== null) output = compactLossless(output, primaryKind);
    if (output.includes('\n') && primaryKind !== 'log') output = compactLossless(output, 'text');
    return output;
  });
}

function shouldVisitText(text, key, parentKey) {
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

function createLeaf(parent, key, { messageIndex, role, parentKey }) {
  return {
    messageIndex,
    role,
    fieldKey: typeof key === 'string' ? key : parentKey,
    get() {
      return parent[key];
    },
    set(value) {
      parent[key] = value;
    },
  };
}

function hasSignedSiblingFields(node) {
  // Signed content blocks must remain byte-exact; skip unexpected signed shapes too.
  return Object.hasOwn(node, 'signature');
}

function walkNode(node, context, leaves, parent = null, key = null) {
  if (typeof node === 'string') {
    if (parent !== null && shouldVisitText(node, key, context.parentKey)) {
      leaves.push(createLeaf(parent, key, context));
    }
    return;
  }

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      walkNode(node[index], context, leaves, node, index);
    }
    return;
  }

  if (node && typeof node === 'object') {
    if (hasSignedSiblingFields(node)) return;

    const nextRole = typeof node.role === 'string' ? normalizeRole(node.role) : context.role;

    for (const [childKey, childValue] of Object.entries(node)) {
      if (SKIP_SUBTREES.has(childKey)) continue;
      walkNode(childValue, { ...context, role: nextRole, parentKey: childKey }, leaves, node, childKey);
    }
  }
}

function collectTextLeaves(messages) {
  const leaves = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const role = normalizeRole(message?.role);
    walkNode(message, { messageIndex, role, parentKey: null }, leaves);
  }

  return leaves;
}

function isLossyEligibleLeaf(leaf, latestMessageIndex, compressLive) {
  // In normal mode the latest message is never lossy-compressed (TTFT/context quality).
  // In live mode the caller has explicitly opted in — drop this protection.
  if (!compressLive && leaf.messageIndex === latestMessageIndex) return false;
  if (NEVER_LOSSY_ROLES.has(leaf.role)) return false;
  if (SKIP_MUTATION_KEYS.has(leaf.fieldKey)) return false;

  const text = leaf.get();
  return text.includes('\n')
    && text.length >= DEFAULT_MIN_CHARS
    && text.split('\n').length >= DEFAULT_MIN_LINES;
}

function groupMessageTexts(leaves) {
  const grouped = new Map();

  for (const leaf of leaves) {
    if (!grouped.has(leaf.messageIndex)) grouped.set(leaf.messageIndex, []);
    grouped.get(leaf.messageIndex).push(leaf.get());
  }

  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([messageIndex, texts]) => ({
      messageIndex,
      text: texts.join('\n\n'),
    }));
}

function chooseProtectedHistoricalMessages(candidates, latestMessageIndex) {
  // protect_recent=0: all constants are 0, so this function always returns an
  // empty set. Early exit to skip the adaptive-sizer computation.
  if (PROTECT_RECENT_AT_MEDIUM === 0 && MIN_ADAPTIVE_RECENT === 0 && MAX_ADAPTIVE_RECENT === 0) {
    return new Set();
  }

  const historicalEntries = groupMessageTexts(candidates)
    .filter(({ messageIndex }) => messageIndex !== latestMessageIndex);

  const count = historicalEntries.length;
  if (count <= 4) return new Set();

  let protectRecentCount = PROTECT_RECENT_AT_MEDIUM;
  if (count > 8) {
    if (count >= MAX_ADAPTIVE_SIZER_ITEMS) {
      protectRecentCount = MAX_ADAPTIVE_RECENT;
    } else {
      protectRecentCount = computeOptimalK(historicalEntries.map(({ text }) => text), {
        minK: MIN_ADAPTIVE_RECENT,
        maxK: Math.min(MAX_ADAPTIVE_RECENT, count),
      });
    }
  }

  return protectRecentCount <= 0
    ? new Set()
    : new Set(
        historicalEntries
          .slice(-protectRecentCount)
          .map(({ messageIndex }) => messageIndex),
      );
}

export function compressMessages(messages, { format = 'anthropic', model = 'default', compressLive = false } = {}) {
  const frozenCount = computeFrozenCount(messages, { format });
  const frozen = messages.slice(0, frozenCount);
  const live = messages.slice(frozenCount);

  const tokensBefore = estimateMessageTokens(messages);

  const outputLive = structuredClone(live);
  const latestMessageIndex = outputLive.length - 1;

  // Phase 1: text-leaf compaction (diffs, logs, search results, JSON minification).
  const leaves = collectTextLeaves(outputLive);
  for (const leaf of leaves) {
    leaf.set(compactMessageText(leaf.get()));
  }

  // Phase 2: JSON array → CSV compaction for tool_result blocks.
  // Runs AFTER the text-leaf loop so the generated CSV strings are never
  // re-encountered by compactMessageText. Running before would cause
  // PATH_ROW_RE to match CSV rows like "src/a.mjs,0" (comma is not excluded),
  // triggering pathHeading which strips shared directory prefixes and corrupts
  // the CSV output (e.g. "src/" appears as a separate heading line).
  compactToolOutputs(outputLive, latestMessageIndex);

  const lossyCandidates = leaves.filter((leaf) => isLossyEligibleLeaf(leaf, latestMessageIndex, compressLive));

  if (lossyCandidates.length >= 2) {
    // In live mode skip the adaptive-sizer entirely — user opted in to maximum compression.
    // cache_control / signature guards are unaffected (enforced by frozen prefix + SKIP_SUBTREES).
    const protectedMessages = compressLive
      ? new Set()
      : chooseProtectedHistoricalMessages(lossyCandidates, latestMessageIndex);
    const { blocks } = dedupBlocks(
      lossyCandidates.map((leaf) => ({
        // Turn numbers must be 1-based relative to the FULL conversation, not the
        // live slice — otherwise dedup pointers say "turn 1" when the correct
        // display turn in the conversation is frozenCount+1.
        turn: leaf.messageIndex + frozenCount + 1,
        text: leaf.get(),
        protected: protectedMessages.has(leaf.messageIndex),
      })),
    );

    for (let index = 0; index < blocks.length; index += 1) {
      lossyCandidates[index].set(blocks[index].text);
    }
  }

  const outputMessages = [...frozen, ...outputLive];

  return {
    messages: outputMessages,
    tokensBefore,
    tokensAfter: estimateMessageTokens(outputMessages),
    frozenCount,
  };
}

/**
 * Async lossy compression pipeline.
 * Runs deterministic lossless compression first, then optionally applies
 * LLMLingua lossy compression to eligible text leaves.
 *
 * @param {Array} messages
 * @param {object} options
 * @param {string} [options.format='anthropic']
 * @param {string} [options.model='default']
 * @param {boolean} [options.compressLive=false]
 * @param {object} [options.lossy]  resolveLossyConfig() result
 * @returns {Promise<object>}  { messages, tokensBefore, tokensAfter, frozenCount, lossy }
 */
export async function compressMessagesAsync(messages, {
  format = 'anthropic',
  model = 'default',
  compressLive = false,
  lossy = { enabled: false },
} = {}) {
  // Step 1: lossless deterministic compression (sync)
  const deterministic = compressMessages(messages, { format, model, compressLive });

  // Step 2: if lossy disabled, return with lossy metadata
  if (!lossy.enabled) {
    return {
      ...deterministic,
      lossy: { enabled: false },
    };
  }

  // Step 3: collect candidates (after frozen prefix)
  const { collectLossyCandidates } = await import('./lossy-eligibility.mjs');
  const { validateCompressedText } = await import('./lossy-guards.mjs');
  const { compressTexts } = await import('../lossy/client.mjs');

  const candidates = collectLossyCandidates(deterministic.messages, {
    format,
    frozenCount: deterministic.frozenCount ?? 0,
    compressLive,
    minChars: lossy.minChars ?? 1000,
    maxChars: lossy.maxChars ?? 60000,
    compressCode: lossy.compressCode ?? false,
  });

  if (candidates.length === 0) {
    return {
      ...deterministic,
      lossy: { enabled: true, attempted: 0, applied: 0, rejected: 0 },
    };
  }

  // Step 4: call service (fail-open by default)
  let serviceResult;
  try {
    serviceResult = await compressTexts(candidates, lossy);
  } catch (err) {
    return {
      ...deterministic,
      lossy: {
        enabled: true,
        attempted: candidates.length,
        applied: 0,
        rejected: candidates.length,
        error: String(err?.message || err),
      },
    };
  }

  // Step 5: apply validated results
  const resultMessages = JSON.parse(JSON.stringify(deterministic.messages));
  let applied = 0;
  let rejected = 0;

  for (const original of candidates) {
    const result = serviceResult.items?.find((r) => r.id === original.id);
    if (!result || !result.compressed || result.error) { rejected++; continue; }
    if (!validateCompressedText(original.text, result.text, original.kind)) { rejected++; continue; }

    const msg = resultMessages[original.msgIdx];
    if (original.contentIdx === null) {
      msg.content = result.text;
    } else {
      msg.content[original.contentIdx].text = result.text;
    }
    applied++;
  }

  return {
    messages: resultMessages,
    tokensBefore: deterministic.tokensBefore,
    tokensAfter: applied > 0
      ? estimateMessageTokens(resultMessages)
      : deterministic.tokensAfter,
    frozenCount: deterministic.frozenCount ?? 0,
    lossy: {
      enabled: true,
      attempted: candidates.length,
      applied,
      rejected,
      backend: lossy.backend,
      modelName: lossy.modelName,
    },
  };
}
