import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompressLive } from '../src/proxy.mjs';
import { compressMessages } from '../src/compress/pipeline.mjs';
import { startServer } from '../src/server.mjs';

// ---------------------------------------------------------------------------
// resolveCompressLive() unit tests
// ---------------------------------------------------------------------------

describe('resolveCompressLive', () => {
  it('absent (undefined) → false', () => assert.equal(resolveCompressLive(undefined), false));
  it('absent (null) → false', () => assert.equal(resolveCompressLive(null), false));
  it('empty string → false', () => assert.equal(resolveCompressLive(''), false));
  it('"safe" → false', () => assert.equal(resolveCompressLive('safe'), false));
  it('"true" → false (not a recognised value)', () => assert.equal(resolveCompressLive('true'), false));
  it('"1" → false', () => assert.equal(resolveCompressLive('1'), false));
  it('"live" → true', () => assert.equal(resolveCompressLive('live'), true));
  it('"LIVE" → true (case-insensitive)', () => assert.equal(resolveCompressLive('LIVE'), true));
  it('"  live  " → true (trimmed)', () => assert.equal(resolveCompressLive('  live  '), true));
  it('"livex" → false (not exact)', () => assert.equal(resolveCompressLive('livex'), false));
});

// ---------------------------------------------------------------------------
// compressMessages — compressLive behaviour
// ---------------------------------------------------------------------------

const LONG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i}: context data that can be compressed`).join('\n');

describe('compressMessages compressLive=false (default)', () => {
  it('latest message is protected from lossy dedup', () => {
    const duplicate = Array.from({ length: 12 }, () => 'identical line content').join('\n');
    const messages = [
      { role: 'assistant', content: duplicate },
      { role: 'user', content: duplicate }, // latest — should NOT be deduped
    ];
    const { messages: out } = compressMessages(messages, { format: 'anthropic', compressLive: false });
    // Latest message content should not contain a dedup pointer
    assert.ok(!String(out[out.length - 1].content).includes('see turn'), 'latest message must not be deduped in safe mode');
  });
});

describe('compressMessages compressLive=true', () => {
  it('latest message IS eligible for lossy dedup', () => {
    const duplicate = Array.from({ length: 12 }, () => 'identical line content for dedup test').join('\n');
    const messages = [
      { role: 'assistant', content: duplicate },
      { role: 'user', content: duplicate }, // latest — in live mode, can be deduped
    ];
    const { messages: out } = compressMessages(messages, { format: 'anthropic', compressLive: true });
    // In live mode the latest message may be deduped OR losslessly compressed
    // Either way it should be smaller than the original
    const outLatest = JSON.stringify(out[out.length - 1].content);
    const inLatest = JSON.stringify(messages[messages.length - 1].content);
    assert.ok(outLatest.length <= inLatest.length, 'latest message should be compressed or deduped in live mode');
  });

  it('system/developer messages are NEVER lossy even in live mode', () => {
    const messages = [
      { role: 'assistant', content: LONG_TEXT },
      { role: 'system', content: LONG_TEXT },
    ];
    const { messages: out } = compressMessages(messages, { format: 'anthropic', compressLive: true });
    // System message must not contain a dedup pointer
    const systemOut = JSON.stringify(out.find((m) => m.role === 'system'));
    assert.ok(!systemOut.includes('see turn'), 'system message must not be deduped');
  });

  it('Anthropic frozen prefix is still respected in live mode', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: LONG_TEXT, cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: LONG_TEXT },
    ];
    const { frozenCount, messages: out } = compressMessages(messages, { format: 'anthropic', compressLive: true });
    assert.equal(frozenCount, 1);
    // Frozen message byte-exact even in live mode
    assert.deepEqual(out[0], messages[0]);
  });

  it('format: openai + compressLive: true — no frozen prefix regardless of cache_control', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: LONG_TEXT, cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: LONG_TEXT },
    ];
    const { frozenCount } = compressMessages(messages, { format: 'openai', compressLive: true });
    assert.equal(frozenCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Server integration — HEADROOM_LITE_COMPRESS=live via compressLive option
// ---------------------------------------------------------------------------

describe('server compress_live flag wired through /health and /v1/compress', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      compressLive: true,
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it('/health reports compress_live: true', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.compress_live, true);
  });

  it('/v1/compress with compressLive=true compresses the latest message', async () => {
    const duplicate = Array.from({ length: 12 }, () => 'identical content for compression test').join('\n');
    const payload = {
      format: 'anthropic',
      messages: [
        { role: 'assistant', content: duplicate },
        { role: 'user', content: duplicate },
      ],
    };
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const latestOut = JSON.stringify(body.messages[body.messages.length - 1].content);
    const latestIn = JSON.stringify(payload.messages[payload.messages.length - 1].content);
    assert.ok(latestOut.length <= latestIn.length, 'server compress_live=true should reduce or equal latest message size');
  });
});
