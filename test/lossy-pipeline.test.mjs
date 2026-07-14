import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compressMessages, compressMessagesAsync } from '../src/compress/pipeline.mjs';

const originalFetch = globalThis.fetch;

function installFetch(handler) {
  globalThis.fetch = handler;
}

function longProse(prefix = 'prose word ') {
  // Ensure ≥1500 chars regardless of prefix length; use unique-ish content
  const chunk = prefix + 'sentence with some content to keep length ample. ';
  return chunk.repeat(50);
}

const LOSSY_DISABLED = { enabled: false };
const LOSSY_ENABLED = {
  enabled: true,
  serviceUrl: 'http://mock',
  backend: 'llmlingua2',
  modelName: 'test-model',
  targetRate: 0.5,
  timeoutMs: 1000,
  minChars: 1000,
  maxChars: 60000,
  maxBatchChars: 120000,
  failClosed: false,
  compressCode: false,
};

describe('compressMessagesAsync', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('with lossy disabled: returns sync compressMessages output plus lossy meta', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const sync = compressMessages(messages);
    const asyncOut = await compressMessagesAsync(messages, { lossy: LOSSY_DISABLED });
    assert.deepEqual(asyncOut.messages, sync.messages);
    assert.equal(asyncOut.tokensBefore, sync.tokensBefore);
    assert.equal(asyncOut.tokensAfter, sync.tokensAfter);
    assert.equal(asyncOut.frozenCount, sync.frozenCount);
    assert.deepEqual(asyncOut.lossy, { enabled: false });
  });

  it('runs deterministic lossless compression before sending candidates to lossy compression', async () => {
    const repeatedLog = Array.from(
      { length: 12 },
      () => '[INFO] repeated event payload for ordering test',
    ).join('\n');
    const messages = [
      { role: 'user', content: repeatedLog },
      { role: 'assistant', content: 'latest reply' },
    ];
    let requestedText = null;

    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedText = body.items[0]?.text;
      return new Response(JSON.stringify({
        items: body.items.map((item) => ({ id: item.id, text: item.text, compressed: false })),
      }), { status: 200 });
    });

    await compressMessagesAsync(messages, {
      format: 'openai',
      lossy: { ...LOSSY_ENABLED, minChars: 10 },
    });

    assert.match(requestedText, /\.\.\. \(repeated 12 times\)/);
    assert.doesNotMatch(requestedText, /(?:\[INFO\].*\n){11}\[INFO\]/);
  });

  it('Anthropic: frozen messages remain byte-exact even when service compresses later ones', async () => {
    const frozenText = 'FROZEN cached preamble ' + longProse();
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: frozenText, cache_control: { type: 'ephemeral' } },
      ] },
      { role: 'user', content: longProse('second ') },
      { role: 'assistant', content: 'latest reply' },
    ];

    installFetch(async () => {
      // Service returns "compressed" for all inputs — deterministic short text.
      const req = { items: [] }; // ignored: we compute response from candidates below
      const response = {
        items: [
          { id: 'm1:text', text: 'compressed short', compressed: true },
        ],
      };
      return new Response(JSON.stringify(response), { status: 200 });
    });

    const out = await compressMessagesAsync(messages, { lossy: LOSSY_ENABLED });
    // Frozen preamble MUST be byte-exact
    assert.equal(out.messages[0].content[0].text, frozenText);
    assert.equal(out.frozenCount, 1);
    // Second (non-latest) message compressed to short
    assert.equal(out.messages[1].content, 'compressed short');
    // Latest untouched
    assert.equal(out.messages[2].content, 'latest reply');
    assert.equal(out.lossy.applied, 1);
    assert.equal(out.lossy.rejected, 0);
    assert.equal(out.lossy.attempted, 1);
  });

  it('OpenAI frozenCount=0: all non-latest eligible messages are considered', async () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'assistant', content: longProse('b ') },
      { role: 'user', content: 'latest short' },
    ];

    let requestedIds = null;
    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedIds = body.items.map((it) => it.id);
      return new Response(JSON.stringify({
        items: body.items.map((it) => ({ id: it.id, text: 'shorty', compressed: true })),
      }), { status: 200 });
    });

    const out = await compressMessagesAsync(messages, { format: 'openai', lossy: LOSSY_ENABLED });
    assert.equal(out.frozenCount, 0);
    // Two candidates (msg 0 and 1); latest skipped
    assert.equal(requestedIds.length, 2);
    assert.equal(out.lossy.attempted, 2);
    assert.equal(out.lossy.applied, 2);
    assert.equal(out.messages[0].content, 'shorty');
    assert.equal(out.messages[1].content, 'shorty');
    assert.equal(out.messages[2].content, 'latest short');
  });

  it('latest message skipped when compressLive=false', async () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'assistant', content: longProse('b ') }, // latest
    ];
    let requestedIds = [];
    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedIds = body.items.map((it) => it.id);
      return new Response(JSON.stringify({
        items: body.items.map((it) => ({ id: it.id, text: 'short', compressed: true })),
      }), { status: 200 });
    });
    const out = await compressMessagesAsync(messages, { format: 'openai', compressLive: false, lossy: LOSSY_ENABLED });
    assert.equal(requestedIds.length, 1);
    assert.equal(out.lossy.attempted, 1);
  });

  it('latest message eligible when compressLive=true', async () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'assistant', content: longProse('b ') },
    ];
    let requestedIds = [];
    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedIds = body.items.map((it) => it.id);
      return new Response(JSON.stringify({
        items: body.items.map((it) => ({ id: it.id, text: 'short', compressed: true })),
      }), { status: 200 });
    });
    const out = await compressMessagesAsync(messages, { format: 'openai', compressLive: true, lossy: LOSSY_ENABLED });
    assert.equal(requestedIds.length, 2);
    assert.equal(out.lossy.attempted, 2);
  });

  it('tool_use.input blocks remain byte-exact (not sent to service)', async () => {
    const bigInput = { command: longProse('cmd ') };
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'run', input: bigInput },
        { type: 'text', text: longProse('reasoning ') },
      ] },
      { role: 'user', content: 'latest' },
    ];
    let requestedIds = [];
    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedIds = body.items.map((it) => it.id);
      return new Response(JSON.stringify({
        items: body.items.map((it) => ({ id: it.id, text: 'short', compressed: true })),
      }), { status: 200 });
    });
    const out = await compressMessagesAsync(messages, { format: 'openai', lossy: LOSSY_ENABLED });
    // Only the text block was sent
    assert.equal(requestedIds.length, 1);
    assert.equal(requestedIds[0], 'm0:b1:text');
    // Tool use input preserved byte-exact
    assert.deepEqual(out.messages[0].content[0].input, bigInput);
    // Reasoning text was compressed
    assert.equal(out.messages[0].content[1].text, 'short');
  });

  it('rejects service result that fails the guard (original text retained)', async () => {
    // Original is a >10-line log; service returns a single line with no newlines → guard rejects.
    const longLog = Array.from({ length: 20 }, (_, i) => `[INFO] event ${i} some data`).join('\n');
    const paddedLog = longLog + '\n' + longProse('pad ');
    const messages = [
      { role: 'assistant', content: paddedLog },
      { role: 'user', content: 'latest' },
    ];

    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        items: body.items.map((it) => ({ id: it.id, text: 'single line no newlines', compressed: true })),
      }), { status: 200 });
    });

    const out = await compressMessagesAsync(messages, { format: 'openai', lossy: LOSSY_ENABLED });
    assert.equal(out.lossy.attempted, 1);
    assert.equal(out.lossy.applied, 0);
    assert.equal(out.lossy.rejected, 1);
    // Original text is retained (compression not applied)
    assert.ok(typeof out.messages[0].content === 'string' && out.messages[0].content.includes('[INFO] event 0'));
  });

  it('service timeout fails open: original messages returned', async () => {
    const messages = [
      { role: 'user', content: longProse('a ') },
      { role: 'user', content: longProse('b ') },
      { role: 'assistant', content: 'latest' },
    ];

    installFetch(async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{}', { status: 200 })), 500);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));

    const cfg = { ...LOSSY_ENABLED, timeoutMs: 20 };
    const out = await compressMessagesAsync(messages, { format: 'openai', lossy: cfg });
    // Non-latest messages retained (fail-open leaves compressed=false ⇒ nothing applied)
    assert.equal(out.lossy.applied, 0);
    assert.ok(out.lossy.rejected >= 1);
    // Content should still be present (post-deterministic-lossless, but starting substring intact)
    assert.ok(typeof out.messages[0].content === 'string');
  });

  it('applied and rejected counts reflect per-item outcomes', async () => {
    const messages = [
      { role: 'user', content: longProse('a ') }, // will be compressed
      { role: 'assistant', content: longProse('b ') }, // guard-rejected
      { role: 'user', content: 'latest' },
    ];
    installFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      const items = body.items.map((it) => {
        if (it.id === 'm0:text') return { id: it.id, text: 'shorter valid', compressed: true };
        // Give too-long text so guard rejects (compressed.length >= original.length)
        return { id: it.id, text: it.text + 'more', compressed: true };
      });
      return new Response(JSON.stringify({ items }), { status: 200 });
    });
    const out = await compressMessagesAsync(messages, { format: 'openai', lossy: LOSSY_ENABLED });
    assert.equal(out.lossy.attempted, 2);
    assert.equal(out.lossy.applied, 1);
    assert.equal(out.lossy.rejected, 1);
  });
});

// ── Fix test: tokensAfter re-estimated when lossy applied ─────────────────


describe('compressMessagesAsync — CR fix: tokensAfter re-estimated', () => {
  it('tokensAfter < tokensBefore when lossy was applied', async () => {
    const bigText = 'The quick brown fox jumps over the lazy dog. '.repeat(30);
    const compressed = 'Fox jumps dog.'; // much shorter
    const messages = [
      { role: 'user', content: bigText },
      { role: 'user', content: 'latest message' },
    ];
    const lossy = {
      enabled: true,
      serviceUrl: 'http://unused',
      backend: 'stub',
      modelName: 'stub',
      targetRate: 0.5,
      timeoutMs: 5000,
      minChars: 10,
      maxChars: 60000,
      maxBatchChars: 120000,
      failClosed: false,
      compressCode: false,
      // Inject a mock fetch for this test
      _mockFetch: async () => ({
        ok: true,
        json: async () => ({
          items: [{ id: 'm0:text', text: compressed, compressed: true,
                    originalChars: bigText.length, compressedChars: compressed.length }],
        }),
      }),
    };
    // Patch global fetch for the duration of this test
    const origFetch = globalThis.fetch;
    globalThis.fetch = lossy._mockFetch;
    try {
      const result = await compressMessagesAsync(messages, { lossy, compressLive: false });
      assert.ok(result.lossy.applied > 0, 'expected at least 1 applied');
      assert.ok(result.tokensAfter < result.tokensBefore,
        `tokensAfter (${result.tokensAfter}) should be < tokensBefore (${result.tokensBefore})`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
