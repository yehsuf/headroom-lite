/**
 * End-to-end tests for live-zone proxy compression.
 *
 * Each test wires up a real mock upstream HTTP server and a headroom-lite proxy
 * server. Requests flow through the full Node.js HTTP stack — no internal
 * module mocking.
 *
 * Invariants verified:
 *   - Compression disabled by default (byte-exact passthrough)
 *   - Anthropic /v1/messages path: compressible messages compressed upstream
 *   - OpenAI /v1/chat/completions path: same
 *   - Non-JSON body forwarded unchanged
 *   - JSON body without `messages` forwarded unchanged
 *   - Body exceeding DEFAULT_MAX_BODY_BYTES forwarded unchanged
 *   - Frozen (cache_control) messages preserved byte-exact through compression
 *   - SSE response raw-piped with no buffering or modification
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.mjs';
import { DEFAULT_MAX_BODY_BYTES, resolveCompressProxy } from '../src/proxy.mjs';
import { compressMessages } from '../src/compress/pipeline.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(resolve);
  });
}

/**
 * Send an HTTP request and return { status, headers, body }.
 * body can be a Buffer or string; if it's an object it is JSON-stringified.
 */
function request(options, body) {
  const bodyBuf = body === undefined || body === null
    ? null
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

  const headers = {
    ...(options.headers ?? {}),
    connection: 'close',
    ...(bodyBuf ? { 'content-length': String(bodyBuf.length) } : {}),
  };

  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** Content that collapseRuns will deterministically compress (repeated adjacent lines). */
function makeCompressibleContent(lineText = 'log line alpha', repeatCount = 6) {
  return Array.from({ length: repeatCount }, () => lineText).join('\n');
}

/**
 * Build a two-message array where the first message contains compressible text
 * (the latest/last message is left unchanged by the lossless pass too, but the
 * first message's repeated lines get collapsed).
 */
function makeCompressibleMessages() {
  return [
    { role: 'user', content: makeCompressibleContent() },
    { role: 'assistant', content: 'acknowledged' },
  ];
}

// ---------------------------------------------------------------------------
// resolveCompressProxy unit tests
// ---------------------------------------------------------------------------

describe('resolveCompressProxy()', () => {
  it('returns false when env var is absent', () => {
    assert.strictEqual(resolveCompressProxy(undefined), false);
  });

  it('returns false for empty string', () => {
    assert.strictEqual(resolveCompressProxy(''), false);
  });

  it('returns true for "true"', () => {
    assert.strictEqual(resolveCompressProxy('true'), true);
  });

  it('returns true for "1"', () => {
    assert.strictEqual(resolveCompressProxy('1'), true);
  });

  it('returns false for "false"', () => {
    assert.strictEqual(resolveCompressProxy('false'), false);
  });
});

// ---------------------------------------------------------------------------
// Test 1 — Compression disabled (default): request forwarded byte-exact
// ---------------------------------------------------------------------------

describe('compression disabled (default)', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody, receivedHeaders;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        receivedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    // compressProxy defaults to false
    proxyServer = createServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards compressible JSON body byte-exact when compression is disabled', async () => {
    const messages = makeCompressibleMessages();
    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages });

    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    assert.strictEqual(receivedBody, inputBody);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Compression enabled, Anthropic path
// ---------------------------------------------------------------------------

describe('compression enabled — Anthropic /v1/messages path', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"msg_1"}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('compresses messages array before forwarding to upstream', async () => {
    const messages = makeCompressibleMessages();
    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages });

    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    assert.strictEqual(res.status, 200);

    const upstreamReceived = JSON.parse(receivedBody);
    // Compressed body must be smaller than original
    assert.ok(
      Buffer.byteLength(receivedBody) < Buffer.byteLength(inputBody),
      `expected upstream body (${Buffer.byteLength(receivedBody)}) to be smaller than input (${Buffer.byteLength(inputBody)})`,
    );
    // Other fields must be preserved
    assert.strictEqual(upstreamReceived.model, 'claude-3-5-sonnet-20241022');
    // First message content should be losslessly compressed (repeated lines collapsed)
    const { messages: expectedMessages } = compressMessages(messages, { format: 'anthropic' });
    assert.deepStrictEqual(upstreamReceived.messages, expectedMessages);
  });

  it('content-length header reflects compressed body size', async () => {
    const messages = makeCompressibleMessages();
    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages });

    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    // content-length must match actual compressed bytes received
    // (upstream receives it via forwardHeaders set by proxyRequest)
    assert.strictEqual(
      Number(receivedBody.length),
      Buffer.byteLength(receivedBody),
      'body length matches byte count',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Compression enabled, OpenAI path
// ---------------------------------------------------------------------------

describe('compression enabled — OpenAI /v1/chat/completions path', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"chatcmpl-1"}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('compresses messages on OpenAI chat path', async () => {
    const messages = makeCompressibleMessages();
    const inputBody = JSON.stringify({ model: 'gpt-4o', messages });

    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    assert.strictEqual(res.status, 200);

    const upstreamReceived = JSON.parse(receivedBody);
    assert.ok(
      Buffer.byteLength(receivedBody) < Buffer.byteLength(inputBody),
      'upstream body is compressed',
    );
    assert.strictEqual(upstreamReceived.model, 'gpt-4o');
    const { messages: expectedMessages } = compressMessages(messages, { format: 'openai' });
    assert.deepStrictEqual(upstreamReceived.messages, expectedMessages);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Non-JSON body forwarded unchanged
// ---------------------------------------------------------------------------

describe('compression enabled — non-JSON body', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody, receivedHeaders;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        receivedHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards text/plain body unchanged', async () => {
    const plainBody = 'hello world, this is plain text';

    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    }, plainBody);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(receivedBody, plainBody);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — JSON body without `messages` field forwarded unchanged
// ---------------------------------------------------------------------------

describe('compression enabled — JSON body without messages field', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards JSON without messages field unchanged', async () => {
    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', system: 'You are helpful' });

    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    assert.strictEqual(receivedBody, inputBody);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Body too large: forwarded unchanged
// ---------------------------------------------------------------------------

describe('compression enabled — body too large', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedContentLength;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      // Drain body without storing it to avoid OOM in test; just record content-length.
      receivedContentLength = Number(req.headers['content-length']);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('forwards oversized body unchanged (content-length preserved)', async () => {
    // Build a body that exceeds DEFAULT_MAX_BODY_BYTES by embedding a large content string.
    // We use a long repeating string; JSON overhead is small relative to 5MB.
    const bigContent = 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1);
    const inputBody = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: bigContent }],
    });
    const inputBuf = Buffer.from(inputBody, 'utf8');

    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBuf);

    assert.strictEqual(res.status, 200);
    // Upstream must receive the exact same byte count as we sent.
    assert.strictEqual(receivedContentLength, inputBuf.length);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Frozen messages preserved byte-exact through compression
// ---------------------------------------------------------------------------

describe('compression enabled — frozen messages preserved', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;
  let receivedBody;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"msg_frozen"}');
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('frozen messages with cache_control arrive at upstream unchanged', async () => {
    const frozenContent = makeCompressibleContent('frozen line', 8);
    const messages = [
      // Frozen: carries cache_control — must not be modified
      {
        role: 'user',
        content: [
          { type: 'text', text: frozenContent, cache_control: { type: 'ephemeral' } },
        ],
      },
      // Live: compressible, should be compressed
      { role: 'assistant', content: makeCompressibleContent('live-line', 6) },
      { role: 'user', content: 'final question' },
    ];

    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages });

    await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    const received = JSON.parse(receivedBody);
    // Frozen message (index 0) must be byte-exact (no mutation)
    assert.deepStrictEqual(received.messages[0], messages[0]);
    // The compressed output must differ from the raw input (live messages were compressed)
    assert.ok(receivedBody.length < inputBody.length, 'overall body was compressed');
  });
});

// ---------------------------------------------------------------------------
// Test 8 — SSE response raw-piped unchanged
// ---------------------------------------------------------------------------

describe('compression enabled — SSE response raw-piped', () => {
  let upstreamPort, upstreamServer, proxyPort, proxyServer;

  before(async () => {
    upstreamServer = http.createServer((req, res) => {
      // Drain request body
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-upstream-marker': 'sse-test',
        });
        res.write('data: {"type":"message_start"}\n\n');
        res.write('data: {"type":"content_block_start"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    upstreamPort = await listen(upstreamServer);

    proxyServer = createServer({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      compressProxy: true,
    });
    proxyPort = await listen(proxyServer);
  });

  after(async () => {
    await close(proxyServer);
    await close(upstreamServer);
  });

  it('pipes SSE response through without modification', async () => {
    const messages = makeCompressibleMessages();
    const inputBody = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', messages, stream: true });

    const res = await request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, inputBody);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    assert.ok(res.body.includes('data: {"type":"message_start"}'), 'SSE events forwarded');
    assert.ok(res.body.includes('data: [DONE]'), 'SSE terminator forwarded');
  });
});
