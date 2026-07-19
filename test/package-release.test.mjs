import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

test('release metadata matches headroom-lite 0.31.0-2', () => {
  assert.equal(pkg.version, '0.31.0-2');
  assert.equal(pkg.engines.node, '>=20.0.0');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.scripts?.test, 'node --test');
  assert.equal(pkg.scripts?.['test:watch'], 'node --test --watch');
});
