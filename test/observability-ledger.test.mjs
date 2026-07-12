import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, it } from 'node:test';
import { createTelemetryLedger } from '../src/observability/ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = join(__dirname, '.artifacts', 'observability-ledger');
const LEDGER_MODULE_PATH = join(__dirname, '..', 'src', 'observability', 'ledger.mjs');

after(() => {
  rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
  mkdirSync(ARTIFACT_ROOT, { recursive: true });
});

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

function ledgerPath(name = 'stats.json') {
  return join(ARTIFACT_ROOT, name);
}

function writePersistedLedger(name, payload) {
  const path = ledgerPath(name);
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  return path;
}

function createEmptyPersistedLedgerPayload(capturedAt = '2026-01-01T00:00:00.000Z') {
  return {
    schema_version: 1,
    captured_at: capturedAt,
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
      compression: {
        requests: 0,
        tokens_before: 0,
        tokens_after: 0,
        tokens_saved: 0,
        latency_ms: 0,
        outcomes: {},
        providers: {},
        models: {},
      },
      proxy: {
        requests: 0,
        latency_ms: 0,
        outcomes: {},
        providers: {},
        models: {},
      },
    },
    session: {
      compression: {
        requests: 0,
        tokens_before: 0,
        tokens_after: 0,
        tokens_saved: 0,
        latency_ms: 0,
        outcomes: {},
        providers: {},
        models: {},
      },
      proxy: {
        requests: 0,
        latency_ms: 0,
        outcomes: {},
        providers: {},
        models: {},
      },
    },
    history_baseline: null,
    history_points: [],
  };
}

const CONCURRENT_FLUSH_CHILD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [, modulePath, ledgerPath, blockedPath, releasePath, tokensBeforeArg, tokensAfterArg, latencyArg] = process.argv;
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const { createTelemetryLedger } = await import(pathToFileURL(modulePath).href);
const ledger = createTelemetryLedger({ path: ledgerPath });
ledger.recordCompression({
  tokensBefore: Number(tokensBeforeArg),
  tokensAfter: Number(tokensAfterArg),
  latencyMs: Number(latencyArg),
  outcome: 'ok',
  provider: 'anthropic',
  model: 'claude-sonnet-4.5',
});

let blocked = false;
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const textPath = typeof path === 'string' ? path : path?.toString?.();
  if (!blocked && textPath === ledgerPath) {
    blocked = true;
    const content = originalReadFileSync(path, ...args);
    fs.writeFileSync(blockedPath, 'blocked\\n', 'utf8');
    while (!fs.existsSync(releasePath)) {
      sleep(10);
    }
    return content;
  }
  return originalReadFileSync(path, ...args);
};
syncBuiltinESMExports();

try {
  ledger.flush();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
`;

const RENEWING_LOCK_HOLDER_CHILD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, modulePath, ledgerPath, blockedPath, releasePath] = process.argv;
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const heartbeatPath = join(\`\${ledgerPath}.lock\`, 'heartbeat');

const { createTelemetryLedger } = await import(pathToFileURL(modulePath).href);
const ledger = createTelemetryLedger({ path: ledgerPath });
ledger.recordCompression({
  tokensBefore: 100,
  tokensAfter: 40,
  latencyMs: 11,
  outcome: 'ok',
  provider: 'anthropic',
  model: 'claude-sonnet-4.5',
});

let blocked = false;
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const textPath = typeof path === 'string' ? path : path?.toString?.();
  if (!blocked && textPath === ledgerPath) {
    blocked = true;
    const content = originalReadFileSync(path, ...args);
    fs.writeFileSync(blockedPath, 'blocked\\n', 'utf8');
    while (!fs.existsSync(releasePath)) {
      if (fs.existsSync(heartbeatPath)) {
        fs.writeFileSync(heartbeatPath, \`\${Date.now()}\\n\`, 'utf8');
      }
      sleep(50);
    }
    return content;
  }
  return originalReadFileSync(path, ...args);
};
syncBuiltinESMExports();

try {
  ledger.flush();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
`;

const LOCK_CONTENDER_CHILD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const [, modulePath, ledgerPath, enteredPath] = process.argv;
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync;

let entered = false;
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  const textPath = typeof path === 'string' ? path : path?.toString?.();
  if (!entered && textPath === ledgerPath) {
    entered = true;
    fs.writeFileSync(enteredPath, 'entered\\n', 'utf8');
  }
  return originalReadFileSync(path, ...args);
};
syncBuiltinESMExports();

const { createTelemetryLedger } = await import(pathToFileURL(modulePath).href);
const ledger = createTelemetryLedger({ path: ledgerPath });
ledger.recordCompression({
  tokensBefore: 80,
  tokensAfter: 30,
  latencyMs: 7,
  outcome: 'ok',
  provider: 'anthropic',
  model: 'claude-sonnet-4.5',
});

try {
  ledger.flush();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
`;

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.signalCode, null);
    assert.equal(child.exitCode, 0);
    return;
  }
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0);
}

async function waitForChildExitWithTimeout(child, timeoutMs = 5_000) {
  let timer;
  try {
    await Promise.race([
      waitForChildExit(child),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`timed out waiting for child ${child.pid}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPath(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForPathWithTimeout(path, timeoutMs) {
  try {
    await waitForPath(path, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForFirstPath(entries, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of entries) {
      if (existsSync(entry.path)) return entry.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for any of: ${entries.map((entry) => entry.path).join(', ')}`);
}

describe('telemetry ledger', () => {
  it('records compression without request content and computes saved tokens', () => {
    const clock = createClock();
    const ledger = createTelemetryLedger({ path: ledgerPath(), now: clock.now });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 40, latencyMs: 12 });

    const stats = ledger.snapshot();
    assert.equal(stats.schema_version, 1);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.service, 'headroom-lite');
    assert.deepEqual(stats.capabilities, {
      snapshot: true,
      history: true,
      csv: true,
      prometheus: true,
      flush: true,
      persistence: true,
    });
    assert.equal(stats.lifetime.compression.tokens_saved, 60);
    assert.equal(stats.lifetime.compression.requests, 1);
    assert.equal(stats.session.compression.tokens_saved, 60);
    assert.equal(stats.session.compression.requests, 1);
    assert.equal(stats.history.retained_points, 0);
    assert.deepEqual(stats.history.series, [
      'compression.requests',
      'compression.tokens_before',
      'compression.tokens_after',
      'compression.tokens_saved',
      'compression.latency_ms',
      'proxy.requests',
      'proxy.latency_ms',
    ]);
    assert.equal('request_body' in stats, false);
  });

  it('rejects unknown event keys for compression and proxy records', () => {
    const ledger = createTelemetryLedger({ path: ledgerPath() });

    assert.throws(
      () => ledger.recordCompression({ tokensBefore: 10, tokensAfter: 5, latencyMs: 3, requestBody: 'secret' }),
      /Unknown event key: requestBody/,
    );
    assert.throws(
      () => ledger.recordProxy({ latencyMs: 3, requestBody: 'secret' }),
      /Unknown event key: requestBody/,
    );
  });

  it('normalizes negative and non-finite numbers to zero', () => {
    const ledger = createTelemetryLedger({ path: ledgerPath() });

    ledger.recordCompression({ tokensBefore: Infinity, tokensAfter: -5, latencyMs: Number.NaN });
    ledger.recordProxy({ latencyMs: -10 });

    const stats = ledger.snapshot();
    assert.equal(stats.lifetime.compression.requests, 1);
    assert.equal(stats.lifetime.compression.tokens_before, 0);
    assert.equal(stats.lifetime.compression.tokens_after, 0);
    assert.equal(stats.lifetime.compression.tokens_saved, 0);
    assert.equal(stats.lifetime.compression.latency_ms, 0);
    assert.equal(stats.lifetime.proxy.requests, 1);
    assert.equal(stats.lifetime.proxy.latency_ms, 0);
  });

  it('persists validated lifetime state across restart while resetting session counters', () => {
    const path = ledgerPath('persisted.json');
    const firstClock = createClock('2026-01-01T00:00:00.000Z');
    const firstLedger = createTelemetryLedger({ path, now: firstClock.now });

    firstLedger.recordCompression({
      tokensBefore: 100,
      tokensAfter: 70,
      latencyMs: 15,
      outcome: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });
    firstLedger.recordProxy({
      latencyMs: 45,
      outcome: 'ok',
      provider: 'openai',
      model: 'gpt-5.5',
    });
    firstClock.set('2026-01-01T00:10:00.000Z');
    firstLedger.flush();

    const secondClock = createClock('2026-01-01T00:15:00.000Z');
    const secondLedger = createTelemetryLedger({ path, now: secondClock.now });
    const snapshot = secondLedger.snapshot();

    assert.equal(snapshot.lifetime.compression.requests, 1);
    assert.equal(snapshot.lifetime.compression.tokens_saved, 30);
    assert.equal(snapshot.lifetime.compression.outcomes.ok, 1);
    assert.equal(snapshot.lifetime.compression.providers.anthropic, 1);
    assert.equal(snapshot.lifetime.compression.models.claude, 1);
    assert.equal(snapshot.lifetime.proxy.requests, 1);
    assert.equal(snapshot.lifetime.proxy.outcomes.ok, 1);
    assert.equal(snapshot.lifetime.proxy.providers.openai, 1);
    assert.equal(snapshot.lifetime.proxy.models.gpt, 1);
    assert.equal(snapshot.session.compression.requests, 0);
    assert.equal(snapshot.session.proxy.requests, 0);
    assert.equal(snapshot.history.retained_points, 1);
  });

  it('rewrites stale session totals to zero on startup before any new event is recorded', () => {
    const path = ledgerPath('restart-session.json');
    const firstClock = createClock('2026-01-01T00:00:00.000Z');
    const firstLedger = createTelemetryLedger({ path, now: firstClock.now });

    firstLedger.recordCompression({
      tokensBefore: 50,
      tokensAfter: 20,
      latencyMs: 11,
      outcome: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });
    firstLedger.recordProxy({
      latencyMs: 17,
      outcome: 'ok',
      provider: 'openai',
      model: 'gpt-5.5',
    });
    firstClock.set('2026-01-01T00:05:00.000Z');
    firstLedger.flush();

    const secondClock = createClock('2026-01-01T00:06:00.000Z');
    const secondLedger = createTelemetryLedger({ path, now: secondClock.now });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));

    assert.equal(persisted.session.compression.requests, 0);
    assert.equal(persisted.session.compression.tokens_saved, 0);
    assert.equal(persisted.session.proxy.requests, 0);
    assert.equal(persisted.lifetime.compression.requests, 1);
    assert.equal(persisted.lifetime.proxy.requests, 1);
    assert.equal(secondLedger.snapshot().session.compression.requests, 0);

    secondLedger.recordCompression({
      tokensBefore: 80,
      tokensAfter: 60,
      latencyMs: 9,
      outcome: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });

    assert.equal(secondLedger.snapshot().session.compression.requests, 1);
    assert.equal(secondLedger.snapshot().lifetime.compression.requests, 2);
  });

  it('redacts unsafe dimension labels before persistence and export', () => {
    const path = ledgerPath('redacted.json');
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({ path, now: clock.now });

    ledger.recordCompression({
      tokensBefore: 100,
      tokensAfter: 70,
      latencyMs: 15,
      outcome: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });
    ledger.recordCompression({
      tokensBefore: 100,
      tokensAfter: 40,
      latencyMs: 20,
      outcome: '{"response":"user-body"}',
      provider: '/Users/alice/.ssh/id_ed25519',
      model: 'opaque-auth-token',
    });
    clock.set('2026-01-01T00:10:00.000Z');
    ledger.flush();

    const persisted = readFileSync(path, 'utf8');
    assert.equal(persisted.includes('/Users/alice/.ssh/id_ed25519'), false);
    assert.equal(persisted.includes('opaque-auth-token'), false);
    assert.equal(persisted.includes('user-body'), false);

    const reloaded = createTelemetryLedger({ path, now: clock.now });
    const snapshot = reloaded.snapshot();
    assert.equal(snapshot.lifetime.compression.outcomes.ok, 1);
    assert.equal(snapshot.lifetime.compression.outcomes.other, 1);
    assert.equal(snapshot.lifetime.compression.providers.anthropic, 1);
    assert.equal(snapshot.lifetime.compression.providers.other, 1);
    assert.equal(snapshot.lifetime.compression.models.claude, 1);
    assert.equal(snapshot.lifetime.compression.models.other, 1);

    const metrics = reloaded.toPrometheus();
    assert.match(metrics, /^headroom_lite_lifetime_compression_models_total\{label="claude"\} 1$/m);
    assert.match(metrics, /^headroom_lite_lifetime_compression_models_total\{label="other"\} 1$/m);
    assert.doesNotMatch(metrics, /Users\/alice/);
    assert.doesNotMatch(metrics, /opaque-auth-token/);
    assert.doesNotMatch(metrics, /user-body/);
  });

  it('migrates legacy persisted labels on load and rewrites sanitized state immediately', () => {
    const path = writePersistedLedger('legacy-vulnerable.json', {
      schema_version: 1,
      captured_at: '2026-01-01T00:10:00.000Z',
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
        compression: {
          requests: 2,
          tokens_before: 200,
          tokens_after: 120,
          tokens_saved: 80,
          latency_ms: 35,
          outcomes: { ok: 1, '{"response":"secret"}': 1 },
          providers: { anthropic: 1, '/Users/alice/.ssh/id_ed25519': 1 },
          models: { 'claude-sonnet-4.5': 1, 'opaque-auth-token': 1 },
        },
        proxy: {
          requests: 1,
          latency_ms: 25,
          outcomes: { timeout: 1 },
          providers: { 'github-models': 1 },
          models: { 'gpt-5.5': 1 },
        },
      },
      session: {
        compression: {
          requests: 1,
          tokens_before: 100,
          tokens_after: 70,
          tokens_saved: 30,
          latency_ms: 15,
          outcomes: { '{"request":"secret"}': 1 },
          providers: { '/private/tmp/request-body': 1 },
          models: { 'opaque-auth-token': 1 },
        },
        proxy: {
          requests: 0,
          latency_ms: 0,
          outcomes: {},
          providers: {},
          models: {},
        },
      },
      history_points: [],
    });

    const ledger = createTelemetryLedger({ path, now: () => new Date('2026-01-01T00:15:00.000Z') });
    const snapshot = ledger.snapshot();

    assert.equal(snapshot.lifetime.compression.outcomes.ok, 1);
    assert.equal(snapshot.lifetime.compression.outcomes.other, 1);
    assert.equal(snapshot.lifetime.compression.providers.anthropic, 1);
    assert.equal(snapshot.lifetime.compression.providers.other, 1);
    assert.equal(snapshot.lifetime.compression.models.claude, 1);
    assert.equal(snapshot.lifetime.compression.models.other, 1);
    assert.equal(snapshot.session.compression.requests, 0);

    const persisted = readFileSync(path, 'utf8');
    assert.equal(persisted.includes('/Users/alice/.ssh/id_ed25519'), false);
    assert.equal(persisted.includes('/private/tmp/request-body'), false);
    assert.equal(persisted.includes('opaque-auth-token'), false);
    assert.equal(persisted.includes('"history_baseline": null'), true);
  });

  it('preserves both compression deltas when two processes flush the same ledger concurrently', async () => {
    const path = writePersistedLedger('concurrent-flush.json', createEmptyPersistedLedgerPayload());
    const firstBlockedPath = ledgerPath('concurrent-flush.first.blocked');
    const secondBlockedPath = ledgerPath('concurrent-flush.second.blocked');
    const firstReleasePath = ledgerPath('concurrent-flush.first.release');
    const secondReleasePath = ledgerPath('concurrent-flush.second.release');
    const childArgs = [
      '--input-type=module',
      '-e',
      CONCURRENT_FLUSH_CHILD,
      LEDGER_MODULE_PATH,
      path,
    ];
    const firstChild = spawn(process.execPath, [...childArgs, firstBlockedPath, firstReleasePath, '100', '40', '11'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const secondChild = spawn(process.execPath, [...childArgs, secondBlockedPath, secondReleasePath, '80', '30', '7'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const firstExit = waitForChildExit(firstChild);
    const secondExit = waitForChildExit(secondChild);

    const firstBlockedChild = await waitForFirstPath([
      { name: 'first', path: firstBlockedPath },
      { name: 'second', path: secondBlockedPath },
    ]);
    const secondBlockedEarly = await waitForPathWithTimeout(
      firstBlockedChild === 'first' ? secondBlockedPath : firstBlockedPath,
      100,
    );

    if (firstBlockedChild === 'first') {
      writeFileSync(firstReleasePath, 'release\n', 'utf8');
      if (secondBlockedEarly) {
        writeFileSync(secondReleasePath, 'release\n', 'utf8');
      } else {
        await firstExit;
        await waitForPath(secondBlockedPath);
        writeFileSync(secondReleasePath, 'release\n', 'utf8');
      }
    } else if (secondBlockedEarly) {
      writeFileSync(firstReleasePath, 'release\n', 'utf8');
      writeFileSync(secondReleasePath, 'release\n', 'utf8');
    } else {
      writeFileSync(secondReleasePath, 'release\n', 'utf8');
      await secondExit;
      await waitForPath(firstBlockedPath);
      writeFileSync(firstReleasePath, 'release\n', 'utf8');
    }

    await Promise.all([firstExit, secondExit]);

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(persisted.lifetime.compression.requests, 2);
    assert.equal(persisted.lifetime.compression.tokens_before, 180);
    assert.equal(persisted.lifetime.compression.tokens_after, 70);
    assert.equal(persisted.lifetime.compression.tokens_saved, 110);
    assert.ok(persisted.history_points.length >= 1);
    const finalPoint = persisted.history_points.at(-1);
    assert.equal(finalPoint.compression.requests, 2);
    assert.equal(finalPoint.compression.tokens_saved, 110);
  });

  it('does not let a contender enter a renewed lock after the stale threshold passes', async () => {
    const path = writePersistedLedger('renewed-lock.json', createEmptyPersistedLedgerPayload());
    const blockedPath = ledgerPath('renewed-lock.blocked');
    const releasePath = ledgerPath('renewed-lock.release');
    const enteredPath = ledgerPath('renewed-lock.entered');
    const holder = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      RENEWING_LOCK_HOLDER_CHILD,
      LEDGER_MODULE_PATH,
      path,
      blockedPath,
      releasePath,
    ], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    await waitForPath(blockedPath);
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    const contender = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      LOCK_CONTENDER_CHILD,
      LEDGER_MODULE_PATH,
      path,
      enteredPath,
    ], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    try {
      assert.equal(await waitForPathWithTimeout(enteredPath, 300), false);

      writeFileSync(releasePath, 'release\n', 'utf8');
      await waitForPath(enteredPath);
    } finally {
      if (!existsSync(releasePath)) {
        writeFileSync(releasePath, 'release\n', 'utf8');
      }
      await Promise.allSettled([
        waitForChildExitWithTimeout(holder),
        waitForChildExitWithTimeout(contender),
      ]);
    }

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(persisted.lifetime.compression.requests, 2);
    assert.equal(persisted.lifetime.compression.tokens_saved, 110);
  });

  it('calculates hourly deltas from cumulative history points', () => {
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({ path: ledgerPath(), now: clock.now });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 70, latencyMs: 10 });
    clock.set('2026-01-01T00:10:00.000Z');
    ledger.flush();

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 80, latencyMs: 10 });
    clock.set('2026-01-01T01:05:00.000Z');
    ledger.flush();

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 90, latencyMs: 10 });
    clock.set('2026-01-01T01:55:00.000Z');
    ledger.flush();

    assert.deepEqual(ledger.history({ series: 'compression.tokens_saved' }), [
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T00:00:00.000Z', value: 30 },
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T01:00:00.000Z', value: 30 },
    ]);
  });

  it('exports csv with stable headers for a selected history series', () => {
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({ path: ledgerPath(), now: clock.now });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 60, latencyMs: 10 });
    clock.set('2026-01-01T00:10:00.000Z');
    ledger.flush();

    const csv = ledger.toCsv({ series: 'compression.tokens_saved' });
    const lines = csv.trim().split('\n');

    assert.equal(lines[0], 'series,bucket_start,value');
    assert.equal(lines[1], 'compression.tokens_saved,2026-01-01T00:00:00.000Z,40');
  });

  it('exports prometheus counters with stable metric names', () => {
    const ledger = createTelemetryLedger({ path: ledgerPath() });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 40, latencyMs: 12 });
    ledger.recordProxy({ latencyMs: 25 });

    const metrics = ledger.toPrometheus();
    assert.match(metrics, /^# HELP headroom_lite_schema_version schema version$/m);
    assert.match(metrics, /^headroom_lite_schema_version 1$/m);
    assert.match(metrics, /^headroom_lite_lifetime_compression_requests_total 1$/m);
    assert.match(metrics, /^headroom_lite_lifetime_compression_tokens_saved_total 60$/m);
    assert.match(metrics, /^headroom_lite_lifetime_proxy_requests_total 1$/m);
    assert.match(metrics, /^headroom_lite_session_proxy_latency_ms_total 25$/m);
    assert.doesNotMatch(metrics, /request_body/);
  });

  it('retains predecessor baseline so the first kept history bucket is not overstated after pruning', () => {
    const path = ledgerPath('pruned.json');
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 2,
      maxHistoryAgeMs: 2 * 60 * 60 * 1000,
    });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 90, latencyMs: 5 });
    clock.set('2026-01-01T00:00:00.000Z');
    ledger.flush();

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 80, latencyMs: 5 });
    clock.set('2026-01-01T01:00:00.000Z');
    ledger.flush();

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 70, latencyMs: 5 });
    clock.set('2026-01-01T02:00:00.000Z');
    ledger.flush();

    const snapshot = ledger.snapshot();
    assert.equal(snapshot.history.retained_points, 2);
    const reloaded = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 2,
      maxHistoryAgeMs: 2 * 60 * 60 * 1000,
    });
    assert.deepEqual(reloaded.history({ series: 'compression.tokens_saved' }), [
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T01:00:00.000Z', value: 20 },
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T02:00:00.000Z', value: 30 },
    ]);
  });

  it('discards unreconstructable legacy retained history on reload so the first bucket is not overstated', () => {
    const path = writePersistedLedger('legacy-history.json', {
      schema_version: 1,
      captured_at: '2026-01-01T02:00:00.000Z',
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
        compression: {
          requests: 3,
          tokens_before: 300,
          tokens_after: 240,
          tokens_saved: 60,
          latency_ms: 15,
          outcomes: {},
          providers: {},
          models: {},
        },
        proxy: {
          requests: 0,
          latency_ms: 0,
          outcomes: {},
          providers: {},
          models: {},
        },
      },
      history_points: [
        {
          captured_at: '2026-01-01T01:00:00.000Z',
          compression: {
            requests: 2,
            tokens_before: 200,
            tokens_after: 170,
            tokens_saved: 30,
            latency_ms: 10,
          },
          proxy: { requests: 0, latency_ms: 0 },
        },
        {
          captured_at: '2026-01-01T02:00:00.000Z',
          compression: {
            requests: 3,
            tokens_before: 300,
            tokens_after: 240,
            tokens_saved: 60,
            latency_ms: 15,
          },
          proxy: { requests: 0, latency_ms: 0 },
        },
      ],
    });

    const reloaded = createTelemetryLedger({
      path,
      now: () => new Date('2026-01-01T02:05:00.000Z'),
      maxHistoryPoints: 2,
      maxHistoryAgeMs: 2 * 60 * 60 * 1000,
    });

    assert.deepEqual(reloaded.history({ series: 'compression.tokens_saved' }), []);
    assert.equal(reloaded.snapshot().history.retained_points, 0);

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(persisted.history_points, []);
    assert.equal(persisted.history_baseline, null);
  });

  it('drops all history when maxHistoryAgeMs is explicitly zero on flush and reload', () => {
    const path = ledgerPath('zero-retention.json');
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 10,
      maxHistoryAgeMs: 0,
    });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 80, latencyMs: 5 });
    clock.set('2026-01-01T01:00:00.000Z');

    const flushed = ledger.flush();
    assert.equal(flushed.history.retained_points, 0);
    assert.deepEqual(ledger.history({ series: 'compression.tokens_saved' }), []);

    const reloaded = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 10,
      maxHistoryAgeMs: 0,
    });

    assert.equal(reloaded.snapshot().history.retained_points, 0);
    assert.deepEqual(reloaded.history({ series: 'compression.tokens_saved' }), []);

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(persisted.history_points, []);
    assert.equal(persisted.history_baseline, null);
  });

  it('drops all history when maxHistoryPoints is explicitly zero on flush and reload', () => {
    const path = ledgerPath('zero-points.json');
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 0,
      maxHistoryAgeMs: 2 * 60 * 60 * 1000,
    });

    ledger.recordCompression({ tokensBefore: 100, tokensAfter: 75, latencyMs: 7 });
    clock.set('2026-01-01T01:00:00.000Z');

    const flushed = ledger.flush();
    assert.equal(flushed.history.retained_points, 0);
    assert.deepEqual(ledger.history({ series: 'compression.tokens_saved' }), []);

    const reloaded = createTelemetryLedger({
      path,
      now: clock.now,
      maxHistoryPoints: 0,
      maxHistoryAgeMs: 2 * 60 * 60 * 1000,
    });

    assert.equal(reloaded.snapshot().history.retained_points, 0);
    assert.deepEqual(reloaded.history({ series: 'compression.tokens_saved' }), []);

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(persisted.history_points, []);
    assert.equal(persisted.history_baseline, null);
  });
});
