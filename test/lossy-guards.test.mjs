import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompressedText } from '../src/compress/lossy-guards.mjs';

describe('validateCompressedText', () => {
  it('rejects empty compressed', () => {
    assert.equal(validateCompressedText('some original text', '', 'prose'), false);
    assert.equal(validateCompressedText('some original text', null, 'prose'), false);
  });

  it('rejects when compressed is not shorter than original', () => {
    assert.equal(validateCompressedText('abc', 'abc', 'prose'), false);
    assert.equal(validateCompressedText('abc', 'abcdef', 'prose'), false);
  });

  it('accepts a valid shorter prose compression', () => {
    const orig = 'This is a longer paragraph of prose that we want to compress.';
    const comp = 'shorter paragraph.';
    assert.equal(validateCompressedText(orig, comp, 'prose'), true);
  });

  it('rejects unbalanced fenced code blocks', () => {
    const orig = 'text\n```\ncode\n```\nmore';
    const comp = 'text\n```\ncode\nmore';
    assert.equal(validateCompressedText(orig, comp, 'prose'), false);
  });

  it('rejects stack_trace when final error line is missing', () => {
    const orig = [
      '    at fn1 (/a.js:1)',
      '    at fn2 (/b.js:2)',
      '    at fn3 (/c.js:3)',
      '    at fn4 (/d.js:4)',
      '    at fn5 (/e.js:5)',
      '    at fn6 (/f.js:6)',
      'Error: something bad happened uniquely_identifiable_token',
    ].join('\n');
    const comp = [
      '    at fn1 (/a.js:1)',
      '    at fn3 (/c.js:3)',
      '    at fn5 (/e.js:5)',
    ].join('\n');
    assert.equal(validateCompressedText(orig, comp, 'stack_trace'), false);
  });

  it('rejects stack_trace when path:line anchor coverage < 80%', () => {
    const orig = Array.from({ length: 10 }, (_, i) => `    at fn${i} (/path${i}.js:${i + 1})`).join('\n');
    const comp = [
      '    at fn0 (/path0.js:1)',
      '    at fn1 (/path1.js:2)',
      '    at fn9 (/path9.js:10)',
    ].join('\n');
    assert.equal(validateCompressedText(orig, comp, 'stack_trace'), false);
  });

  it('accepts stack_trace when path:line anchors ≥ 80% and last line preserved', () => {
    const lastLine = '    at fnLast (/path_last.js:99)';
    const orig = [
      '    at fn0 (/path0.js:1)',
      '    at fn1 (/path1.js:2)',
      '    at fn2 (/path2.js:3)',
      '    at fn3 (/path3.js:4)',
      '    at fn4 (/path4.js:5)',
      '    at fn5 (/path5.js:6)',
      lastLine,
    ].join('\n');
    const comp = [
      '    at fn0 (/path0.js:1)',
      '    at fn1 (/path1.js:2)',
      '    at fn2 (/path2.js:3)',
      '    at fn3 (/path3.js:4)',
      '    at fn5 (/path5.js:6)',
      lastLine,
    ].join('\n');
    assert.equal(validateCompressedText(orig, comp, 'stack_trace'), true);
  });

  it('rejects when >10-line original is compressed to 0 newlines', () => {
    const orig = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
    const comp = 'one long line no newlines';
    assert.equal(validateCompressedText(orig, comp, 'prose'), false);
  });
});
