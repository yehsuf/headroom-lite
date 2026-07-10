import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { DriftDetector } from '../src/analyze/drift-detector.mjs';
import { startServer } from '../src/server.mjs';

// ---------------------------------------------------------------------------
// DriftDetector unit tests
// ---------------------------------------------------------------------------

describe('DriftDetector', () => {
  const body = () => ({
    system: 'You are a helpful assistant.',
    tools: [{ name: 'search' }, { name: 'calc' }],
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ],
  });

  it('first call returns status "first" with a 64-char hex curr_hash', () => {
    const d = new DriftDetector();
    const result = d.check('sess-1', body());
    assert.equal(result.status, 'first');
    assert.match(result.curr_hash, /^[0-9a-f]{64}$/);
    assert.equal(result.prev_hash, undefined);
  });

  it('same body again returns status "stable" with same curr_hash', () => {
    const d = new DriftDetector();
    const first = d.check('sess-1', body());
    const second = d.check('sess-1', body());
    assert.equal(second.status, 'stable');
    assert.equal(second.curr_hash, first.curr_hash);
  });

  it('changed system prompt returns status "drifted" with differing hashes', () => {
    const d = new DriftDetector();
    const first = d.check('sess-1', body());
    const changed = { ...body(), system: 'You are a different assistant.' };
    const result = d.check('sess-1', changed);
    assert.equal(result.status, 'drifted');
    assert.equal(result.prev_hash, first.curr_hash);
    assert.notEqual(result.curr_hash, first.curr_hash);
  });

  it('changed tool names returns status "drifted"', () => {
    const d = new DriftDetector();
    d.check('sess-1', body());
    const changed = { ...body(), tools: [{ name: 'search' }, { name: 'exec' }] };
    const result = d.check('sess-1', changed);
    assert.equal(result.status, 'drifted');
  });

  it('changed early message text returns status "drifted"', () => {
    const d = new DriftDetector();
    d.check('sess-1', body());
    const b = body();
    b.messages[1] = { role: 'user', content: 'Changed question' };
    const result = d.check('sess-1', b);
    assert.equal(result.status, 'drifted');
  });

  it('changed message[3] (beyond early window) returns status "stable"', () => {
    const d = new DriftDetector();
    const b = body();
    b.messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Original message 4' },
    ];
    d.check('sess-1', b);
    const changed = { ...b, messages: [...b.messages] };
    changed.messages[3] = { role: 'user', content: 'Totally different message 4' };
    const result = d.check('sess-1', changed);
    assert.equal(result.status, 'stable');
  });

  it('two different session IDs are independent, each starts "first"', () => {
    const d = new DriftDetector();
    const r1 = d.check('sess-a', body());
    const r2 = d.check('sess-b', body());
    assert.equal(r1.status, 'first');
    assert.equal(r2.status, 'first');
  });

  it('TTL eviction causes session to reset to "first"', async () => {
    const d = new DriftDetector({ ttlMs: 10 });
    d.check('sess-1', body());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = d.check('sess-1', body());
    assert.equal(result.status, 'first');
  });

  it('sessionCount reflects active sessions and decreases after eviction', async () => {
    const d = new DriftDetector({ ttlMs: 10 });
    d.check('s1', body());
    d.check('s2', body());
    assert.equal(d.sessionCount, 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // trigger eviction by calling check (evict runs at start of check)
    d.check('s3', body());
    assert.equal(d.sessionCount, 1); // only s3 survives
  });

  it('computeHash is deterministic: same input → same hash', () => {
    const d = new DriftDetector();
    const h1 = d.computeHash(body());
    const h2 = d.computeHash(body());
    assert.equal(h1, h2);
  });

  it('computeHash: different input → different hash', () => {
    const d = new DriftDetector();
    const h1 = d.computeHash(body());
    const h2 = d.computeHash({ ...body(), system: 'Something else entirely' });
    assert.notEqual(h1, h2);
  });

  it('tool order does not affect hash (tools are sorted)', () => {
    const d = new DriftDetector();
    const b1 = { ...body(), tools: [{ name: 'z' }, { name: 'a' }] };
    const b2 = { ...body(), tools: [{ name: 'a' }, { name: 'z' }] };
    assert.equal(d.computeHash(b1), d.computeHash(b2));
  });
});

// ---------------------------------------------------------------------------
// Server integration tests
// ---------------------------------------------------------------------------

describe('DriftDetector — server integration', () => {
  let server;
  let baseUrl;

  const MESSAGES = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ];

  before(async () => {
    server = await startServer({ host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024 });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function compress(payload) {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.json();
  }

  it('POST /v1/compress with session_id includes cache_drift in response', async () => {
    const body = await compress({ session_id: 'int-sess-1', messages: MESSAGES });
    assert.ok('cache_drift' in body, 'cache_drift should be present');
    assert.equal(body.cache_drift.status, 'first');
    assert.match(body.cache_drift.curr_hash, /^[0-9a-f]{64}$/);
  });

  it('POST /v1/compress without session_id has no cache_drift field', async () => {
    const body = await compress({ messages: MESSAGES });
    assert.ok(!('cache_drift' in body), 'cache_drift should not be present');
  });

  it('two consecutive POSTs with same session and same content → second is "stable"', async () => {
    const payload = { session_id: 'int-sess-stable', messages: MESSAGES };
    await compress(payload);
    const body = await compress(payload);
    assert.equal(body.cache_drift.status, 'stable');
  });

  it('two consecutive POSTs with same session but different messages → second is "drifted"', async () => {
    const sessionId = 'int-sess-drifted';
    await compress({ session_id: sessionId, messages: MESSAGES });
    const changed = [
      { role: 'user', content: 'Completely different opening message' },
    ];
    const body = await compress({ session_id: sessionId, messages: changed });
    assert.equal(body.cache_drift.status, 'drifted');
    assert.ok('prev_hash' in body.cache_drift);
  });
});

describe('DriftDetector — session cap and validation', () => {
  it('throws on empty session_id', () => {
    const d = new DriftDetector();
    assert.throws(() => d.check('', {}), /non-empty string/);
  });

  it('throws on session_id longer than 256 chars', () => {
    const d = new DriftDetector();
    assert.throws(() => d.check('x'.repeat(257), {}), /256/);
  });

  it('accepts session_id of exactly 256 chars', () => {
    const d = new DriftDetector();
    assert.doesNotThrow(() => d.check('a'.repeat(256), {}));
  });

  it('evicts oldest session when maxSessions cap is reached', () => {
    const d = new DriftDetector({ maxSessions: 3 });
    d.check('sess-a', { messages: [] });
    d.check('sess-b', { messages: [] });
    d.check('sess-c', { messages: [] });
    assert.equal(d.sessionCount, 3);

    // Adding a 4th session should evict the oldest (sess-a)
    d.check('sess-d', { messages: [] });
    assert.equal(d.sessionCount, 3);

    // sess-d is new so next call should be 'stable' (already stored)
    const r = d.check('sess-d', { messages: [] });
    assert.equal(r.status, 'stable');
  });

  it('session count does not exceed maxSessions after many inserts', () => {
    const d = new DriftDetector({ maxSessions: 5 });
    for (let i = 0; i < 20; i++) d.check(`s${i}`, { messages: [] });
    assert.ok(d.sessionCount <= 5);
  });
});
