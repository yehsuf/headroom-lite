#!/usr/bin/env node

import { createRequire } from 'node:module';
import { DEFAULT_HOST, startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { version, name } = require('../package.json');

// CLI parity with the classic Python `headroom` binary: answer --version/--help
// quickly and exit, WITHOUT starting the server. myelin's installer detects the
// engine via `detectTool('headroom-lite', '--version')`, which expects a fast
// version print + exit(0); starting the server here would hang that probe.
const cliArgs = process.argv.slice(2);
if (cliArgs.includes('--version') || cliArgs.includes('-v')) {
  console.log(version);
  process.exit(0);
}
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  console.log(
    `${name} ${version}\n`
    + 'Usage: headroom-lite [--version] [--help]\n'
    + 'Starts the headroom-lite compression sidecar.\n'
    + 'Configuration is environment-driven (e.g. HEADROOM_LITE_HOST, PORT).',
  );
  process.exit(0);
}

const host = process.env.HEADROOM_LITE_HOST ?? DEFAULT_HOST;

const server = await startServer({ host, version });
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
