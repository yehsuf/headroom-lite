import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { minifyJson, minifyJsonSequence, MIN_JSON_BYTES } from '../src/compress/json-minifier.mjs';

// A formatted JSON object well over MIN_JSON_BYTES
const LARGE_FORMATTED_OBJ = JSON.stringify(
  {
    name: 'headroom-lite',
    version: '0.1.0',
    description: 'Deterministic context compression sidecar for the headroom API contract.',
    keywords: ['compression', 'context', 'llm', 'tokens'],
    config: { maxTokens: 8192, strategy: 'lossless', fallback: true },
    tags: ['production', 'stable', 'reviewed'],
  },
  null,
  2,
);

// A formatted JSON array well over MIN_JSON_BYTES
const LARGE_FORMATTED_ARR = JSON.stringify(
  Array.from({ length: 20 }, (_, i) => ({ id: i, value: `item-${i}`, active: i % 2 === 0 })),
  null,
  2,
);

describe('minifyJson', () => {
  it('returns non-string input unchanged', () => {
    assert.equal(minifyJson(null), null);
    assert.equal(minifyJson(undefined), undefined);
    assert.equal(minifyJson(42), 42);
  });

  it('returns small JSON (< MIN_JSON_BYTES) unchanged', () => {
    const small = '{"a":1}';
    assert.ok(small.length < MIN_JSON_BYTES);
    assert.equal(minifyJson(small), small);
  });

  it('returns string unchanged if it does not start with { or [', () => {
    const notJson = 'x'.repeat(MIN_JSON_BYTES);
    assert.equal(minifyJson(notJson), notJson);

    const quotedStr = `"${'x'.repeat(MIN_JSON_BYTES)}"`;
    assert.equal(minifyJson(quotedStr), quotedStr);
  });

  it('returns invalid JSON unchanged', () => {
    const invalid = `{${'x'.repeat(MIN_JSON_BYTES)}`;
    assert.equal(minifyJson(invalid), invalid);
  });

  it('minifies a large formatted JSON object', () => {
    assert.ok(LARGE_FORMATTED_OBJ.length >= MIN_JSON_BYTES, 'test fixture must be large enough');
    const result = minifyJson(LARGE_FORMATTED_OBJ);
    assert.ok(result.length < LARGE_FORMATTED_OBJ.length, 'minified must be smaller');
    assert.deepEqual(JSON.parse(result), JSON.parse(LARGE_FORMATTED_OBJ));
    assert.ok(!result.includes('\n'), 'minified must have no newlines');
    assert.ok(!result.includes('  '), 'minified must have no double spaces');
  });

  it('minifies a large formatted JSON array', () => {
    assert.ok(LARGE_FORMATTED_ARR.length >= MIN_JSON_BYTES, 'test fixture must be large enough');
    const result = minifyJson(LARGE_FORMATTED_ARR);
    assert.ok(result.length < LARGE_FORMATTED_ARR.length, 'minified must be smaller');
    assert.deepEqual(JSON.parse(result), JSON.parse(LARGE_FORMATTED_ARR));
  });

  it('returns already-minified JSON unchanged (no size improvement)', () => {
    const minified = JSON.stringify(
      { a: 1, b: 'hello world', c: [1, 2, 3], d: null, e: true, f: false, g: 'x'.repeat(180) },
    );
    assert.ok(minified.length >= MIN_JSON_BYTES, 'test fixture must be large enough');
    const result = minifyJson(minified);
    assert.equal(result, minified);
  });

  it('preserves string values that contain internal whitespace', () => {
    const obj = { message: '  hello   world  \n  spaces preserved  ', other: 'x'.repeat(150) };
    const formatted = JSON.stringify(obj, null, 2);
    assert.ok(formatted.length >= MIN_JSON_BYTES);
    const result = minifyJson(formatted);
    assert.equal(JSON.parse(result).message, obj.message);
  });

  it('preserves numbers, booleans, and null exactly', () => {
    const obj = {
      int: 42,
      float: 3.14159,
      neg: -7,
      bool_true: true,
      bool_false: false,
      nil: null,
      padding: 'x'.repeat(150),
    };
    const formatted = JSON.stringify(obj, null, 2);
    assert.ok(formatted.length >= MIN_JSON_BYTES);
    const result = JSON.parse(minifyJson(formatted));
    assert.equal(result.int, 42);
    assert.equal(result.float, 3.14159);
    assert.equal(result.neg, -7);
    assert.equal(result.bool_true, true);
    assert.equal(result.bool_false, false);
    assert.equal(result.nil, null);
  });
});

// Helper: build a large space-separated JSON sequence over MIN_JSON_BYTES
function makeLargeSequence(n = 3) {
  return Array.from({ length: n }, (_, i) => JSON.stringify({
    id: i,
    url: `https://example.com/result/${i}`,
    title: `Result ${i}  with  extra   spaces`,
    score: Number((0.9 - i * 0.1).toFixed(2)),
  }, null, 2)).join(' ');
}

describe('minifyJsonSequence', () => {
  it('returns null for non-string input', () => {
    assert.equal(minifyJsonSequence(null), null);
    assert.equal(minifyJsonSequence(undefined), null);
    assert.equal(minifyJsonSequence(42), null);
  });

  it('returns null for small input (< MIN_JSON_BYTES)', () => {
    const small = '{"a":1} {"b":2}';
    assert.ok(small.length < MIN_JSON_BYTES);
    assert.equal(minifyJsonSequence(small), null);
  });

  it('returns null for a single JSON object', () => {
    const single = JSON.stringify({ id: 0, title: 'x'.repeat(200) }, null, 2);
    assert.ok(single.length >= MIN_JSON_BYTES);
    assert.equal(minifyJsonSequence(single), null);
  });

  it('returns null for a JSON array', () => {
    const arr = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ id: i, v: 'x'.repeat(40) })), null, 2);
    assert.ok(arr.length >= MIN_JSON_BYTES);
    assert.equal(minifyJsonSequence(arr), null);
  });

  it('returns null for non-JSON content', () => {
    assert.equal(minifyJsonSequence('x'.repeat(MIN_JSON_BYTES + 1)), null);
  });

  it('minifies a large space-separated sequence', () => {
    const seq = makeLargeSequence(3);
    assert.ok(seq.length >= MIN_JSON_BYTES);
    const result = minifyJsonSequence(seq);
    assert.ok(result !== null, 'should minify');
    assert.ok(result.length < seq.length, 'result must be smaller');
  });

  it('result has no inter-field whitespace', () => {
    // Use objects WITHOUT spaces in values to verify structural whitespace is stripped
    const objs = Array.from({ length: 3 }, (_, i) => ({ id: i, tag: `item${i}`, score: i * 0.1, padding: 'x'.repeat(60) }));
    const seq = objs.map((o) => JSON.stringify(o, null, 2)).join(' ');
    assert.ok(seq.length >= MIN_JSON_BYTES, 'fixture must be large enough');
    const result = minifyJsonSequence(seq);
    assert.ok(result !== null);
    // No newlines or structural spacing
    assert.ok(!result.includes('\n'), 'must have no newlines');
    // Verify each object individually is compact JSON (no surrounding whitespace)
    const parts = result.split(/(?<=\})\s+(?=\{)/u);
    for (const part of parts) {
      assert.equal(part, JSON.stringify(JSON.parse(part)));
    }
  });

  it('preserves object values exactly (lossless round-trip)', () => {
    const objs = [
      { id: 1, url: 'https://example.com', score: 0.9 },
      { id: 2, url: 'https://other.com/path', score: 0.8 },
      { id: 3, url: 'https://third.org', score: 0.7 },
    ];
    // Make it big enough
    const padded = objs.map((o) => ({ ...o, padding: 'x'.repeat(60) }));
    const seq = padded.map((o) => JSON.stringify(o, null, 2)).join(' ');
    assert.ok(seq.length >= MIN_JSON_BYTES);
    const result = minifyJsonSequence(seq);
    assert.ok(result !== null);
    // Re-parse by splitting on object boundaries
    const reparsed = result.split(/(?<=\})\s+(?=\{)/u).map((s) => JSON.parse(s));
    assert.equal(reparsed.length, padded.length);
    for (let i = 0; i < padded.length; i += 1) {
      assert.equal(reparsed[i].id, padded[i].id);
      assert.equal(reparsed[i].url, padded[i].url);
      assert.equal(reparsed[i].score, padded[i].score);
    }
  });

  it('handles strings containing literal "} {" without false-positive split', () => {
    const objs = [
      { text: 'data} {embedded', value: 1, padding: 'a'.repeat(60) },
      { text: 'normal', value: 2, padding: 'b'.repeat(60) },
    ];
    const seq = objs.map((o) => JSON.stringify(o, null, 2)).join(' ');
    assert.ok(seq.length >= MIN_JSON_BYTES);
    const result = minifyJsonSequence(seq);
    assert.ok(result !== null);
    // The embedded "} {" in a string must not corrupt the output
    assert.ok(result.includes('"data} {embedded"'), 'string value must be preserved');
  });

  it('returns null when already compact (no size improvement)', () => {
    const objs = Array.from({ length: 3 }, (_, i) => ({ i, v: 'x'.repeat(60) }));
    const alreadyCompact = objs.map((o) => JSON.stringify(o)).join(' ');
    assert.ok(alreadyCompact.length >= MIN_JSON_BYTES);
    assert.equal(minifyJsonSequence(alreadyCompact), null);
  });
});

describe('minifyJson — sequence passthrough', () => {
  it('minifies a space-separated sequence via minifyJson (single-parse fail path)', () => {
    const seq = makeLargeSequence(3);
    assert.ok(seq.length >= MIN_JSON_BYTES);
    const result = minifyJson(seq);
    assert.ok(result.length < seq.length, 'minifyJson must compress the sequence');
    assert.ok(!result.includes('\n'));
  });

  it('leaves non-JSON plain text unchanged via minifyJson', () => {
    const text = 'hello world ' + 'x'.repeat(MIN_JSON_BYTES);
    assert.equal(minifyJson(text), text);
  });
});
