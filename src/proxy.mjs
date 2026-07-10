/**
 * Transparent HTTP/HTTPS reverse proxy for headroom-lite Phase 2.
 *
 * Design constraints (non-negotiable):
 *   1. Auth headers (Authorization, x-api-key, x-goog-api-key, etc.) are treated
 *      as FULLY OPAQUE — forwarded byte-for-byte, never read, classified, or
 *      rewritten under any circumstance. See headroomlabs-ai/headroom#1879 for
 *      the exact bug class this avoids.
 *   2. SSE responses (text/event-stream) are raw byte-piped — never buffered,
 *      never reparsed mid-stream. TTFT is preserved.
 *   3. Hop-by-hop headers are stripped from both inbound and outbound per RFC 7230.
 *   4. If the client disconnects, the upstream request is immediately aborted.
 */
import http from 'node:http';
import https from 'node:https';
import { parseIntOption } from './lib/config.mjs';
import { compressMessages } from './compress/pipeline.mjs';
import { detectFormat } from './providers/detect.mjs';

// RFC 7230 §6.1 — fixed set of hop-by-hop headers that must not be forwarded.
// The Connection header value may also name additional hop-by-hop headers;
// those are handled dynamically in buildForwardHeaders().
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',    // RFC 7230 §6.1 uses singular "Trailer"
  'trailers',   // kept for defensive coverage; some implementations use plural
  'transfer-encoding',
  'upgrade',
]);

export const DEFAULT_PROXY_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes — covers long SSE streams
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — proxy compression read limit

export function resolveUpstream(input = process.env.HEADROOM_LITE_UPSTREAM) {
  if (!input) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`HEADROOM_LITE_UPSTREAM is not a valid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`HEADROOM_LITE_UPSTREAM must use http: or https: — got: ${url.protocol}`);
  }
  if (url.search) {
    throw new Error(`HEADROOM_LITE_UPSTREAM must not include a query string — got: ${input}`);
  }
  // Return without trailing slash for consistent path-prefix prepending
  return url.href.replace(/\/$/, '');
}

export function resolveProxyTimeoutMs(input = process.env.HEADROOM_LITE_PROXY_TIMEOUT_MS) {
  return parseIntOption(input, DEFAULT_PROXY_TIMEOUT_MS);
}

export function resolveCompressProxy(input = process.env.HEADROOM_LITE_COMPRESS_PROXY) {
  if (!input) return false;
  return input === 'true' || input === '1';
}

function buildForwardHeaders(source) {
  // RFC 7230 §6.1: the Connection header may list additional hop-by-hop header names.
  // Strip those dynamically so connection-scoped metadata cannot leak across hops.
  const connectionValue = String(source['connection'] ?? '');
  const dynamicHopByHop = new Set(
    connectionValue.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
  );

  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (dynamicHopByHop.has(lower)) continue;
    // host is always replaced with the upstream host
    if (lower === 'host') continue;
    out[lower] = value;
  }
  return out;
}

/**
 * Proxy `inboundReq` to `upstream` and pipe the response back to `inboundRes`.
 *
 * @param {import('node:http').IncomingMessage} inboundReq
 * @param {import('node:http').ServerResponse} inboundRes
 * @param {{ upstream: string, timeoutMs?: number, body?: Buffer|null }} options
 */
export function proxyRequest(inboundReq, inboundRes, { upstream, timeoutMs = DEFAULT_PROXY_TIMEOUT_MS, body = null }) {
  const upstreamBase = new URL(upstream);
  const isHttps = upstreamBase.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Build the target path: upstream base-path prefix + inbound path + query string.
  // Using new URL(inboundPath, upstream) would drop the upstream path prefix
  // (e.g. '/api/v2' from 'http://upstream/api/v2') because the inbound path starts
  // with '/', which resolves relative to the origin root. We prepend explicitly instead.
  const inboundParsed = new URL(inboundReq.url ?? '/', 'http://placeholder');
  const upstreamPathPrefix = upstreamBase.pathname === '/' ? '' : upstreamBase.pathname.replace(/\/$/, '');
  const targetPath = upstreamPathPrefix + inboundParsed.pathname + inboundParsed.search;

  const forwardHeaders = buildForwardHeaders(inboundReq.headers);
  forwardHeaders['host'] = upstreamBase.host;

  // When we have a pre-read body buffer, set the exact length and drop transfer-encoding
  // so the upstream sees a well-formed Content-Length request.
  if (body !== null) {
    forwardHeaders['content-length'] = String(body.length);
    delete forwardHeaders['transfer-encoding'];
  }

  const upstreamOptions = {
    hostname: upstreamBase.hostname,
    port: upstreamBase.port !== '' ? Number(upstreamBase.port) : (isHttps ? 443 : 80),
    path: targetPath,
    method: inboundReq.method ?? 'GET',
    headers: forwardHeaders,
    timeout: timeoutMs,
  };

  // We capture the upstream response stream to destroy it on client disconnect
  let upstreamRes = null;
  let clientClosed = false;

  const upstreamReq = transport.request(upstreamOptions, (res) => {
    upstreamRes = res;

    if (clientClosed) {
      // Client already disconnected before upstream responded
      res.destroy();
      return;
    }

    // Strip hop-by-hop from the upstream response headers before forwarding
    const responseHeaders = buildForwardHeaders(res.headers);
    inboundRes.writeHead(res.statusCode ?? 502, responseHeaders);

    // Raw byte-pipe — zero buffering, works identically for SSE and regular JSON
    res.pipe(inboundRes, { end: true });

    // Clean up the socket listener once the response is fully sent
    inboundRes.on('finish', () => clientSocket?.off('close', onClientSocketClose));

    res.on('error', () => {
      if (!inboundRes.destroyed) inboundRes.destroy();
    });
  });

  // Abort upstream when the client TCP socket closes (not IncomingMessage 'close',
  // which fires after the request body is consumed — too early for GET requests).
  // We guard on !writableEnded so we don't abort when the socket closes naturally
  // after a successful response cycle.
  const clientSocket = inboundReq.socket;
  const onClientSocketClose = () => {
    if (!inboundRes.writableEnded) {
      clientClosed = true;
      upstreamReq.destroy();
      upstreamRes?.destroy();
    }
  };
  clientSocket?.on('close', onClientSocketClose);

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream request timed out'));
  });

  upstreamReq.on('error', (error) => {
    // Always clean up the socket listener — the response callback won't fire on error,
    // so the 'finish' handler inside it would never remove it. Without this, repeated
    // upstream errors on a keep-alive socket accumulate stale listeners.
    clientSocket?.off('close', onClientSocketClose);

    // If headers already sent (mid-stream SSE), just close the socket
    if (inboundRes.headersSent) {
      if (!inboundRes.destroyed) inboundRes.destroy();
      return;
    }

    if (clientClosed) return;

    const statusCode = error.message === 'upstream request timed out' ? 504 : 502;
    const errorBody = JSON.stringify({ error: error.message });
    try {
      inboundRes.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(errorBody).toString(),
      });
      inboundRes.end(errorBody);
    } catch {
      if (!inboundRes.destroyed) inboundRes.destroy();
    }
  });

  // If a pre-read body buffer is provided, write it directly; otherwise pipe the inbound stream.
  if (body !== null) {
    upstreamReq.end(body);
  } else {
    // Pipe inbound request body to upstream (GET requests have no body — pipe is a no-op)
    inboundReq.pipe(upstreamReq, { end: true });
  }
}

/**
 * Like proxyRequest, but first reads and (when possible) compresses the JSON request body.
 * Falls back to forwarding the original body on any error.
 *
 * @param {import('node:http').IncomingMessage} inboundReq
 * @param {import('node:http').ServerResponse} inboundRes
 * @param {{ upstream: string, timeoutMs?: number, maxBodyBytes?: number }} options
 */
export async function proxyCompressedRequest(inboundReq, inboundRes, {
  upstream,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  // Buffer the full request body so we can inspect, compress, and forward it.
  let rawBody;
  try {
    const chunks = [];
    for await (const chunk of inboundReq) {
      chunks.push(chunk);
    }
    rawBody = Buffer.concat(chunks);
  } catch {
    if (!inboundRes.headersSent && !inboundRes.destroyed) {
      const msg = JSON.stringify({ error: 'failed to read request body' });
      try {
        inboundRes.writeHead(502, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(msg)),
        });
        inboundRes.end(msg);
      } catch { /* socket already gone */ }
    }
    return;
  }

  // Only attempt compression when body is within size limit and content-type is JSON.
  if (rawBody.length <= maxBodyBytes) {
    const contentType = inboundReq.headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)) {
          const inboundParsed = new URL(inboundReq.url ?? '/', 'http://placeholder');
          const format = detectFormat(inboundParsed.pathname);
          const { messages } = compressMessages(parsed.messages, { format });
          const compressed = Buffer.from(JSON.stringify({ ...parsed, messages }), 'utf8');
          proxyRequest(inboundReq, inboundRes, { upstream, timeoutMs, body: compressed });
          return;
        }
      } catch {
        // Compression failed — fall through to forward original body unchanged.
      }
    }
  }

  proxyRequest(inboundReq, inboundRes, { upstream, timeoutMs, body: rawBody });
}
