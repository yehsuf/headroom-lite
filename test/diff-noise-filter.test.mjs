import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { filterDiffNoise } from '../src/compress/diff-noise-filter.mjs';

// ── fixtures ──────────────────────────────────────────────────────────────────

const BINARY_DIFF = [
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index abc1234..def5678 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
].join('\n');

const PACKAGE_LOCK_DIFF = [
  'diff --git a/package-lock.json b/package-lock.json',
  'index abc1234..def5678 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,5 +1,5 @@',
  ' {',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  '   "name": "test"',
  ' }',
].join('\n');

const YARN_LOCK_DIFF = [
  'diff --git a/yarn.lock b/yarn.lock',
  'index 0000000..1111111 100644',
  '--- a/yarn.lock',
  '+++ b/yarn.lock',
  '@@ -1,4 +1,4 @@',
  ' # yarn lockfile v1',
  '-lodash@^4.0.0:',
  '+lodash@^4.17.0:',
  '   version "4.17.21"',
].join('\n');

const SOURCE_DIFF = [
  'diff --git a/src/index.js b/src/index.js',
  'index 1234567..abcdef0 100644',
  '--- a/src/index.js',
  '+++ b/src/index.js',
  '@@ -1,5 +1,5 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  ' const z = 4;',
  ' module.exports = { x, y, z };',
].join('\n');

// Mixed: lockfile section + source section
const MIXED_DIFF = [
  'diff --git a/yarn.lock b/yarn.lock',
  'index 0000000..1111111 100644',
  '--- a/yarn.lock',
  '+++ b/yarn.lock',
  '@@ -1,3 +1,3 @@',
  ' # yarn lockfile v1',
  '-lodash@^4.0.0:',
  '+lodash@^4.17.0:',
  'diff --git a/src/utils.js b/src/utils.js',
  'index aabbcc..ddeeff 100644',
  '--- a/src/utils.js',
  '+++ b/src/utils.js',
  '@@ -10,5 +10,5 @@',
  ' function helper() {',
  '-  return false;',
  '+  return true;',
  ' }',
].join('\n');

const SOURCE_ONLY_SECTION = [
  'diff --git a/src/utils.js b/src/utils.js',
  'index aabbcc..ddeeff 100644',
  '--- a/src/utils.js',
  '+++ b/src/utils.js',
  '@@ -10,5 +10,5 @@',
  ' function helper() {',
  '-  return false;',
  '+  return true;',
  ' }',
].join('\n');

// Diff with a whitespace-only first hunk and a real second hunk
const WHITESPACE_HUNK_DIFF = [
  'diff --git a/src/style.css b/src/style.css',
  'index 123..456 100644',
  '--- a/src/style.css',
  '+++ b/src/style.css',
  '@@ -1,4 +1,4 @@',
  ' .foo {',
  '-  ',
  '+   ',
  ' }',
  '@@ -10,4 +10,4 @@',
  ' .bar {',
  '-  color: red;',
  '+  color: blue;',
  ' }',
].join('\n');

const WHITESPACE_HUNK_DIFF_FILTERED = [
  'diff --git a/src/style.css b/src/style.css',
  'index 123..456 100644',
  '--- a/src/style.css',
  '+++ b/src/style.css',
  '@@ -10,4 +10,4 @@',
  ' .bar {',
  '-  color: red;',
  '+  color: blue;',
  ' }',
].join('\n');

// ── tests ─────────────────────────────────────────────────────────────────────

describe('filterDiffNoise', () => {
  it('returns empty string for empty input', () => {
    assert.equal(filterDiffNoise(''), '');
  });

  it('drops binary file diffs entirely', () => {
    assert.equal(filterDiffNoise(BINARY_DIFF), '');
  });

  it('drops package-lock.json diffs entirely', () => {
    assert.equal(filterDiffNoise(PACKAGE_LOCK_DIFF), '');
  });

  it('drops yarn.lock diffs entirely', () => {
    assert.equal(filterDiffNoise(YARN_LOCK_DIFF), '');
  });

  it('passes normal source diffs through unchanged', () => {
    assert.equal(filterDiffNoise(SOURCE_DIFF), SOURCE_DIFF);
  });

  it('keeps only the source file section from a mixed diff', () => {
    assert.equal(filterDiffNoise(MIXED_DIFF), SOURCE_ONLY_SECTION);
  });

  it('drops whitespace-only hunks, keeps file header and real hunks', () => {
    assert.equal(filterDiffNoise(WHITESPACE_HUNK_DIFF), WHITESPACE_HUNK_DIFF_FILTERED);
  });

  it('drops section entirely when all its hunks are whitespace-only', () => {
    const allWhitespaceDiff = [
      'diff --git a/src/blank.js b/src/blank.js',
      'index 111..222 100644',
      '--- a/src/blank.js',
      '+++ b/src/blank.js',
      '@@ -1,3 +1,3 @@',
      ' line',
      '-   ',
      '+  ',
      ' line',
    ].join('\n');
    assert.equal(filterDiffNoise(allWhitespaceDiff), '');
  });
});
