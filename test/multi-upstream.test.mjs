import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveUpstreams, selectUpstream } from '../src/providers/upstreams.mjs';
import { startServer } from '../src/server.mjs';

// ---------------------------------------------------------------------------
// resolveUpstreams() unit tests
// ---------------------------------------------------------------------------

describe('resolveUpstreams', () => {
  it('all vars absent → all null', () => {
    const result = resolveUpstreams({});
    assert.deepEqual(result, { legacy: null, anthropic: null, openai: null, 'github-models': null });
  });

  it('only legacy set → legacy populated, others null', () => {
    const result = resolveUpstreams({ HEADROOM_LITE_UPSTREAM: 'https://api.anthropic.com' });
    assert.equal(result.legacy, 'https://api.anthropic.com');
    assert.equal(result.anthropic, null);
    assert.equal(result.openai, null);
    assert.equal(result['github-models'], null);
  });

  it('provider-specific vars override their slots', () => {
    const result = resolveUpstreams({
      HEADROOM_LITE_UPSTREAM: 'https://fallback.example.com',
      HEADROOM_LITE_UPSTREAM_ANTHROPIC: 'https://api.anthropic.com',
      HEADROOM_LITE_UPSTREAM_OPENAI: 'https://api.openai.com',
      HEADROOM_LITE_UPSTREAM_GITHUB_MODELS: 'https://models.github.ai/inference',
    });
    assert.equal(result.legacy, 'https://fallback.example.com');
    assert.equal(result.anthropic, 'https://api.anthropic.com');
    assert.equal(result.openai, 'https://api.openai.com');
    assert.equal(result['github-models'], 'https://models.github.ai/inference');
  });

  it('strips trailing slash', () => {
    const result = resolveUpstreams({ HEADROOM_LITE_UPSTREAM: 'https://api.anthropic.com/' });
    assert.equal(result.legacy, 'https://api.anthropic.com');
  });

  it('throws with env-var name in message on malformed URL', () => {
    assert.throws(
      () => resolveUpstreams({ HEADROOM_LITE_UPSTREAM_ANTHROPIC: 'not-a-url' }),
      /HEADROOM_LITE_UPSTREAM_ANTHROPIC/,
    );
    assert.throws(
      () => resolveUpstreams({ HEADROOM_LITE_UPSTREAM_OPENAI: 'not-a-url' }),
      /HEADROOM_LITE_UPSTREAM_OPENAI/,
    );
  });

  it('throws on non-http/https protocol', () => {
    assert.throws(
      () => resolveUpstreams({ HEADROOM_LITE_UPSTREAM: 'ftp://example.com' }),
      /http:|https:/,
    );
  });

  it('throws when URL contains query string', () => {
    assert.throws(
      () => resolveUpstreams({ HEADROOM_LITE_UPSTREAM: 'https://api.openai.com?key=val' }),
      /query string/,
    );
  });
});

// ---------------------------------------------------------------------------
// selectUpstream() unit tests
// ---------------------------------------------------------------------------

describe('selectUpstream', () => {
  const UPSTREAMS = {
    legacy: 'https://legacy.example.com',
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    'github-models': 'https://models.github.ai/inference',
  };

  it('provider-specific beats legacy', () => {
    assert.equal(selectUpstream(UPSTREAMS, 'anthropic'), 'https://api.anthropic.com');
    assert.equal(selectUpstream(UPSTREAMS, 'openai'), 'https://api.openai.com');
    assert.equal(selectUpstream(UPSTREAMS, 'github-models'), 'https://models.github.ai/inference');
  });

  it('falls back to legacy when provider-specific is null', () => {
    const upstreams = { ...UPSTREAMS, openai: null };
    assert.equal(selectUpstream(upstreams, 'openai'), 'https://legacy.example.com');
  });

  it('returns null when both provider-specific and legacy are null', () => {
    const upstreams = { legacy: null, anthropic: null, openai: null, 'github-models': null };
    assert.equal(selectUpstream(upstreams, 'anthropic'), null);
  });

  it('unknown provider falls through to legacy', () => {
    assert.equal(selectUpstream(UPSTREAMS, 'unknown'), 'https://legacy.example.com');
  });

  it('unknown provider + no legacy → null', () => {
    const upstreams = { legacy: null, anthropic: 'https://api.anthropic.com', openai: null, 'github-models': null };
    assert.equal(selectUpstream(upstreams, 'unknown'), null);
  });
});

// ---------------------------------------------------------------------------
// Integration: server routes to the correct upstream by path
// ---------------------------------------------------------------------------

describe('multi-upstream routing integration', () => {
  // Start three stub upstream servers — one per provider
  let anthropicServer, openaiServer, githubServer;
  let anthropicPort, openaiPort, githubPort;
  let proxyServer, proxyUrl;

  before(async () => {
    // Create stub servers that record what they receive and respond 200
    function stubServer(name) {
      const received = [];
      const server = http.createServer((req, res) => {
        received.push({ path: req.url, name });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stub: name, path: req.url }));
      });
      server._received = received;
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
    }

    [anthropicServer, openaiServer, githubServer] = await Promise.all([
      stubServer('anthropic'),
      stubServer('openai'),
      stubServer('github-models'),
    ]);
    anthropicPort = anthropicServer.address().port;
    openaiPort = openaiServer.address().port;
    githubPort = githubServer.address().port;

    proxyServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      upstreams: {
        legacy: null,
        anthropic: `http://127.0.0.1:${anthropicPort}`,
        openai: `http://127.0.0.1:${openaiPort}`,
        'github-models': `http://127.0.0.1:${githubPort}`,
      },
    });
    proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  after(async () => {
    await Promise.all([
      new Promise((r) => proxyServer.close(r)),
      new Promise((r) => anthropicServer.close(r)),
      new Promise((r) => openaiServer.close(r)),
      new Promise((r) => githubServer.close(r)),
    ]);
  });

  it('routes /v1/messages to Anthropic stub', async () => {
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const body = await res.json();
    assert.equal(body.stub, 'anthropic');
  });

  it('routes /v1/chat/completions to OpenAI stub', async () => {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const body = await res.json();
    assert.equal(body.stub, 'openai');
  });

  it('routes /chat/completions to GitHub Models stub', async () => {
    const res = await fetch(`${proxyUrl}/chat/completions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const body = await res.json();
    assert.equal(body.stub, 'github-models');
  });

  it('returns 404 for unknown path with no legacy upstream', async () => {
    const res = await fetch(`${proxyUrl}/v1/embeddings`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 404);
  });

  it('/health reports the full upstreams map', async () => {
    const res = await fetch(`${proxyUrl}/health`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.upstreams, 'must include upstreams key');
    assert.equal(body.upstreams.anthropic, `http://127.0.0.1:${anthropicPort}`);
    assert.equal(body.upstreams.openai, `http://127.0.0.1:${openaiPort}`);
    assert.equal(body.upstreams['github-models'], `http://127.0.0.1:${githubPort}`);
  });
});

// ---------------------------------------------------------------------------
// Backward compat: legacy single-upstream mode unchanged
// ---------------------------------------------------------------------------

describe('legacy single-upstream backward compat', () => {
  let legacyStub, proxyServer, proxyUrl;

  before(async () => {
    legacyStub = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stub: 'legacy', path: req.url }));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

    proxyServer = await startServer({
      host: '127.0.0.1',
      port: 0,
      upstream: `http://127.0.0.1:${legacyStub.address().port}`,
    });
    proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  after(async () => {
    await Promise.all([
      new Promise((r) => proxyServer.close(r)),
      new Promise((r) => legacyStub.close(r)),
    ]);
  });

  it('routes all paths to legacy upstream when only HEADROOM_LITE_UPSTREAM is set', async () => {
    const paths = ['/v1/messages', '/v1/chat/completions', '/chat/completions'];
    for (const path of paths) {
      const res = await fetch(`${proxyUrl}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      const body = await res.json();
      assert.equal(body.stub, 'legacy', `expected legacy stub for path ${path}`);
    }
  });

  it('/health upstream field still reports legacy URL (backward compat)', async () => {
    const res = await fetch(`${proxyUrl}/health`);
    const body = await res.json();
    assert.ok(body.upstream, 'legacy upstream field must be present');
  });
});
