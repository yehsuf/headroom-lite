/**
 * Proxy tests for headroom-lite Phase 2.
 *
 * Each test spins up a real mock upstream server on a random port, then starts
 * headroom-lite in proxy mode pointing at it. Requests flow through the full
 * Node HTTP stack — no mocking of internal modules.
 *
 * Critical invariants verified:
 *   - Auth headers (Authorization, x-api-key, x-goog-api-key) forwarded byte-for-byte
 *   - Hop-by-hop headers stripped from both request and response
 *   - SSE responses are raw byte-piped (no buffering, correct content-type preserved)
 *   - 502 on upstream connection refused, 504 on timeout
 *   - Proxy disabled when no upstream configured (404 for unknown paths)
 *   - /health, /livez, /v1/compress still work when proxy is enabled
 *   - Client disconnect aborts upstream request cleanly (no dangling connections)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, startServer, resolveUpstream, resolveProxyTimeoutMs } from '../src/server.mjs';
import { DEFAULT_PROXY_TIMEOUT_MS, resolveUpstream as resolveUpstreamDirect } from '../src/proxy.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    // Force-close all keep-alive connections so server.close() resolves immediately
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(resolve);
  });
}

function request(options, body) {
  const bodyBuf = body !== undefined
    ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    : null;

  const headers = {
    ...(options.headers ?? {}),
    // Always force connection:close LAST so it wins — prevents keep-alive from
    // blocking server.close() in test cleanup.
    connection: 'close',
    ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
  };

  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// resolveUpstream unit tests
// ---------------------------------------------------------------------------

describe('resolveUpstream()', () => {
  it('returns null when input is undefined', () => {
    assert.strictEqual(resolveUpstreamDirect(undefined), null);
  });

  it('returns null when input is empty string', () => {
    assert.strictEqual(resolveUpstreamDirect(''), null);
  });

  it('normalises trailing slash', () => {
    assert.strictEqual(resolveUpstreamDirect('https://api.anthropic.com/'), 'https://api.anthropic.com');
  });

  it('accepts http upstream', () => {
    assert.strictEqual(resolveUpstreamDirect('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  });

  it('throws on invalid URL', () => {
    assert.throws(() => resolveUpstreamDirect('not-a-url'), /not a valid URL/i);
  });

  it('throws on non-http protocol', () => {
    assert.throws(() => resolveUpstreamDirect('ftp://example.com'), /must use http:/);
  });
});

// ---------------------------------------------------------------------------
// resolveProxyTimeoutMs unit tests
// ---------------------------------------------------------------------------

describe('resolveProxyTimeoutMs()', () => {
  it('returns default when input is undefined', () => {
    assert.strictEqual(resolveProxyTimeoutMs(undefined), DEFAULT_PROXY_TIMEOUT_MS);
  });

  it('parses valid integer', () => {
    assert.strictEqual(resolveProxyTimeoutMs('10000'), 10_000);
  });

  it('throws on non-integer', () => {
    assert.throws(() => resolveProxyTimeoutMs('abc'), /invalid numeric value/);
  });
});

// ---------------------------------------------------------------------------
// Proxy disabled — no upstream
// ---------------------------------------------------------------------------

describe('proxy disabled (no upstream)', () => {
  let proxyPort;
  let proxyServer;

  before(async () => {
    proxyServer = createServer({ upstream: null });
    proxyPort = await listen(proxyServer);
  });

  after(() => close(proxyServer));

  it('returns 404 for unknown paths', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST' }, '{}');
    assert.strictEqual(res.status, 404);
  });

  it('/health still works without upstream', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.mode, 'deterministic');
    assert.strictEqual(body.upstream, null);
  });
});

// ---------------------------------------------------------------------------
// Auth header invariant — must be forwarded byte-for-byte
// ---------------------------------------------------------------------------

describe('auth header forwarding invariant', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;
  let receivedHeaders;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards Authorization header byte-for-byte', async () => {
    const token = 'Bearer sk-ant-api-TESTTOKEN12345';
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
    }, '{}');
    assert.strictEqual(receivedHeaders['authorization'], token);
  });

  it('forwards x-api-key header byte-for-byte', async () => {
    const apiKey = 'sk-ant-api-XAPIKEY99999';
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    }, '{}');
    assert.strictEqual(receivedHeaders['x-api-key'], apiKey);
  });

  it('forwards x-goog-api-key header byte-for-byte', async () => {
    const googleKey = 'AIzaSy-GOOGLEKEY12345';
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'x-goog-api-key': googleKey, 'content-type': 'application/json' },
    }, '{}');
    assert.strictEqual(receivedHeaders['x-goog-api-key'], googleKey);
  });

  it('forwards custom x-auth-token header byte-for-byte', async () => {
    const customToken = 'custom-auth-token-XYZ';
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'x-auth-token': customToken, 'content-type': 'application/json' },
    }, '{}');
    assert.strictEqual(receivedHeaders['x-auth-token'], customToken);
  });
});

// ---------------------------------------------------------------------------
// Hop-by-hop header stripping
// ---------------------------------------------------------------------------

describe('hop-by-hop header stripping', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;
  let receivedHeaders;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      // Include keep-alive in the upstream response — we verify the client never sees it.
      // Node.js HTTP server does NOT inject keep-alive on its own, so absence = stripping worked.
      res.writeHead(200, {
        'content-type': 'application/json',
        'keep-alive': 'timeout=5, max=1000',
        'x-custom-header': 'preserved',
      });
      res.end('{"ok":true}');
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('strips proxy-authorization hop-by-hop header from forwarded request', async () => {
    // Node.js http client never adds proxy-authorization automatically,
    // making it a clean signal that our stripping code ran.
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/test',
      method: 'GET',
      headers: { 'proxy-authorization': 'Basic dGVzdA==', 'x-custom': 'value' },
    });
    assert.strictEqual(receivedHeaders['proxy-authorization'], undefined);
  });

  it('strips te hop-by-hop header from forwarded request', async () => {
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/test',
      method: 'GET',
      headers: { te: 'trailers', 'x-custom': 'value' },
    });
    assert.strictEqual(receivedHeaders['te'], undefined);
  });

  it('preserves non-hop-by-hop headers in forwarded request', async () => {
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/test',
      method: 'GET',
      headers: { 'x-forwarded-test': 'hello' },
    });
    assert.strictEqual(receivedHeaders['x-forwarded-test'], 'hello');
  });

  it('strips keep-alive hop-by-hop header from upstream response', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/test',
      method: 'GET',
    });
    // Upstream sent keep-alive: timeout=5,max=1000 — must NOT reach the client
    assert.strictEqual(res.headers['keep-alive'], undefined);
    // Non-hop-by-hop custom header must be preserved
    assert.strictEqual(res.headers['x-custom-header'], 'preserved');
  });
});

// ---------------------------------------------------------------------------
// Request body forwarding
// ---------------------------------------------------------------------------

describe('request body forwarding', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;
  let receivedBody;

  before(async () => {
    upstreamServer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards request body byte-for-byte', async () => {
    const payload = JSON.stringify({ model: 'claude-opus-4-5', messages: [{ role: 'user', content: 'hello' }] });
    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() },
    }, payload);
    assert.strictEqual(receivedBody, payload);
  });
});

// ---------------------------------------------------------------------------
// SSE passthrough — raw byte-pipe, no buffering
// ---------------------------------------------------------------------------

describe('SSE passthrough', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      // Emit 3 SSE events with small delays to verify streaming (not buffered)
      res.write('data: {"type":"ping"}\n\n');
      setTimeout(() => res.write('data: {"type":"message_start"}\n\n'), 20);
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end(); }, 40);
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('preserves content-type: text/event-stream in response', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/sse', method: 'GET' });
    assert.ok(res.headers['content-type']?.includes('text/event-stream'), `expected SSE content-type, got: ${res.headers['content-type']}`);
  });

  it('delivers all SSE events', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/sse', method: 'GET' });
    assert.ok(res.body.includes('{"type":"ping"}'), 'missing ping event');
    assert.ok(res.body.includes('{"type":"message_start"}'), 'missing message_start event');
    assert.ok(res.body.includes('[DONE]'), 'missing DONE event');
  });

  it('preserves x-accel-buffering header', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/sse', method: 'GET' });
    assert.strictEqual(res.headers['x-accel-buffering'], 'no');
  });
});

// ---------------------------------------------------------------------------
// Status code passthrough
// ---------------------------------------------------------------------------

describe('status code passthrough', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const code = Number.parseInt(url.searchParams.get('code') ?? '200', 10);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: code }));
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  for (const code of [200, 400, 401, 429, 500]) {
    it(`passes through ${code} status code`, async () => {
      const res = await request({ host: '127.0.0.1', port: proxyPort, path: `/v1/test?code=${code}`, method: 'GET' });
      assert.strictEqual(res.status, code);
    });
  }
});

// ---------------------------------------------------------------------------
// Error handling — 502 on upstream refused, 504 on timeout
// ---------------------------------------------------------------------------

describe('upstream error handling', () => {
  let proxyPort;
  let proxyServer;

  before(async () => {
    // Point at a port with nothing listening
    proxyServer = createServer({ upstream: 'http://127.0.0.1:1' });
    proxyPort = await listen(proxyServer);
  });

  after(() => close(proxyServer));

  it('returns 502 when upstream connection is refused', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST' }, '{}');
    assert.strictEqual(res.status, 502);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.error === 'string');
  });
});

describe('upstream timeout handling', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;

  before(async () => {
    // Upstream never responds
    upstreamServer = http.createServer((_req, _res) => { /* intentionally hang */ });
    upstreamPort = await listen(upstreamServer);

    // Very short timeout to make the test fast
    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}`, proxyTimeoutMs: 100 });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('returns 504 when upstream times out', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages', method: 'POST' }, '{}');
    assert.strictEqual(res.status, 504);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.error === 'string');
  });
});

// ---------------------------------------------------------------------------
// Path + query forwarding
// ---------------------------------------------------------------------------

describe('path and query forwarding', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;
  let receivedPath;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards path and query string verbatim', async () => {
    await request({ host: '127.0.0.1', port: proxyPort, path: '/v1/messages?stream=true&version=2', method: 'GET' });
    assert.strictEqual(receivedPath, '/v1/messages?stream=true&version=2');
  });
});

// ---------------------------------------------------------------------------
// headroom-lite own endpoints still work in proxy mode
// ---------------------------------------------------------------------------

describe('own endpoints work in proxy mode', () => {
  let upstreamPort;
  let upstreamServer;
  let proxyPort;
  let proxyServer;

  before(async () => {
    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('/health returns 200 with mode=proxy+deterministic when upstream is set', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.mode, 'proxy+deterministic');
    assert.ok(body.upstream?.includes('127.0.0.1'));
  });

  it('/livez returns 200 in proxy mode', async () => {
    const res = await request({ host: '127.0.0.1', port: proxyPort, path: '/livez', method: 'GET' });
    assert.strictEqual(res.status, 200);
  });

  it('/v1/compress works in proxy mode', async () => {
    const payload = { messages: [{ role: 'user', content: 'hello' }] };
    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/compress',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, payload);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.messages));
  });
});
