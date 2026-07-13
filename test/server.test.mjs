import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { compressMessages } from '../src/compress/pipeline.mjs';
import { createServer, startServer } from '../src/server.mjs';

const DUPLICATE_FILE_SPAN = [
  'export async function login(user, password) {',
  '  const account = await loadAccount(user);',
  '  if (!account) throw new Error("missing account");',
  '  const session = await createSession(account.id);',
  '  await audit.log("login", account.id, session.id);',
  '  return { sessionId: session.id, userId: account.id };',
  '}',
  'export const LOGIN_TIMEOUT_MS = 30_000;',
].join('\n');

const SEARCH_OUTPUT = [
  'src/auth/login.mjs:10:const alpha = 1;',
  'src/auth/login.mjs:11:const beta = 2;',
  'src/auth/audit.mjs:3:export function gamma() {}',
  '',
].join('\n');

const REPEATED_LOG = [
  '\u001b[32minfo\u001b[0m build step ok',
  '\u001b[32minfo\u001b[0m build step ok',
  '\u001b[32minfo\u001b[0m build step ok',
  'warn cache miss',
  '',
].join('\n');

describe('HTTP server', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('serves health and liveness endpoints', async () => {
    const [health, livez] = await Promise.all([
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/livez`),
    ]);

    assert.equal(health.status, 200);
    assert.equal(livez.status, 200);

    assert.deepEqual(await health.json(), {
      status: 'ok',
      service: 'headroom-lite',
      mode: 'deterministic',
      max_body_bytes: 1024 * 1024,
      compress_live: false,
      upstream: null,
      upstreams: { legacy: null, anthropic: null, openai: null, 'github-models': null },
      lossy: { enabled: false, backend: 'llmlingua2', service_url: 'http://127.0.0.1:8791' },
    });
    assert.deepEqual(await livez.json(), {
      status: 'alive',
      service: 'headroom-lite',
    });
  });

  it('serves /stats endpoint with counters', async () => {
    const r = await fetch(`${baseUrl}/stats`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'headroom-lite');
    assert.ok(typeof body.uptime_seconds === 'number' && body.uptime_seconds >= 0);
    assert.ok(typeof body.proxy_requests === 'number');
    assert.ok(typeof body.compress_requests === 'number');
    assert.ok(typeof body.compress_tokens_before === 'number');
    assert.ok(typeof body.compress_tokens_after === 'number');
    assert.ok(typeof body.compress_tokens_saved === 'number');
    assert.ok(typeof body.compress_pct === 'string');
  });

  it('/stats compress_requests increments after /v1/compress call', async () => {
    const before = await (await fetch(`${baseUrl}/stats`)).json();
    await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const after = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(after.compress_requests, before.compress_requests + 1);
  });

  it('compresses a conversation via the /v1/compress contract', async () => {
    const payload = {
      format: 'openai',
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: 'You are a precise assistant.',
        },
        {
          role: 'assistant',
          content: `cat src/auth/login.mjs\n${DUPLICATE_FILE_SPAN}\n# eof`,
        },
        {
          role: 'tool',
          content: REPEATED_LOG,
        },
        {
          role: 'assistant',
          content: SEARCH_OUTPUT,
        },
        {
          role: 'assistant',
          content: `sed -n '1,8p' src/auth/login.mjs\n${DUPLICATE_FILE_SPAN}\n# done`,
        },
        {
          role: 'user',
          content: 'Summarize the duplicate code output and the repeated log lines.',
        },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    const expected = compressMessages(payload.messages, {
      format: payload.format,
      model: payload.model,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      messages: expected.messages,
      tokens_before: expected.tokensBefore,
      tokens_after: expected.tokensAfter,
      frozen_count: expected.frozenCount,
    });
    assert.ok(body.tokens_after < body.tokens_before);
    assert.match(body.messages[2].content, /\.\.\. \(repeated 3 times\)/);
    assert.equal(
      body.messages[3].content,
      'src/auth/login.mjs\n10:const alpha = 1;\n11:const beta = 2;\nsrc/auth/audit.mjs\n3:export function gamma() {}\n',
    );
    assert.match(body.messages[4].content, /\[myelin: 8 lines identical to output shown earlier \(turn 2, lines 2-9\)/);
    assert.equal(
      body.messages[5].content,
      'Summarize the duplicate code output and the repeated log lines.',
    );
  });

  it('rejects invalid compress payloads with a 400', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ format: 'openai' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: '`messages` (or `input` with kind:"responses") must be a JSON array',
    });
  });

  it('compresses a Responses API `input` array (kind:"responses")', async () => {
    const bigOutput = Array.from({ length: 60 }, (_, i) =>
      `src/services/handler.mjs:${i}:  return process(item[${i}], ctx);`).join('\n');
    const payload = {
      kind: 'responses',
      format: 'openai',
      model: 'gpt-4o',
      input: [
        { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'grep', arguments: '{"q":"x"}' },
        { type: 'function_call_output', id: 'fco1', call_id: 'c1', output: bigOutput },
        { type: 'reasoning', id: 'r1', encrypted_content: 'OPAQUE' },
      ],
    };
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    // Mirrors the `input` key, not `messages`.
    assert.ok(Array.isArray(body.input));
    assert.equal(body.messages, undefined);
    // The latest function_call_output (not the last item) was compressed.
    assert.ok(body.input[1].output.length < bigOutput.length);
    assert.ok(body.tokens_after < body.tokens_before);
    // Passthrough fields preserved.
    assert.equal(body.input[0].arguments, '{"q":"x"}');
    assert.equal(body.input[2].encrypted_content, 'OPAQUE');
    assert.equal(typeof body.frozen_count, 'number');
  });

  it('skips clientError writes when the socket is not writable or already reset', () => {
    const clientErrorServer = createServer();
    let endCalls = 0;

    clientErrorServer.emit('clientError', { code: 'ECONNRESET' }, {
      writable: true,
      end() {
        endCalls += 1;
      },
    });

    clientErrorServer.emit('clientError', { code: 'HPE_INVALID_METHOD' }, {
      writable: false,
      end() {
        endCalls += 1;
      },
    });

    assert.equal(endCalls, 0);
  });

  it('still returns a 400 response for writable clientError sockets', () => {
    const clientErrorServer = createServer();
    let payload = null;

    clientErrorServer.emit('clientError', { code: 'HPE_INVALID_METHOD' }, {
      writable: true,
      end(chunk) {
        payload = chunk;
      },
    });

    assert.equal(payload, 'HTTP/1.1 400 Bad Request\r\n\r\n');
  });
});
