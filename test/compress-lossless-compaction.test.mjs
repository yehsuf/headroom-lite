import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  collapseRuns,
  compactLossless,
  expandRuns,
  searchHeading,
  searchUnheading,
} from '../src/compress/lossless-compaction.mjs';
import { estimateTokenCount } from '../src/lib/estimate-tokens.mjs';

describe('lossless compaction', () => {
  it('round-trips grep-shaped search output exactly', () => {
    const original = [
      'src/a.js:10:const alpha = 1;',
      'src/a.js:11:const beta = 2;',
      'src/b.js:3:export function gamma() {}',
      '',
    ].join('\n');

    const compacted = compactLossless(original, 'search');

    assert.equal(compacted, searchHeading(original));
    assert.equal(searchUnheading(compacted), original);
  });

  it('collapses repeated log lines and stays reversible against the de-ANSI baseline', () => {
    const original = [
      '\u001b[32minfo\u001b[0m build step ok',
      '\u001b[32minfo\u001b[0m build step ok',
      '\u001b[32minfo\u001b[0m build step ok',
      'warn cache miss',
      '',
    ].join('\n');

    const compacted = compactLossless(original, 'log');

    assert.match(compacted, /\.\.\. \(repeated 3 times\)/);
    assert.equal(expandRuns(compacted), 'info build step ok\ninfo build step ok\ninfo build step ok\nwarn cache miss\n');
  });

  it('falls back to the original text when a marker collision would lose information', () => {
    const original = 'alpha\n... (repeated 3 times)\nomega\n';

    assert.equal(compactLossless(original, 'text'), original);
  });

  it('falls back when compaction does not actually shrink the output', () => {
    const original = 'single line only\n';

    assert.equal(compactLossless(original, 'text'), original);
  });

  it('short-circuits fake embedded run markers that exceed the verification budget', () => {
    const original = [
      'alpha',
      'alpha',
      'beta',
      '... (repeated 100000 times)',
      'omega',
      '',
    ].join('\n');
    const candidate = collapseRuns(original);

    assert.throws(
      () => expandRuns(candidate, { maxOutputLength: original.length }),
      /verification budget/,
    );
    assert.equal(compactLossless(original, 'text'), original);
  });

  it('keeps verified folds that save tokens even when they do not save characters', () => {
    const original = Array.from({ length: 5 }, () => 'a-b').join('\n');
    const folded = 'a-b\n... (repeated 5 times)';

    assert.ok(folded.length > original.length, 'fixture must not be accepted by character length');
    assert.ok(estimateTokenCount(folded) < estimateTokenCount(original), 'fixture must save estimated tokens');
    assert.equal(compactLossless(original, 'text'), folded);
  });

  it('rejects folds that shrink characters but do not save estimated tokens', () => {
    const original = Array.from({ length: 2 }, () => 'a'.repeat(23)).join('\n');
    const folded = `${'a'.repeat(23)}\n... (repeated 2 times)`;

    assert.ok(folded.length < original.length, 'fixture would pass the old character-length gate');
    assert.ok(estimateTokenCount(folded) > estimateTokenCount(original), 'fixture must not save estimated tokens');
    assert.equal(compactLossless(original, 'text'), original);
  });

  // Regression: GH #2140 — diff fold must not delete lines from non-diff content
  describe('compactLossless diff guard (GH #2140)', () => {
    it('strips index lines from genuine unified diffs', () => {
      const diff = [
        'diff --git a/foo.js b/foo.js',
        'index abc1234..def5678 100644',
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -1,3 +1,3 @@',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 3;',
      ].join('\n') + '\n';
      const result = compactLossless(diff, 'diff');
      assert.ok(!result.includes('index abc1234..def5678'), 'index line must be stripped from real diff');
      assert.ok(result.includes('@@ -1,3'), 'hunk header must be preserved');
    });

    it('does NOT strip index lines from log/text content containing index-shaped lines', () => {
      // A build log that happens to contain a git-object reference — must not lose that line
      const buildLog = [
        '[build] starting webpack compilation',
        'index 1a2b3c4..5d6e7f8 — this is a stash reference in a log, not a diff',
        '[build] module resolved: src/app.js',
        '[build] compilation complete',
      ].join('\n');
      // Content has no @@ hunk header, so the diff guard should block stripping
      const result = compactLossless(buildLog, 'diff');
      assert.equal(result, buildLog, 'log content with index-like line must be returned unchanged');
    });

    it('does NOT strip index lines from content that has index line but no hunk header', () => {
      const noHunk = [
        'diff --git a/x.txt b/x.txt',
        'index aabbcc..ddeeff 100644',
        '--- a/x.txt',
        '+++ b/x.txt',
        // No @@ hunk header — malformed / partial diff
        '+some added line',
      ].join('\n');
      const result = compactLossless(noHunk, 'diff');
      assert.equal(result, noHunk, 'content without @@ hunk header must be returned unchanged');
    });

    it('does NOT strip index lines from source code containing index-pattern comments', () => {
      const sourceCode = [
        '// Cache key: index a1b2c3..d4e5f6',
        'function hashCommit(sha) {',
        '  return sha.slice(0, 7);',
        '}',
      ].join('\n');
      const result = compactLossless(sourceCode, 'diff');
      assert.equal(result, sourceCode, 'source code with index-pattern comment must be unchanged');
    });
  });
});
