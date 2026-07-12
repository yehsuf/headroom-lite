import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, describe, it } from 'node:test';
import { createTelemetryLedger } from '../src/observability/ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_ROOT = join(__dirname, '.artifacts', 'observability-ledger');

after(() => {
  rmSync(join(__dirname, '.artifacts'), { recursive: true, force: true });
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
    assert.equal(snapshot.lifetime.compression.models['claude-sonnet-4.5'], 1);
    assert.equal(snapshot.lifetime.proxy.requests, 1);
    assert.equal(snapshot.lifetime.proxy.outcomes.ok, 1);
    assert.equal(snapshot.lifetime.proxy.providers.openai, 1);
    assert.equal(snapshot.lifetime.proxy.models['gpt-5.5'], 1);
    assert.equal(snapshot.session.compression.requests, 0);
    assert.equal(snapshot.session.proxy.requests, 0);
    assert.equal(snapshot.history.retained_points, 1);
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

  it('prunes history by age and count before flush writes', () => {
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const ledger = createTelemetryLedger({
      path: ledgerPath(),
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
    assert.deepEqual(ledger.history({ series: 'compression.tokens_saved' }), [
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T01:00:00.000Z', value: 30 },
      { series: 'compression.tokens_saved', bucket_start: '2026-01-01T02:00:00.000Z', value: 30 },
    ]);
  });
});
