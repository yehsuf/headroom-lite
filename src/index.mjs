#!/usr/bin/env node

import { createRequire } from 'node:module';
import { DEFAULT_HOST, startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { version, name } = require('../package.json');

const host = process.env.HEADROOM_LITE_HOST ?? DEFAULT_HOST;

const server = await startServer({ host });
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 'unknown';

console.log(`[${name}] v${version} listening on http://${host}:${port}`);

function shutdown(signal) {
  server.close(() => {
    console.log(`[headroom-lite] received ${signal}, shutting down`);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
