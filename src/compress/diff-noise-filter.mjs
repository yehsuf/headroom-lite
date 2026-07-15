/**
 * Filter noise from unified diff text before compression.
 *
 * Returns filtered diff string. May return empty string if entire diff
 * was noise. Never returns undefined/null.
 *
 * Noise categories:
 *   1. Binary file diffs (no useful content)
 *   2. Lockfile diffs (package-lock.json, yarn.lock, Cargo.lock, pnpm-lock.yaml,
 *      poetry.lock, Gemfile.lock, composer.lock, go.sum)
 *   3. Hunks where every +/- line is whitespace-only
 */

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'Cargo.lock', 'pnpm-lock.yaml',
  'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
]);

function normalizeDiffLines(diffText) {
  return diffText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''));
}

function getFilename(sectionLines) {
  for (const line of sectionLines) {
    const gitMatch = line.match(/^diff --git a\/(.+) b\/.+$/);
    if (gitMatch) return gitMatch[1].split('/').pop();
    if (line.startsWith('--- ')) {
      // --- a/path/to/file or --- path/to/file
      const path = line.replace(/^--- (a\/)?/, '');
      if (path !== '/dev/null') return path.split('/').pop();
    }
  }
  return null;
}

function isBinarySection(sectionLines) {
  return sectionLines.some(
    (line) => line.includes('Binary files') && line.includes('differ'),
  );
}

function filterWhitespaceHunks(sectionLines) {
  // Collect header lines (everything before the first @@ hunk marker)
  const headerLines = [];
  let hunkStart = -1;
  for (let i = 0; i < sectionLines.length; i += 1) {
    if (sectionLines[i].startsWith('@@')) {
      hunkStart = i;
      break;
    }
    headerLines.push(sectionLines[i]);
  }

  // No hunks — return as-is (e.g. rename-only or mode-change diff)
  if (hunkStart === -1) return sectionLines;

  // Split remainder into individual hunks
  const hunks = [];
  let currentHunk = [];
  for (let i = hunkStart; i < sectionLines.length; i += 1) {
    if (sectionLines[i].startsWith('@@') && currentHunk.length > 0) {
      hunks.push(currentHunk);
      currentHunk = [sectionLines[i]];
    } else {
      currentHunk.push(sectionLines[i]);
    }
  }
  if (currentHunk.length > 0) hunks.push(currentHunk);

  // Drop hunks where every +/- line is whitespace-only
  const filteredHunks = hunks.filter((hunk) => {
    const changedLines = hunk.filter(
      (line) => line.startsWith('+') || line.startsWith('-'),
    );
    if (changedLines.length === 0) return false;
    if (changedLines.every((line) => line.slice(1).trim() === '')) return false;

    const removed = hunk.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
    const added = hunk.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
    if (removed.length > 0 && removed.length === added.length &&
        removed.every((line, index) => line === added[index])) {
      return false;
    }

    return true;
  });

  // If all hunks were noise, drop the whole section (header included)
  if (filteredHunks.length === 0) return [];

  return [...headerLines, ...filteredHunks.flat()];
}

export function filterDiffNoise(diffText) {
  if (!diffText) return '';

  const lines = normalizeDiffLines(diffText);

  // Use `diff --git` boundaries when present; fall back to `--- ` for plain patches
  const hasGitHeaders = lines.some((l) => l.startsWith('diff --git '));

  const sections = [];
  let current = null;

  for (const line of lines) {
    const isStart = hasGitHeaders
      ? line.startsWith('diff --git ')
      : line.startsWith('--- ');

    if (isStart) {
      if (current !== null) sections.push(current);
      current = [line];
    } else {
      if (current === null) current = [];
      current.push(line);
    }
  }
  if (current !== null) sections.push(current);

  if (sections.length === 0) return diffText;

  const kept = [];
  for (const section of sections) {
    if (isBinarySection(section)) continue;

    const filename = getFilename(section);
    if (filename !== null && LOCKFILE_NAMES.has(filename)) continue;

    const filtered = filterWhitespaceHunks(section);
    if (filtered.length > 0) kept.push(filtered);
  }

  return kept.map((s) => s.join('\n')).join('\n');
}
