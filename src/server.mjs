import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compressMessages, compressMessagesAsync } from './compress/pipeline.mjs';
import { compressResponsesInput } from './compress/responses.mjs';
import { estimateMessageTokens } from './lib/estimate-tokens.mjs';
import { resolveLossyConfig } from './lossy/config.mjs';
import { normalizeTools } from './normalize/tools.mjs';
import { detectVolatileContent } from './analyze/volatile-detector.mjs';
import { proxyRequest, proxyCompressedRequest, resolveUpstream, resolveProxyTimeoutMs, resolveCompressProxy, resolveCompressLive } from './proxy.mjs';
import { parseIntOption } from './lib/config.mjs';
import { IMPLEMENTATION_NAME, IMPLEMENTATION_HEADER } from './lib/identity.mjs';
import { DriftDetector } from './analyze/drift-detector.mjs';
import { injectOpenAICacheKey, resolveOpenAICacheKey } from './normalize/openai-cache-key.mjs';
import { detectProvider } from './providers/detect.mjs';
import { resolveUpstreams, selectUpstream } from './providers/upstreams.mjs';
import { createInMemoryTelemetryLedger, createTelemetryLedger } from './observability/ledger.mjs';

const driftDetector = new DriftDetector();
const TELEMETRY_SCHEMA_VERSION = 1;
const TELEMETRY_CAPABILITIES = Object.freeze({
  snapshot: true,
  history: true,
  csv: true,
  prometheus: true,
  flush: true,
  persistence: true,
});
const TELEMETRY_HISTORY_SERIES = Object.freeze([
  'compression.requests',
  'compression.tokens_before',
  'compression.tokens_after',
  'compression.tokens_saved',
  'compression.latency_ms',
  'proxy.requests',
  'proxy.latency_ms',
]);
const STATS_HISTORY_QUERY_KEYS = new Set(['format', 'series']);
const DEFAULT_TELEMETRY_PATH = join(homedir(), '.headroom-lite', 'telemetry.json');
const DEFAULT_STATS_MAX_POINTS = 720;
const DEFAULT_STATS_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function createLegacyStatsState() {
  return {
    startedAt: Date.now(),
    proxyRequests: 0,
    compressRequests: 0,
    compressTokensBefore: 0,
    compressTokensAfter: 0,
  };
}

const DEFAULT_LEGACY_STATS_STATE = createLegacyStatsState();

function resolveLegacyStatsState(statsState) {
  return statsState ?? DEFAULT_LEGACY_STATS_STATE;
}

/** Reset the in-memory runtime counters (mirrors headroom's POST /stats/reset:
 *  a runtime reset for local test/debug isolation). Durable telemetry history
 *  in the ledger is intentionally left intact. */
function resetLegacyStatsState(statsState) {
  const s = resolveLegacyStatsState(statsState);
  s.startedAt = Date.now();
  s.proxyRequests = 0;
  s.compressRequests = 0;
  s.compressTokensBefore = 0;
  s.compressTokensAfter = 0;
}

// Known headroom endpoints that headroom-lite deliberately does NOT implement
// (no subscription/RAG/telemetry-ledger-write/TOIN/admin surface). They answer
// with an explicit 501 + reason so a probe expecting headroom's API gets a
// defined shape instead of a bare 404 or an accidental upstream proxy.
const NOT_IMPLEMENTED_EXACT = {
  '/subscription-window': 'headroom-lite has no subscription/budget model',
  '/quota': 'headroom-lite has no subscription/budget model',
  '/transformations/feed': 'headroom-lite does not buffer a transformation feed',
  '/dashboard': 'headroom-lite serves no HTML dashboard',
  '/cache/clear': 'headroom-lite keeps no server-side cache to clear',
};
const NOT_IMPLEMENTED_PREFIXES = {
  '/v1/retrieve': 'headroom-lite has no RAG retrieval store',
  '/v1/feedback': 'headroom-lite collects no tool feedback',
  '/v1/telemetry': 'headroom-lite exposes telemetry via /stats, /stats-history and /metrics',
  '/v1/toin': 'headroom-lite implements no TOIN pattern store',
};

/** Reason string if `pathname` is a known-but-unimplemented headroom endpoint,
 *  else null. Matches exact paths and `<prefix>` / `<prefix>/...` families. */
function notImplementedReason(pathname) {
  if (Object.prototype.hasOwnProperty.call(NOT_IMPLEMENTED_EXACT, pathname)) {
    return NOT_IMPLEMENTED_EXACT[pathname];
  }
  for (const [prefix, reason] of Object.entries(NOT_IMPLEMENTED_PREFIXES)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return reason;
  }
  return null;
}

// ── In-memory stats counters (reset on process restart) ──────────────────────
/** Read-only snapshot — safe to JSON.serialize directly. */
export function getStats(statsState) {
  const resolvedStatsState = resolveLegacyStatsState(statsState);
  const uptimeSec = Math.floor((Date.now() - resolvedStatsState.startedAt) / 1000);
  const saved = resolvedStatsState.compressTokensBefore - resolvedStatsState.compressTokensAfter;
  const pct = resolvedStatsState.compressTokensBefore > 0
    ? (saved / resolvedStatsState.compressTokensBefore * 100).toFixed(1)
    : '0.0';
  return {
    status: 'ok',
    service: 'headroom-lite',
    uptime_seconds: uptimeSec,
    proxy_requests: resolvedStatsState.proxyRequests,
    compress_requests: resolvedStatsState.compressRequests,
    compress_tokens_before: resolvedStatsState.compressTokensBefore,
    compress_tokens_after: resolvedStatsState.compressTokensAfter,
    compress_tokens_saved: saved,
    compress_pct: pct,
  };
}

function createEmptyAggregate() {
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

function createCompatibilitySnapshot(capturedAt = new Date(), statsState = DEFAULT_LEGACY_STATS_STATE) {
  const legacy = getStats(statsState);
  const aggregate = createEmptyAggregate();
  aggregate.compression.requests = legacy.compress_requests;
  aggregate.compression.tokens_before = legacy.compress_tokens_before;
  aggregate.compression.tokens_after = legacy.compress_tokens_after;
  aggregate.compression.tokens_saved = legacy.compress_tokens_saved;
  aggregate.proxy.requests = legacy.proxy_requests;

  return {
    schema_version: TELEMETRY_SCHEMA_VERSION,
    captured_at: capturedAt.toISOString(),
    status: 'ok',
    service: 'headroom-lite',
    capabilities: { ...TELEMETRY_CAPABILITIES },
    lifetime: aggregate,
    session: structuredClone(aggregate),
    history: {
      retained_points: 0,
      max_points: 0,
      max_age_ms: 0,
      has_predecessor_baseline: false,
      series: [...TELEMETRY_HISTORY_SERIES],
    },
  };
}

function getTelemetrySnapshot(telemetryLedger, statsState = DEFAULT_LEGACY_STATS_STATE) {
  if (!telemetryLedger || typeof telemetryLedger.snapshot !== 'function') {
    return createCompatibilitySnapshot(new Date(), statsState);
  }
  return telemetryLedger.snapshot();
}

function writeText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body).toString(),
    [IMPLEMENTATION_HEADER]: IMPLEMENTATION_NAME,
  });
  response.end(body);
}

function metricValue(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value) || 0);
}

function hourBucketStart(isoTimestamp) {
  const bucket = new Date(isoTimestamp);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString();
}

function buildCompatibilityPrometheus(snapshot) {
  const totalRequests = (snapshot.session?.compression?.requests ?? 0) + (snapshot.session?.proxy?.requests ?? 0);
  return [
    '# HELP headroom_lite_requests_total total session requests',
    '# TYPE headroom_lite_requests_total counter',
    `headroom_lite_requests_total ${metricValue(totalRequests)}`,
  ].join('\n');
}

function normalizeHistorySeries(value) {
  if (value == null) return 'hourly';
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'history' || normalized === 'hourly') return 'hourly';
  if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') return normalized;
  throw new HttpError(400, 'series must be one of "history", "hourly", "daily", "weekly", or "monthly"');
}

function normalizeHistoryFormat(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'json';
  if (normalized === 'json' || normalized === 'csv') return normalized;
  throw new HttpError(400, 'format must be "json" or "csv"');
}

function validateStatsHistoryQuery(searchParams) {
  const unexpected = [...new Set([...searchParams.keys()].filter((key) => !STATS_HISTORY_QUERY_KEYS.has(key)))].sort();
  if (unexpected.length === 0) return;
  throw new HttpError(
    400,
    `unsupported stats-history query parameter${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}`,
  );
}

function startOfWeek(date) {
  const bucket = new Date(date);
  bucket.setUTCHours(0, 0, 0, 0);
  const day = bucket.getUTCDay();
  const delta = (day + 6) % 7;
  bucket.setUTCDate(bucket.getUTCDate() - delta);
  return bucket.toISOString();
}

function bucketHistoryStart(isoTimestamp, resolution) {
  if (resolution === 'hourly') return hourBucketStart(isoTimestamp);

  const bucket = new Date(isoTimestamp);
  if (resolution === 'daily') {
    bucket.setUTCHours(0, 0, 0, 0);
    return bucket.toISOString();
  }
  if (resolution === 'weekly') {
    return startOfWeek(bucket);
  }
  bucket.setUTCDate(1);
  bucket.setUTCHours(0, 0, 0, 0);
  return bucket.toISOString();
}

function collectHistoryRows(telemetryLedger, resolution, snapshot, telemetryState) {
  const rows = [];
  if (telemetryLedger?.history) {
    for (const series of snapshot.history?.series ?? []) {
      rows.push(...telemetryLedger.history({ series }));
    }
  }
  rows.push(...getPendingHistoryRows(telemetryState));
  const grouped = new Map();
  for (const row of rows) {
    const bucketStart = resolution === 'hourly'
      ? row.bucket_start
      : bucketHistoryStart(row.bucket_start, resolution);
    const key = `${row.series}\u0000${bucketStart}`;
    grouped.set(key, (grouped.get(key) ?? 0) + row.value);
  }

  return [...grouped.entries()]
    .map(([key, value]) => {
      const [series, bucket_start] = key.split('\u0000');
      return { series, bucket_start, value };
    })
    .sort((left, right) => left.bucket_start.localeCompare(right.bucket_start) || left.series.localeCompare(right.series));
}

function historyRowsToCsv(rows) {
  return ['series,bucket_start,value', ...rows.map((row) => `${row.series},${row.bucket_start},${row.value}`)].join('\n');
}

function createTelemetryState() {
  return {
    pendingRows: new Map(),
    flushTimer: null,
  };
}

function addPendingHistoryRows(telemetryState, capturedAt, deltas) {
  const bucketStart = hourBucketStart(capturedAt.toISOString());
  for (const [series, value] of deltas) {
    if (!(value > 0)) continue;
    const key = `${series}\u0000${bucketStart}`;
    telemetryState.pendingRows.set(key, (telemetryState.pendingRows.get(key) ?? 0) + value);
  }
}

function getPendingHistoryRows(telemetryState) {
  return [...telemetryState.pendingRows.entries()]
    .map(([key, value]) => {
      const [series, bucket_start] = key.split('\u0000');
      return { series, bucket_start, value };
    })
    .sort((left, right) => left.bucket_start.localeCompare(right.bucket_start) || left.series.localeCompare(right.series));
}

function clearTelemetryFlushTimer(telemetryState) {
  if (telemetryState.flushTimer) {
    clearTimeout(telemetryState.flushTimer);
    telemetryState.flushTimer = null;
  }
}

async function flushTelemetry(telemetryLedger, telemetryState) {
  if (!telemetryLedger?.flush) return;
  try {
    const snapshot = await telemetryLedger.flush?.();
    telemetryState.pendingRows.clear();
    return snapshot;
  } catch {
    // Observability must never disrupt proxy/compression behavior.
  }
}

function scheduleTelemetryFlush(server, telemetryLedger, telemetryState) {
  if (!telemetryLedger?.flush) {
    let closePromise = null;
    return {
      flushTelemetry() {},
      closeAndFlushTelemetry() {
        if (closePromise) return closePromise;
        closePromise = new Promise((resolve, reject) => {
          // Drain keep-alive idle connections so server.close() resolves promptly
          // without killing active in-flight requests (stream-lock release).
          server.closeIdleConnections?.();
          server.close((error) => (error ? reject(error) : resolve()));
        });
        return closePromise;
      },
      telemetryLedger,
    };
  }

  let closeFlushPromise = null;
  let closeAndFlushPromise = null;
  let closeRequested = false;
  let closeCompleted = false;

  const flushTelemetryNow = () => flushTelemetry(telemetryLedger, telemetryState);

  const flushAfterClose = () => {
    if (closeFlushPromise) return closeFlushPromise;
    clearTelemetryFlushTimer(telemetryState);
    closeFlushPromise = Promise.resolve(flushTelemetryNow());
    return closeFlushPromise;
  };

  const closeAndFlushTelemetry = () => {
    if (closeAndFlushPromise) return closeAndFlushPromise;
    clearTelemetryFlushTimer(telemetryState);
    closeRequested = true;
    if (closeCompleted) {
      closeAndFlushPromise = Promise.resolve(flushAfterClose());
      return closeAndFlushPromise;
    }
    closeAndFlushPromise = new Promise((resolve, reject) => {
      // Drain keep-alive idle connections so server.close() resolves promptly
      // without killing active in-flight SSE/streaming connections (stream-lock release).
      server.closeIdleConnections?.();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        Promise.resolve(flushAfterClose()).then(resolve, reject);
      });
    });
    return closeAndFlushPromise;
  };

  const scheduleNext = () => {
    if (closeRequested) return;
    const now = new Date();
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    const delay = Math.max(1, next.getTime() - now.getTime() - 1);
    telemetryState.flushTimer = setTimeout(() => {
      void (async () => {
        if (closeRequested) return;
        await flushTelemetryNow();
        scheduleNext();
      })();
    }, delay);
    telemetryState.flushTimer.unref?.();
  };

  scheduleNext();
  server.on('close', () => {
    closeRequested = true;
    closeCompleted = true;
    void flushAfterClose();
  });

  return {
    flushTelemetry: flushTelemetryNow,
    closeAndFlushTelemetry,
    telemetryLedger,
  };
}

function persistTelemetry(telemetryLedger, telemetryState, record, deltas) {
  if (!telemetryLedger) return;
  try {
    record();
    const capturedAt = new Date(telemetryLedger.snapshot?.().captured_at ?? Date.now());
    addPendingHistoryRows(telemetryState, capturedAt, deltas);
  } catch {
    // Observability must never disrupt proxy/compression behavior.
  }
}

function observeProxyOutcome(response, telemetryLedger, telemetryState, { provider, startedAt }) {
  if (!telemetryLedger || typeof telemetryLedger.recordProxy !== 'function') return;
  response.once('finish', () => {
    let outcome = 'ok';
    if ((response.statusCode ?? 0) >= 500) outcome = 'error';
    if (response.statusCode === 504) outcome = 'timeout';
    const latencyMs = Date.now() - startedAt;
    persistTelemetry(telemetryLedger, telemetryState, () => {
      telemetryLedger.recordProxy({
        latencyMs,
        outcome,
        provider: provider === 'unknown' ? undefined : provider,
      });
    }, [
      ['proxy.requests', 1],
      ['proxy.latency_ms', latencyMs],
    ]);
  });
}

function parseNonNegativeIntegerOption(input, envName, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue;
  const normalized = String(input).trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`${envName} must be a non-negative integer`);
  }
  return Number.parseInt(normalized, 10);
}

function normalizeStatsPath(path) {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function resolveStatsPath(input = process.env.HEADROOM_LITE_STATS_PATH) {
  if (input === undefined || input === null || input === '') return DEFAULT_TELEMETRY_PATH;
  const normalized = String(input).trim();
  if (!normalized) {
    throw new Error('HEADROOM_LITE_STATS_PATH must be a non-empty path');
  }
  return normalizeStatsPath(normalized);
}

export function resolveStatsMaxPoints(input = process.env.HEADROOM_LITE_STATS_MAX_POINTS) {
  return parseNonNegativeIntegerOption(input, 'HEADROOM_LITE_STATS_MAX_POINTS', DEFAULT_STATS_MAX_POINTS);
}

export function resolveStatsMaxAgeMs(input = process.env.HEADROOM_LITE_STATS_MAX_AGE_DAYS) {
  return parseNonNegativeIntegerOption(input, 'HEADROOM_LITE_STATS_MAX_AGE_DAYS', DEFAULT_STATS_MAX_AGE_DAYS) * DAY_MS;
}

function resolveConfiguredTelemetryLedger({
  telemetryLedger,
  statsPathInput = process.env.HEADROOM_LITE_STATS_PATH,
  statsMaxPointsInput = process.env.HEADROOM_LITE_STATS_MAX_POINTS,
  statsMaxAgeDaysInput = process.env.HEADROOM_LITE_STATS_MAX_AGE_DAYS,
} = {}) {
  if (telemetryLedger !== undefined) return telemetryLedger;

  const path = resolveStatsPath(statsPathInput);
  const maxHistoryPoints = resolveStatsMaxPoints(statsMaxPointsInput);
  const maxHistoryAgeMs = resolveStatsMaxAgeMs(statsMaxAgeDaysInput);
  const usingDefaultPath = path === DEFAULT_TELEMETRY_PATH;

  try {
    return createTelemetryLedger({
      path,
      maxHistoryPoints,
      maxHistoryAgeMs,
    });
  } catch (error) {
    if (!usingDefaultPath) throw error;
    return createInMemoryTelemetryLedger({
      maxHistoryPoints,
      maxHistoryAgeMs,
    });
  }
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

// Re-export proxy config helpers so callers only need to import from server.mjs
export { resolveUpstream, resolveProxyTimeoutMs, resolveCompressProxy, resolveCompressLive };

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
    [IMPLEMENTATION_HEADER]: IMPLEMENTATION_NAME,
  });
  response.end(body);
}

async function readRequestBody(request, maxBodyBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      throw new HttpError(413, `request body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function resolvePort(input = process.env.HEADROOM_LITE_PORT ?? process.env.PORT) {
  return parseIntOption(input, DEFAULT_PORT);
}

export function resolveMaxBodyBytes(input = process.env.HEADROOM_LITE_MAX_BODY_BYTES) {
  return parseIntOption(input, DEFAULT_MAX_BODY_BYTES);
}

/**
 * Resolve the HEADROOM_LITE_MIN_TOKENS env var.
 * When > 0, /v1/compress skips compression and returns messages as-is if the
 * estimated token count is below the threshold. Default: 0 (always compress).
 * Mirrors upstream headroom's HEADROOM_MIN_TOKENS semantics.
 */
export function resolveMinTokens(input = process.env.HEADROOM_LITE_MIN_TOKENS) {
  return parseIntOption(input, 0, { allowZero: true });
}

async function handleCompress(request, response, { maxBodyBytes, compressLive, lossyConfig, minTokens, telemetryLedger, telemetryState, statsState }) {
  const startedAt = Date.now();
  const telemetryEvent = {
    tokensBefore: 0,
    tokensAfter: 0,
    provider: undefined,
    model: undefined,
  };
  response.once('finish', () => {
    let outcome = 'ok';
    if ((response.statusCode ?? 0) >= 500) outcome = 'error';
    else if ((response.statusCode ?? 0) >= 400) outcome = 'rejected';
    const latencyMs = Date.now() - startedAt;
    const tokensSaved = Math.max(0, telemetryEvent.tokensBefore - telemetryEvent.tokensAfter);
    persistTelemetry(telemetryLedger, telemetryState, () => {
      telemetryLedger.recordCompression?.({
        tokensBefore: telemetryEvent.tokensBefore,
        tokensAfter: telemetryEvent.tokensAfter,
        latencyMs,
        outcome,
        provider: telemetryEvent.provider,
        model: telemetryEvent.model,
      });
    }, [
      ['compression.requests', 1],
      ['compression.tokens_before', telemetryEvent.tokensBefore],
      ['compression.tokens_after', telemetryEvent.tokensAfter],
      ['compression.tokens_saved', tokensSaved],
      ['compression.latency_ms', latencyMs],
    ]);
  });
  const rawBody = await readRequestBody(request, maxBodyBytes);

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }

  const isResponses = payload && typeof payload === 'object'
    && payload.kind === 'responses' && Array.isArray(payload.input);

  // A request that declares kind:"responses" MUST carry an `input` array —
  // reject a contradictory/invalid payload rather than silently falling through
  // to the messages path.
  if (payload && typeof payload === 'object' && payload.kind === 'responses' && !isResponses) {
    throw new HttpError(400, 'kind:"responses" requires `input` to be a JSON array');
  }

  if (!payload || typeof payload !== 'object'
    || (!Array.isArray(payload.messages) && !isResponses)) {
    throw new HttpError(400, '`messages` (or `input` with kind:"responses") must be a JSON array');
  }

  // HEADROOM_LITE_MIN_TOKENS gate: when set to > 0, skip compression and return
  // messages as-is if estimated token count is below the threshold. This mirrors
  // upstream headroom's HEADROOM_MIN_TOKENS semantics and lets callers avoid
  // compression overhead on short conversations.
  if (!isResponses && minTokens > 0) {
    const rawTokens = estimateMessageTokens(payload.messages);
    if (rawTokens <= minTokens) {
      const normalizedTools = Array.isArray(payload.tools) ? normalizeTools(payload.tools) : undefined;
      const skippedBody = {
        service: IMPLEMENTATION_NAME,
        messages: payload.messages,
        tokens_before: rawTokens,
        tokens_after: rawTokens,
        tokens_saved: 0,
        compression_ratio: 1.0,
        frozen_count: 0,
        skipped_reason: 'below_min_tokens',
      };
      if (normalizedTools !== undefined) skippedBody.normalized_tools = normalizedTools;
      telemetryEvent.tokensBefore = rawTokens;
      telemetryEvent.tokensAfter = rawTokens;
      telemetryEvent.provider = payload.format === 'openai' ? 'openai' : 'anthropic';
      telemetryEvent.model = typeof payload.model === 'string' ? payload.model : undefined;
      writeJson(response, 200, skippedBody);
      return;
    }
  }

  // Responses API path: compress the `input` array (typed items), mirror the key.
  if (isResponses) {
    const r = compressResponsesInput(payload.input, { compressLive });
    statsState.compressRequests++;
    statsState.compressTokensBefore += r.tokensBefore;
    statsState.compressTokensAfter += r.tokensAfter;

    const responseBody = {
      service: IMPLEMENTATION_NAME,
      input: r.items,
      tokens_before: r.tokensBefore,
      tokens_after: r.tokensAfter,
      tokens_saved: Math.max(0, r.tokensBefore - r.tokensAfter),
      compression_ratio: r.tokensBefore > 0 ? r.tokensAfter / r.tokensBefore : 1.0,
      frozen_count: r.frozenCount,
    };
    const normalizedTools = Array.isArray(payload.tools)
      ? normalizeTools(payload.tools)
      : undefined;
    if (normalizedTools !== undefined) responseBody.normalized_tools = normalizedTools;

    // NOTE: OpenAI prompt_cache_key injection is intentionally NOT applied on the
    // Responses path. injectOpenAICacheKey derives the key from `messages` (and a
    // Responses request's system context lives in `instructions`, not `input`), so
    // injecting here would emit an incomplete key. Explicit cache-key support for
    // Responses is a separate feature; the sidecar caller does not consume the key.

    telemetryEvent.tokensBefore = r.tokensBefore;
    telemetryEvent.tokensAfter = r.tokensAfter;
    telemetryEvent.provider = 'openai';
    telemetryEvent.model = typeof payload.model === 'string' ? payload.model : undefined;
    writeJson(response, 200, responseBody);
    return;
  }

  const result = await compressMessagesAsync(payload.messages, {
    format: typeof payload.format === 'string' ? payload.format : 'anthropic',
    model: typeof payload.model === 'string' ? payload.model : 'default',
    compressLive,
    lossy: lossyConfig,
  });
  const { messages, tokensBefore, tokensAfter, frozenCount } = result;

  statsState.compressRequests++;
  statsState.compressTokensBefore += tokensBefore;
  statsState.compressTokensAfter += tokensAfter;

  const normalizedTools = Array.isArray(payload.tools)
    ? normalizeTools(payload.tools)
    : undefined;

  const system = typeof payload.system === 'string' ? payload.system : null;
  const warnings = detectVolatileContent({ messages: payload.messages, frozenCount, system });

  const responseBody = {
    service: IMPLEMENTATION_NAME,
    messages,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    tokens_saved: Math.max(0, tokensBefore - tokensAfter),
    compression_ratio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1.0,
    frozen_count: frozenCount,
  };
  if (normalizedTools !== undefined) responseBody.normalized_tools = normalizedTools;
  if (warnings.length > 0) responseBody.warnings = warnings;
  if (lossyConfig && lossyConfig.enabled) responseBody.lossy = result.lossy;

  // OpenAI prompt_cache_key injection for OpenAI-format requests
  if (payload.format === 'openai' && resolveOpenAICacheKey()) {
    const injected = injectOpenAICacheKey(payload);
    if (injected.prompt_cache_key != null) {
      responseBody.prompt_cache_key = injected.prompt_cache_key;
    }
  }

  // Cache drift detection — only when caller provides a valid session_id (max 256 chars)
  if (typeof payload.session_id === 'string' && payload.session_id.length > 0 &&
      payload.session_id.length <= 256) {
    const driftInfo = driftDetector.check(payload.session_id, {
      system: payload.system,
      tools: payload.tools,
      messages: payload.messages,
    });
    responseBody.cache_drift = driftInfo;
  }

  telemetryEvent.tokensBefore = tokensBefore;
  telemetryEvent.tokensAfter = tokensAfter;
  telemetryEvent.provider = payload.format === 'openai' ? 'openai' : 'anthropic';
  telemetryEvent.model = typeof payload.model === 'string' ? payload.model : undefined;
  writeJson(response, 200, responseBody);
}

async function routeRequest(request, response, options) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const telemetrySnapshot = getTelemetrySnapshot(options.telemetryLedger, options.statsState);

  if (method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    // Check whether any upstream is configured
    const { upstreams, lossyConfig } = options;
    const anyUpstream = upstreams.legacy ?? upstreams.anthropic ?? upstreams.openai ?? upstreams['github-models'];
    writeJson(response, 200, {
      status: 'ok',
      service: 'headroom-lite',
      schema_version: telemetrySnapshot.schema_version,
      mode: anyUpstream ? 'proxy+deterministic' : 'deterministic',
      max_body_bytes: options.maxBodyBytes,
      compress_live: options.compressLive,
      // legacy field kept for one release for backward compat with existing scrapers
      upstream: upstreams.legacy,
      upstreams,
      capabilities: telemetrySnapshot.capabilities,
      lossy: {
        enabled: lossyConfig.enabled,
        backend: lossyConfig.backend,
        service_url: lossyConfig.serviceUrl,
      },
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/readyz') {
    writeJson(response, 200, {
      status: 'ready',
      service: 'headroom-lite',
      schema_version: telemetrySnapshot.schema_version,
      capabilities: telemetrySnapshot.capabilities,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/livez') {
    writeJson(response, 200, {
      status: 'alive',
      service: 'headroom-lite',
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/stats') {
    writeJson(response, 200, {
      ...getStats(options.statsState),
      ...telemetrySnapshot,
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/stats/reset') {
    resetLegacyStatsState(options.statsState);
    options.telemetryLedger?.resetSession?.();
    // resetSession() committed the pending session delta into durable history;
    // drop the server's pending-rows buffer too so /stats-history doesn't count
    // the same delta twice (mirrors flushTelemetry()).
    options.telemetryState?.pendingRows?.clear();
    writeJson(response, 200, {
      ...getStats(options.statsState),
      ...getTelemetrySnapshot(options.telemetryLedger, options.statsState),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/stats-history') {
    validateStatsHistoryQuery(url.searchParams);
    const format = normalizeHistoryFormat(url.searchParams.get('format') ?? 'json');
    const series = normalizeHistorySeries(
      url.searchParams.has('series')
        ? url.searchParams.get('series')
        : undefined,
    );
    const rows = collectHistoryRows(options.telemetryLedger, series, telemetrySnapshot, options.telemetryState);
    if (format === 'csv') {
      const body = historyRowsToCsv(rows);
      writeText(response, 200, body, 'text/csv; charset=utf-8');
      return;
    }
    writeJson(response, 200, {
      schema_version: telemetrySnapshot.schema_version,
      status: 'ok',
      service: 'headroom-lite',
      series,
      rows,
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/metrics') {
    const metrics = [buildCompatibilityPrometheus(telemetrySnapshot)];
    if (options.telemetryLedger?.toPrometheus) {
      metrics.push(options.telemetryLedger.toPrometheus());
    } else {
      metrics.push(
        '# HELP headroom_lite_schema_version schema version',
        '# TYPE headroom_lite_schema_version gauge',
        `headroom_lite_schema_version ${telemetrySnapshot.schema_version}`,
      );
    }
    writeText(response, 200, metrics.join('\n'), 'text/plain; version=0.0.4; charset=utf-8');
    return;
  }

  // GH #1787: browsers auto-fetch /favicon.ico; answer locally so it is never
  // tunneled to the upstream provider.
  if (method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, { [IMPLEMENTATION_HEADER]: IMPLEMENTATION_NAME });
    response.end();
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/compress') {
    await handleCompress(request, response, options);
    return;
  }

  // Known headroom endpoints headroom-lite doesn't implement -> explicit 501
  // (defined shape for probes; never proxied upstream). Checked AFTER the real
  // endpoints and BEFORE the passthrough proxy.
  const niReason = notImplementedReason(url.pathname);
  if (niReason) {
    writeJson(response, 501, {
      error: 'not implemented',
      service: 'headroom-lite',
      reason: niReason,
    });
    return;
  }

  // Transparent passthrough proxy — route to the provider-specific upstream, fall back to legacy.
  const { provider } = detectProvider(url.pathname);
  const chosenUpstream = selectUpstream(options.upstreams, provider);

  if (chosenUpstream) {
    options.statsState.proxyRequests++;
    observeProxyOutcome(response, options.telemetryLedger, options.telemetryState, { provider, startedAt: Date.now() });
    if (options.compressProxy) {
      proxyCompressedRequest(request, response, {
        upstream: chosenUpstream,
        timeoutMs: options.proxyTimeoutMs,
        maxBodyBytes: options.maxBodyBytes,
        compressLive: options.compressLive,
      }).catch(() => {
        if (!response.headersSent && !response.destroyed) {
          const msg = JSON.stringify({ error: 'proxy error' });
          try {
            response.writeHead(502, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(Buffer.byteLength(msg)),
              [IMPLEMENTATION_HEADER]: IMPLEMENTATION_NAME,
            });
            response.end(msg);
          } catch { /* socket already gone */ }
        }
      });
    } else {
      proxyRequest(request, response, { upstream: chosenUpstream, timeoutMs: options.proxyTimeoutMs });
    }
    return;
  }

  writeJson(response, 404, { error: 'not found' });
}

export function createServer({
  maxBodyBytes = resolveMaxBodyBytes(),
  upstream = null,
  upstreams = null,
  proxyTimeoutMs = resolveProxyTimeoutMs(),
  compressProxy = resolveCompressProxy(),
  compressLive = resolveCompressLive(),
  lossyConfig = resolveLossyConfig(),
  minTokens = resolveMinTokens(),
  telemetryLedger = undefined,
  statsPathInput = process.env.HEADROOM_LITE_STATS_PATH,
  statsMaxPointsInput = process.env.HEADROOM_LITE_STATS_MAX_POINTS,
  statsMaxAgeDaysInput = process.env.HEADROOM_LITE_STATS_MAX_AGE_DAYS,
} = {}) {
  const resolvedUpstreams = upstreams ?? {
    legacy: upstream,
    anthropic: null,
    openai: null,
    'github-models': null,
  };
  const resolvedTelemetryLedger = resolveConfiguredTelemetryLedger({
    telemetryLedger,
    statsPathInput,
    statsMaxPointsInput,
    statsMaxAgeDaysInput,
  });
  const telemetryState = createTelemetryState();
  const statsState = createLegacyStatsState();

  const server = http.createServer((request, response) => {
    routeRequest(request, response, {
      maxBodyBytes,
      upstreams: resolvedUpstreams,
      proxyTimeoutMs,
      compressProxy,
      compressLive,
      lossyConfig,
      minTokens,
      telemetryLedger: resolvedTelemetryLedger,
      telemetryState,
      statsState,
    }).catch((error) => {
      if (response.headersSent || response.writableEnded || response.destroyed) {
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
        return;
      }
      if (error instanceof HttpError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
      }

      writeJson(response, 500, { error: 'internal server error' });
    });
  });

  server.on('clientError', (error, socket) => {
    // Silently drop disconnected clients and unwritable sockets.
    // Note: HPE_INVALID_METHOD can fire when an HTTP/2 client accidentally connects
    // to this HTTP/1.1-only server; respond with 400 so the client learns H/2 is
    // not supported (same as node's default behavior).
    if (error.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const scheduledTelemetry = scheduleTelemetryFlush(server, resolvedTelemetryLedger, telemetryState);
  Object.defineProperties(server, {
    telemetryLedger: {
      value: scheduledTelemetry.telemetryLedger,
      configurable: false,
      enumerable: false,
      writable: false,
    },
    flushTelemetry: {
      value: scheduledTelemetry.flushTelemetry,
      configurable: false,
      enumerable: false,
      writable: false,
    },
    closeAndFlushTelemetry: {
      value: scheduledTelemetry.closeAndFlushTelemetry,
      configurable: false,
      enumerable: false,
      writable: false,
    },
    flushTelemetryBeforeClose: {
      value: scheduledTelemetry.flushTelemetry,
      configurable: false,
      enumerable: false,
      writable: false,
    },
  });

  return server;
}

export function startServer({
  host = process.env.HEADROOM_LITE_HOST ?? DEFAULT_HOST,
  port = resolvePort(),
  maxBodyBytes = resolveMaxBodyBytes(),
  upstream = undefined,
  upstreams = undefined,
  proxyTimeoutMs = resolveProxyTimeoutMs(),
  compressProxy = resolveCompressProxy(),
  compressLive = resolveCompressLive(),
  lossyConfig = resolveLossyConfig(),
  minTokens = resolveMinTokens(),
  telemetryLedger = undefined,
  statsPathInput = process.env.HEADROOM_LITE_STATS_PATH,
  statsMaxPointsInput = process.env.HEADROOM_LITE_STATS_MAX_POINTS,
  statsMaxAgeDaysInput = process.env.HEADROOM_LITE_STATS_MAX_AGE_DAYS,
} = {}) {
  let resolvedUpstreams;
  if (upstreams !== undefined) {
    resolvedUpstreams = upstreams;
  } else if (upstream !== undefined) {
    resolvedUpstreams = { legacy: upstream, anthropic: null, openai: null, 'github-models': null };
  } else {
    resolvedUpstreams = resolveUpstreams();
  }
  const resolvedTelemetryLedger = resolveConfiguredTelemetryLedger({
    telemetryLedger,
    statsPathInput,
    statsMaxPointsInput,
    statsMaxAgeDaysInput,
  });

  const server = createServer({
    maxBodyBytes,
    upstreams: resolvedUpstreams,
    proxyTimeoutMs,
    compressProxy,
    compressLive,
    lossyConfig,
    minTokens,
    telemetryLedger: resolvedTelemetryLedger,
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
