import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeOptimalK,
  computeUniqueBigramCurve,
  countUniqueSimhash,
  findKnee,
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
});
