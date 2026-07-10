import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, startServer } from '../src/server.mjs';

const originalFetch = globalThis.fetch;

function installFetch(handler) {
  globalThis.fetch = handler;
}

function longProse(prefix = 'prose ') {
  const chunk = prefix + 'sentence with content to keep length ample. ';
  return chunk.repeat(50);
}

describe('server with lossy DISABLED (default)', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      lossyConfig: {
        enabled: false,
        serviceUrl: 'http://127.0.0.1:8791',
        backend: 'llmlingua2',
        modelName: 'test-model',
      },
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('/health includes lossy field with enabled=false', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.lossy, {
      enabled: false,
      backend: 'llmlingua2',
      service_url: 'http://127.0.0.1:8791',
    });
  });

  it('/v1/compress response omits lossy field when disabled', async () => {
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal('lossy' in body, false);
    assert.ok(Array.isArray(body.messages));
  });
});

describe('server with lossy ENABLED (mock service)', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      lossyConfig: {
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
      },
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('/v1/compress response includes lossy field when enabled', async () => {
    // Preserve real fetch for the client → server call; only intercept the mock service.
    const realFetch = originalFetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith('http://mock')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          items: body.items.map((it) => ({ id: it.id, text: 'short', compressed: true })),
        }), { status: 200 });
      }
      return realFetch(url, init);
    };

    const res = await realFetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'openai',
        messages: [
          { role: 'user', content: longProse('a ') },
          { role: 'assistant', content: 'reply' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.lossy, 'response body should have a lossy field');
    assert.equal(body.lossy.enabled, true);
    assert.equal(typeof body.lossy.attempted, 'number');
    assert.equal(typeof body.lossy.applied, 'number');
    assert.equal(typeof body.lossy.rejected, 'number');
  });
});

describe('proxy path is not affected by lossy config (SSE passthrough)', () => {
  it('createServer accepts lossyConfig and does not disturb proxy setup', () => {
    const srv = createServer({
      maxBodyBytes: 1024 * 1024,
      lossyConfig: { enabled: true, serviceUrl: 'x', backend: 'llmlingua2', modelName: 'm' },
    });
    // Just verify server is constructed and can be closed cleanly
    srv.close();
  });
});
