// Pure ES module: no three.js, no DOM, no I/O, no environment reads.
// Certified keyframe pruning for translation / scale / morph-weight tracks.
//
// Mathematical fact used by the certificate:
// between two original key times both the source track and the candidate track
// are linear, so their difference is linear. The Euclidean norm of a linear
// vector function is convex, therefore its maximum on a closed interval is at
// an endpoint. Hence max error over continuous time == max error at the
// original sample times. verify.mjs also samples fractionally to confirm it.

const MAX_DIM = 4;
const FEASIBLE = 0x3fffffff;

export function validateTrack(times, values, dim) {
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) {
    throw new Error(`dim must be an integer in [1, ${MAX_DIM}], got ${dim}`);
  }
  if (!times || !values) throw new Error("times and values are required");
  if (times.length < 2) throw new Error("a track needs at least 2 keyframes");
  if (values.length !== times.length * dim) {
    throw new Error(`values length ${values.length} != times.length*dim ${times.length * dim}`);
  }
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!Number.isFinite(t)) throw new Error(`time[${i}] is not finite`);
    if (i > 0 && !(t > times[i - 1])) throw new Error(`times must be strictly increasing at ${i}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error(`values[${i}] is not finite`);
  }
  return { n: times.length, dim };
}

function lerp(a, b, u) {
  return a + (b - a) * u;
}

function splitFraction(times, i, j, k) {
  return (times[k] - times[i]) / (times[j] - times[i]);
}

// Max Euclidean reconstruction error at original samples strictly between i and j.
export function segmentError(times, values, dim, i, j) {
  if (!(j > i)) throw new Error("segment endpoints must satisfy j > i");
  let maxSq = 0;
  const vi = i * dim;
  const vj = j * dim;
  for (let k = i + 1; k < j; k++) {
    const u = splitFraction(times, i, j, k);
    const vk = k * dim;
    let sq = 0;
    for (let d = 0; d < dim; d++) {
      const e = values[vk + d] - lerp(values[vi + d], values[vj + d], u);
      sq += e * e;
    }
    if (sq > maxSq) maxSq = sq;
  }
  return Math.sqrt(maxSq);
}

// Exact global minimum-cardinality plan among endpoint-preserving subsets.
// DP over source samples: dp[j] = min keys for prefix [0..j], edge i->j is
// allowed iff the straight segment i..j stays within tolerance at every
// original sample. O(n^3) time, O(n) extra memory (n <= a few hundred).
export function simplifyTrack(times, values, dim, tolerance) {
  const { n } = validateTrack(times, values, dim);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`tolerance must be a finite non-negative number, got ${tolerance}`);
  }
  const keys = new Int32Array(n).fill(FEASIBLE);
  const pathErr = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  keys[0] = 1;
  pathErr[0] = 0;

  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (keys[i] >= FEASIBLE) continue;
      const e = segmentError(times, values, dim, i, j);
      // Only a guard against tiny negative/positive round-off in the
      // comparison; it is tolerance-relative, never an absolute world scale.
      const slack = tolerance * 1e-12 + 1e-15;
      if (e > tolerance + slack) continue;
      const c = keys[i] + 1;
      const pe = Math.max(pathErr[i], e);
      if (c < keys[j] ||
          (c === keys[j] && (pe < pathErr[j] - 1e-15 ||
           (Math.abs(pe - pathErr[j]) <= 1e-15 && i < prev[j])))) {
        keys[j] = c;
        pathErr[j] = pe;
        prev[j] = i;
      }
    }
  }

  const keptIndices = [];
  for (let k = n - 1; k >= 0; k = prev[k]) {
    keptIndices.push(k);
    if (k === 0) break;
  }
  keptIndices.reverse();
  if (keptIndices[0] !== 0 || keptIndices[keptIndices.length - 1] !== n - 1) {
    throw new Error("internal error: plan does not preserve both endpoints");
  }
  const certificate = evaluatePlan(times, values, dim, keptIndices);
  return {
    trackName: null,
    dim,
    tolerance,
    inputKeys: n,
    outputKeys: keptIndices.length,
    keptIndices,
    maxError: certificate.maxError,
    worst: certificate.worst,
    optimality: "global-minimum-key-count-for-piecewise-linear-endpoint-preserving-plans",
  };
}

// Evaluate a plan at an arbitrary time. The candidate is the piecewise-linear
// interpolation through the kept original samples.
export function evalPlanAt(times, values, dim, keptIndices, t) {
  if (!Number.isFinite(t)) throw new Error("t must be finite");
  const first = keptIndices[0];
  const last = keptIndices[keptIndices.length - 1];
  if (t <= times[first]) t = times[first];
  if (t >= times[last]) t = times[last];
  let lo = 0;
  let hi = keptIndices.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[keptIndices[mid]] <= t) lo = mid;
    else hi = mid;
  }
  const i = keptIndices[lo];
  const j = keptIndices[hi];
  const u = (t - times[i]) / (times[j] - times[i]);
  const out = new Array(dim);
  for (let d = 0; d < dim; d++) out[d] = lerp(values[i * dim + d], values[j * dim + d], u);
  return out;
}

function errorAt(times, values, dim, keptIndices, t) {
  const p = evalPlanAt(times, values, dim, keptIndices, t);
  let k = 0;
  // The source is the piecewise-linear interpolation of every original key.
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[0]) k = 0;
  else if (t >= times[times.length - 1]) k = times.length - 1;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const u = (t - times[lo]) / (times[hi] - times[lo]);
    let sq = 0;
    for (let d = 0; d < dim; d++) {
      const e = lerp(values[lo * dim + d], values[hi * dim + d], u) - p[d];
      sq += e * e;
    }
    return Math.sqrt(sq);
  }
  let sq = 0;
  for (let d = 0; d < dim; d++) {
    const e = values[k * dim + d] - p[d];
    sq += e * e;
  }
  return Math.sqrt(sq);
}

export function evaluatePlan(times, values, dim, keptIndices) {
  validateTrack(times, values, dim);
  if (!Array.isArray(keptIndices) || keptIndices.length < 2) {
    throw new Error("keptIndices must contain at least the two endpoints");
  }
  for (let q = 0; q < keptIndices.length; q++) {
    const idx = keptIndices[q];
    if (!Number.isInteger(idx) || idx < 0 || idx >= times.length) throw new Error("kept index out of range");
    if (q > 0 && !(idx > keptIndices[q - 1])) throw new Error("kept indices must be strictly increasing");
  }
  if (keptIndices[0] !== 0 || keptIndices[keptIndices.length - 1] !== times.length - 1) {
    throw new Error("keptIndices must start at 0 and end at the last sample");
  }

  let maxError = 0;
  let worst = null;
  for (let q = 1; q < keptIndices.length; q++) {
    const i = keptIndices[q - 1];
    const j = keptIndices[q];
    for (let k = i; k <= j; k++) {
      const e = errorAt(times, values, dim, keptIndices, times[k]);
      if (e > maxError) {
        maxError = e;
        worst = { sampleIndex: k, segmentStart: i, segmentEnd: j, error: e };
      }
    }
  }
  return { maxError, worst, evaluations: keptIndices.length >= 2 ? times.length : 0 };
}

// Dense continuous-time recheck. Because both curves are linear on each
// original interval, the true maximum is at a key; this samples `subdivisions`
// interior points per interval, so any disagreement would expose the claim as
// false. It is evidence, not the definition of the algorithm.
export function continuousError(times, values, dim, keptIndices, subdivisions = 4) {
  validateTrack(times, values, dim);
  if (!Number.isInteger(subdivisions) || subdivisions < 1) throw new Error("subdivisions must be >= 1");
  let maxError = 0;
  let samples = 0;
  let worst = null;
  for (let k = 0; k + 1 < times.length; k++) {
    for (let s = 0; s <= subdivisions; s++) {
      const t = k + 1 < times.length && s === subdivisions
        ? times[k + 1]
        : lerp(times[k], times[k + 1], s / subdivisions);
      const e = errorAt(times, values, dim, keptIndices, t);
      samples++;
      if (e > maxError) {
        maxError = e;
        worst = { interval: k, subdivision: s, t, error: e };
      }
    }
  }
  return { maxError, samples, worst, linearSegmentArgument: true };
}

export function planHash(plans) {
  let h = 0x811c9dc5;
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const p of plans) {
    feed(`${p.trackName ?? ""}|${p.dim}|${p.tolerance.toPrecision(12)}|`);
    feed(p.keptIndices.join(","));
    feed(";");
  }
  return h.toString(16).padStart(8, "0");
}

export function summarizePlans(plans) {
  let inputKeys = 0;
  let outputKeys = 0;
  let maxError = 0;
  let worst = null;
  for (const p of plans) {
    inputKeys += p.inputKeys;
    outputKeys += p.outputKeys;
    if (p.maxError > maxError) {
      maxError = p.maxError;
      worst = { trackName: p.trackName, ...p.worst };
    }
  }
  return {
    tracks: plans.length,
    inputKeys,
    outputKeys,
    reductionPct: inputKeys === 0 ? 0 : (1 - outputKeys / inputKeys) * 100,
    maxError,
    worst,
  };
}

// Independent of the DP: given an exact key count, turn it into a deterministic
// list of plan objects (used by the browser panel and by verify's baseline
// comparison). It does not claim optimality.
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
  // Rounding can drop slots; fill deterministically if needed.
  let cursor = 1;
  while (out.length < targetCount) {
    if (!out.includes(cursor)) {
      out.push(cursor);
      out.sort((a, b) => a - b);
    }
    cursor++;
  }
  return out;
}
