#!/usr/bin/env node
// Real assertions on the generated dataset, the DP, and an independent oracle.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  simplifyTrack,
  evaluatePlan,
  continuousError,
  planHash,
  summarizePlans,
  evalPlanAt,
  uniformIndices,
} from "../src/core.mjs";
import { planError, uniformAtCount, uniformPlan } from "../baseline/uniform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const data = JSON.parse(readFileSync(join(root, "data/motion.json"), "utf8"));
const ref = JSON.parse(readFileSync(join(root, "data/reference.json"), "utf8"));
const TOL = 0.01;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}  ${detail}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}
function close(a, b, rel = 1e-11, abs = 1e-15) {
  return Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b));
}
function popcount(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

// --- dataset shape ---------------------------------------------------------
check("dataset.tracks", data.tracks.length === 6, `tracks=${data.tracks.length}`);
check("dataset.keys", data.keyframesPerTrack === 257, `n=${data.keyframesPerTrack}`);
check("dataset.fps", data.fps === 30, `fps=${data.fps}`);
check("dataset.totalKeys", data.tracks.reduce((s, t) => s + t.times.length, 0) === 1542,
  `total=${data.tracks.reduce((s, t) => s + t.times.length, 0)}`);

// --- plans and reference ---------------------------------------------------
const plans = data.tracks.map((t) => {
  const p = simplifyTrack(t.times, t.values, t.dim, TOL);
  p.trackName = t.name;
  return p;
});
const summary = summarizePlans(plans);
const rehash = planHash(plans);
check("planHash.matchesReference", rehash === ref.planHash, `node=${rehash} ref=${ref.planHash}`);
check("summary.outputKeys", summary.outputKeys === ref.summary.outputKeys,
  `node=${summary.outputKeys} ref=${ref.summary.outputKeys}`);
check("summary.inputKeys", summary.inputKeys === 1542, `input=${summary.inputKeys}`);
check("summary.reductionPct", close(summary.reductionPct, ref.summary.reductionPct, 1e-12),
  `node=${summary.reductionPct.toFixed(6)}% ref=${ref.summary.reductionPct.toFixed(6)}%`);
check("summary.maxError", close(summary.maxError, ref.summary.maxError, 1e-12),
  `node=${summary.maxError.toExponential(6)} ref=${ref.summary.maxError.toExponential(6)}`);

let certified = 0;
let uniformViolations = 0;
let maxUniformRatio = 0;
let worstUniformTrack = "";
for (const p of plans) {
  const t = data.tracks.find((q) => q.name === p.trackName);
  const r = ref.tracks.find((q) => q.name === p.trackName);
  check(`${p.trackName}.endpoints`, p.keptIndices[0] === 0 && p.keptIndices.at(-1) === t.values.length / t.dim - 1,
    `kept=${p.keptIndices[0]}..${p.keptIndices.at(-1)}`);
  check(`${p.trackName}.errorWithinTolerance`, p.maxError <= TOL + 1e-15,
    `maxError=${p.maxError.toExponential(6)} tol=${TOL}`);
  check(`${p.trackName}.countMatchesReference`, p.outputKeys === r.outputKeys,
    `node=${p.outputKeys} ref=${r.outputKeys}`);
  check(`${p.trackName}.errorMatchesReference`, close(p.maxError, r.maxError, 1e-12),
    `node=${p.maxError.toExponential(6)} ref=${r.maxError.toExponential(6)}`);
  check(`${p.trackName}.keptIndicesMatchReference`,
    JSON.stringify(p.keptIndices) === JSON.stringify(r.keptIndices),
    `len=${p.keptIndices.length}`);

  const dense = continuousError(t.times, t.values, t.dim, p.keptIndices, 6);
  check(`${p.trackName}.continuousMatchesKeys`, dense.maxError <= p.maxError + 1e-15,
    `dense=${dense.maxError.toExponential(6)} keys=${p.maxError.toExponential(6)} samples=${dense.samples}`);
  if (dense.maxError <= TOL + 1e-15) certified++;

  const u = uniformAtCount(t.times, t.values, t.dim, p.outputKeys);
  const ratio = u.maxError / TOL;
  if (ratio > 1) uniformViolations++;
  if (ratio > maxUniformRatio) {
    maxUniformRatio = ratio;
    worstUniformTrack = p.trackName;
  }
  check(`${p.trackName}.uniformAtSameCountWorse`, u.maxError > p.maxError,
    `uniform=${u.maxError.toExponential(6)} dp=${p.maxError.toExponential(6)} keys=${p.outputKeys}`);

  const ut = uniformPlan(t.times, t.values, t.dim, TOL);
  check(`${p.trackName}.uniformMinKeysNotBetter`, ut.outputKeys >= p.outputKeys,
    `uniform=${ut.outputKeys} dp=${p.outputKeys}`);
}

check("certificate.continuousAllWithinTolerance", certified === 6, `certified=${certified}/6`);
check("uniform.sameCountViolations", uniformViolations >= 5,
  `violations=${uniformViolations}/6, worst=${worstUniformTrack} ${maxUniformRatio.toFixed(3)}x tol`);
check("uniform.worstRatio", maxUniformRatio > 5,
  `max=${maxUniformRatio.toFixed(3)}x tolerance (${worstUniformTrack})`);

// --- independent brute-force optimality oracle -----------------------------
function smallTrack(seed, n, dim) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const times = Array.from({ length: n }, (_, i) => i / 7);
  const vals = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    for (let d = 0; d < dim; d++) {
      vals.push(Math.sin(2 * Math.PI * (d + 1) * u) * (0.4 + 0.1 * d) + 0.18 * (rnd() - 0.5));
    }
  }
  return { times, values: vals, dim };
}

function bruteForceMinKeys(times, values, dim, tol) {
  const n = times.length;
  const lastBit = 1 << (n - 1);
  let best = n;
  for (let mask = 0; mask < (1 << n); mask++) {
    if ((mask & 1) === 0 || (mask & lastBit) === 0) continue;
    const count = popcount(mask);
    if (count >= best) continue;
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    if (planError(times, values, dim, idx) <= tol) best = count;
  }
  return best;
}

let oracleChecks = 0;
let oracleMismatch = 0;
const tolerances = [0.01, 0.03, 0.08, 0.15];
for (let seed = 1; seed <= 12; seed++) {
  const dim = (seed % 3) + 1;
  const t = smallTrack(seed, 10, dim);
  for (const tol of tolerances) {
    const dp = simplifyTrack(t.times, t.values, t.dim, tol);
    const oracle = bruteForceMinKeys(t.times, t.values, t.dim, tol);
    oracleChecks++;
    if (dp.outputKeys !== oracle) {
      oracleMismatch++;
      console.log(`FAIL  bruteForce seed=${seed} dim=${dim} tol=${tol} dp=${dp.outputKeys} oracle=${oracle}`);
    }
  }
}
check("optimality.bruteForce", oracleMismatch === 0, `${oracleChecks - oracleMismatch}/${oracleChecks} exact min-count matches`);

// --- exact edge cases ------------------------------------------------------
const constTimes = [0, 0.5, 1, 1.5, 2];
const constVals = [3, 3, 3, 3, 3];
const constPlan = simplifyTrack(constTimes, constVals, 1, 0);
check("edge.constantTrack", constPlan.outputKeys === 2 && constPlan.maxError === 0,
  `keys=${constPlan.outputKeys} err=${constPlan.maxError}`);
const linTimes = [0, 1, 2, 3, 4];
const linVals = [0, 2, 4, 6, 8];
const linPlan = simplifyTrack(linTimes, linVals, 1, 0);
check("edge.linearTrack", linPlan.outputKeys === 2 && linPlan.maxError === 0,
  `keys=${linPlan.outputKeys} err=${linPlan.maxError}`);

let threw = 0;
for (const fn of [
  () => simplifyTrack([0, 1, 1], [0, 1, 2], 1, 0.1),
  () => simplifyTrack([0, 1], [0, 1], 5, 0.1),
  () => simplifyTrack([0, 1], [0], 1, 0.1),
  () => simplifyTrack([0, 1], [0, 1], 1, -1),
]) {
  try { fn(); } catch { threw++; }
}
check("edge.invalidInputsThrow", threw === 4, `threw=${threw}/4`);

// --- scale invariance ------------------------------------------------------
let scaleBad = 0;
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
for (const t of data.tracks) {
  const base = simplifyTrack(t.times, t.values, t.dim, TOL);
  for (const s of scales) {
    const scaled = t.values.map((v) => v * s);
    const p = simplifyTrack(t.times, scaled, t.dim, TOL * s);
    if (JSON.stringify(p.keptIndices) !== JSON.stringify(base.keptIndices)) scaleBad++;
  }
}
check("scaleInvariance.planIndices", scaleBad === 0, `bad=${scaleBad}, scales=${scales.length} x tracks=${data.tracks.length}`);

// --- loop seam -------------------------------------------------------------
const loop = data.tracks.find((t) => t.name === "loop-orbit");
let seamMax = 0;
for (let d = 0; d < loop.dim; d++) seamMax = Math.max(seamMax, Math.abs(loop.values[d] - loop.values[(loop.times.length - 1) * loop.dim + d]));
check("loop.seamClosed", seamMax === 0, `max endpoint delta=${seamMax}`);
const loopPlan = plans.find((p) => p.trackName === "loop-orbit");
const p0 = evalPlanAt(loop.times, loop.values, loop.dim, loopPlan.keptIndices, 0);
const p1 = evalPlanAt(loop.times, loop.values, loop.dim, loopPlan.keptIndices, loop.times.at(-1));
let endDelta = 0;
for (let d = 0; d < loop.dim; d++) endDelta = Math.max(endDelta, Math.abs(p0[d] - p1[d]));
check("loop.planEndpointsEqual", endDelta === 0, `max eval delta=${endDelta}`);

// --- determinism / core purity --------------------------------------------
const again = simplifyTrack(data.tracks[0].times, data.tracks[0].values, data.tracks[0].dim, TOL);
check("determinism.samePlan", JSON.stringify(again.keptIndices) === JSON.stringify(plans[0].keptIndices),
  `hash=${planHash([{ ...again, trackName: data.tracks[0].name }])}`);
const coreText = readFileSync(join(root, "src/core.mjs"), "utf8");
check("purity.noBrowserOrThree", !/\b(three|window|document|navigator|requestAnimationFrame)\b/.test(
  coreText.replace(/^\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
), "no forbidden tokens outside comments");
check("uniformIndices.valid", JSON.stringify(uniformIndices(5, 3)) === JSON.stringify([0, 2, 4]),
  `got=${JSON.stringify(uniformIndices(5, 3))}`);

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
