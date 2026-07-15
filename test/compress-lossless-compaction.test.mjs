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
});
