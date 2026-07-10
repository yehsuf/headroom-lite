import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTextKind, collectLossyCandidates } from '../src/compress/lossy-eligibility.mjs';

function longProse(prefix = 'prose ') {
  // Ensure ≥1500 chars regardless of prefix length
  const chunk = prefix + 'sentence here to add unique content. ';
  return chunk.repeat(50); // ~ 50 * (prefix.length + 37) chars
}

describe('classifyTextKind', () => {
  it('classifies diff', () => {
    assert.equal(classifyTextKind('diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y'), 'diff');
    assert.equal(classifyTextKind('--- a/x\n+++ b/x'), 'diff');
  });
  it('classifies stack trace with "at X.method"', () => {
    assert.equal(classifyTextKind('    at Object.foo (/a.js:1)\n    at Module.bar (/b.js:2)'), 'stack_trace');
  });
  it('classifies stack trace with "Traceback:"', () => {
    assert.equal(classifyTextKind('Traceback: something\nFile "x.py", line 3'), 'stack_trace');
  });
  it('classifies log with [INFO]', () => {
    assert.equal(classifyTextKind('[INFO] started service'), 'log');
  });
  it('classifies code by keywords', () => {
    assert.equal(classifyTextKind('function foo() { return 1; }'), 'code');
    assert.equal(classifyTextKind('class Bar {}'), 'code');
    assert.equal(classifyTextKind('def baz():\n    pass'), 'code');
  });
  it('classifies plain prose', () => {
    assert.equal(classifyTextKind('this is just a plain english paragraph with nothing special.'), 'prose');
  });
});

describe('collectLossyCandidates', () => {
  it('never includes messages before frozenCount', () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'assistant', content: longProse('b ') },
      { role: 'user', content: longProse('c ') },
      { role: 'assistant', content: 'short reply' },
    ];
    const candidates = collectLossyCandidates(messages, { frozenCount: 2 });
    // msg 0 and 1 are frozen; msg 3 (latest) is skipped; only msg 2 eligible
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].msgIdx, 2);
  });

  it('skips system and developer roles', () => {
    const messages = [
      { role: 'system', content: longProse('sys ') },
      { role: 'developer', content: longProse('dev ') },
      { role: 'assistant', content: 'reply' },
    ];
    const candidates = collectLossyCandidates(messages);
    assert.equal(candidates.length, 0);
  });

  it('skips latest message when compressLive=false', () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'user', content: longProse('b ') },
    ];
    const candidates = collectLossyCandidates(messages, { compressLive: false });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].msgIdx, 0);
  });

  it('includes latest message when compressLive=true', () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'user', content: longProse('b ') },
    ];
    const candidates = collectLossyCandidates(messages, { compressLive: true });
    assert.equal(candidates.length, 2);
  });

  it('skips tool_use and tool_result blocks', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'x', input: { long: longProse('args ') } },
        { type: 'text', text: longProse('should include ') },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: longProse('tool ') }] },
      ] },
      { role: 'assistant', content: 'latest' },
    ];
    const candidates = collectLossyCandidates(messages);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].msgIdx, 0);
    assert.equal(candidates[0].contentIdx, 1);
  });

  it('skips signed blocks (blocks with a signature key)', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'text', text: longProse('signed '), signature: 'abc' },
        { type: 'text', text: longProse('unsigned ') },
      ] },
      { role: 'user', content: 'latest' },
    ];
    const candidates = collectLossyCandidates(messages);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].contentIdx, 1);
  });

  it('skips text shorter than minChars', () => {
    const messages = [
      { role: 'user', content: 'short' },
      { role: 'user', content: 'latest' },
    ];
    const candidates = collectLossyCandidates(messages, { minChars: 1000 });
    assert.equal(candidates.length, 0);
  });

  it('skips code by default; includes it when compressCode=true', () => {
    const codeText = 'function foo() { }\n' + longProse('body ');
    const messages = [
      { role: 'assistant', content: codeText },
      { role: 'user', content: 'latest' },
    ];
    const defaultOut = collectLossyCandidates(messages);
    assert.equal(defaultOut.length, 0);

    const includedOut = collectLossyCandidates(messages, { compressCode: true });
    assert.equal(includedOut.length, 1);
    assert.equal(includedOut[0].kind, 'code');
  });

  it('skips blocks with cache_control set', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'text', text: longProse('cached '), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: longProse('not cached ') },
      ] },
      { role: 'user', content: 'latest' },
    ];
    const candidates = collectLossyCandidates(messages);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].contentIdx, 1);
  });
});
