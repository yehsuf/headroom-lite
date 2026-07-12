import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;
const SERVICE = 'headroom-lite';
const DEFAULT_MAX_HISTORY_POINTS = 720;
const DEFAULT_MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CAPABILITIES = Object.freeze({
  snapshot: true,
  history: true,
  csv: true,
  prometheus: true,
  flush: true,
  persistence: true,
});
const HISTORY_SERIES = Object.freeze([
  'compression.requests',
  'compression.tokens_before',
  'compression.tokens_after',
  'compression.tokens_saved',
  'compression.latency_ms',
  'proxy.requests',
  'proxy.latency_ms',
]);
const COMPRESSION_EVENT_KEYS = new Set(['tokensBefore', 'tokensAfter', 'latencyMs', 'outcome', 'provider', 'model']);
const PROXY_EVENT_KEYS = new Set(['latencyMs', 'outcome', 'provider', 'model']);

function createAggregate() {
  return {
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
  };
}

function normalizeNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCountMap(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    const count = normalizeNumber(raw);
    if (count > 0) normalized[key] = count;
  }
  return normalized;
}

function cloneAggregate(source = createAggregate()) {
  const aggregate = createAggregate();
  const compression = source?.compression ?? {};
  const proxy = source?.proxy ?? {};

  aggregate.compression.requests = normalizeNumber(compression.requests);
  aggregate.compression.tokens_before = normalizeNumber(compression.tokens_before);
  aggregate.compression.tokens_after = normalizeNumber(compression.tokens_after);
  aggregate.compression.tokens_saved = normalizeNumber(compression.tokens_saved);
  aggregate.compression.latency_ms = normalizeNumber(compression.latency_ms);
  aggregate.compression.outcomes = normalizeCountMap(compression.outcomes);
  aggregate.compression.providers = normalizeCountMap(compression.providers);
  aggregate.compression.models = normalizeCountMap(compression.models);

  aggregate.proxy.requests = normalizeNumber(proxy.requests);
  aggregate.proxy.latency_ms = normalizeNumber(proxy.latency_ms);
  aggregate.proxy.outcomes = normalizeCountMap(proxy.outcomes);
  aggregate.proxy.providers = normalizeCountMap(proxy.providers);
  aggregate.proxy.models = normalizeCountMap(proxy.models);

  return aggregate;
}

function createHistoryPoint(aggregate, capturedAt) {
  return {
    captured_at: capturedAt.toISOString(),
    compression: {
      requests: aggregate.compression.requests,
      tokens_before: aggregate.compression.tokens_before,
      tokens_after: aggregate.compression.tokens_after,
      tokens_saved: aggregate.compression.tokens_saved,
      latency_ms: aggregate.compression.latency_ms,
    },
    proxy: {
      requests: aggregate.proxy.requests,
      latency_ms: aggregate.proxy.latency_ms,
    },
  };
}

function normalizeHistoryPoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const timestamp = new Date(value.captured_at);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    captured_at: timestamp.toISOString(),
    compression: {
      requests: normalizeNumber(value?.compression?.requests),
      tokens_before: normalizeNumber(value?.compression?.tokens_before),
      tokens_after: normalizeNumber(value?.compression?.tokens_after),
      tokens_saved: normalizeNumber(value?.compression?.tokens_saved),
      latency_ms: normalizeNumber(value?.compression?.latency_ms),
    },
    proxy: {
      requests: normalizeNumber(value?.proxy?.requests),
      latency_ms: normalizeNumber(value?.proxy?.latency_ms),
    },
  };
}

function pruneHistory(points, now, maxHistoryPoints, maxHistoryAgeMs) {
  const cutoff = now.getTime() - maxHistoryAgeMs;
  const keptByAge = points.filter((point) => new Date(point.captured_at).getTime() >= cutoff);
  if (maxHistoryPoints <= 0) return [];
  return keptByAge.slice(-maxHistoryPoints);
}

function addDimensionCount(target, label) {
  if (typeof label !== 'string') return;
  const key = label.trim();
  if (!key) return;
  target[key] = (target[key] ?? 0) + 1;
}

function assertAllowedEventKeys(event, allowedKeys) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  for (const key of Object.keys(event)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown event key: ${key}`);
  }
}

function seriesValue(point, series) {
  switch (series) {
    case 'compression.requests': return point.compression.requests;
    case 'compression.tokens_before': return point.compression.tokens_before;
    case 'compression.tokens_after': return point.compression.tokens_after;
    case 'compression.tokens_saved': return point.compression.tokens_saved;
    case 'compression.latency_ms': return point.compression.latency_ms;
    case 'proxy.requests': return point.proxy.requests;
    case 'proxy.latency_ms': return point.proxy.latency_ms;
    default:
      throw new Error(`Unsupported history series: ${series}`);
  }
}

function hourBucketStart(isoTimestamp) {
  const bucket = new Date(isoTimestamp);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString();
}

function toHistoryRows(points, series) {
  if (!HISTORY_SERIES.includes(series)) {
    throw new Error(`Unsupported history series: ${series}`);
  }

  const buckets = new Map();
  let previous = 0;
  for (const point of points) {
    const current = seriesValue(point, series);
    const delta = Math.max(0, current - previous);
    previous = current;
    const bucketStart = hourBucketStart(point.captured_at);
    buckets.set(bucketStart, (buckets.get(bucketStart) ?? 0) + delta);
  }

  return [...buckets.entries()].map(([bucket_start, value]) => ({
    series,
    bucket_start,
    value,
  }));
}

function escapeCsv(value) {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function formatMetricValue(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value));
}

function escapePrometheusLabel(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function appendLabeledMetrics(lines, prefix, dimensions) {
  for (const [label, count] of Object.entries(dimensions)) {
    lines.push(`${prefix}{label="${escapePrometheusLabel(label)}"} ${formatMetricValue(count)}`);
  }
}

function loadAggregateState(path) {
  const emptyState = { lifetime: createAggregate(), historyPoints: [] };
  if (!existsSync(path)) return emptyState;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION) return emptyState;
    return {
      lifetime: cloneAggregate(parsed.lifetime),
      historyPoints: Array.isArray(parsed.history_points)
        ? parsed.history_points.map(normalizeHistoryPoint).filter(Boolean)
        : [],
    };
  } catch {
    return emptyState;
  }
}

export function createTelemetryLedger({
  path,
  now = () => new Date(),
  maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
  maxHistoryAgeMs = DEFAULT_MAX_HISTORY_AGE_MS,
} = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }

  const historyLimit = Math.max(0, Math.floor(normalizeNumber(maxHistoryPoints)));
  const historyAgeLimitMs = normalizeNumber(maxHistoryAgeMs) || DEFAULT_MAX_HISTORY_AGE_MS;
  const loaded = loadAggregateState(path);
  const state = {
    lifetime: cloneAggregate(loaded.lifetime),
    session: createAggregate(),
    historyPoints: pruneHistory(loaded.historyPoints, new Date(now()), historyLimit, historyAgeLimitMs),
  };

  function snapshotAt(capturedAt) {
    return {
      schema_version: SCHEMA_VERSION,
      captured_at: capturedAt.toISOString(),
      status: 'ok',
      service: SERVICE,
      capabilities: { ...CAPABILITIES },
      lifetime: cloneAggregate(state.lifetime),
      session: cloneAggregate(state.session),
      history: {
        retained_points: state.historyPoints.length,
        max_points: historyLimit,
        max_age_ms: historyAgeLimitMs,
        series: [...HISTORY_SERIES],
      },
    };
  }

  function recordCompression(event) {
    assertAllowedEventKeys(event, COMPRESSION_EVENT_KEYS);
    const tokensBefore = normalizeNumber(event.tokensBefore);
    const tokensAfter = normalizeNumber(event.tokensAfter);
    const latencyMs = normalizeNumber(event.latencyMs);
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter);

    for (const aggregate of [state.lifetime, state.session]) {
      aggregate.compression.requests += 1;
      aggregate.compression.tokens_before += tokensBefore;
      aggregate.compression.tokens_after += tokensAfter;
      aggregate.compression.tokens_saved += tokensSaved;
      aggregate.compression.latency_ms += latencyMs;
      addDimensionCount(aggregate.compression.outcomes, event.outcome);
      addDimensionCount(aggregate.compression.providers, event.provider);
      addDimensionCount(aggregate.compression.models, event.model);
    }
  }

  function recordProxy(event) {
    assertAllowedEventKeys(event, PROXY_EVENT_KEYS);
    const latencyMs = normalizeNumber(event.latencyMs);

    for (const aggregate of [state.lifetime, state.session]) {
      aggregate.proxy.requests += 1;
      aggregate.proxy.latency_ms += latencyMs;
      addDimensionCount(aggregate.proxy.outcomes, event.outcome);
      addDimensionCount(aggregate.proxy.providers, event.provider);
      addDimensionCount(aggregate.proxy.models, event.model);
    }
  }

  function history({ series } = {}) {
    return toHistoryRows(state.historyPoints, series);
  }

  function toCsv({ series } = {}) {
    const rows = history({ series });
    return [
      'series,bucket_start,value',
      ...rows.map((row) => [row.series, row.bucket_start, row.value].map(escapeCsv).join(',')),
    ].join('\n');
  }

  function toPrometheus() {
    const snapshot = snapshotAt(new Date(now()));
    const lines = [
      '# HELP headroom_lite_schema_version schema version',
      '# TYPE headroom_lite_schema_version gauge',
      `headroom_lite_schema_version ${SCHEMA_VERSION}`,
    ];

    const metrics = [
      ['headroom_lite_lifetime_compression_requests_total', 'counter', 'lifetime compression requests total', snapshot.lifetime.compression.requests],
      ['headroom_lite_lifetime_compression_tokens_before_total', 'counter', 'lifetime compression tokens before total', snapshot.lifetime.compression.tokens_before],
      ['headroom_lite_lifetime_compression_tokens_after_total', 'counter', 'lifetime compression tokens after total', snapshot.lifetime.compression.tokens_after],
      ['headroom_lite_lifetime_compression_tokens_saved_total', 'counter', 'lifetime compression tokens saved total', snapshot.lifetime.compression.tokens_saved],
      ['headroom_lite_lifetime_compression_latency_ms_total', 'counter', 'lifetime compression latency milliseconds total', snapshot.lifetime.compression.latency_ms],
      ['headroom_lite_lifetime_proxy_requests_total', 'counter', 'lifetime proxy requests total', snapshot.lifetime.proxy.requests],
      ['headroom_lite_lifetime_proxy_latency_ms_total', 'counter', 'lifetime proxy latency milliseconds total', snapshot.lifetime.proxy.latency_ms],
      ['headroom_lite_session_compression_requests_total', 'counter', 'session compression requests total', snapshot.session.compression.requests],
      ['headroom_lite_session_compression_tokens_before_total', 'counter', 'session compression tokens before total', snapshot.session.compression.tokens_before],
      ['headroom_lite_session_compression_tokens_after_total', 'counter', 'session compression tokens after total', snapshot.session.compression.tokens_after],
      ['headroom_lite_session_compression_tokens_saved_total', 'counter', 'session compression tokens saved total', snapshot.session.compression.tokens_saved],
      ['headroom_lite_session_compression_latency_ms_total', 'counter', 'session compression latency milliseconds total', snapshot.session.compression.latency_ms],
      ['headroom_lite_session_proxy_requests_total', 'counter', 'session proxy requests total', snapshot.session.proxy.requests],
      ['headroom_lite_session_proxy_latency_ms_total', 'counter', 'session proxy latency milliseconds total', snapshot.session.proxy.latency_ms],
    ];

    for (const [name, type, help, value] of metrics) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${formatMetricValue(value)}`);
    }

    lines.push('# HELP headroom_lite_lifetime_compression_outcomes_total lifetime compression outcomes by label');
    lines.push('# TYPE headroom_lite_lifetime_compression_outcomes_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_compression_outcomes_total', snapshot.lifetime.compression.outcomes);
    lines.push('# HELP headroom_lite_lifetime_compression_providers_total lifetime compression providers by label');
    lines.push('# TYPE headroom_lite_lifetime_compression_providers_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_compression_providers_total', snapshot.lifetime.compression.providers);
    lines.push('# HELP headroom_lite_lifetime_compression_models_total lifetime compression models by label');
    lines.push('# TYPE headroom_lite_lifetime_compression_models_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_compression_models_total', snapshot.lifetime.compression.models);
    lines.push('# HELP headroom_lite_lifetime_proxy_outcomes_total lifetime proxy outcomes by label');
    lines.push('# TYPE headroom_lite_lifetime_proxy_outcomes_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_proxy_outcomes_total', snapshot.lifetime.proxy.outcomes);
    lines.push('# HELP headroom_lite_lifetime_proxy_providers_total lifetime proxy providers by label');
    lines.push('# TYPE headroom_lite_lifetime_proxy_providers_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_proxy_providers_total', snapshot.lifetime.proxy.providers);
    lines.push('# HELP headroom_lite_lifetime_proxy_models_total lifetime proxy models by label');
    lines.push('# TYPE headroom_lite_lifetime_proxy_models_total counter');
    appendLabeledMetrics(lines, 'headroom_lite_lifetime_proxy_models_total', snapshot.lifetime.proxy.models);

    return lines.join('\n');
  }

  function flush() {
    const capturedAt = new Date(now());
    state.historyPoints.push(createHistoryPoint(state.lifetime, capturedAt));
    state.historyPoints = pruneHistory(state.historyPoints, capturedAt, historyLimit, historyAgeLimitMs);

    const payload = JSON.stringify({
      schema_version: SCHEMA_VERSION,
      captured_at: capturedAt.toISOString(),
      status: 'ok',
      service: SERVICE,
      capabilities: { ...CAPABILITIES },
      lifetime: cloneAggregate(state.lifetime),
      session: cloneAggregate(state.session),
      history_points: state.historyPoints,
    }, null, 2);

    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp-${process.pid}-${capturedAt.getTime()}`;
    writeFileSync(tempPath, payload, 'utf8');
    renameSync(tempPath, path);
    return snapshotAt(capturedAt);
  }

  return {
    recordCompression,
    recordProxy,
    snapshot() {
      return snapshotAt(new Date(now()));
    },
    history,
    toCsv,
    toPrometheus,
    flush,
  };
}
