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

// RFC 7230 §6.1 — headers that must not be forwarded between hops
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export const DEFAULT_PROXY_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes — covers long SSE streams

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
  // Return without trailing slash for consistent URL construction
  return url.href.replace(/\/$/, '');
}

export function resolveProxyTimeoutMs(input = process.env.HEADROOM_LITE_PROXY_TIMEOUT_MS) {
  return parseIntOption(input, DEFAULT_PROXY_TIMEOUT_MS);
}

function buildForwardHeaders(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
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
 * @param {{ upstream: string, timeoutMs?: number }} options
 */
export function proxyRequest(inboundReq, inboundRes, { upstream, timeoutMs = DEFAULT_PROXY_TIMEOUT_MS }) {
  const upstreamBase = new URL(upstream);
  const isHttps = upstreamBase.protocol === 'https:';
  const transport = isHttps ? https : http;

  // Build the full target URL from the upstream base + original path + query
  const targetUrl = new URL(inboundReq.url ?? '/', upstream);

  const forwardHeaders = buildForwardHeaders(inboundReq.headers);
  forwardHeaders['host'] = upstreamBase.host;

  const upstreamOptions = {
    hostname: upstreamBase.hostname,
    port: upstreamBase.port !== '' ? Number(upstreamBase.port) : (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
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
    // If headers already sent (mid-stream SSE), just close the socket
    if (inboundRes.headersSent) {
      if (!inboundRes.destroyed) inboundRes.destroy();
      return;
    }

    if (clientClosed) return;

    const statusCode = error.message === 'upstream request timed out' ? 504 : 502;
    const body = JSON.stringify({ error: error.message });
    try {
      inboundRes.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body).toString(),
      });
      inboundRes.end(body);
    } catch {
      if (!inboundRes.destroyed) inboundRes.destroy();
    }
  });

  // Pipe inbound request body to upstream (GET requests have no body — pipe is a no-op)
  inboundReq.pipe(upstreamReq, { end: true });
}
