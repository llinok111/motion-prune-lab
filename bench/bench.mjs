#!/usr/bin/env node
// Timing: cold first run once, warmup once, then 7 full-dataset runs.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { simplifyTrack, summarizePlans, planHash } from "../src/core.mjs";
import { uniformAtCount, uniformPlan } from "../baseline/uniform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const data = JSON.parse(readFileSync(join(root, "data/motion.json"), "utf8"));
const TOL = 0.01;

function runAll() {
  return data.tracks.map((t) => {
    const p = simplifyTrack(t.times, t.values, t.dim, TOL);
    p.trackName = t.name;
    return p;
  });
}

function timed() {
  const t0 = performance.now();
  const plans = runAll();
  return { ms: performance.now() - t0, plans };
}

const cold = timed();
timed(); // warmup
const samples = [];
for (let i = 0; i < 7; i++) samples.push(timed());

const plans = samples.at(-1).plans;

// Cost of the independent uniform baseline at the same per-track key counts.
function uniformRun() {
  return data.tracks.map((t, i) => uniformAtCount(t.times, t.values, t.dim, plans[i].outputKeys));
}
const uniformCold = (() => {
  const t0 = performance.now();
  uniformRun();
  return performance.now() - t0;
})();
uniformRun(); // warmup
const uniformSamples = [];
for (let i = 0; i < 7; i++) {
  const t0 = performance.now();
  uniformRun();
  uniformSamples.push(performance.now() - t0);
}
const uniformSorted = [...uniformSamples].sort((a, b) => a - b);
const uniformMedian = uniformSorted[Math.floor(uniformSorted.length / 2)];
const uniformMean = uniformSamples.reduce((s, x) => s + x, 0) / uniformSamples.length;
const uniformStd = Math.sqrt(uniformSamples.reduce((s, x) => s + (x - uniformMean) ** 2, 0) / uniformSamples.length);
const summary = summarizePlans(plans);
const times = samples.map((s) => s.ms).sort((a, b) => a - b);
const n = times.length;
const median = n % 2 ? times[(n - 1) / 2] : (times[n / 2 - 1] + times[n / 2]) / 2;
const mean = times.reduce((s, x) => s + x, 0) / n;
const variance = times.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
const stddev = Math.sqrt(variance);
const pct = (q) => times[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];

const uniformSame = plans.map((p) => {
  const t = data.tracks.find((q) => q.name === p.trackName);
  const u = uniformAtCount(t.times, t.values, t.dim, p.outputKeys);
  return { name: p.trackName, outputKeys: p.outputKeys, maxError: u.maxError, ratioToTolerance: u.maxError / TOL };
});
const uniformTol = data.tracks.map((t) => {
  const u = uniformPlan(t.times, t.values, t.dim, TOL);
  return { name: t.name, outputKeys: u.outputKeys, maxError: u.maxError };
});

const result = {
  schema: "motion-prune-lab/bench/1",
  generatedAt: new Date().toISOString(),
  node: process.version,
  tolerance: TOL,
  dataset: {
    tracks: data.tracks.length,
    keysPerTrack: data.keyframesPerTrack,
    inputKeys: summary.inputKeys,
  },
  plans: plans.map((p) => ({
    name: p.trackName,
    dim: p.dim,
    inputKeys: p.inputKeys,
    outputKeys: p.outputKeys,
    maxError: p.maxError,
    worst: p.worst,
  })),
  summary,
  planHash: planHash(plans),
  uniformSameCount: uniformSame,
  uniformSameCountViolations: uniformSame.filter((u) => u.ratioToTolerance > 1).length,
  worstUniformRatioToTolerance: Math.max(...uniformSame.map((u) => u.ratioToTolerance)),
  uniformToTolerance: uniformTol,
  timing: {
    unit: "ms",
    sampleCount: n,
    coldMs: cold.ms,
    warmupRuns: 1,
    samples: samples.map((s) => s.ms),
    min: times[0],
    median,
    p25: pct(0.25),
    p75: pct(0.75),
    p95: pct(0.95),
    stddev,
    relativeStddevPct: (stddev / mean) * 100,
    mean,
    note: "one sample = simplifyTrack over all 6 tracks at tolerance 0.01",
  },
  uniformTiming: {
    unit: "ms",
    sampleCount: 7,
    coldMs: uniformCold,
    samples: uniformSamples,
    median: uniformMedian,
    relativeStddevPct: (uniformStd / uniformMean) * 100,
    note: "independent uniform baseline at the same per-track key counts; it is much cheaper but fails the tolerance on 5/6 tracks",
  },
};
writeFileSync(join(root, "bench/result.json"), JSON.stringify(result, null, 2) + "\n");

console.log(`cold ${cold.ms.toFixed(3)} ms; warmup 1; samples ${n}`);
console.log(`median ${median.toFixed(3)} ms  p95 ${pct(0.95).toFixed(3)} ms  RSD ${result.timing.relativeStddevPct.toFixed(2)}%`);
console.log(`keys ${summary.inputKeys} -> ${summary.outputKeys} (${summary.reductionPct.toFixed(2)}% fewer), maxError ${summary.maxError.toExponential(4)}`);
console.log(`uniform same-count violations ${result.uniformSameCountViolations}/6, worst ${result.worstUniformRatioToTolerance.toFixed(3)}x tolerance`);
console.log(`uniform baseline median ${uniformMedian.toFixed(3)} ms (same key counts, ${result.uniformSameCountViolations}/6 violate tolerance)`);
console.log(`wrote bench/result.json; planHash ${result.planHash}`);
