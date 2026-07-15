import { estimateTokenCount } from '../lib/estimate-tokens.mjs';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RUN_MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/;
const GREP_ROW_RE = /^(?<path>[^\n:]+):(?<line>\d+):(?<content>.*)$/;
const HEADING_ROW_RE = /^(?<line>\d+):(?<content>.*)$/;
const DIFF_INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+( [0-7]+)?$/;
const PATH_ROW_RE = /^(?<dir>(?:\.{0,2}\/)?(?:[^/\s:]+\/)+)(?<base>[^/\s:]+)$/;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

function splitKeepTrailing(text) {
  if (text === '') return { lines: [], hadTrailingNewline: false };
  const hadTrailingNewline = text.endsWith('\n');
  const body = hadTrailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), hadTrailingNewline };
}

function joinLines(lines, hadTrailingNewline) {
  const output = lines.join('\n');
  return hadTrailingNewline ? `${output}\n` : output;
}

export function collapseRuns(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;

  const output = [];
  let index = 0;

  while (index < lines.length) {
    let end = index;
    while (end + 1 < lines.length && lines[end + 1] === lines[index]) end += 1;
    const runLength = end - index + 1;
    output.push(lines[index]);
    if (runLength >= 2) output.push(`... (repeated ${runLength} times)`);
    index = end + 1;
  }

  return joinLines(output, hadTrailingNewline);
}

export function expandRuns(text, { maxOutputLength = Number.POSITIVE_INFINITY } = {}) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;

  const output = [];
  let expandedLength = 0;
  let outputLineCount = 0;
  let index = 0;

  const addLinesWithinBudget = (line, runLength, maxOutputLength) => {
    if (runLength === 0) return;
    const repeatedLineLength = line.length + 1;
    const firstLineLength = line.length + (hadTrailingNewline ? 1 : 0);
    const growth = outputLineCount === 0
      ? firstLineLength + ((runLength - 1) * repeatedLineLength)
      : runLength * repeatedLineLength;

    if (expandedLength + growth > maxOutputLength) {
      throw new Error('expanded output exceeds verification budget');
    }

    expandedLength += growth;
    outputLineCount += runLength;
  };

  while (index < lines.length) {
    const line = lines[index];
    const marker = index + 1 < lines.length ? lines[index + 1].match(RUN_MARKER_RE) : null;
    if (marker) {
      const runLength = Number(marker[1]);
      if (!Number.isSafeInteger(runLength)) {
        throw new Error('run marker exceeds supported integer range');
      }
      addLinesWithinBudget(line, runLength, maxOutputLength);
      for (let repeat = 0; repeat < runLength; repeat += 1) output.push(line);
      index += 2;
      continue;
    }
    addLinesWithinBudget(line, 1, maxOutputLength);
    output.push(line);
    index += 1;
  }

  return joinLines(output, hadTrailingNewline);
}

export function isRunCollapsed(text) {
  return text.split('\n').some((line) => RUN_MARKER_RE.test(line));
}

export function searchHeading(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;

  const output = [];
  let currentPath = null;

  for (const line of lines) {
    const match = line.match(GREP_ROW_RE);
    if (match?.groups) {
      const { path, line: lineNumber, content } = match.groups;
      if (path !== currentPath) {
        output.push(path);
        currentPath = path;
      }
      output.push(`${lineNumber}:${content}`);
      continue;
    }
    output.push(line);
    currentPath = null;
  }

  return joinLines(output, hadTrailingNewline);
}

export function searchUnheading(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;

  const output = [];
  let currentPath = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dataMatch = line.match(HEADING_ROW_RE);
    if (currentPath !== null && dataMatch?.groups) {
      output.push(`${currentPath}:${dataMatch.groups.line}:${dataMatch.groups.content}`);
      continue;
    }

    const nextIsData = index + 1 < lines.length && HEADING_ROW_RE.test(lines[index + 1]);
    if (!dataMatch && nextIsData) {
      currentPath = line;
      continue;
    }

    currentPath = null;
    output.push(line);
  }

  return joinLines(output, hadTrailingNewline);
}

export function diffStripIndex(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;
  return joinLines(lines.filter((line) => !DIFF_INDEX_RE.test(line)), hadTrailingNewline);
}

export function pathHeading(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (lines.filter((line) => PATH_ROW_RE.test(line)).length < 2) return text;

  const output = [];
  let currentDir = null;

  for (const line of lines) {
    const match = line.match(PATH_ROW_RE);
    if (match?.groups) {
      const { dir, base } = match.groups;
      if (dir !== currentDir) {
        output.push(dir);
        currentDir = dir;
      }
      output.push(base);
      continue;
    }
    output.push(line);
    currentDir = null;
  }

  return joinLines(output, hadTrailingNewline);
}

export function pathUnheading(text) {
  const { lines, hadTrailingNewline } = splitKeepTrailing(text);
  if (!lines.length) return text;

  const output = [];
  let currentDir = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isBasename = line !== '' && !line.includes('/');
    if (currentDir !== null && isBasename) {
      output.push(currentDir + line);
      continue;
    }

    const nextIsBasename = index + 1 < lines.length && lines[index + 1] !== '' && !lines[index + 1].includes('/');
    if (line.endsWith('/') && nextIsBasename) {
      currentDir = line;
      continue;
    }

    currentDir = null;
    output.push(line);
  }

  return joinLines(output, hadTrailingNewline);
}

function savesTokens(candidate, original) {
  return estimateTokenCount(candidate) < estimateTokenCount(original);
}

export function compactLossless(content, kind) {
  if (!content) return content;

  try {
    if (kind === 'log') {
      const baseline = stripAnsi(content);
      const candidate = collapseRuns(baseline);
      // Verification only needs to rebuild up to the original baseline length.
      // Anything larger can only come from an input-authored fake marker, so
      // bail out before allocating a disproportionate temporary buffer.
      if (expandRuns(candidate, { maxOutputLength: baseline.length }) !== baseline) return content;
      return savesTokens(candidate, content) ? candidate : content;
    }

    if (kind === 'search') {
      const candidate = searchHeading(content);
      if (searchUnheading(candidate) !== content) return content;
      return savesTokens(candidate, content) ? candidate : content;
    }

    if (kind === 'paths') {
      const candidate = pathHeading(content);
      if (pathUnheading(candidate) !== content) return content;
      return savesTokens(candidate, content) ? candidate : content;
    }

    if (kind === 'diff') {
      const candidate = diffStripIndex(content);
      return savesTokens(candidate, content) ? candidate : content;
    }

    if (kind === 'text') {
      const candidate = collapseRuns(content);
      // See the log path above: round-trip verification should never need to
      // reconstruct more than the original text length.
      if (expandRuns(candidate, { maxOutputLength: content.length }) !== content) return content;
      return savesTokens(candidate, content) ? candidate : content;
    }
  } catch {
    return content;
  }

  return content;
}
