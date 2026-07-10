import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { injectOpenAICacheKey } from '../src/normalize/openai-cache-key.mjs';
import { startServer } from '../src/server.mjs';

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('injectOpenAICacheKey()', () => {
  it('injects a prompt_cache_key starting with "hl-" when none present', () => {
    const body = { model: 'gpt-4o', messages: [] };
    const result = injectOpenAICacheKey(body);
    assert.ok(typeof result.prompt_cache_key === 'string');
    assert.match(result.prompt_cache_key, /^hl-[0-9a-f]{32}$/);
  });

  it('does NOT override an existing prompt_cache_key', () => {
    const body = { model: 'gpt-4o', messages: [], prompt_cache_key: 'caller-owned' };
    const result = injectOpenAICacheKey(body);
    assert.equal(result.prompt_cache_key, 'caller-owned');
  });

  it('does NOT inject when model field is missing', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const result = injectOpenAICacheKey(body);
    assert.equal(result.prompt_cache_key, undefined);
  });

  it('returns the original body unchanged for null/non-object input', () => {
    assert.equal(injectOpenAICacheKey(null), null);
    assert.equal(injectOpenAICacheKey('string'), 'string');
    assert.equal(injectOpenAICacheKey(undefined), undefined);
  });

  it('is deterministic — same input produces same key', () => {
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'You are helpful.' }],
      tools: [{ function: { name: 'search' } }],
    };
    const a = injectOpenAICacheKey(body).prompt_cache_key;
    const b = injectOpenAICacheKey(body).prompt_cache_key;
    assert.equal(a, b);
  });

  it('produces different keys for different models', () => {
    const base = { messages: [] };
    const k1 = injectOpenAICacheKey({ ...base, model: 'gpt-4o' }).prompt_cache_key;
    const k2 = injectOpenAICacheKey({ ...base, model: 'gpt-4-turbo' }).prompt_cache_key;
    assert.notEqual(k1, k2);
  });

  it('produces different keys for different system messages', () => {
    const base = { model: 'gpt-4o' };
    const k1 = injectOpenAICacheKey({ ...base, messages: [{ role: 'system', content: 'Be concise.' }] }).prompt_cache_key;
    const k2 = injectOpenAICacheKey({ ...base, messages: [{ role: 'system', content: 'Be verbose.' }] }).prompt_cache_key;
    assert.notEqual(k1, k2);
  });

  it('produces different keys for different tool sets', () => {
    const base = { model: 'gpt-4o', messages: [] };
    const k1 = injectOpenAICacheKey({ ...base, tools: [{ function: { name: 'search' } }] }).prompt_cache_key;
    const k2 = injectOpenAICacheKey({ ...base, tools: [{ function: { name: 'calculator' } }] }).prompt_cache_key;
    assert.notEqual(k1, k2);
  });

  it('produces the SAME key for tools in different order (sorted)', () => {
    const base = { model: 'gpt-4o', messages: [] };
    const k1 = injectOpenAICacheKey({ ...base, tools: [{ function: { name: 'alpha' } }, { function: { name: 'beta' } }] }).prompt_cache_key;
    const k2 = injectOpenAICacheKey({ ...base, tools: [{ function: { name: 'beta' } }, { function: { name: 'alpha' } }] }).prompt_cache_key;
    assert.equal(k1, k2);
  });

  it('works with no system message — key derived from model + tools only', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] };
    const result = injectOpenAICacheKey(body);
    assert.match(result.prompt_cache_key, /^hl-[0-9a-f]{32}$/);
  });

  it('extracts OpenAI system message with role=system correctly', () => {
    const base = { model: 'gpt-4o' };
    const withSys = { ...base, messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: 'hi' }] };
    const withoutSys = { ...base, messages: [{ role: 'user', content: 'hi' }] };
    assert.notEqual(
      injectOpenAICacheKey(withSys).prompt_cache_key,
      injectOpenAICacheKey(withoutSys).prompt_cache_key,
    );
  });

  it('extracts system content when content is an array of text blocks', () => {
    const base = { model: 'gpt-4o' };
    const arrayContent = { ...base, messages: [{ role: 'system', content: [{ type: 'text', text: 'Be precise.' }] }] };
    const stringContent = { ...base, messages: [{ role: 'system', content: 'Be precise.' }] };
    assert.equal(
      injectOpenAICacheKey(arrayContent).prompt_cache_key,
      injectOpenAICacheKey(stringContent).prompt_cache_key,
    );
  });

  it('does not throw with empty tools and messages arrays', () => {
    assert.doesNotThrow(() => injectOpenAICacheKey({ model: 'gpt-4o', messages: [], tools: [] }));
  });

  it('handles tools with top-level name (Anthropic-style name field fallback)', () => {
    const base = { model: 'gpt-4o', messages: [] };
    const k1 = injectOpenAICacheKey({ ...base, tools: [{ name: 'mytool' }] }).prompt_cache_key;
    const k2 = injectOpenAICacheKey({ ...base, tools: [{ function: { name: 'mytool' } }] }).prompt_cache_key;
    assert.equal(k1, k2);
  });
});

// ── Server integration tests ──────────────────────────────────────────────────

describe('POST /v1/compress — OpenAI cache key integration', () => {
  let server;
  let baseUrl;

  before(async () => {
    process.env.HEADROOM_LITE_OPENAI_CACHE_KEY = 'true';
    server = await startServer({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    delete process.env.HEADROOM_LITE_OPENAI_CACHE_KEY;
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });

  it('includes prompt_cache_key in response when format=openai and env enabled', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(typeof body.prompt_cache_key === 'string', 'prompt_cache_key should be present');
    assert.match(body.prompt_cache_key, /^hl-[0-9a-f]{32}$/);
  });

  it('does NOT include prompt_cache_key when format=anthropic', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'anthropic',
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.prompt_cache_key, undefined);
  });
});

describe('POST /v1/compress — OpenAI cache key disabled by default', () => {
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.HEADROOM_LITE_OPENAI_CACHE_KEY;
    server = await startServer({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });

  it('does NOT include prompt_cache_key when env var is not set', async () => {
    const response = await fetch(`${baseUrl}/v1/compress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.prompt_cache_key, undefined);
  });
});
