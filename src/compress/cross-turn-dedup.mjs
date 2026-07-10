export const DEFAULT_MIN_LINES = 7;
export const DEFAULT_MIN_CHARS = 120;
export const MAX_ANCHOR_CANDIDATES = 16;

const TRIVIAL_LINES = new Set([
  'return',
  'pass',
  'else:',
  'try:',
  'except:',
  'finally:',
  'break',
  'continue',
  '});',
  '})',
  '],',
  '),',
  '"""',
  "'''",
  '...',
]);

function isTrivialLine(line) {
  const trimmed = line.trim();
  return trimmed.length < 4 || TRIVIAL_LINES.has(trimmed);
}

// KNOWN LIMITATION (inherited from the Headroom reference implementation,
// confirmed present in cross_turn_dedup.py's `_pointer`/`m[2]` too — not a
// JS-port regression): `refLine` indexes into the referenced block's
// pre-fold, original-length verbatim array. If that block itself already
// folded an earlier duplicate into a pointer line, its *displayed* text is
// shorter than this indexing assumes, so line numbers can point past what's
// actually shown for that turn. Only triggers when a referenced block (a)
// contains a fold of its own AND (b) has unique content after that fold
// which a later block then references. MUST be fixed (recompute against the
// referenced block's actual rendered position, not its raw verbatim index)
// before this module is wired into any live compression path.
function makePointer(span, refTurn, refLine) {
  let anchor = span.find((line) => line.trim())?.trim() ?? '';
  if (anchor.length > 80) anchor = `${anchor.slice(0, 77)}...`;
  const endLine = refLine + span.length - 1;
  return `[myelin: ${span.length} lines identical to output shown earlier (turn ${refTurn}, lines ${refLine}-${endLine}) — starts: ${JSON.stringify(anchor)}]`;
}

function indexLines(lines, blockIndex, anchorIndex) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === null || isTrivialLine(line)) continue;
    const bucket = anchorIndex.get(line) ?? [];
    if (bucket.length < MAX_ANCHOR_CANDIDATES) {
      bucket.push([blockIndex, lineIndex]);
      if (!anchorIndex.has(line)) anchorIndex.set(line, bucket);
    }
  }
}

function longestMatch(currentLines, startIndex, anchorIndex, corpus) {
  const anchor = currentLines[startIndex];
  const candidates = anchorIndex.get(anchor);
  if (!candidates?.length) return null;

  let bestLength = 0;
  let bestBlockIndex = -1;
  let bestLineIndex = -1;

  for (const [blockIndex, lineIndex] of candidates) {
    const blockLines = corpus[blockIndex];
    let matchLength = 0;
    while (
      startIndex + matchLength < currentLines.length
      && lineIndex + matchLength < blockLines.length
      && blockLines[lineIndex + matchLength] !== null
      && currentLines[startIndex + matchLength] === blockLines[lineIndex + matchLength]
    ) {
      matchLength += 1;
    }

    if (matchLength > bestLength) {
      bestLength = matchLength;
      bestBlockIndex = blockIndex;
      bestLineIndex = lineIndex;
    }
  }

  return bestLength === 0 ? null : [bestLength, bestBlockIndex, bestLineIndex];
}

/**
 * Prefix-monotonic cross-turn verbatim folding.
 *
 * @param {Array<{text: string, turn: number, protected?: boolean}>} blocks
 * @param {{minLines?: number, minChars?: number}} [options]
 */
export function dedupBlocks(
  blocks,
  { minLines = DEFAULT_MIN_LINES, minChars = DEFAULT_MIN_CHARS } = {},
) {
  const stats = { spansFolded: 0, linesRemoved: 0, charsRemoved: 0, blocks: blocks.length };

  try {
    const corpus = [];
    const anchorIndex = new Map();
    const outputBlocks = [];

    for (const block of blocks) {
      const lines = block.text.split('\n');

      if (block.protected) {
        const verbatim = [...lines];
        indexLines(verbatim, corpus.length, anchorIndex);
        corpus.push(verbatim);
        outputBlocks.push({ ...block });
        continue;
      }

      const outputLines = [];
      const verbatim = [];
      let index = 0;

      while (index < lines.length) {
        const match = longestMatch(lines, index, anchorIndex, corpus);
        if (match !== null && match[0] >= minLines) {
          const span = lines.slice(index, index + match[0]);
          const spanText = span.join('\n');
          if (spanText.length >= minChars) {
            const refTurn = blocks[match[1]].turn;
            const pointer = makePointer(span, refTurn, match[2]);
            outputLines.push(pointer);
            verbatim.push(...Array(match[0]).fill(null));
            stats.spansFolded += 1;
            stats.linesRemoved += match[0];
            stats.charsRemoved += spanText.length - pointer.length;
            index += match[0];
            continue;
          }
        }

        outputLines.push(lines[index]);
        verbatim.push(lines[index]);
        index += 1;
      }

      indexLines(verbatim, corpus.length, anchorIndex);
      corpus.push(verbatim);
      outputBlocks.push({
        ...block,
        text: outputLines.join('\n'),
        protected: false,
      });
    }

    return { blocks: outputBlocks, stats };
  } catch {
    return {
      blocks,
      stats: { spansFolded: 0, linesRemoved: 0, charsRemoved: 0, error: true },
    };
  }
}

/**
 * @param {Array<{text: string, turn: number, protected?: boolean}>} blocks
 * @param {{minLines?: number, minChars?: number}} [options]
 */
export function isPrefixMonotonic(
  blocks,
  { minLines = DEFAULT_MIN_LINES, minChars = DEFAULT_MIN_CHARS } = {},
) {
  const full = dedupBlocks(blocks, { minLines, minChars });
  const fullTexts = full.blocks.map((block) => block.text);

  for (let end = 1; end <= blocks.length; end += 1) {
    const partial = dedupBlocks(blocks.slice(0, end), { minLines, minChars });
    const partialTexts = partial.blocks.map((block) => block.text);
    if (JSON.stringify(partialTexts) !== JSON.stringify(fullTexts.slice(0, end))) {
      return false;
    }
  }

  return true;
}
