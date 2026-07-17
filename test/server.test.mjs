import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
  rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
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
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX — override both
  // so the fake home is honored cross-platform (otherwise Windows writes to the
  // real home and the read-only-path fallback tests never trigger).
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  try {
    return await import(new URL(`../src/server.mjs?${tag}`, import.meta.url).href);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

function patchReadOnlyDefaultTelemetryPath(homeDirectory) {
  const defaultTelemetryDir = join(homeDirectory, '.headroom-lite');
  const require = createRequire(import.meta.url);
  const fs = require('node:fs');
  const originalMkdirSync = fs.mkdirSync;

  fs.mkdirSync = function patchedMkdirSync(path, ...args) {
    const textPath = typeof path === 'string' ? path : path?.toString?.();
    if (textPath === defaultTelemetryDir) {
      const error = new Error(`EROFS: read-only file system, mkdir '${textPath}'`);
      error.code = 'EROFS';
      throw error;
    }
    return originalMkdirSync.call(this, path, ...args);
  };
  syncBuiltinESMExports();

  return () => {
    fs.mkdirSync = originalMkdirSync;
    syncBuiltinESMExports();
  };
}

async function withEnv(overrides, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function closeServer(server) {
  if (typeof server.closeAndFlushTelemetry === 'function') {
    await server.closeAndFlushTelemetry();
    return;
  }
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

async function allocatePort() {
  const server = await listenServer(http.createServer());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await closeServer(server);
  return port;
}

async function waitForOutput(stream, pattern, timeoutMs = 5_000) {
  let output = '';

  if (pattern.test(output)) {
    return output;
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern} in output: ${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };

    const onEnd = () => {
      cleanup();
      reject(new Error(`stream ended before matching ${pattern}: ${output}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
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
      fetch(`${baseUrl}/stats-history`),
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

  it('records /v1/compress telemetry for rejected and successful responses', async () => {
    const before = await (await fetch(`${baseUrl}/stats`)).json();
    const invalid = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'openai' }),
    });
    assert.equal(invalid.status, 400);
    const afterInvalid = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(afterInvalid.compress_requests, before.compress_requests);
    assert.equal(afterInvalid.session.compression.requests, before.session.compression.requests + 1);
    assert.equal(afterInvalid.session.compression.outcomes.rejected, (before.session.compression.outcomes.rejected ?? 0) + 1);

    await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const afterSuccess = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(afterSuccess.compress_requests, before.compress_requests + 1);
    assert.equal(afterSuccess.session.compression.requests, before.session.compression.requests + 2);
    assert.equal(afterSuccess.session.compression.outcomes.ok, (before.session.compression.outcomes.ok ?? 0) + 1);
    const history = await (await fetch(`${baseUrl}/stats-history?series=hourly`)).json();
    assert.ok(history.rows.some((row) => row.series === 'compression.requests' && row.value >= 2));
  });

  it('self-identifies as headroom-lite via response header and compress body', async () => {
    // Header on every first-class endpoint (health + compress).
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.headers.get('x-headroom-implementation'), 'headroom-lite');
    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.headers.get('x-headroom-implementation'), 'headroom-lite');

    // Messages path: header + body `service` field.
    const msg = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi hi' }] }),
    });
    assert.equal(msg.status, 200);
    assert.equal(msg.headers.get('x-headroom-implementation'), 'headroom-lite');
    const msgBody = await msg.json();
    assert.equal(msgBody.service, 'headroom-lite');
    assert.ok(Array.isArray(msgBody.messages));

    // Responses API path: header + body `service` field.
    const resp = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'responses', input: [{ role: 'user', content: 'hi hi' }] }),
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('x-headroom-implementation'), 'headroom-lite');
    const respBody = await resp.json();
    assert.equal(respBody.service, 'headroom-lite');
    assert.ok(Array.isArray(respBody.input));
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
    const [csv, badFormat, badSeries, emptySeries, whitespaceSeries, unexpectedKey] = await Promise.all([
      fetch(`${baseUrl}/stats-history?series=hourly&format=csv`),
      fetch(`${baseUrl}/stats-history?series=hourly&format=xml`),
      fetch(`${baseUrl}/stats-history?series=yearly`),
      fetch(`${baseUrl}/stats-history?series=`),
      fetch(`${baseUrl}/stats-history?series=%20%20`),
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

    assert.equal(emptySeries.status, 400);
    assert.deepEqual(await emptySeries.json(), {
      error: 'series must be one of "history", "hourly", "daily", "weekly", or "monthly"',
    });

    assert.equal(whitespaceSeries.status, 400);
    assert.deepEqual(await whitespaceSeries.json(), {
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
      service: 'headroom-lite',
      messages: expected.messages,
      tokens_before: expected.tokensBefore,
      tokens_after: expected.tokensAfter,
      tokens_saved: Math.max(0, expected.tokensBefore - expected.tokensAfter),
      compression_ratio: expected.tokensBefore > 0 ? expected.tokensAfter / expected.tokensBefore : 1.0,
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

  it('keeps no-argument getStats bound to a stable module-level legacy state snapshot', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-get-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-get-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const originalNow = Date.now;
    let fakeNow = 1_000;
    Date.now = () => fakeNow;
    try {
      const { getStats: getFreshStats } = await importFreshServerModule(defaultHome, tag);
      const first = getFreshStats();
      fakeNow += 5_000;
      const second = getFreshStats();

      assert.equal(first.uptime_seconds, 0);
      assert.equal(second.uptime_seconds, 5);
      assert.equal(second.proxy_requests, 0);
      assert.equal(second.compress_requests, 0);
    } finally {
      Date.now = originalNow;
    }
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

  it('uses validated stats env vars for default startServer telemetry', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-configured-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const statsPath = ledgerPath(`configured-stats-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const tag = `configured-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;

    await withEnv({
      HEADROOM_LITE_STATS_PATH: statsPath,
      HEADROOM_LITE_STATS_MAX_POINTS: '2',
      HEADROOM_LITE_STATS_MAX_AGE_DAYS: '7',
    }, async () => {
      const {
        startServer: startConfiguredServer,
        resolveStatsPath,
        resolveStatsMaxPoints,
        resolveStatsMaxAgeMs,
      } = await importFreshServerModule(defaultHome, tag);

      assert.equal(resolveStatsPath(), statsPath);
      assert.equal(resolveStatsMaxPoints(), 2);
      assert.equal(resolveStatsMaxAgeMs(), maxAgeMs);
      assert.throws(() => resolveStatsPath('   '), /HEADROOM_LITE_STATS_PATH must be a non-empty path/);
      assert.throws(() => resolveStatsMaxPoints('abc'), /HEADROOM_LITE_STATS_MAX_POINTS must be a non-negative integer/);
      assert.throws(() => resolveStatsMaxAgeMs('-1'), /HEADROOM_LITE_STATS_MAX_AGE_DAYS must be a non-negative integer/);

      const firstServer = await startConfiguredServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
      const firstAddress = firstServer.address();

      try {
        const compress = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'persist-configured-telemetry' }] }),
        });
        assert.equal(compress.status, 200);
      } finally {
        await closeServer(firstServer);
      }

      const secondServer = await startConfiguredServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
      const secondAddress = secondServer.address();

      try {
        const stats = await (await fetch(`http://127.0.0.1:${secondAddress.port}/stats`)).json();
        assert.equal(stats.history.max_points, 2);
        assert.equal(stats.history.max_age_ms, maxAgeMs);
        assert.equal(stats.lifetime.compression.requests, 1);
        assert.equal(stats.session.compression.requests, 0);
      } finally {
        await closeServer(secondServer);
      }
    });
  });

  it('persists in-flight proxy telemetry when CLI shutdown starts on SIGTERM', {
    skip: process.platform === 'win32'
      ? 'SIGTERM graceful shutdown is POSIX-only; Windows emulates SIGTERM as a hard kill'
      : false,
  }, async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const statsPath = ledgerPath(`cli-shutdown-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const port = await allocatePort();
    let releaseUpstream;
    let resolveUpstreamStarted;
    const upstreamStarted = new Promise((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    const upstreamServer = await listenServer(http.createServer((_request, response) => {
      resolveUpstreamStarted();
      return new Promise((resolve) => {
        releaseUpstream = () => {
          if (response.headersSent || response.writableEnded) return;
          const body = JSON.stringify({ ok: true });
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(body)),
          });
          response.end(body);
          resolve();
        };
      });
    }));
    const upstreamAddress = upstreamServer.address();
    const child = spawn(process.execPath, ['src/index.mjs'], {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        HOME: defaultHome,
        HEADROOM_LITE_HOST: '127.0.0.1',
        HEADROOM_LITE_PORT: String(port),
        HEADROOM_LITE_STATS_PATH: statsPath,
        HEADROOM_LITE_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitForOutput(child.stdout, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));

      const proxyResponsePromise = fetch(`http://127.0.0.1:${port}/v1/models`);
      await upstreamStarted;

      child.kill('SIGTERM');
      releaseUpstream();
      const proxyResponse = await proxyResponsePromise;
      assert.equal(proxyResponse.status, 200);
      assert.deepEqual(await proxyResponse.json(), { ok: true });
      const [exitCode, signal] = await once(child, 'exit');
      assert.equal(signal, null, stderr);
      assert.equal(exitCode, 0, stderr);
    } finally {
      releaseUpstream?.();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      await closeServer(upstreamServer);
    }

    await withEnv({
      HEADROOM_LITE_STATS_PATH: statsPath,
    }, async () => {
      const tag = `cli-shutdown-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const { startServer: startConfiguredServer } = await importFreshServerModule(defaultHome, tag);
      const server = await startConfiguredServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
      const address = server.address();

      try {
        const stats = await (await fetch(`http://127.0.0.1:${address.port}/stats`)).json();
        assert.equal(stats.lifetime.proxy.requests, 1);
        assert.equal(stats.session.proxy.requests, 0);
      } finally {
        await closeServer(server);
      }
    });
  });

  it('falls back to an in-memory default telemetry ledger when createServer cannot create the default path', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-readonly-create-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-readonly-create-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const restoreFs = patchReadOnlyDefaultTelemetryPath(defaultHome);
    let server;

    try {
      const { createServer: createDefaultServer } = await importFreshServerModule(defaultHome, tag);
      server = await listenServer(createDefaultServer({
        maxBodyBytes: 1024 * 1024,
      }));
    } finally {
      restoreFs();
    }

    const address = server.address();
    try {
      const compress = await fetch(`http://127.0.0.1:${address.port}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'fallback-createServer' }] }),
      });
      assert.equal(compress.status, 200);

      const [health, stats, history] = await Promise.all([
        fetch(`http://127.0.0.1:${address.port}/health`),
        fetch(`http://127.0.0.1:${address.port}/stats`),
        fetch(`http://127.0.0.1:${address.port}/stats-history?series=hourly`),
      ]);
      assert.equal(health.status, 200);
      assert.equal(stats.status, 200);
      assert.equal(history.status, 200);

      const healthBody = await health.json();
      const statsBody = await stats.json();
      const historyBody = await history.json();

      assert.deepEqual(healthBody.capabilities, {
        snapshot: true,
        history: true,
        csv: true,
        prometheus: true,
        flush: true,
        persistence: false,
      });
      assert.deepEqual(statsBody.capabilities, healthBody.capabilities);
      assert.equal(statsBody.compress_requests, 1);
      assert.equal(statsBody.session.compression.requests, 1);
      assert.equal(statsBody.lifetime.compression.requests, 1);
      assert.ok(historyBody.rows.some((row) => row.series === 'compression.requests' && row.value >= 1));
    } finally {
      await closeServer(server);
    }
  });

  it('keeps the default-path fallback when an explicit resolved default telemetry path cannot be created', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-readonly-explicit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-readonly-explicit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const restoreFs = patchReadOnlyDefaultTelemetryPath(defaultHome);
    const explicitDefaultPath = join(defaultHome, '.headroom-lite', 'telemetry.json');
    let server;

    try {
      const { createServer: createDefaultServer } = await importFreshServerModule(defaultHome, tag);
      server = await listenServer(createDefaultServer({
        maxBodyBytes: 1024 * 1024,
        statsPathInput: explicitDefaultPath,
      }));
    } finally {
      restoreFs();
    }

    const address = server.address();
    try {
      const [health, stats] = await Promise.all([
        fetch(`http://127.0.0.1:${address.port}/health`),
        fetch(`http://127.0.0.1:${address.port}/stats`),
      ]);
      assert.equal(health.status, 200);
      assert.equal(stats.status, 200);

      const healthBody = await health.json();
      const statsBody = await stats.json();
      assert.equal(healthBody.capabilities.persistence, false);
      assert.equal(statsBody.capabilities.persistence, false);
    } finally {
      await closeServer(server);
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

  it('expands ~/ stats paths into the home directory without creating a literal workspace tilde directory', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-tilde-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-tilde-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const literalWorkspaceTildeDir = join(__dirname, '..', '~');
    const expandedStatsPath = join(defaultHome, '.headroom-lite', 'tilde-telemetry.json');

    rmSync(literalWorkspaceTildeDir, { recursive: true, force: true });

    await withEnv({
      HOME: defaultHome,
      // os.homedir() reads USERPROFILE on Windows — set both so the ~/ expansion
      // resolves to the fake home at runtime cross-platform.
      USERPROFILE: defaultHome,
      HEADROOM_LITE_STATS_PATH: '~/.headroom-lite/tilde-telemetry.json',
    }, async () => {
      const { startServer: startDefaultServer, resolveStatsPath } = await importFreshServerModule(defaultHome, tag);
      assert.equal(resolveStatsPath(), expandedStatsPath);

      const firstServer = await startDefaultServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
      const firstAddress = firstServer.address();

      try {
        const compress = await fetch(`http://127.0.0.1:${firstAddress.port}/v1/compress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'tilde-path-persistence' }] }),
        });
        assert.equal(compress.status, 200);
      } finally {
        await closeServer(firstServer);
      }

      const secondServer = await startDefaultServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
      const secondAddress = secondServer.address();

      try {
        const stats = await (await fetch(`http://127.0.0.1:${secondAddress.port}/stats`)).json();
        assert.equal(stats.lifetime.compression.requests, 1);
        assert.equal(stats.session.compression.requests, 0);
        assert.equal(existsSync(expandedStatsPath), true);
        assert.equal(existsSync(literalWorkspaceTildeDir), false);
      } finally {
        await closeServer(secondServer);
      }
    });

    rmSync(literalWorkspaceTildeDir, { recursive: true, force: true });
  });

  it('falls back to an in-memory default telemetry ledger when startServer cannot create the default path', async () => {
    const defaultHome = join(ARTIFACT_ROOT, `default-home-readonly-start-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tag = `default-readonly-start-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const restoreFs = patchReadOnlyDefaultTelemetryPath(defaultHome);
    let server;

    try {
      const { startServer: startDefaultServer } = await importFreshServerModule(defaultHome, tag);
      server = await startDefaultServer({
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 1024 * 1024,
      });
    } finally {
      restoreFs();
    }

    const address = server.address();
    try {
      const [ready, stats] = await Promise.all([
        fetch(`http://127.0.0.1:${address.port}/readyz`),
        fetch(`http://127.0.0.1:${address.port}/stats`),
      ]);
      assert.equal(ready.status, 200);
      assert.equal(stats.status, 200);

      const readyBody = await ready.json();
      const statsBody = await stats.json();

      assert.deepEqual(readyBody.capabilities, {
        snapshot: true,
        history: true,
        csv: true,
        prometheus: true,
        flush: true,
        persistence: false,
      });
      assert.deepEqual(statsBody.capabilities, readyBody.capabilities);
      assert.equal(statsBody.status, 'ok');
      assert.equal(statsBody.service, 'headroom-lite');
      assert.equal(statsBody.lifetime.compression.requests, 0);
    } finally {
      await closeServer(server);
    }
  });
});

describe('headroom-parity gap endpoints', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      telemetryLedger: createTelemetryLedger({ path: ledgerPath('http-parity-gaps.json') }),
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await closeServer(server);
  });

  it('serves /healthz as an alias of /health', async () => {
    const [health, healthz] = await Promise.all([
      fetch(`${baseUrl}/health`),
      fetch(`${baseUrl}/healthz`),
    ]);
    assert.equal(healthz.status, 200);
    assert.deepEqual(await healthz.json(), await health.json());
  });

  it('POST /stats/reset zeroes the runtime counters and telemetry session', async () => {
    await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }),
    });
    const before = await (await fetch(`${baseUrl}/stats`)).json();
    assert.ok(before.compress_requests >= 1);
    assert.ok(before.session.compression.requests >= 1);

    const reset = await fetch(`${baseUrl}/stats/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.equal(resetBody.compress_requests, 0);
    assert.equal(resetBody.compress_tokens_before, 0);
    assert.equal(resetBody.compress_tokens_after, 0);
    // Telemetry session must reset too so /stats is internally consistent...
    assert.equal(resetBody.session.compression.requests, 0);
    // ...while durable lifetime history is preserved.
    assert.ok(resetBody.lifetime.compression.requests >= 1);

    const after = await (await fetch(`${baseUrl}/stats`)).json();
    assert.equal(after.compress_requests, 0);
    assert.equal(after.session.compression.requests, 0);
  });

  it('does not double-count history after POST /stats/reset', async () => {
    await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'y'.repeat(4000) }] }),
    });
    const sumRequests = (rows) => rows
      .filter((r) => r.series === 'compression.requests')
      .reduce((sum, r) => sum + r.value, 0);

    const beforeRows = (await (await fetch(`${baseUrl}/stats-history`)).json()).rows;
    const beforeValue = sumRequests(beforeRows);
    assert.ok(beforeValue >= 1);

    await fetch(`${baseUrl}/stats/reset`, { method: 'POST' });

    const afterRows = (await (await fetch(`${baseUrl}/stats-history`)).json()).rows;
    const afterValue = sumRequests(afterRows);
    // The reset commits the pending delta into durable history exactly once — it
    // must NOT also leave the same delta in the server's pending-rows buffer
    // (which would double-count on the next /stats-history read).
    assert.equal(afterValue, beforeValue, 'reset double-counted pending history rows');
  });

  it('returns 501 not-implemented for known headroom endpoints hl does not serve', async () => {
    const paths = ['/subscription-window', '/quota', '/v1/telemetry', '/v1/toin/stats', '/cache/clear', '/transformations/feed', '/dashboard'];
    for (const path of paths) {
      const r = await fetch(`${baseUrl}${path}`);
      assert.equal(r.status, 501, `${path} should be 501`);
      const body = await r.json();
      assert.equal(body.error, 'not implemented');
      assert.equal(body.service, 'headroom-lite');
      assert.ok(typeof body.reason === 'string' && body.reason.length > 0, `${path} needs a reason`);
    }
  });

  // ── B4: favicon 204 ───────────────────────────────────────────────────────
  it('returns 204 for GET /favicon.ico and never proxies it (B4 #1787)', async () => {
    const res = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(res.status, 204, '/favicon.ico should be 204 No Content');
    const body = await res.text();
    assert.equal(body, '', 'favicon response must have no body');
  });

  // ── B4: tokens_saved + compression_ratio in /v1/compress response ─────────
  it('includes tokens_saved and compression_ratio in /v1/compress response', async () => {
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.tokens_saved === 'number', 'tokens_saved must be a number');
    assert.ok(typeof body.compression_ratio === 'number', 'compression_ratio must be a number');
    assert.ok(body.compression_ratio >= 0 && body.compression_ratio <= 1.0, 'compression_ratio must be in [0, 1]');
    assert.equal(body.tokens_saved, Math.max(0, body.tokens_before - body.tokens_after));
  });

  // ── B4: HEADROOM_LITE_MIN_TOKENS gate ─────────────────────────────────────
  it('skips compression and returns messages as-is when below HEADROOM_LITE_MIN_TOKENS', async () => {
    const minTokenServer = createServer({ minTokens: 999999 });
    await new Promise((resolve) => minTokenServer.listen(0, '127.0.0.1', resolve));
    const minTokenPort = minTokenServer.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${minTokenPort}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Short message' }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.skipped_reason, 'below_min_tokens', 'should indicate skip reason');
      assert.equal(body.tokens_saved, 0, 'no tokens saved when skipped');
      assert.equal(body.compression_ratio, 1.0, 'compression_ratio must be 1.0 when skipped');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Short message' }], 'messages returned as-is');
    } finally {
      await new Promise((resolve) => minTokenServer.close(resolve));
    }
  });

  it('compresses normally when token count exceeds HEADROOM_LITE_MIN_TOKENS threshold', async () => {
    const minTokenServer = createServer({ minTokens: 1 });
    await new Promise((resolve) => minTokenServer.listen(0, '127.0.0.1', resolve));
    const minTokenPort = minTokenServer.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${minTokenPort}/v1/compress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!body.skipped_reason, 'should not skip when above threshold');
    } finally {
      await new Promise((resolve) => minTokenServer.close(resolve));
    }
  });

  it('compresses normally when minTokens is 0 (default — no minimum)', async () => {
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.skipped_reason, 'minTokens=0 must never trigger skip');
  });
});
