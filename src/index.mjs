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

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[headroom-lite] received ${signal}, shutting down`);

  let exitCode = 0;
  try {
    if (typeof server.closeAndFlushTelemetry === 'function') {
      await server.closeAndFlushTelemetry();
    } else {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } catch {
    exitCode = 1;
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
