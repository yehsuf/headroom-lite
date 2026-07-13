import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESPONSES_MIN_BYTES,
  identifyLiveZone,
  compressResponsesInput,
} from '../src/compress/responses.mjs';

// A large, compressible tool output (search-row shape -> lossless search-heading).
const bigOutput = Array.from({ length: 60 }, (_, i) =>
  `src/services/handler.mjs:${i}:  return process(item[${i}], ctx);`).join('\n');
assert.ok(Buffer.byteLength(bigOutput) >= RESPONSES_MIN_BYTES);

const smallOutput = 'ok: done';

function fco(id, output) {
  return { type: 'function_call_output', id: `fco_${id}`, call_id: `call_${id}`, output };
}
function fc(id, name) {
  return { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: '{"q":"x"}' };
}
function userMsg(text) {
  return { type: 'message', role: 'user', content: text };
}

describe('identifyLiveZone', () => {
  it('picks the latest of each output kind and the latest user message', () => {
    const items = [
      userMsg('first'),
      fco(1, bigOutput),
      fco(2, bigOutput),
      { type: 'local_shell_call_output', id: 'ls1', call_id: 'c', output: bigOutput },
      userMsg('latest question'),
    ];
    const { messageIdx, outputIdxByKind } = identifyLiveZone(items);
    assert.equal(messageIdx, 4);
    assert.equal(outputIdxByKind.get('function_call_output'), 2); // latest, not 1
    assert.equal(outputIdxByKind.get('local_shell_call_output'), 3);
  });
});

describe('compressResponsesInput — live zone only', () => {
  it('compresses the latest output of a kind but freezes earlier ones', () => {
    const items = [
      fco(1, bigOutput),        // earlier -> FROZEN (byte-identical)
      fc(2, 'read'),
      fco(2, bigOutput),        // latest fco -> compressed (not the last item)
      userMsg('go'),            // last item -> protected (and <512B anyway)
    ];
    const r = compressResponsesInput(items);
    assert.equal(r.items[0].output, bigOutput, 'earlier fco frozen');
    assert.ok(r.items[2].output.length < bigOutput.length, 'latest fco compressed');
    assert.ok(r.tokensAfter < r.tokensBefore);
  });

  it('never mutates passthrough items/fields', () => {
    const items = [
      fc(1, 'grep'),
      { type: 'reasoning', id: 'r1', encrypted_content: 'OPAQUE_BLOB', summary: [{ type: 'summary_text', text: 'x' }] },
      { type: 'apply_patch_call', id: 'ap1', call_id: 'c', operation: { diff: '*** patch\n@@ -1 +1 @@\n-a\n+b' } },
      { type: 'local_shell_call', id: 'ls1', call_id: 'c', action: { command: ['bash', '-c', 'echo hi'] } },
      { type: 'compaction', id: 'cp1', encrypted_content: 'BLOB2' },
      fco(9, bigOutput),        // latest fco (not last item) -> compressed
      userMsg('done'),
    ];
    const before = JSON.parse(JSON.stringify(items));
    const r = compressResponsesInput(items);
    // The ORIGINAL input array is never mutated (compression works on a clone).
    assert.deepEqual(items, before);
    // arguments untouched
    assert.equal(r.items[0].arguments, before[0].arguments);
    // reasoning opaque untouched
    assert.equal(r.items[1].encrypted_content, 'OPAQUE_BLOB');
    // apply_patch diff untouched (re-serializing breaks apply)
    assert.deepEqual(r.items[2].operation, before[2].operation);
    // shell argv array untouched (not stringified)
    assert.deepEqual(r.items[3].action.command, ['bash', '-c', 'echo hi']);
    // compaction opaque untouched
    assert.equal(r.items[4].encrypted_content, 'BLOB2');
    // types + ids preserved everywhere
    assert.deepEqual(r.items.map((x) => x.type), before.map((x) => x.type));
    assert.equal(r.items[5].call_id, 'call_9');
  });

  it('skips outputs below the byte floor', () => {
    const items = [fco(1, smallOutput), userMsg('go')];
    const r = compressResponsesInput(items);
    assert.equal(r.items[0].output, smallOutput, 'small output untouched');
  });

  it('protects the current turn (last item) unless compressLive', () => {
    const items = [fc(1, 'grep'), fco(1, 'ignored'), userMsg(bigOutput)]; // last item is a big user msg
    const rDefault = compressResponsesInput(items);
    assert.equal(rDefault.items[2].content, bigOutput, 'last item protected by default');
    const rLive = compressResponsesInput(items, { compressLive: true });
    assert.ok(rLive.items[2].content.length < bigOutput.length, 'compressLive compresses the last item');
  });

  it('handles message content as a content-parts array', () => {
    const items = [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: bigOutput },
        { type: 'input_image', image_url: 'data:...' },
      ] },                       // latest user message, not the last item -> compressed
      fc(9, 'read'),             // trailing non-message item
    ];
    const r = compressResponsesInput(items);
    assert.ok(r.items[0].content[0].text.length < bigOutput.length, 'text part compressed');
    assert.equal(r.items[0].content[1].image_url, 'data:...', 'non-text part untouched');
  });

  it('is a no-op passthrough when there is no live zone', () => {
    const items = [fc(1, 'grep'), { type: 'reasoning', id: 'r', encrypted_content: 'B' }];
    const before = JSON.parse(JSON.stringify(items));
    const r = compressResponsesInput(items);
    assert.deepEqual(r.items, before);
    assert.equal(r.frozenCount, 2);
  });
});
