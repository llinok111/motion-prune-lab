// Baseline: uniform keyframe extraction, independent implementation.
// It deliberately does not import src/core.mjs: the verifier compares the DP
// against this code so the two error calculations cannot share a helper.

export function uniformIndices(n, targetCount) {
  if (!Number.isInteger(n) || n < 2) throw new Error("n must be >= 2");
  if (!Number.isInteger(targetCount) || targetCount < 2 || targetCount > n) {
    throw new Error("targetCount must be in [2, n]");
  }
  const out = [0];
  for (let q = 1; q < targetCount - 1; q++) {
    const idx = Math.round((q * (n - 1)) / (targetCount - 1));
    if (idx > out[out.length - 1] && idx < n - 1) out.push(idx);
  }
  out.push(n - 1);
  if (out.length !== targetCount) {
    // This baseline never pretends a rounded set has more keys than it does;
    // fill deterministic unused slots, then sort.
    for (let idx = 1; idx < n - 1 && out.length < targetCount; idx++) {
      if (!out.includes(idx)) out.push(idx);
    }
    out.sort((a, b) => a - b);
  }
  return out;
}

function valueAtSample(values, dim, idx, d) {
  return values[idx * dim + d];
}

function lerp(a, b, u) {
  return a * (1 - u) + b * u;
}

function interp(times, values, dim, indices, t) {
  let lo = 0;
  let hi = indices.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[indices[mid]] <= t) lo = mid;
    else hi = mid;
  }
  const i = indices[lo];
  const j = indices[hi];
  const u = (t - times[i]) / (times[j] - times[i]);
  const out = new Array(dim);
  for (let d = 0; d < dim; d++) {
    out[d] = lerp(valueAtSample(values, dim, i, d), valueAtSample(values, dim, j, d), u);
  }
  return out;
}

export function planError(times, values, dim, indices) {
  let maxSq = 0;
  for (let k = 0; k < times.length; k++) {
    const p = interp(times, values, dim, indices, times[k]);
    let sq = 0;
    for (let d = 0; d < dim; d++) {
      const e = valueAtSample(values, dim, k, d) - p[d];
      sq += e * e;
    }
    if (sq > maxSq) maxSq = sq;
  }
  return Math.sqrt(maxSq);
}

export function uniformPlan(times, values, dim, tolerance) {
  const n = times.length;
  // Smallest uniform key count that meets the tolerance; scan upward rather
  // than binary-searching, because uniform-sample error is not guaranteed to
  // be monotone in the number of samples.
  let best = n;
  for (let count = 2; count <= n; count++) {
    const idx = uniformIndices(n, count);
    if (planError(times, values, dim, idx) <= tolerance) {
      best = count;
      break;
    }
  }
  const keptIndices = uniformIndices(n, best);
  return {
    trackName: null,
    dim,
    tolerance,
    inputKeys: n,
    outputKeys: keptIndices.length,
    keptIndices,
    maxError: planError(times, values, dim, keptIndices),
    method: "uniform",
  };
}

export function uniformAtCount(times, values, dim, count) {
  const keptIndices = uniformIndices(times.length, count);
  return {
    inputKeys: times.length,
    outputKeys: keptIndices.length,
    keptIndices,
    maxError: planError(times, values, dim, keptIndices),
    method: "uniform-same-count",
  };
}
