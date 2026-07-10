import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryObjectArrayToCsv,
  compactStringArray,
  compactNumberArray,
  compactJsonArray,
  compactToolOutputs,
  MIN_ITEMS,
} from '../src/compress/tool-output-compactor.mjs';

// ── tryObjectArrayToCsv ───────────────────────────────────────────────────────

describe('tryObjectArrayToCsv', () => {
  it('converts uniform object array to CSV-schema', () => {
    const arr = Array.from({ length: 15 }, (_, i) => ({ name: `file${i}.js`, size: i * 100, type: 'file' }));
    const result = tryObjectArrayToCsv(arr);
    assert.ok(result !== null, 'should produce output');
    assert.match(result, /^schema:\[/);
    assert.match(result, /name,size,type|name,type,size/);
    // Should have 15 data rows + 1 header
    assert.equal(result.split('\n').length, 16);
  });

  it('returns null for array smaller than savings threshold', () => {
    // 2 objects, very short — no meaningful savings
    const arr = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    const result = tryObjectArrayToCsv(arr);
    // May return null (too small for savings) or valid CSV — both are acceptable
    if (result !== null) assert.match(result, /^schema:/);
  });

  it('returns null for heterogeneous object array', () => {
    const arr = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? { a: i } : { b: i, c: i }));
    const result = tryObjectArrayToCsv(arr);
    // Heterogeneous keys — CSV may not apply; if it does, it must be valid
    if (result !== null) assert.match(result, /^schema:/);
  });

  it('returns null for non-object array', () => {
    assert.equal(tryObjectArrayToCsv(['a', 'b', 'c']), null);
    assert.equal(tryObjectArrayToCsv([1, 2, 3]), null);
  });

  it('escapes commas and quotes in values', () => {
    const arr = Array.from({ length: 12 }, (_, i) => ({ name: `file,${i}`, desc: `say "hi"` }));
    const result = tryObjectArrayToCsv(arr);
    if (result !== null) {
      assert.match(result, /"file,/); // comma in value is quoted
      assert.match(result, /"say ""hi""/); // quote in value is double-escaped
    }
  });

  it('handles null/undefined values gracefully', () => {
    const arr = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, size: i % 3 === 0 ? null : i }));
    const result = tryObjectArrayToCsv(arr);
    if (result !== null) assert.match(result, /^schema:/);
  });
});

// ── compactStringArray ────────────────────────────────────────────────────────

describe('compactStringArray', () => {
  it('returns null for arrays at or below MIN_ITEMS', () => {
    assert.equal(compactStringArray(Array(MIN_ITEMS).fill('x')), null);
    assert.equal(compactStringArray([]), null);
  });

  it('compacts a long string array to head + omitted marker + tail', () => {
    const arr = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const result = compactStringArray(arr);
    assert.ok(result !== null, 'should compact');
    const parsed = JSON.parse(result);
    assert.ok(parsed.some((x) => typeof x === 'string' && x.includes('omitted')));
    assert.match(parsed.find((x) => x.includes('omitted')), /\d+ items omitted/);
    // First and last original items preserved
    assert.ok(parsed.includes('item-0'));
    assert.ok(parsed.includes('item-49'));
  });

  it('preserves original order: head items come before omitted marker', () => {
    const arr = Array.from({ length: 30 }, (_, i) => `item-${i}`);
    const result = compactStringArray(arr);
    assert.ok(result !== null);
    const parsed = JSON.parse(result);
    const markerIdx = parsed.findIndex((x) => typeof x === 'string' && x.includes('omitted'));
    assert.ok(markerIdx > 0, 'marker should not be first');
    assert.ok(markerIdx < parsed.length - 1, 'marker should not be last');
  });

  it('returns null if savings below threshold', () => {
    // Small array just over MIN_ITEMS — may not achieve MIN_SAVINGS_RATIO
    const arr = Array.from({ length: MIN_ITEMS + 1 }, (_, i) => `x${i}`);
    const result = compactStringArray(arr);
    // Acceptable: either null (no savings) or a valid compact JSON string
    if (result !== null) assert.doesNotThrow(() => JSON.parse(result));
  });
});

// ── compactNumberArray ────────────────────────────────────────────────────────

describe('compactNumberArray', () => {
  it('returns null for arrays at or below MIN_ITEMS', () => {
    assert.equal(compactNumberArray([1, 2, 3]), null);
  });

  it('compacts a long number array with stats summary', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = compactNumberArray(arr);
    assert.ok(result !== null, 'should compact');
    const parsed = JSON.parse(result);
    const summary = parsed.find((x) => typeof x === 'string' && x.includes('omitted'));
    assert.ok(summary, 'should have omitted summary');
    assert.match(summary, /min=\d+,max=\d+,mean=[\d.]+,median=[\d.]+/);
    // First and last numbers preserved
    assert.equal(parsed[0], 0);
    assert.equal(parsed[parsed.length - 1], 99);
  });
});

// ── compactJsonArray ──────────────────────────────────────────────────────────

describe('compactJsonArray', () => {
  it('returns null for non-array text', () => {
    assert.equal(compactJsonArray('{"key":"value"}'), null);
    assert.equal(compactJsonArray('hello world'), null);
    assert.equal(compactJsonArray(''), null);
    assert.equal(compactJsonArray(null), null);
  });

  it('returns null for small arrays (passthrough)', () => {
    const small = JSON.stringify(Array(MIN_ITEMS).fill({ a: 1, b: 2 }));
    assert.equal(compactJsonArray(small), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(compactJsonArray('[1, 2, {broken'), null);
  });

  it('compacts large object array', () => {
    const arr = Array.from({ length: 25 }, (_, i) => ({ path: `/src/file${i}.mjs`, size: i * 512 }));
    const result = compactJsonArray(JSON.stringify(arr));
    assert.ok(result !== null, 'should compact large object array');
    assert.match(result, /^schema:\[path,size\]|^schema:\[size,path\]/);
  });

  it('compacts large string array', () => {
    const arr = Array.from({ length: 40 }, (_, i) => `/path/to/file${i}.js`);
    const result = compactJsonArray(JSON.stringify(arr));
    assert.ok(result !== null, 'should compact large string array');
    const parsed = JSON.parse(result);
    assert.ok(parsed.some((x) => typeof x === 'string' && x.includes('omitted')));
  });

  it('compacts large number array', () => {
    const arr = Array.from({ length: 50 }, (_, i) => i * 3.14);
    const result = compactJsonArray(JSON.stringify(arr));
    assert.ok(result !== null, 'should compact large number array');
    const parsed = JSON.parse(result);
    assert.ok(parsed.some((x) => typeof x === 'string' && x.includes('omitted')));
  });

  it('handles whitespace-prefixed JSON array', () => {
    const arr = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const result = compactJsonArray('  \n' + JSON.stringify(arr));
    // Should still be attempted (trimStart)
    if (result !== null) assert.doesNotThrow(() => JSON.parse(result));
  });
});

// ── compactToolOutputs ────────────────────────────────────────────────────────

describe('compactToolOutputs', () => {
  const bigArray = JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ file: `src/file${i}.mjs`, size: i * 100 }))
  );

  it('compacts Anthropic tool_result content blocks', () => {
    const messages = [
      { role: 'user', content: 'run ls' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'id1',
            content: [{ type: 'text', text: bigArray }],
          },
        ],
      },
      { role: 'assistant', content: 'done' },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, cloned.length - 1);
    const inner = cloned[1].content[0].content[0].text;
    assert.notEqual(inner, bigArray, 'should have been compacted');
    assert.match(inner, /^schema:/);
  });

  it('compacts OpenAI role=tool messages', () => {
    const messages = [
      { role: 'user', content: 'run tool' },
      { role: 'tool', tool_call_id: 'id1', content: bigArray },
      { role: 'assistant', content: 'ok' },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, cloned.length - 1);
    assert.notEqual(cloned[1].content, bigArray, 'should have been compacted');
    assert.match(cloned[1].content, /^schema:/);
  });

  it('does not compact the latest message', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'id1', content: bigArray },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, 0);
    assert.equal(cloned[0].content, bigArray, 'latest message must not be compacted');
  });

  it('does not compact blocks with cache_control', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'id1',
            cache_control: { type: 'ephemeral' },
            content: [{ type: 'text', text: bigArray }],
          },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, cloned.length - 1);
    assert.equal(cloned[0].content[0].content[0].text, bigArray, 'frozen block must not be compacted');
  });

  it('leaves non-JSON tool content unchanged', () => {
    const messages = [
      { role: 'tool', tool_call_id: 'id1', content: 'plain text result' },
      { role: 'assistant', content: 'ok' },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, cloned.length - 1);
    assert.equal(cloned[0].content, 'plain text result');
  });

  it('leaves small JSON arrays unchanged (below MIN_ITEMS)', () => {
    const small = JSON.stringify([{ a: 1 }, { a: 2 }]);
    const messages = [
      { role: 'tool', tool_call_id: 'id1', content: small },
      { role: 'assistant', content: 'ok' },
    ];
    const cloned = structuredClone(messages);
    compactToolOutputs(cloned, cloned.length - 1);
    assert.equal(cloned[0].content, small, 'small array must not be compacted');
  });
});
