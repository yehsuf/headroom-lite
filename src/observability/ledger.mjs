import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const SERVICE = 'headroom-lite';
const DEFAULT_MAX_HISTORY_POINTS = 720;
const DEFAULT_MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PERSIST_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_PERSIST_LOCK_RETRY_MS = 10;
const DEFAULT_PERSIST_LOCK_STALE_MS = 5_000;
const DEFAULT_PERSIST_LOCK_HEARTBEAT_MS = 1_000;
const PERSIST_LOCK_OWNER_FILE = 'owner.json';
const PERSIST_LOCK_HEARTBEAT_FILE = 'heartbeat';
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
const COMPRESSION_EVENT_KEYS = new Set(['tokensBefore', 'tokensAfter', 'cacheWritePremiumTokens', 'cacheDriftStatus', 'latencyMs', 'outcome', 'provider', 'model']);
const PROXY_EVENT_KEYS = new Set(['latencyMs', 'outcome', 'provider', 'model']);
// Persisted/exported label dimensions must never echo raw request-derived strings.
// Collapse them into a finite safe vocabulary so paths, IDs, auth material, bodies,
// and responses cannot be written to disk or exposed via snapshot/Prometheus output.
const SAFE_OUTCOME_LABELS = new Set(['ok', 'error', 'timeout', 'rejected', 'cancelled']);
// Valid cache drift statuses (from DriftDetector: 'first' | 'stable' | 'drifted' | null/undefined → skipped)
const SAFE_CACHE_DRIFT_STATUSES = new Set(['first', 'stable', 'drifted']);
const SAFE_PROVIDER_LABELS = new Set(['anthropic', 'openai', 'github-models']);
const SAFE_MODEL_FAMILIES = Object.freeze([
  ['claude', 'claude'],
  ['gpt', 'gpt'],
  ['o1', 'gpt'],
  ['o3', 'gpt'],
  ['o4', 'gpt'],
  ['gemini', 'gemini'],
  ['llama', 'llama'],
  ['meta-llama', 'llama'],
  ['mistral', 'mistral'],
  ['mixtral', 'mistral'],
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'],
]);
const SAFE_LABEL_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function createCapabilities({ flush = true, persistence = true } = {}) {
  return {
    ...CAPABILITIES,
    flush,
    persistence,
  };
}

function createAggregate() {
  return {
    compression: {
      requests: 0,
      tokens_before: 0,
      tokens_after: 0,
      tokens_saved: 0,
      cache_write_premium_tokens: 0,
      latency_ms: 0,
      cache_stable: 0,
      cache_drifted: 0,
      cache_first: 0,
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

function normalizeLabelValue(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

function normalizeOutcomeLabel(value) {
  const normalized = normalizeLabelValue(value);
  if (!normalized) return null;
  if (SAFE_OUTCOME_LABELS.has(normalized)) return normalized;
  if (normalized === 'err' || normalized === 'failed' || normalized === 'failure') return 'error';
  if (normalized === 'canceled') return 'cancelled';
  return 'other';
}

function normalizeProviderLabel(value) {
  const normalized = normalizeLabelValue(value);
  if (!normalized) return null;
  if (SAFE_PROVIDER_LABELS.has(normalized)) return normalized;
  return 'other';
}

function normalizeModelLabel(value) {
  const normalized = normalizeLabelValue(value);
  if (!normalized || !SAFE_LABEL_RE.test(normalized)) return 'other';
  for (const [prefix, family] of SAFE_MODEL_FAMILIES) {
    if (normalized.startsWith(prefix)) return family;
  }
  return 'other';
}

function normalizeCountMap(value, normalizeLabel) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [key, raw] of Object.entries(value)) {
    const label = normalizeLabel(key);
    if (!label) continue;
    const count = normalizeNumber(raw);
    if (count > 0) normalized[label] = (normalized[label] ?? 0) + count;
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
  aggregate.compression.cache_write_premium_tokens = normalizeNumber(compression.cache_write_premium_tokens);
  aggregate.compression.cache_stable = normalizeNumber(compression.cache_stable);
  aggregate.compression.cache_drifted = normalizeNumber(compression.cache_drifted);
  aggregate.compression.cache_first = normalizeNumber(compression.cache_first);
  aggregate.compression.latency_ms = normalizeNumber(compression.latency_ms);
  aggregate.compression.outcomes = normalizeCountMap(compression.outcomes, normalizeOutcomeLabel);
  aggregate.compression.providers = normalizeCountMap(compression.providers, normalizeProviderLabel);
  aggregate.compression.models = normalizeCountMap(compression.models, normalizeModelLabel);

  aggregate.proxy.requests = normalizeNumber(proxy.requests);
  aggregate.proxy.latency_ms = normalizeNumber(proxy.latency_ms);
  aggregate.proxy.outcomes = normalizeCountMap(proxy.outcomes, normalizeOutcomeLabel);
  aggregate.proxy.providers = normalizeCountMap(proxy.providers, normalizeProviderLabel);
  aggregate.proxy.models = normalizeCountMap(proxy.models, normalizeModelLabel);

  return aggregate;
}

function addCountMap(target, delta) {
  for (const [key, value] of Object.entries(delta ?? {})) {
    const count = normalizeNumber(value);
    if (count > 0) target[key] = (target[key] ?? 0) + count;
  }
}

function addAggregate(target, delta) {
  target.compression.requests += normalizeNumber(delta?.compression?.requests);
  target.compression.tokens_before += normalizeNumber(delta?.compression?.tokens_before);
  target.compression.tokens_after += normalizeNumber(delta?.compression?.tokens_after);
  target.compression.tokens_saved += normalizeNumber(delta?.compression?.tokens_saved);
  target.compression.cache_write_premium_tokens += normalizeNumber(delta?.compression?.cache_write_premium_tokens);
  target.compression.cache_stable += normalizeNumber(delta?.compression?.cache_stable);
  target.compression.cache_drifted += normalizeNumber(delta?.compression?.cache_drifted);
  target.compression.cache_first += normalizeNumber(delta?.compression?.cache_first);
  target.compression.latency_ms += normalizeNumber(delta?.compression?.latency_ms);
  addCountMap(target.compression.outcomes, delta?.compression?.outcomes);
  addCountMap(target.compression.providers, delta?.compression?.providers);
  addCountMap(target.compression.models, delta?.compression?.models);

  target.proxy.requests += normalizeNumber(delta?.proxy?.requests);
  target.proxy.latency_ms += normalizeNumber(delta?.proxy?.latency_ms);
  addCountMap(target.proxy.outcomes, delta?.proxy?.outcomes);
  addCountMap(target.proxy.providers, delta?.proxy?.providers);
  addCountMap(target.proxy.models, delta?.proxy?.models);
  return target;
}

function diffCountMap(current, previous) {
  const delta = {};
  const keys = new Set([
    ...Object.keys(current ?? {}),
    ...Object.keys(previous ?? {}),
  ]);
  for (const key of keys) {
    const value = Math.max(0, normalizeNumber(current?.[key]) - normalizeNumber(previous?.[key]));
    if (value > 0) delta[key] = value;
  }
  return delta;
}

function diffAggregate(current, previous = createAggregate()) {
  return {
    compression: {
      requests: Math.max(0, normalizeNumber(current?.compression?.requests) - normalizeNumber(previous?.compression?.requests)),
      tokens_before: Math.max(0, normalizeNumber(current?.compression?.tokens_before) - normalizeNumber(previous?.compression?.tokens_before)),
      tokens_after: Math.max(0, normalizeNumber(current?.compression?.tokens_after) - normalizeNumber(previous?.compression?.tokens_after)),
      tokens_saved: Math.max(0, normalizeNumber(current?.compression?.tokens_saved) - normalizeNumber(previous?.compression?.tokens_saved)),
      cache_write_premium_tokens: Math.max(0, normalizeNumber(current?.compression?.cache_write_premium_tokens) - normalizeNumber(previous?.compression?.cache_write_premium_tokens)),
      cache_stable: Math.max(0, normalizeNumber(current?.compression?.cache_stable) - normalizeNumber(previous?.compression?.cache_stable)),
      cache_drifted: Math.max(0, normalizeNumber(current?.compression?.cache_drifted) - normalizeNumber(previous?.compression?.cache_drifted)),
      cache_first: Math.max(0, normalizeNumber(current?.compression?.cache_first) - normalizeNumber(previous?.compression?.cache_first)),
      latency_ms: Math.max(0, normalizeNumber(current?.compression?.latency_ms) - normalizeNumber(previous?.compression?.latency_ms)),
      outcomes: diffCountMap(current?.compression?.outcomes, previous?.compression?.outcomes),
      providers: diffCountMap(current?.compression?.providers, previous?.compression?.providers),
      models: diffCountMap(current?.compression?.models, previous?.compression?.models),
    },
    proxy: {
      requests: Math.max(0, normalizeNumber(current?.proxy?.requests) - normalizeNumber(previous?.proxy?.requests)),
      latency_ms: Math.max(0, normalizeNumber(current?.proxy?.latency_ms) - normalizeNumber(previous?.proxy?.latency_ms)),
      outcomes: diffCountMap(current?.proxy?.outcomes, previous?.proxy?.outcomes),
      providers: diffCountMap(current?.proxy?.providers, previous?.proxy?.providers),
      models: diffCountMap(current?.proxy?.models, previous?.proxy?.models),
    },
  };
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

function createLedgerSnapshot({ state, capturedAt, historyLimit, historyAgeLimitMs, capabilities }) {
  return {
    schema_version: SCHEMA_VERSION,
    captured_at: capturedAt.toISOString(),
    status: 'ok',
    service: SERVICE,
    capabilities: { ...capabilities },
    lifetime: cloneAggregate(state.lifetime),
    session: cloneAggregate(state.session),
    history: {
      retained_points: state.historyPoints.length,
      max_points: historyLimit,
      max_age_ms: historyAgeLimitMs,
      has_predecessor_baseline: Boolean(state.historyBaseline),
      series: [...HISTORY_SERIES],
    },
  };
}

function recordCompressionInState(state, event) {
  assertAllowedEventKeys(event, COMPRESSION_EVENT_KEYS);
  const tokensBefore = normalizeNumber(event.tokensBefore);
  const tokensAfter = normalizeNumber(event.tokensAfter);
  const cacheWritePremiumTokens = normalizeNumber(event.cacheWritePremiumTokens);
  const latencyMs = normalizeNumber(event.latencyMs);
  // Subtract cache write premiums from net savings — cache writes cost extra tokens
  // (e.g. Anthropic charges 25% on top for the first write) so gross savings overstate
  // the true benefit when prompt caching is active. Ref: fix(proxy) GH #1800.
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter - cacheWritePremiumTokens);
  // cacheDriftStatus: 'stable' | 'drifted' | 'first' — from DriftDetector.check().
  // Tracks cross-provider cache consistency: how often the compressed cache prefix
  // stays stable between requests. Unknown/absent = not counted (session_id not provided).
  const cacheDrift = SAFE_CACHE_DRIFT_STATUSES.has(event.cacheDriftStatus) ? event.cacheDriftStatus : null;

  for (const aggregate of [state.lifetime, state.session]) {
    aggregate.compression.requests += 1;
    aggregate.compression.tokens_before += tokensBefore;
    aggregate.compression.tokens_after += tokensAfter;
    aggregate.compression.tokens_saved += tokensSaved;
    aggregate.compression.cache_write_premium_tokens += cacheWritePremiumTokens;
    aggregate.compression.latency_ms += latencyMs;
    if (cacheDrift === 'stable')  aggregate.compression.cache_stable  += 1;
    if (cacheDrift === 'drifted') aggregate.compression.cache_drifted += 1;
    if (cacheDrift === 'first')   aggregate.compression.cache_first   += 1;
    addDimensionCount(aggregate.compression.outcomes, event.outcome, normalizeOutcomeLabel);
    addDimensionCount(aggregate.compression.providers, event.provider, normalizeProviderLabel);
    addDimensionCount(aggregate.compression.models, event.model, normalizeModelLabel);
  }
}

function recordProxyInState(state, event) {
  assertAllowedEventKeys(event, PROXY_EVENT_KEYS);
  const latencyMs = normalizeNumber(event.latencyMs);

  for (const aggregate of [state.lifetime, state.session]) {
    aggregate.proxy.requests += 1;
    aggregate.proxy.latency_ms += latencyMs;
    addDimensionCount(aggregate.proxy.outcomes, event.outcome, normalizeOutcomeLabel);
    addDimensionCount(aggregate.proxy.providers, event.provider, normalizeProviderLabel);
    addDimensionCount(aggregate.proxy.models, event.model, normalizeModelLabel);
  }
}

function snapshotToPrometheus(snapshot) {
  const lines = [
    '# HELP headroom_lite_schema_version schema version',
    '# TYPE headroom_lite_schema_version gauge',
    `headroom_lite_schema_version ${SCHEMA_VERSION}`,
  ];

  const metrics = [
    ['headroom_lite_lifetime_compression_requests_total', 'counter', 'lifetime compression requests total', snapshot.lifetime.compression.requests],
    ['headroom_lite_lifetime_compression_tokens_before_total', 'counter', 'lifetime compression tokens before total', snapshot.lifetime.compression.tokens_before],
    ['headroom_lite_lifetime_compression_tokens_after_total', 'counter', 'lifetime compression tokens after total', snapshot.lifetime.compression.tokens_after],
    ['headroom_lite_lifetime_compression_tokens_saved_total', 'counter', 'lifetime compression tokens saved (net, after cache write premiums) total', snapshot.lifetime.compression.tokens_saved],
    ['headroom_lite_lifetime_compression_cache_write_premium_tokens_total', 'counter', 'lifetime cache write premium tokens total', snapshot.lifetime.compression.cache_write_premium_tokens],
    ['headroom_lite_lifetime_compression_cache_stable_total', 'counter', 'lifetime requests with stable cache prefix (provider-agnostic)', snapshot.lifetime.compression.cache_stable],
    ['headroom_lite_lifetime_compression_cache_drifted_total', 'counter', 'lifetime requests where cache prefix drifted (busted)', snapshot.lifetime.compression.cache_drifted],
    ['headroom_lite_lifetime_compression_cache_first_total', 'counter', 'lifetime first-seen requests per session (no prior cache baseline)', snapshot.lifetime.compression.cache_first],
    ['headroom_lite_lifetime_compression_latency_ms_total', 'counter', 'lifetime compression latency milliseconds total', snapshot.lifetime.compression.latency_ms],
    ['headroom_lite_lifetime_proxy_requests_total', 'counter', 'lifetime proxy requests total', snapshot.lifetime.proxy.requests],
    ['headroom_lite_lifetime_proxy_latency_ms_total', 'counter', 'lifetime proxy latency milliseconds total', snapshot.lifetime.proxy.latency_ms],
    ['headroom_lite_session_compression_requests_total', 'counter', 'session compression requests total', snapshot.session.compression.requests],
    ['headroom_lite_session_compression_tokens_before_total', 'counter', 'session compression tokens before total', snapshot.session.compression.tokens_before],
    ['headroom_lite_session_compression_tokens_after_total', 'counter', 'session compression tokens after total', snapshot.session.compression.tokens_after],
    ['headroom_lite_session_compression_tokens_saved_total', 'counter', 'session compression tokens saved (net, after cache write premiums) total', snapshot.session.compression.tokens_saved],
    ['headroom_lite_session_compression_cache_write_premium_tokens_total', 'counter', 'session cache write premium tokens total', snapshot.session.compression.cache_write_premium_tokens],
    ['headroom_lite_session_compression_cache_stable_total', 'counter', 'session requests with stable cache prefix (provider-agnostic)', snapshot.session.compression.cache_stable],
    ['headroom_lite_session_compression_cache_drifted_total', 'counter', 'session requests where cache prefix drifted (busted)', snapshot.session.compression.cache_drifted],
    ['headroom_lite_session_compression_cache_first_total', 'counter', 'session first-seen requests per session (no prior cache baseline)', snapshot.session.compression.cache_first],
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

function sleepSync(delayMs) {
  if (!(delayMs > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function lockPathFor(path) {
  return `${path}.lock`;
}

function lockOwnerPath(lockPath) {
  return `${lockPath}/${PERSIST_LOCK_OWNER_FILE}`;
}

function lockHeartbeatPath(lockPath) {
  return `${lockPath}/${PERSIST_LOCK_HEARTBEAT_FILE}`;
}

function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockOwnerPath(lockPath), 'utf8'));
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null,
        acquiredAt: typeof parsed.acquired_at === 'string' ? parsed.acquired_at : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function createLockOwner() {
  return {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
}

function writeLockOwner(lockPath, owner) {
  writeFileSync(lockOwnerPath(lockPath), JSON.stringify({
    pid: owner.pid,
    token: owner.token,
    acquired_at: owner.acquiredAt,
  }), 'utf8');
}

function lockOwnersMatch(left, right) {
  if (!left || !right) return false;
  if (left.token && right.token) return left.token === right.token;
  return left.pid === right.pid && left.acquiredAt === right.acquiredAt;
}

function renewLockHeartbeat(lockPath) {
  writeFileSync(lockHeartbeatPath(lockPath), `${Date.now()}\n`, 'utf8');
}

function lockHeartbeatAgeMs(lockPath) {
  try {
    return Date.now() - statSync(lockHeartbeatPath(lockPath)).mtimeMs;
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockCanBeReclaimed(lockPath, staleMs) {
  if (lockHeartbeatAgeMs(lockPath) < staleMs) return false;
  const owner = readLockOwner(lockPath);
  return !owner || !processIsRunning(owner.pid);
}

function restoreClaimedLock(claimPath, lockPath) {
  let restoredPath = false;
  try {
    mkdirSync(lockPath);
    restoredPath = true;
  } catch {
    // Another contender already has the lock path; do not overwrite it.
  }
  if (restoredPath) {
    try {
      writeFileSync(lockOwnerPath(lockPath), readFileSync(lockOwnerPath(claimPath), 'utf8'), 'utf8');
    } catch {
      // The claimed directory may have been a fresh, ownerless lock that we
      // raced with. Leave the empty lock path in place so that owner can finish
      // acquiring instead of deleting a directory it just created.
    }
    try {
      writeFileSync(lockHeartbeatPath(lockPath), readFileSync(lockHeartbeatPath(claimPath), 'utf8'), 'utf8');
    } catch {
      // Heartbeat can be renewed by the restored owner; owner token is the
      // fencing value that matters for correctness.
    }
  }
  try {
    rmSync(claimPath, { recursive: true, force: true });
  } catch {
    // Best effort: a contender that raced with a fresh owner must not delete the
    // current lock path; a leaked claim is preferable to corrupting the ledger.
  }
}

function claimStaleLock(lockPath, staleMs) {
  if (lockHeartbeatAgeMs(lockPath) < staleMs) return false;
  const expectedOwner = readLockOwner(lockPath);
  if (expectedOwner && processIsRunning(expectedOwner.pid)) return false;

  const claimPath = `${lockPath}.claim-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    renameSync(lockPath, claimPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return false;
    throw error;
  }

  const claimedOwner = readLockOwner(claimPath);
  const claimedExpectedLock = expectedOwner
    ? lockOwnersMatch(claimedOwner, expectedOwner)
    : claimedOwner === null;
  if (!claimedExpectedLock || lockHeartbeatAgeMs(claimPath) < staleMs) {
    restoreClaimedLock(claimPath, lockPath);
    return false;
  }

  rmSync(claimPath, { recursive: true, force: true });
  return true;
}

function withPersistenceLock(path, callback) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = lockPathFor(path);
  const deadline = Date.now() + DEFAULT_PERSIST_LOCK_TIMEOUT_MS;
  const lockOwner = createLockOwner();

  while (true) {
    try {
      mkdirSync(lockPath);
      writeLockOwner(lockPath, lockOwner);
      renewLockHeartbeat(lockPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockCanBeReclaimed(lockPath, DEFAULT_PERSIST_LOCK_STALE_MS)
        && claimStaleLock(lockPath, DEFAULT_PERSIST_LOCK_STALE_MS)) {
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`timed out waiting for telemetry persistence lock: ${path}`);
      }
      sleepSync(Math.min(DEFAULT_PERSIST_LOCK_RETRY_MS, remainingMs));
    }
  }

  const renewOwnedLock = () => {
    if (!lockOwnersMatch(readLockOwner(lockPath), lockOwner)) {
      throw new Error(`telemetry persistence lock lost: ${path}`);
    }
    renewLockHeartbeat(lockPath);
  };

  const heartbeatTimer = setInterval(() => {
    try {
      renewOwnedLock();
    } catch {
      // Best-effort heartbeat updates; explicit renewals fence writes.
    }
  }, DEFAULT_PERSIST_LOCK_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  try {
    return callback(renewOwnedLock);
  } finally {
    clearInterval(heartbeatTimer);
    if (lockOwnersMatch(readLockOwner(lockPath), lockOwner)) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
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

function pruneHistory(points, now, maxHistoryPoints, maxHistoryAgeMs, baselinePoint = null) {
  if (maxHistoryAgeMs <= 0) {
    return { baselinePoint: null, points: [] };
  }
  const cutoff = now.getTime() - maxHistoryAgeMs;
  const keptByAge = [];
  let nextBaseline = baselinePoint;
  for (const point of points) {
    if (new Date(point.captured_at).getTime() >= cutoff) {
      keptByAge.push(point);
    } else {
      nextBaseline = point;
    }
  }
  if (maxHistoryPoints <= 0) {
    return { baselinePoint: null, points: [] };
  }
  if (keptByAge.length > maxHistoryPoints) {
    nextBaseline = keptByAge.at(-(maxHistoryPoints + 1)) ?? nextBaseline;
  }
  return {
    baselinePoint: nextBaseline,
    points: keptByAge.slice(-maxHistoryPoints),
  };
}

function addDimensionCount(target, label, normalizeLabel) {
  const key = normalizeLabel(label);
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

function toHistoryRows(points, series, baselinePoint = null) {
  if (!HISTORY_SERIES.includes(series)) {
    throw new Error(`Unsupported history series: ${series}`);
  }

  const buckets = new Map();
  let previous = baselinePoint ? seriesValue(baselinePoint, series) : 0;
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

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasAggregateTotals(aggregate) {
  return Boolean(
    aggregate.compression.requests
    || aggregate.compression.tokens_before
    || aggregate.compression.tokens_after
    || aggregate.compression.tokens_saved
    || aggregate.compression.latency_ms
    || aggregate.proxy.requests
    || aggregate.proxy.latency_ms
    || Object.keys(aggregate.compression.outcomes).length
    || Object.keys(aggregate.compression.providers).length
    || Object.keys(aggregate.compression.models).length
    || Object.keys(aggregate.proxy.outcomes).length
    || Object.keys(aggregate.proxy.providers).length
    || Object.keys(aggregate.proxy.models).length
  );
}

function createPersistedState({
  capturedAt,
  lifetime,
  session = createAggregate(),
  historyBaseline = null,
  historyPoints = [],
}) {
  return {
    schema_version: SCHEMA_VERSION,
    captured_at: capturedAt.toISOString(),
    status: 'ok',
    service: SERVICE,
    capabilities: { ...CAPABILITIES },
    lifetime: cloneAggregate(lifetime),
    session: cloneAggregate(session),
    history_baseline: historyBaseline ? normalizeHistoryPoint(historyBaseline) : null,
    history_points: historyPoints.map(normalizeHistoryPoint).filter(Boolean),
  };
}

function fsyncParentDirectory(path) {
  let directoryFd = null;
  try {
    directoryFd = openSync(dirname(path), 'r');
    fsyncSync(directoryFd);
  } catch {
    // Directory fsync is a POSIX crash-durability optimization; some platforms
    // and filesystems do not permit opening directories this way.
  } finally {
    if (directoryFd !== null) {
      try {
        closeSync(directoryFd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function fsyncFile(path) {
  let fileFd = null;
  try {
    // Open read/write: Windows FlushFileBuffers requires a handle with write
    // access, so a read-only ('r') descriptor makes fsyncSync fail there.
    fileFd = openSync(path, 'r+');
    fsyncSync(fileFd);
  } finally {
    if (fileFd !== null) {
      try {
        closeSync(fileFd);
      } catch {
        // Best effort only.
      }
    }
  }
}

function writePersistedState(path, persistedState) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(persistedState, null, 2), 'utf8');
  fsyncFile(tempPath);
  renameSync(tempPath, path);
  fsyncParentDirectory(path);
}

function loadAggregateState(path) {
  const emptyState = {
    lifetime: createAggregate(),
    session: createAggregate(),
    historyBaseline: null,
    historyPoints: [],
    needsRewrite: false,
  };
  if (!existsSync(path)) return emptyState;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || parsed.schema_version !== SCHEMA_VERSION) return emptyState;
    const lifetime = cloneAggregate(parsed.lifetime);
    const session = cloneAggregate(parsed.session);
    const hasHistoryBaseline = Object.prototype.hasOwnProperty.call(parsed, 'history_baseline');
    const normalizedBaseline = hasHistoryBaseline ? normalizeHistoryPoint(parsed.history_baseline) : null;
    const normalizedHistoryPoints = Array.isArray(parsed.history_points)
      ? parsed.history_points.map(normalizeHistoryPoint).filter(Boolean)
      : [];
    const legacyRetainedHistoryWithoutBaseline = normalizedHistoryPoints.length > 0 && !hasHistoryBaseline;

    let historyBaseline = normalizedBaseline;
    let historyPoints = normalizedHistoryPoints;
    if (legacyRetainedHistoryWithoutBaseline || (hasHistoryBaseline && parsed.history_baseline !== null && !normalizedBaseline)) {
      historyBaseline = null;
      historyPoints = [];
    }

    const normalizedPersistedState = createPersistedState({
      capturedAt: new Date(parsed.captured_at ?? 0),
      lifetime,
      session,
      historyBaseline,
      historyPoints,
    });

    return {
      lifetime,
      session,
      historyBaseline,
      historyPoints,
      needsRewrite: !jsonEquals(parsed, normalizedPersistedState),
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
  const historyAgeLimitMs = maxHistoryAgeMs === undefined
    ? DEFAULT_MAX_HISTORY_AGE_MS
    : normalizeNumber(maxHistoryAgeMs);
  const capabilities = createCapabilities();
  const state = withPersistenceLock(path, (renewLock) => {
    const capturedAt = new Date(now());
    const loaded = loadAggregateState(path);
    renewLock();
    const prunedHistory = pruneHistory(
      loaded.historyPoints,
      capturedAt,
      historyLimit,
      historyAgeLimitMs,
      loaded.historyBaseline,
    );
    const nextState = {
      lifetime: cloneAggregate(loaded.lifetime),
      session: createAggregate(),
      persistedSession: createAggregate(),
      historyBaseline: prunedHistory.baselinePoint,
      historyPoints: prunedHistory.points,
    };
    const loadedSessionHadTotals = hasAggregateTotals(loaded.session);

    if (
      loaded.needsRewrite
      || loadedSessionHadTotals
      || !jsonEquals(loaded.historyBaseline, nextState.historyBaseline)
      || !jsonEquals(loaded.historyPoints, nextState.historyPoints)
    ) {
      writePersistedState(path, createPersistedState({
        capturedAt,
        lifetime: nextState.lifetime,
        session: nextState.session,
        historyBaseline: nextState.historyBaseline,
        historyPoints: nextState.historyPoints,
      }));
      renewLock();
    }

    return nextState;
  });

  function snapshotAt(capturedAt) {
    return createLedgerSnapshot({
      state,
      capturedAt,
      historyLimit,
      historyAgeLimitMs,
      capabilities,
    });
  }

  function recordCompression(event) {
    recordCompressionInState(state, event);
  }

  function recordProxy(event) {
    recordProxyInState(state, event);
  }

  function history({ series } = {}) {
    return toHistoryRows(state.historyPoints, series, state.historyBaseline);
  }

  function toCsv({ series } = {}) {
    const rows = history({ series });
    return [
      'series,bucket_start,value',
      ...rows.map((row) => [row.series, row.bucket_start, row.value].map(escapeCsv).join(',')),
    ].join('\n');
  }

  function toPrometheus() {
    return snapshotToPrometheus(snapshotAt(new Date(now())));
  }

  function commit(reset) {
    return withPersistenceLock(path, (renewLock) => {
      const capturedAt = new Date(now());
      const latest = loadAggregateState(path);
      renewLock();
      const latestPrunedHistory = pruneHistory(
        latest.historyPoints,
        capturedAt,
        historyLimit,
        historyAgeLimitMs,
        latest.historyBaseline,
      );
      const sessionDelta = diffAggregate(state.session, state.persistedSession);
      const mergedLifetime = cloneAggregate(latest.lifetime);
      addAggregate(mergedLifetime, sessionDelta);

      const mergedHistoryPoints = latestPrunedHistory.points.slice();
      mergedHistoryPoints.push(createHistoryPoint(mergedLifetime, capturedAt));
      const prunedHistory = pruneHistory(
        mergedHistoryPoints,
        capturedAt,
        historyLimit,
        historyAgeLimitMs,
        latestPrunedHistory.baselinePoint,
      );
      const nextSession = reset ? createAggregate() : cloneAggregate(state.session);
      const nextPersistedSession = reset ? createAggregate() : cloneAggregate(state.session);
      const nextHistoryBaseline = prunedHistory.baselinePoint;
      const nextHistoryPoints = prunedHistory.points;

      renewLock();
      writePersistedState(path, createPersistedState({
        capturedAt,
        lifetime: mergedLifetime,
        session: nextSession,
        historyBaseline: nextHistoryBaseline,
        historyPoints: nextHistoryPoints,
      }));
      state.lifetime = mergedLifetime;
      state.session = nextSession;
      state.persistedSession = nextPersistedSession;
      state.historyBaseline = nextHistoryBaseline;
      state.historyPoints = nextHistoryPoints;
      return snapshotAt(capturedAt);
    });
  }

  function flush() {
    return commit(false);
  }

  function resetSession() {
    return commit(true);
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
    resetSession,
  };
}

export function createInMemoryTelemetryLedger({
  now = () => new Date(),
  maxHistoryPoints = DEFAULT_MAX_HISTORY_POINTS,
  maxHistoryAgeMs = DEFAULT_MAX_HISTORY_AGE_MS,
} = {}) {
  const historyLimit = Math.max(0, Math.floor(normalizeNumber(maxHistoryPoints)));
  const historyAgeLimitMs = maxHistoryAgeMs === undefined
    ? DEFAULT_MAX_HISTORY_AGE_MS
    : normalizeNumber(maxHistoryAgeMs);
  const capabilities = createCapabilities({ persistence: false });
  const state = {
    lifetime: createAggregate(),
    session: createAggregate(),
    persistedSession: createAggregate(),
    historyBaseline: null,
    historyPoints: [],
  };

  function snapshotAt(capturedAt) {
    return createLedgerSnapshot({
      state,
      capturedAt,
      historyLimit,
      historyAgeLimitMs,
      capabilities,
    });
  }

  function recordCompression(event) {
    recordCompressionInState(state, event);
  }

  function recordProxy(event) {
    recordProxyInState(state, event);
  }

  function history({ series } = {}) {
    return toHistoryRows(state.historyPoints, series, state.historyBaseline);
  }

  function toCsv({ series } = {}) {
    const rows = history({ series });
    return [
      'series,bucket_start,value',
      ...rows.map((row) => [row.series, row.bucket_start, row.value].map(escapeCsv).join(',')),
    ].join('\n');
  }

  function toPrometheus() {
    return snapshotToPrometheus(snapshotAt(new Date(now())));
  }

  function flush() {
    const capturedAt = new Date(now());
    const mergedHistoryPoints = state.historyPoints.slice();
    mergedHistoryPoints.push(createHistoryPoint(state.lifetime, capturedAt));
    const prunedHistory = pruneHistory(
      mergedHistoryPoints,
      capturedAt,
      historyLimit,
      historyAgeLimitMs,
      state.historyBaseline,
    );
    state.persistedSession = cloneAggregate(state.session);
    state.historyBaseline = prunedHistory.baselinePoint;
    state.historyPoints = prunedHistory.points;
    return snapshotAt(capturedAt);
  }

  function resetSession() {
    // Snapshot current lifetime into history (parity with flush), then zero the
    // runtime session; lifetime is updated live so it is preserved.
    flush();
    state.session = createAggregate();
    state.persistedSession = createAggregate();
    return snapshotAt(new Date(now()));
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
    resetSession,
  };
}
