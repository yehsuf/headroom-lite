import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { deflateSync } from 'node:zlib';
import {
  computeOptimalK,
  computeUniqueBigramCurve,
  countUniqueSimhash,
  findKnee,
  MAX_SIMHASH_ITEMS,
} from '../src/compress/adaptive-sizer.mjs';

const LOW_DIVERSITY_ITEMS = Array.from(
  { length: 15 },
  (_, index) => [
    'src/auth.js login user auth token refresh repeated pattern alpha',
    'src/auth.js login user auth token refresh repeated pattern beta',
    'src/auth.js login user auth token refresh repeated pattern gamma',
  ][index % 3],
);

const HIGH_DIVERSITY_ITEMS = Array.from(
  { length: 15 },
  (_, index) => `feature ${index} unique telemetry ${String.fromCharCode(97 + index)} ${index * index} shard ${index + 10}`,
);

function validateWithSubset(items, k, maxK, selectSubset, tolerance = 0.15) {
  if (k >= items.length || k >= maxK) return k;

  const fullText = Buffer.from(items.join('\n'));
  const subsetText = Buffer.from(selectSubset(items, k).join('\n'));
  if (fullText.length < 200) return k;

  const fullCompressed = deflateSync(fullText, { level: 1 }).length;
  const subsetCompressed = deflateSync(subsetText, { level: 1 }).length;
  const fullRatio = fullText.length ? fullCompressed / fullText.length : 1.0;
  const subsetRatio = subsetText.length ? subsetCompressed / subsetText.length : 1.0;

  if (Math.abs(fullRatio - subsetRatio) > tolerance) {
    return Math.min(Math.trunc(k * 1.2), maxK);
  }
  return k;
}

function computeOptimalKWithValidationSubset(
  items,
  { bias = 1.0, minK = 3, maxK, selectSubset } = {},
) {
  const count = items.length;
  const effectiveMax = maxK ?? count;

  if (count <= 8) return count;

  const uniqueCount = countUniqueSimhash(items);
  if (uniqueCount <= 3) {
    const k = Math.max(minK, uniqueCount);
    return Math.min(k, effectiveMax);
  }

  const curve = computeUniqueBigramCurve(items);
  let knee = findKnee(curve);
  const diversityRatio = uniqueCount / count;

  if (knee === null) {
    const keepFraction = 0.3 + 0.7 * diversityRatio;
    knee = Math.max(minK, Math.trunc(count * keepFraction));
  } else if (diversityRatio > 0.7) {
    const diversityFloor = Math.max(minK, Math.trunc(count * (0.3 + 0.7 * diversityRatio)));
    knee = Math.max(knee, diversityFloor);
  }

  let k = Math.max(minK, Math.trunc(knee * bias));
  k = Math.min(k, effectiveMax);
  k = validateWithSubset(items, k, effectiveMax, selectSubset);
  return Math.max(minK, Math.min(k, effectiveMax));
}

function makeDiverseItem(index, targetSize = 900) {
  let text = `diverse-${index}\n`;
  for (let line = 0; text.length < targetSize; line += 1) {
    text += `fn ${index}_${line} alpha${(index * 97 + line * 13).toString(36)} beta${(index * 131 + line * 17).toString(36)} gamma${(index * 173 + line * 19).toString(36)}\n`;
  }
  return text.slice(0, targetSize);
}

function makeRepetitiveItem(index, targetSize = 900) {
  const base = `repeated stack frame ${index % 2}\nline cache miss\nline cache miss\nline cache miss\n`;
  return base.repeat(Math.ceil(targetSize / base.length)).slice(0, targetSize);
}

const VALIDATION_DIRECTION_ITEMS = [
  ...Array.from({ length: 5 }, (_, index) => makeDiverseItem(index)),
  ...Array.from({ length: 6 }, (_, index) => makeRepetitiveItem(index + 5)),
];

describe('adaptive sizer', () => {
  it('finds the knee on a concave saturation curve', () => {
    assert.equal(findKnee([10, 18, 24, 28, 30, 31, 32]), 4);
  });

  it('treats a near-linear growth curve as having no clear knee', () => {
    assert.equal(findKnee([2, 4, 6, 8, 10, 12]), null);
  });

  it('keeps far fewer redundant items than diverse ones', () => {
    const lowCurve = computeUniqueBigramCurve(LOW_DIVERSITY_ITEMS);
    const highCurve = computeUniqueBigramCurve(HIGH_DIVERSITY_ITEMS);
    const lowK = computeOptimalK(LOW_DIVERSITY_ITEMS);
    const highK = computeOptimalK(HIGH_DIVERSITY_ITEMS);

    assert.equal(countUniqueSimhash(LOW_DIVERSITY_ITEMS), 3);
    assert.equal(lowCurve.at(-1), 10);
    assert.ok(highCurve.at(-1) > lowCurve.at(-1));
    assert.equal(lowK, 3);
    assert.equal(highK, HIGH_DIVERSITY_ITEMS.length);
    assert.ok(lowK < highK);
  });

  it('validates the newest protected subset instead of the oldest history', () => {
    const options = { minK: 3, maxK: 6 };
    const actual = computeOptimalK(VALIDATION_DIRECTION_ITEMS, options);
    const newestSubset = computeOptimalKWithValidationSubset(VALIDATION_DIRECTION_ITEMS, {
      ...options,
      selectSubset: (items, k) => items.slice(-k),
    });
    const oldestSubset = computeOptimalKWithValidationSubset(VALIDATION_DIRECTION_ITEMS, {
      ...options,
      selectSubset: (items, k) => items.slice(0, k),
    });

    assert.equal(newestSubset, 5);
    assert.equal(oldestSubset, 6);
    assert.equal(actual, newestSubset);
    assert.notEqual(actual, oldestSubset);
  });

  it('countUniqueSimhash computes normally at exactly MAX_SIMHASH_ITEMS', () => {
    const items = Array.from({ length: MAX_SIMHASH_ITEMS }, (_, i) => `item ${i}`);
    const result = countUniqueSimhash(items);
    assert.ok(result > 0 && result <= MAX_SIMHASH_ITEMS);
  });

  it('countUniqueSimhash returns items.length when over MAX_SIMHASH_ITEMS', () => {
    const size = MAX_SIMHASH_ITEMS + 1;
    const items = Array.from({ length: size }, (_, i) => `item ${i}`);
    assert.equal(countUniqueSimhash(items), size);
  });

  it('countUniqueSimhash with 1000 items completes in under 100ms', () => {
    const items = Array.from({ length: 1000 }, (_, i) => `item ${i} pad ${i * 7}`);
    const start = performance.now();
    countUniqueSimhash(items);
    assert.ok(performance.now() - start < 100, 'expected <100ms for 1000 items');
  });
});
