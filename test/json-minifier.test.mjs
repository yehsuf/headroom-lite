import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { minifyJson, MIN_JSON_BYTES } from '../src/compress/json-minifier.mjs';

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
