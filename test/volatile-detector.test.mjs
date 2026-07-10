import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectVolatileContent, computeFrozenCount, MAX_WARNINGS } from '../src/analyze/volatile-detector.mjs';
import { startServer } from '../src/server.mjs';

// --- helpers ---

function frozenMsg(content) {
  return { role: 'user', content, cache_control: { type: 'ephemeral' } };
}

function liveMsg(content) {
  return { role: 'user', content };
}

// --- unit tests ---

describe('detectVolatileContent', () => {
  it('returns empty array for clean frozen messages', () => {
    const msgs = [frozenMsg('You are a helpful assistant. Answer concisely.')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1, system: null });
    assert.deepEqual(warnings, []);
  });

  it('detects ISO 8601 datetime in a frozen message', () => {
    const msgs = [frozenMsg('Session started at 2024-01-15T10:30:00Z. Please help.')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'iso_datetime');
    assert.equal(warnings[0].location, 'messages[0].content');
    assert.ok(warnings[0].sample.includes('2024-01-15T10:30:00Z'));
  });

  it('detects UUID v4 in a frozen message', () => {
    const msgs = [frozenMsg('Request 550e8400-e29b-41d4-a716-446655440000 initiated.')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'uuid_v4');
    assert.ok(warnings[0].sample.startsWith('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('does NOT warn for volatile content in live messages (i >= frozenCount)', () => {
    const msgs = [
      frozenMsg('You are a stable assistant.'),
      liveMsg('Request at 2024-01-15T10:30:00Z — please summarize.'),
    ];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1 });
    assert.deepEqual(warnings, []);
  });

  it('detects UUID v4 in system prompt', () => {
    const warnings = detectVolatileContent({
      messages: [],
      frozenCount: 0,
      system: 'You handle requests. Trace: 550e8400-e29b-41d4-a716-446655440000',
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'uuid_v4');
    assert.equal(warnings[0].location, 'system');
  });

  it('detects ISO datetime in system prompt', () => {
    const warnings = detectVolatileContent({
      messages: [],
      frozenCount: 0,
      system: 'Cache built at 2024-06-01T08:00:00+00:00. Use this context.',
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'iso_datetime');
  });

  it('detects request_id field with opaque value in a frozen message', () => {
    const msg = { role: 'user', content: 'Hello', request_id: 'req_abc123xyz', cache_control: { type: 'ephemeral' } };
    const warnings = detectVolatileContent({ messages: [msg], frozenCount: 1 });
    const found = warnings.find((w) => w.pattern === 'id_field');
    assert.ok(found, 'expected an id_field warning');
    assert.match(found.location, /messages\[0\]\.request_id/);
    assert.equal(found.sample, 'req_abc123xyz');
  });

  it('caps warnings at MAX_WARNINGS even with many volatile patterns', () => {
    const system = '2024-01-01T00:00:00Z 550e8400-e29b-41d4-a716-446655440000';
    const msgs = [
      { role: 'user', content: '2024-02-01T12:00:00Z', request_id: 'r1x', session_id: 'sx2', cache_control: { type: 'ephemeral' } },
      { role: 'user', content: '550e8400-e29b-41d4-a716-446655440001 and 2024-03-01T09:00:00Z', trace_id: 't3x', cache_control: { type: 'ephemeral' } },
    ];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 2, system });
    assert.ok(warnings.length <= MAX_WARNINGS, `expected ≤ ${MAX_WARNINGS}, got ${warnings.length}`);
    assert.equal(warnings.length, MAX_WARNINGS);
  });

  it('scans only messages when system is null', () => {
    const msgs = [frozenMsg('Check 550e8400-e29b-41d4-a716-446655440000')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1, system: null });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'uuid_v4');
  });

  it('returns no warnings when frozenCount = 0, even with volatile message content', () => {
    const msgs = [liveMsg('Request at 2024-01-15T10:30:00Z with ID 550e8400-e29b-41d4-a716-446655440000')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 0 });
    assert.deepEqual(warnings, []);
  });

  it('returns no warnings for empty messages', () => {
    const warnings = detectVolatileContent({ messages: [], frozenCount: 0, system: null });
    assert.deepEqual(warnings, []);
  });

  it('detects volatile content in array-format content blocks', () => {
    const msgs = [{
      role: 'user',
      content: [{ type: 'text', text: 'Request at 2024-01-15T10:30:00Z' }],
      cache_control: { type: 'ephemeral' },
    }];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1 });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].pattern, 'iso_datetime');
    assert.match(warnings[0].location, /content\[0\]\.text/);
  });

  it('does not warn for dates without time component (date-only strings)', () => {
    const msgs = [frozenMsg('Published on 2024-01-15. No time component.')];
    const warnings = detectVolatileContent({ messages: msgs, frozenCount: 1 });
    assert.deepEqual(warnings, []);
  });

  it('does not warn for short human-readable string values in id fields (has spaces)', () => {
    const msg = { role: 'user', content: 'Hello', session_id: 'my session name', cache_control: { type: 'ephemeral' } };
    const warnings = detectVolatileContent({ messages: [msg], frozenCount: 1 });
    const idWarnings = warnings.filter((w) => w.pattern === 'id_field');
    assert.equal(idWarnings.length, 0);
  });
});

describe('computeFrozenCount', () => {
  it('returns 0 when no messages have cache_control', () => {
    assert.equal(computeFrozenCount([liveMsg('Hello'), liveMsg('World')]), 0);
  });

  it('returns 1 when only first message has cache_control', () => {
    assert.equal(computeFrozenCount([frozenMsg('System context'), liveMsg('Dynamic part')]), 1);
  });

  it('returns index of last cache_control message + 1', () => {
    const msgs = [frozenMsg('A'), frozenMsg('B'), liveMsg('C'), liveMsg('D')];
    assert.equal(computeFrozenCount(msgs), 2);
  });

  it('detects cache_control on content blocks', () => {
    const msgs = [{
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    }, liveMsg('live')];
    assert.equal(computeFrozenCount(msgs), 1);
  });
});

// --- server integration tests ---

describe('server /v1/compress volatile warnings', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = await startServer({ host: '127.0.0.1', port: 0, maxBodyBytes: 1024 * 1024 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('includes warnings when system prompt contains a UUID', async () => {
    const payload = {
      messages: [{ role: 'user', content: 'Hello' }],
      system: 'You are helpful. Correlation: 550e8400-e29b-41d4-a716-446655440000',
    };
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.warnings), 'expected warnings array');
    assert.equal(body.warnings[0].pattern, 'uuid_v4');
    assert.equal(body.warnings[0].location, 'system');
  });

  it('omits the warnings field entirely when content is clean', async () => {
    const payload = {
      messages: [{ role: 'user', content: 'Tell me about the weather.' }],
    };
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(!Object.hasOwn(body, 'warnings'), 'warnings field should be absent');
  });

  it('omits warnings when frozenCount=0 even with volatile message content', async () => {
    // No cache_control → computeFrozenCount returns 0; no system → nothing scanned
    const payload = {
      messages: [
        { role: 'user', content: 'Request at 2024-01-15T10:30:00Z' },
        { role: 'assistant', content: 'Here is your answer.' },
      ],
    };
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(!Object.hasOwn(body, 'warnings'), 'no warnings when no frozen zone');
  });

  it('warns when a frozen message contains a timestamp', async () => {
    const payload = {
      messages: [
        { role: 'user', content: 'Cache loaded at 2024-03-10T15:45:00Z', cache_control: { type: 'ephemeral' } },
        { role: 'user', content: 'What is two plus two?' },
      ],
    };
    const res = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.warnings));
    assert.equal(body.warnings[0].pattern, 'iso_datetime');
  });
});
