import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export function computeOptimalK(
  items,
  { bias = 1.0, minK = 3, maxK } = {},
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
  k = validateWithZlib(items, k, effectiveMax);
  return Math.max(minK, Math.min(k, effectiveMax));
}

export function findKnee(curve) {
  const count = curve.length;
  if (count < 3) return null;

  const yMin = curve[0];
  const yMax = curve[count - 1];
  if (yMax === yMin) return 1;

  const xRange = count - 1;
  const yRange = yMax - yMin;
  let maxDiff = -1;
  let kneeIndex = null;

  for (let index = 0; index < count; index += 1) {
    const xNorm = index / xRange;
    const yNorm = (curve[index] - yMin) / yRange;
    const diff = yNorm - xNorm;
    if (diff > maxDiff) {
      maxDiff = diff;
      kneeIndex = index;
    }
  }

  if (maxDiff < 0.05) return null;
  return kneeIndex === null ? null : kneeIndex + 1;
}

export function computeUniqueBigramCurve(items) {
  const seenBigrams = new Set();
  const curve = [];

  for (const item of items) {
    const words = item.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      seenBigrams.add(`${words[0] ?? ''}\u0000`);
    } else {
      for (let index = 0; index < words.length - 1; index += 1) {
        seenBigrams.add(`${words[index]}\u0000${words[index + 1]}`);
      }
    }
    curve.push(seenBigrams.size);
  }

  return curve;
}

function simhash(text) {
  const votes = Array(64).fill(0);
  const lowered = text.toLowerCase();
  const gramCount = Math.max(1, lowered.length - 3);

  for (let index = 0; index < gramCount; index += 1) {
    const gram = lowered.slice(index, index + 4);
    const digest = createHash('md5').update(gram).digest();
    const hash = digest.readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit += 1) {
      const mask = 1n << BigInt(bit);
      votes[bit] += (hash & mask) !== 0n ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (votes[bit] > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

function hammingDistance(left, right) {
  let diff = left ^ right;
  let distance = 0;
  while (diff !== 0n) {
    distance += 1;
    diff &= diff - 1n;
  }
  return distance;
}

// KNOWN LIMITATION (inherited from the Headroom reference implementation,
// confirmed present in adaptive_sizer.py's `count_unique_simhash` too — not
// a JS-port regression): greedy clustering compares every item against
// every existing cluster representative with no LSH/bucketing, making this
// effectively O(n^2) on genuinely diverse input (measured: ~15s at 10,000
// diverse items — slower than skipping compression entirely). MUST add
// LSH-style bucketing by hash prefix (or an explicit input-size cap) before
// this module is wired into any live path handling large diverse outputs.
export function countUniqueSimhash(items, threshold = 3) {
  if (!items.length) return 0;

  const fingerprints = items.map((item) => simhash(item));
  const clusters = [];

  for (const fingerprint of fingerprints) {
    let matched = false;
    for (const representative of clusters) {
      if (hammingDistance(fingerprint, representative) <= threshold) {
        matched = true;
        break;
      }
    }
    if (!matched) clusters.push(fingerprint);
  }

  return clusters.length;
}

function validateWithZlib(items, k, maxK, tolerance = 0.15) {
  if (k >= items.length || k >= maxK) return k;

  const fullText = Buffer.from(items.join('\n'));
  const subsetText = Buffer.from(items.slice(0, k).join('\n'));
  if (fullText.length < 200) return k;

  const fullCompressed = deflateSync(fullText, { level: 1 }).length;
  const subsetCompressed = deflateSync(subsetText, { level: 1 }).length;
  const fullRatio = fullText.length ? fullCompressed / fullText.length : 1.0;
  const subsetRatio = subsetText.length ? subsetCompressed / subsetText.length : 1.0;
  const ratioDiff = Math.abs(fullRatio - subsetRatio);

  if (ratioDiff > tolerance) return Math.min(Math.trunc(k * 1.2), maxK);
  return k;
}
