import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compressTexts } from '../src/lossy/client.mjs';

const BASE_CONFIG = {
  serviceUrl: 'http://127.0.0.1:8791',
  backend: 'llmlingua2',
  modelName: 'microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank',
  targetRate: 0.5,
  timeoutMs: 100,
  failClosed: false,
};

const originalFetch = globalThis.fetch;

function installFetch(handler) {
  globalThis.fetch = handler;
}

describe('compressTexts', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty items when input is empty', async () => {
    let called = false;
    installFetch(async () => { called = true; throw new Error('should not fetch'); });
    const out = await compressTexts([], BASE_CONFIG);
    assert.deepEqual(out, { items: [] });
    assert.equal(called, false);
  });

  it('returns empty items when input is null', async () => {
    installFetch(async () => { throw new Error('should not fetch'); });
    const out = await compressTexts(null, BASE_CONFIG);
    assert.deepEqual(out, { items: [] });
  });

  it('returns service response on success', async () => {
    const response = {
      items: [{ id: 'a', text: 'shorter', compressed: true, originalChars: 20, compressedChars: 7, backend: 'llmlingua2', modelName: 'm' }],
    };
    installFetch(async () => new Response(JSON.stringify(response), { status: 200 }));
    const out = await compressTexts([{ id: 'a', text: 'some long text', kind: 'prose' }], BASE_CONFIG);
    assert.deepEqual(out, response);
  });

  it('fails open on HTTP 4xx when failClosed=false', async () => {
    installFetch(async () => new Response('nope', { status: 400 }));
    const out = await compressTexts([{ id: 'a', text: 'hello world', kind: 'prose' }], BASE_CONFIG);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].compressed, false);
    assert.equal(out.items[0].text, 'hello world');
    assert.match(out.items[0].error, /HTTP 400/);
  });

  it('throws on HTTP 4xx when failClosed=true', async () => {
    installFetch(async () => new Response('nope', { status: 400 }));
    await assert.rejects(
      () => compressTexts([{ id: 'a', text: 'x', kind: 'prose' }], { ...BASE_CONFIG, failClosed: true }),
      /HTTP 400/,
    );
  });

  it('fails open on network error when failClosed=false', async () => {
    installFetch(async () => { throw new Error('econnrefused'); });
    const out = await compressTexts([{ id: 'a', text: 'hello', kind: 'prose' }], BASE_CONFIG);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].compressed, false);
    assert.equal(out.items[0].text, 'hello');
    assert.match(out.items[0].error, /econnrefused/);
  });

  it('throws on network error when failClosed=true', async () => {
    installFetch(async () => { throw new Error('econnrefused'); });
    await assert.rejects(
      () => compressTexts([{ id: 'a', text: 'x', kind: 'prose' }], { ...BASE_CONFIG, failClosed: true }),
      /econnrefused/,
    );
  });

  it('fails open on timeout', async () => {
    installFetch(async (_url, init) => {
      // Delay longer than timeoutMs; respect the AbortSignal to reject fast.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}', { status: 200 })), 500);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const abortErr = new Error(init.signal.reason?.message || 'aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    });
    const out = await compressTexts(
      [{ id: 'a', text: 'hello world', kind: 'prose' }],
      { ...BASE_CONFIG, timeoutMs: 30 },
    );
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].compressed, false);
    assert.equal(out.items[0].text, 'hello world');
    assert.ok(typeof out.items[0].error === 'string' && out.items[0].error.length > 0);
  });

  it('fail-open items preserve original text and mark compressed=false', async () => {
    installFetch(async () => new Response('nope', { status: 500 }));
    const items = [
      { id: 'a', text: 'first', kind: 'prose' },
      { id: 'b', text: 'second longer text', kind: 'log' },
    ];
    const out = await compressTexts(items, BASE_CONFIG);
    assert.equal(out.items.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(out.items[i].id, items[i].id);
      assert.equal(out.items[i].text, items[i].text);
      assert.equal(out.items[i].compressed, false);
      assert.equal(out.items[i].originalChars, items[i].text.length);
      assert.equal(out.items[i].compressedChars, items[i].text.length);
      assert.equal(out.items[i].backend, BASE_CONFIG.backend);
    }
  });
});
