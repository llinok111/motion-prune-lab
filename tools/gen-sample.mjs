#!/usr/bin/env node
// Deterministic sample generator. Same command -> byte-identical data/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simplifyTrack, summarizePlans, planHash } from "../src/core.mjs";
import { uniformAtCount, uniformPlan } from "../baseline/uniform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "data");
mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const rng = mulberry32(0x5eedc0de);
const n = 257;
const fps = 30;
const times = Array.from({ length: n }, (_, i) => i / fps);

function round12(x) {
  return Number(x.toFixed(12));
}

const specs = [
  {
    name: "root-figure8",
    dim: 3,
    path: "translation",
    note: "smooth figure-eight root motion used by a looping character",
    fn: (u) => [
      2.0 * Math.sin(2 * Math.PI * u) + 0.035 * (rng() - 0.5),
      0.12 + 0.18 * Math.sin(4 * Math.PI * u) + 0.02 * (rng() - 0.5),
      1.1 * Math.sin(4 * Math.PI * u) + 0.035 * (rng() - 0.5),
    ],
  },
  {
    name: "hand-swing",
    dim: 3,
    path: "translation",
    note: "fast secondary motion with three incommensurate frequencies",
    fn: (u) => [
      0.32 * Math.sin(2 * Math.PI * 6 * u) + 0.012 * (rng() - 0.5),
      0.16 * Math.cos(2 * Math.PI * 6 * u) + 0.008 * (rng() - 0.5),
      0.10 * Math.sin(2 * Math.PI * 10 * u) + 0.012 * (rng() - 0.5),
    ],
  },
  {
    name: "camera-dolly",
    dim: 3,
    path: "translation",
    note: "mostly linear camera move plus a small vertical float",
    fn: (u) => [
      3.0 * u - 1.5,
      1.4 + 0.09 * Math.sin(2 * Math.PI * 2 * u) + 0.015 * (rng() - 0.5),
      1.0 - 0.6 * u + 0.025 * Math.sin(2 * Math.PI * 3 * u),
    ],
  },
  {
    name: "loop-orbit",
    dim: 3,
    path: "translation",
    note: "closed orbit; endpoints are forced equal so loop seam is explicit",
    fn: (u) => [
      1.5 * Math.cos(2 * Math.PI * u),
      0.25 * Math.sin(2 * Math.PI * u) + 0.025 * Math.sin(6 * Math.PI * u),
      1.5 * Math.sin(2 * Math.PI * u),
    ],
  },
  {
    name: "impact-decay",
    dim: 1,
    path: "weights",
    note: "damped impact morph weight; high curvature near t=0",
    fn: (u) => [Math.exp(-3.6 * u) * Math.sin(10 * Math.PI * u) * 0.6
      + 0.08 * Math.exp(-7 * u) * Math.sin(23 * Math.PI * u)],
  },
  {
    name: "morph-weight",
    dim: 1,
    path: "weights",
    note: "piecewise smoothstep blend with deterministic sensor jitter",
    fn: (u) => [0.10 + 0.72 * smoothstep(0.12, 0.30, u)
      - 0.46 * smoothstep(0.45, 0.55, u)
      + 0.30 * smoothstep(0.72, 0.90, u)
      + 0.004 * (rng() - 0.5)],
  },
];

const tracks = specs.map((spec) => {
  const values = [];
  for (let i = 0; i < n; i++) {
    const v = spec.fn(i / (n - 1));
    for (let d = 0; d < spec.dim; d++) values.push(round12(v[d]));
  }
  if (spec.name === "loop-orbit") {
    for (let d = 0; d < spec.dim; d++) values[(n - 1) * spec.dim + d] = values[d];
  }
  return { name: spec.name, dim: spec.dim, path: spec.path, note: spec.note, times, values };
});

const dataset = {
  schema: "motion-prune-lab/1",
  generatedBy: "node tools/gen-sample.mjs",
  deterministicSeed: "0x5eedc0de",
  fps,
  keyframesPerTrack: n,
  tracks,
};
const motionPath = join(outDir, "motion.json");
writeFileSync(motionPath, JSON.stringify(dataset) + "\n");

const tolerance = 0.01;
const plans = dataset.tracks.map((t) => ({
  ...simplifyTrack(t.times, t.values, t.dim, tolerance),
  trackName: t.name,
}));
const uniformSame = plans.map((p) => {
  const t = dataset.tracks.find((q) => q.name === p.trackName);
  return { trackName: p.trackName, ...uniformAtCount(t.times, t.values, t.dim, p.outputKeys) };
});
const uniformTol = dataset.tracks.map((t) => ({
  ...uniformPlan(t.times, t.values, t.dim, tolerance),
  trackName: t.name,
}));

const sweep = [0.002, 0.005, 0.01, 0.02, 0.05].map((tol) => {
  const ps = dataset.tracks.map((t) => ({
    ...simplifyTrack(t.times, t.values, t.dim, tol),
    trackName: t.name,
  }));
  return { tolerance: tol, plans: ps.map((p) => ({ trackName: p.trackName, outputKeys: p.outputKeys, maxError: p.maxError })) };
});

const reference = {
  schema: "motion-prune-lab/ref/1",
  tolerance,
  generatedBy: "node tools/gen-sample.mjs",
  planHash: planHash(plans),
  summary: summarizePlans(plans),
  tracks: plans.map((p) => ({
    name: p.trackName,
    dim: p.dim,
    inputKeys: p.inputKeys,
    outputKeys: p.outputKeys,
    keptIndices: p.keptIndices,
    maxError: p.maxError,
    worst: p.worst,
    uniformSameCount: uniformSame.find((q) => q.trackName === p.trackName),
    uniformTolerance: {
      outputKeys: uniformTol.find((q) => q.trackName === p.trackName).outputKeys,
      maxError: uniformTol.find((q) => q.trackName === p.trackName).maxError,
    },
  })),
  sweep,
};
writeFileSync(join(outDir, "reference.json"), JSON.stringify(reference, null, 2) + "\n");

console.log(`motion.json: ${dataset.tracks.length} tracks x ${n} keys`);
for (const p of plans) {
  const us = uniformSame.find((q) => q.trackName === p.trackName);
  console.log(`${p.trackName.padEnd(14)} ${p.inputKeys} -> ${p.outputKeys} keys, max err ${p.maxError.toExponential(3)}, uniform@same ${us.maxError.toExponential(3)}`);
}
console.log(`planHash=${reference.planHash} summaryMaxError=${reference.summary.maxError.toExponential(3)}`);
