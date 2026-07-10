/**
 * Tag protector — preserves XML-like tag patterns through compression.
 *
 * Replaces protected opening/closing tag patterns with stable opaque tokens
 * before the compression pipeline runs, then restores them after.
 *
 * Protected patterns: any <identifier> or </identifier> where identifier
 * matches [a-zA-Z][a-zA-Z0-9_:-]* (XML Name production, simplified).
 * We protect PAIRED tags — only patterns where both <tag> and </tag> appear
 * in the same text (unpaired angle brackets are left alone).
 *
 * Design: tokens are short stable strings (TAG_OPEN_0, TAG_CLOSE_0, etc.)
 * that the compaction algorithms will treat as opaque identifiers and never
 * split, collapse, or deduplicate across.
 */

// Match <tagname> and </tagname> but NOT HTML entities, comments, CDATA,
// or processing instructions.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9_:-]{0,63})(?:\s[^>]*)?\/?>/g;
const TOKEN_PREFIX = '\x00HL_TAG_';
const TOKEN_SUFFIX = '\x00';

/**
 * Scan text for paired XML-like tags, replace with opaque tokens.
 * Returns { protected: string, restoreMap: Map<token, original> }
 */
export function protectTags(text) {
  // Collect all unique tag names that appear as both open and close.
  const openTags = new Set();
  const closeTags = new Set();

  for (const match of text.matchAll(TAG_RE)) {
    const full = match[0];
    const name = match[1];
    if (full.startsWith('</')) {
      closeTags.add(name);
    } else {
      openTags.add(name);
    }
  }

  // Only protect tags that are paired (both open and close present).
  const pairedNames = new Set([...openTags].filter((name) => closeTags.has(name)));

  if (pairedNames.size === 0) {
    return { protected: text, restoreMap: new Map() };
  }

  // Build restoreMap: token → original string.
  // We need to map every distinct full tag string (e.g. "<file>", "</file>").
  const tokenByOriginal = new Map();
  const restoreMap = new Map();
  let tokenIndex = 0;

  // First pass: enumerate all distinct tag strings for paired names.
  for (const match of text.matchAll(TAG_RE)) {
    const full = match[0];
    const name = match[1];
    if (!pairedNames.has(name)) continue;
    if (tokenByOriginal.has(full)) continue;

    const token = `${TOKEN_PREFIX}${tokenIndex}${TOKEN_SUFFIX}`;
    tokenByOriginal.set(full, token);
    restoreMap.set(token, full);
    tokenIndex += 1;
  }

  // Second pass: replace all occurrences.
  let result = text;
  for (const [original, token] of tokenByOriginal) {
    // Escape special regex chars in the original tag string for safe replacement.
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), token);
  }

  return { protected: result, restoreMap };
}

/**
 * Restore tokens back to original tag strings.
 */
export function restoreTags(text, restoreMap) {
  let result = text;
  for (const [token, original] of restoreMap) {
    if (!result.includes(token)) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), original);
  }
  return result;
}

/**
 * Wrap a text transform function to protect tags before + restore after.
 */
export function withTagProtection(text, transformFn) {
  const { protected: safeText, restoreMap } = protectTags(text);
  const transformed = transformFn(safeText);
  return restoreTags(transformed, restoreMap);
}
