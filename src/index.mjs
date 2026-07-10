#!/usr/bin/env node

import { DEFAULT_HOST, startServer } from './server.mjs';

const host = process.env.HEADROOM_LITE_HOST ?? DEFAULT_HOST;

const server = await startServer({ host });
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 'unknown';

console.log(`[headroom-lite] listening on http://${host}:${port}`);

function shutdown(signal) {
  server.close(() => {
    console.log(`[headroom-lite] received ${signal}, shutting down`);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
