import http from 'node:http';
import { compressMessages } from './compress/pipeline.mjs';
import { normalizeTools } from './normalize/tools.mjs';
import { detectVolatileContent } from './analyze/volatile-detector.mjs';
import { proxyRequest, proxyCompressedRequest, resolveUpstream, resolveProxyTimeoutMs, resolveCompressProxy } from './proxy.mjs';
import { parseIntOption } from './lib/config.mjs';
import { DriftDetector } from './analyze/drift-detector.mjs';
import { injectOpenAICacheKey, resolveOpenAICacheKey } from './normalize/openai-cache-key.mjs';

const driftDetector = new DriftDetector();

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

// Re-export proxy config helpers so callers only need to import from server.mjs
export { resolveUpstream, resolveProxyTimeoutMs, resolveCompressProxy };

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

async function handleCompress(request, response, { maxBodyBytes }) {
  const rawBody = await readRequestBody(request, maxBodyBytes);

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
    throw new HttpError(400, '`messages` must be a JSON array');
  }

  const { messages, tokensBefore, tokensAfter, frozenCount } = compressMessages(payload.messages, {
    format: typeof payload.format === 'string' ? payload.format : 'unknown',
    model: typeof payload.model === 'string' ? payload.model : 'default',
  });

  const normalizedTools = Array.isArray(payload.tools)
    ? normalizeTools(payload.tools)
    : undefined;

  const system = typeof payload.system === 'string' ? payload.system : null;
  const warnings = detectVolatileContent({ messages: payload.messages, frozenCount, system });

  const responseBody = {
    messages,
    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    frozen_count: frozenCount,
  };
  if (normalizedTools !== undefined) responseBody.normalized_tools = normalizedTools;
  if (warnings.length > 0) responseBody.warnings = warnings;

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

  writeJson(response, 200, responseBody);
}

async function routeRequest(request, response, options) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

  if (method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, {
      status: 'ok',
      service: 'headroom-lite',
      mode: options.upstream ? 'proxy+deterministic' : 'deterministic',
      max_body_bytes: options.maxBodyBytes,
      upstream: options.upstream ?? null,
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

  if (method === 'POST' && url.pathname === '/v1/compress') {
    await handleCompress(request, response, options);
    return;
  }

  // Transparent passthrough proxy — only active when upstream is configured
  if (options.upstream) {
    if (options.compressProxy) {
      proxyCompressedRequest(request, response, {
        upstream: options.upstream,
        timeoutMs: options.proxyTimeoutMs,
        maxBodyBytes: options.maxBodyBytes,
      }).catch(() => {
        if (!response.headersSent && !response.destroyed) {
          const msg = JSON.stringify({ error: 'proxy error' });
          try {
            response.writeHead(502, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(Buffer.byteLength(msg)),
            });
            response.end(msg);
          } catch { /* socket already gone */ }
        }
      });
    } else {
      proxyRequest(request, response, { upstream: options.upstream, timeoutMs: options.proxyTimeoutMs });
    }
    return;
  }

  writeJson(response, 404, { error: 'not found' });
}

export function createServer({ maxBodyBytes = resolveMaxBodyBytes(), upstream = null, proxyTimeoutMs = resolveProxyTimeoutMs(), compressProxy = resolveCompressProxy() } = {}) {
  const server = http.createServer((request, response) => {
    routeRequest(request, response, { maxBodyBytes, upstream, proxyTimeoutMs, compressProxy }).catch((error) => {
      if (error instanceof HttpError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
      }

      writeJson(response, 500, { error: 'internal server error' });
    });
  });

  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

export function startServer({
  host = process.env.HEADROOM_LITE_HOST ?? DEFAULT_HOST,
  port = resolvePort(),
  maxBodyBytes = resolveMaxBodyBytes(),
  upstream = resolveUpstream(),
  proxyTimeoutMs = resolveProxyTimeoutMs(),
  compressProxy = resolveCompressProxy(),
} = {}) {
  const server = createServer({ maxBodyBytes, upstream, proxyTimeoutMs, compressProxy });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
