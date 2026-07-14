import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(repoRoot, 'src', 'index.mjs');
const { version } = require('../package.json');

// The bin must be introspectable for parity with the classic Python `headroom`
// binary, which myelin's installer detects via `detectTool('headroom-lite',
// '--version')` (a quick version print + exit, NOT a long-running server).

async function runBin(args) {
  // A short timeout: if the flag is unhandled the server would start and the
  // process would hang, so a timeout here means the parity is broken.
  return execFileP(process.execPath, [indexPath, ...args], {
    cwd: repoRoot,
    timeout: 5000,
    env: { ...process.env },
  });
}

test('`--version` prints the version and exits 0 without starting the server', async () => {
  const { stdout } = await runBin(['--version']);
  assert.ok(stdout.includes(version), `stdout should contain version ${version}; got: ${stdout}`);
  assert.ok(!/listening on/i.test(stdout), 'server must not start on --version');
});

test('`-v` is an alias for --version', async () => {
  const { stdout } = await runBin(['-v']);
  assert.ok(stdout.includes(version), `stdout should contain version ${version}; got: ${stdout}`);
});

test('`--help` prints usage and exits 0 without starting the server', async () => {
  const { stdout } = await runBin(['--help']);
  assert.ok(/usage/i.test(stdout), `--help should print usage; got: ${stdout}`);
  assert.ok(!/listening on/i.test(stdout), 'server must not start on --help');
});
