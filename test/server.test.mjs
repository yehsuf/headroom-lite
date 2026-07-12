import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressMessages } from '../src/compress/pipeline.mjs';
import { createTelemetryLedger } from '../src/observability/ledger.mjs';
import { createServer, startServer } from '../src/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = join(__dirname, '.artifacts', 'server');

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

after(() => {
  rmSync(join(__dirname, '.artifacts'), { recursive: true, force: true });
});

function ledgerPath(name = 'stats.json') {
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  return join(ARTIFACT_ROOT, name);
}

function createClock(initialValue = '2026-01-01T00:00:00.000Z') {
  let current = new Date(initialValue);
  return {
    now() {
      return new Date(current);
    },
    set(value) {
      current = new Date(value);
    },
  };
}

async function importFreshServerModule(homeDirectory, tag) {
  mkdirSync(homeDirectory, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = homeDirectory;
  try {
    return await import(new URL(`../src/server.mjs?${tag}`, import.meta.url).href);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function createStubTelemetryLedger(overrides = {}) {
  const snapshot = {
    schema_version: 1,
    captured_at: '2026-01-01T00:00:00.000Z',
    status: 'ok',
    service: 'headroom-lite',
    capabilities: {
      snapshot: true,
      history: true,
      csv: true,
      prometheus: true,
      flush: true,
      persistence: true,
    },
    lifetime: {
      compression: { requests: 0, tokens_before: 0, tokens_after: 0, tokens_saved: 0, latency_ms: 0, outcomes: {}, providers: {}, models: {} },
      proxy: { requests: 0, latency_ms: 0, outcomes: {}, providers: {}, models: {} },
    },
    session: {
      compression: { requests: 0, tokens_before: 0, tokens_after: 0, tokens_saved: 0, latency_ms: 0, outcomes: {}, providers: {}, models: {} },
      proxy: { requests: 0, latency_ms: 0, outcomes: {}, providers: {}, models: {} },
    },
    history: {
      retained_points: 0,
      max_points: 720,
      max_age_ms: 30 * 24 * 60 * 60 * 1000,
      has_predecessor_baseline: false,
      series: [
        'compression.requests',
        'compression.tokens_before',
        'compression.tokens_after',
        'compression.tokens_saved',
        'compression.latency_ms',
        'proxy.requests',
        'proxy.latency_ms',
      ],
    },
  };

  return {
    snapshot() {
      return structuredClone(snapshot);
    },
    history() {
      return [];
    },
    toCsv() {
      return 'series,bucket_start,value';
    },
    toPrometheus() {
      return '# HELP headroom_lite_schema_version schema version\n# TYPE headroom_lite_schema_version gauge\nheadroom_lite_schema_version 1';
    },
    recordCompression() {},
    recordProxy() {},
    flush() {},
    ...overrides,
  };
}

describe('HTTP server', () => {
  let server;
  let baseUrl;
  let telemetryLedger;

  before(async () => {
    telemetryLedger = createTelemetryLedger({ path: ledgerPath('http-server-stats.json') });
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger,
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await closeServer(server);
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
      schema_version: 1,
      mode: 'deterministic',
      max_body_bytes: 1024 * 1024,
      compress_live: false,
      upstream: null,
      upstreams: { legacy: null, anthropic: null, openai: null, 'github-models': null },
      capabilities: telemetryLedger.snapshot().capabilities,
      lossy: { enabled: false, backend: 'llmlingua2', service_url: 'http://127.0.0.1:8791' },
    });
    assert.deepEqual(await livez.json(), {
      status: 'alive',
      service: 'headroom-lite',
    });
  });

  it('serves readiness, versioned stats history, and Prometheus metrics', async () => {
    const [ready, history, metrics] = await Promise.all([
      fetch(`${baseUrl}/readyz`),
      fetch(`${baseUrl}/stats-history?series=hourly`),
      fetch(`${baseUrl}/metrics`),
    ]);

    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: 'ready',
      service: 'headroom-lite',
      schema_version: 1,
      capabilities: telemetryLedger.snapshot().capabilities,
    });

    assert.equal(history.status, 200);
    assert.equal(history.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await history.json(), {
      schema_version: 1,
      status: 'ok',
      service: 'headroom-lite',
      series: 'hourly',
      rows: [],
    });

    assert.equal(metrics.status, 200);
    assert.equal(metrics.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    const metricsText = await metrics.text();
    assert.match(metricsText, /^# HELP headroom_lite_requests_total total session requests$/m);
    assert.match(metricsText, /^# TYPE headroom_lite_requests_total counter$/m);
    assert.match(metricsText, /^headroom_lite_schema_version 1$/m);
  });

  it('serves /stats endpoint with legacy counters plus versioned telemetry', async () => {
    const r = await fetch(`${baseUrl}/stats`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.schema_version, 1);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'headroom-lite');
    assert.ok(typeof body.captured_at === 'string');
    assert.deepEqual(body.capabilities, telemetryLedger.snapshot().capabilities);
    assert.ok(body.lifetime && body.session && body.history);
    assert.ok(typeof body.uptime_seconds === 'number' && body.uptime_seconds >= 0);
    assert.ok(typeof body.proxy_requests === 'number');
    assert.ok(typeof body.compress_requests === 'number');
    assert.ok(typeof body.compress_tokens_before === 'number');
    assert.ok(typeof body.compress_tokens_after === 'number');
    assert.ok(typeof body.compress_tokens_saved === 'number');
    assert.ok(typeof body.compress_pct === 'string');
  });

  it('records /v1/compress telemetry only after successful responses', async () => {
    const before = await (await fetch(`${baseUrl}/stats`)).json();
    const invalid = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'openai' }),
    });
    assert.equal(invalid.status, 400);
    const afterInvalid = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(afterInvalid.compress_requests, before.compress_requests);
    assert.equal(afterInvalid.session.compression.requests, before.session.compression.requests);

    await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const afterSuccess = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(afterSuccess.compress_requests, before.compress_requests + 1);
    assert.equal(afterSuccess.session.compression.requests, before.session.compression.requests + 1);
    const history = await (await fetch(`${baseUrl}/stats-history?series=hourly`)).json();
    assert.ok(history.rows.some((row) => row.series === 'compression.requests' && row.value >= 1));
  });

  it('coalesces persisted and pending hourly history rows into one canonical row', async () => {
    const clock = createClock('2026-01-01T00:05:00.000Z');
    const coalescedLedger = createTelemetryLedger({
      path: ledgerPath('coalesced-hourly.json'),
      now: clock.now,
    });
    const firstServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: coalescedLedger,
    });
    const firstAddress = firstServer.address();

    try {
      const first = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] }),
      });
      assert.equal(first.status, 200);
    } finally {
      clock.set('2026-01-01T00:15:00.000Z');
      await closeServer(firstServer);
    }

    const secondServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: coalescedLedger,
    });
    const secondAddress = secondServer.address();

    try {
      clock.set('2026-01-01T00:45:00.000Z');
      const second = await fetch(`http://127.0.0.1:${secondAddress.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'second' }] }),
      });
      assert.equal(second.status, 200);

      const history = await (await fetch(`http://127.0.0.1:${secondAddress.port}/stats-history?series=hourly`)).json();
      assert.deepEqual(
        history.rows.filter((row) => row.series === 'compression.requests'),
        [
          {
            series: 'compression.requests',
            bucket_start: '2026-01-01T00:00:00.000Z',
            value: 2,
          },
        ],
      );
    } finally {
      await closeServer(secondServer);
    }
  });

  it('serves csv stats history and rejects unsupported history queries', async () => {
    const [csv, badFormat, badSeries, unexpectedKey] = await Promise.all([
      fetch(`${baseUrl}/stats-history?series=hourly&format=csv`),
      fetch(`${baseUrl}/stats-history?series=hourly&format=xml`),
      fetch(`${baseUrl}/stats-history?series=yearly`),
      fetch(`${baseUrl}/stats-history?series=hourly&unexpected=1`),
    ]);

    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(await csv.text(), /^series,bucket_start,value/m);

    assert.equal(badFormat.status, 400);
    assert.deepEqual(await badFormat.json(), {
      error: 'format must be "json" or "csv"',
    });

    assert.equal(badSeries.status, 400);
    assert.deepEqual(await badSeries.json(), {
      error: 'series must be one of "history", "hourly", "daily", "weekly", or "monthly"',
    });

    assert.equal(unexpectedKey.status, 400);
    assert.deepEqual(await unexpectedKey.json(), {
      error: 'unsupported stats-history query parameter: unexpected',
    });
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

  it('rejects kind:"responses" with a non-array `input` even if messages is present', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'responses', input: null, messages: [] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'kind:"responses" requires `input` to be a JSON array',
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
    // No OpenAI cache key is emitted on the Responses path (system context lives
    // in `instructions`, not `input`/`messages`, so a derived key would be wrong).
    assert.equal(body.prompt_cache_key, undefined);
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

  it('records successful proxy outcomes in the telemetry ledger', async () => {
    const upstreamServer = await listenServer(http.createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    }));
    const upstreamAddress = upstreamServer.address();
    const ledger = createTelemetryLedger({ path: ledgerPath('proxy-success.json') });
    const proxyServer = await listenServer(createServer({
      upstream: `http://127.0.0.1:${upstreamAddress.port}`,
      telemetryLedger: ledger,
    }));
    const proxyAddress = proxyServer.address();

    try {
      const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [] }),
      });

      assert.equal(response.status, 204);
      const snapshot = ledger.snapshot();
      assert.equal(snapshot.session.proxy.requests, 1);
      assert.equal(snapshot.session.proxy.outcomes.ok, 1);
      assert.equal(snapshot.session.proxy.providers.anthropic, 1);
    } finally {
      await closeServer(proxyServer);
      await closeServer(upstreamServer);
    }
  });

  it('records 502 proxy fallbacks in the telemetry ledger', async () => {
    const ledger = createTelemetryLedger({ path: ledgerPath('proxy-error.json') });
    const proxyServer = await listenServer(createServer({
      upstream: 'http://127.0.0.1:1',
      telemetryLedger: ledger,
    }));
    const proxyAddress = proxyServer.address();

    try {
      const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [] }),
      });

      assert.equal(response.status, 502);
      const snapshot = ledger.snapshot();
      assert.equal(snapshot.session.proxy.requests, 1);
      assert.equal(snapshot.session.proxy.outcomes.error, 1);
      assert.equal(snapshot.session.proxy.providers.anthropic, 1);
    } finally {
      await closeServer(proxyServer);
    }
  });

  it('records upstream 5xx proxy responses as errors', async () => {
    const upstreamServer = await listenServer(http.createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'upstream unavailable' }));
    }));
    const upstreamAddress = upstreamServer.address();
    const ledger = createTelemetryLedger({ path: ledgerPath('proxy-upstream-error.json') });
    const proxyServer = await listenServer(createServer({
      upstream: `http://127.0.0.1:${upstreamAddress.port}`,
      telemetryLedger: ledger,
    }));
    const proxyAddress = proxyServer.address();

    try {
      const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4.5', messages: [] }),
      });

      assert.equal(response.status, 503);
      const snapshot = ledger.snapshot();
      assert.equal(snapshot.session.proxy.requests, 1);
      assert.equal(snapshot.session.proxy.outcomes.error, 1);
    } finally {
      await closeServer(proxyServer);
      await closeServer(upstreamServer);
    }
  });

  it('treats telemetry flush failures as best-effort after successful compression', async () => {
    const fragileLedger = createStubTelemetryLedger({
      flush() {
        throw new Error('flush failed');
      },
    });
    const fragileServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: fragileLedger,
    });
    const address = fragileServer.address();

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).tokens_before, 1);
    } finally {
      await closeServer(fragileServer);
    }
  });

  it('keeps legacy flat stats scoped to the current server instance', async () => {
    const firstLedger = createTelemetryLedger({ path: ledgerPath('server-a.json') });
    const secondLedger = createTelemetryLedger({ path: ledgerPath('server-b.json') });
    const firstServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: firstLedger,
    });
    const secondServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: secondLedger,
    });
    const firstAddress = firstServer.address();
    const secondAddress = secondServer.address();

    try {
      const compress = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(compress.status, 200);

      const stats = await (await fetch(`http://127.0.0.1:${secondAddress.port}/stats`)).json();
      assert.equal(stats.compress_requests, 0);
      assert.equal(stats.session.compression.requests, 0);
    } finally {
      await closeServer(firstServer);
      await closeServer(secondServer);
    }
  });

  it('keeps default server stats isolated across startServer instances', async () => {
    const defaultHome = join(ARTIFACT_ROOT, 'default-home');
    const tag = `default-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { startServer: startDefaultServer } = await importFreshServerModule(defaultHome, tag);
    const firstServer = await startDefaultServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const secondServer = await startDefaultServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const firstAddress = firstServer.address();
    const secondAddress = secondServer.address();

    try {
      const compress = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(compress.status, 200);

      const stats = await (await fetch(`http://127.0.0.1:${secondAddress.port}/stats`)).json();
      assert.equal(stats.compress_requests, 0);
      assert.equal(stats.session.compression.requests, 0);
    } finally {
      await closeServer(firstServer);
      await closeServer(secondServer);
    }
  });

  it('preserves default telemetry lifetime after shared-home servers close out of order', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-persist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { startServer: startDefaultServer } = await importFreshServerModule(defaultHome, tag);
    const firstServer = await startDefaultServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const secondServer = await startDefaultServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const firstAddress = firstServer.address();

    try {
      const compress = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'survive-shared-close' }] }),
      });
      assert.equal(compress.status, 200);
    } finally {
      await closeServer(firstServer);
      await closeServer(secondServer);
    }

    const thirdServer = await startDefaultServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
    });
    const thirdAddress = thirdServer.address();

    try {
      const stats = await (await fetch(`http://127.0.0.1:${thirdAddress.port}/stats`)).json();
      assert.equal(stats.lifetime.compression.requests, 1);
      assert.equal(stats.session.compression.requests, 0);

      const history = await (await fetch(`http://127.0.0.1:${thirdAddress.port}/stats-history?series=hourly`)).json();
      assert.ok(history.rows.some((row) => row.series === 'compression.requests' && row.value >= 1));
    } finally {
      await closeServer(thirdServer);
    }
  });
});
