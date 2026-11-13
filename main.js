import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  simplifyTrack,
  summarizePlans,
  planHash,
  continuousError,
  evalPlanAt,
} from "./src/core.mjs";
import { uniformAtCount } from "./baseline/uniform.mjs";

const $ = (id) => document.getElementById(id);
const motion = await fetch("./data/motion.json").then((r) => {
  if (!r.ok) throw new Error(`data/motion.json: HTTP ${r.status}`);
  return r.json();
});
const reference = await fetch("./data/reference.json").then((r) => {
  if (!r.ok) throw new Error(`data/reference.json: HTTP ${r.status}`);
  return r.json();
});

const stage = $("stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070a10);
scene.fog = new THREE.Fog(0x070a10, 15, 30);
const camera = new THREE.PerspectiveCamera(44, stage.clientWidth / stage.clientHeight, 0.05, 100);
camera.position.set(7.6, 5.4, 8.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxDistance = 24;
controls.minDistance = 2;

scene.add(new THREE.HemisphereLight(0x9ecbff, 0x10151d, 1.2));
const grid = new THREE.GridHelper(16, 32, 0x1b2a3c, 0x101a27);
grid.position.y = -1.6;
scene.add(grid);
const axes = new THREE.AxesHelper(2.2);
axes.position.y = -1.59;
scene.add(axes);

const COLORS = [0x37e0d0, 0x7ee787, 0xffbf5a, 0xff7ab6, 0x7aa2ff, 0xff9f6e];
const DURATION = motion.tracks[0].times.at(-1);
const trackGroups = [];
const markers = [];
const clock = new THREE.Clock();

function plotPoint(track, t, values, dim, trackIndex) {
  if (dim === 3) return new THREE.Vector3(values[0], values[1], values[2]);
  const u = (t - track.times[0]) / (track.times.at(-1) - track.times[0]);
  return new THREE.Vector3(-4.2 + 8.4 * u, 0.65 + 0.9 * values[0], -3.2 + trackIndex * 0.55);
}

function positionsFor(track, indices, trackIndex) {
  const arr = new Float32Array(indices.length * 3);
  for (let q = 0; q < indices.length; q++) {
    const idx = indices[q];
    const vals = track.values.slice(idx * track.dim, idx * track.dim + track.dim);
    const p = plotPoint(track, track.times[idx], vals, track.dim, trackIndex);
    arr[q * 3] = p.x;
    arr[q * 3 + 1] = p.y;
    arr[q * 3 + 2] = p.z;
  }
  return arr;
}

function lineFrom(points, color, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(points, 3));
  const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false });
  return new THREE.Line(g, m);
}

let currentPlans = [];
let scheduled = 0;

function update(tol) {
  $("tolValue").textContent = tol.toFixed(3);
  const plans = motion.tracks.map((t) => {
    const p = simplifyTrack(t.times, t.values, t.dim, tol);
    p.trackName = t.name;
    return p;
  });
  const summary = summarizePlans(plans);
  const hash = planHash(plans);
  const worst = summary.worst;

  let denseDelta = 0;
  for (const p of plans) {
    const t = motion.tracks.find((q) => q.name === p.trackName);
    const dense = continuousError(t.times, t.values, t.dim, p.keptIndices, 3);
    denseDelta = Math.max(denseDelta, dense.maxError - p.maxError);
  }

  let violations = 0;
  let worstRatio = 0;
  for (const p of plans) {
    const t = motion.tracks.find((q) => q.name === p.trackName);
    const u = uniformAtCount(t.times, t.values, t.dim, p.outputKeys);
    const ratio = u.maxError / tol;
    if (ratio > 1) violations++;
    worstRatio = Math.max(worstRatio, ratio);
  }

  $("inKeys").textContent = summary.inputKeys;
  $("outKeys").textContent = summary.outputKeys;
  $("reduction").textContent = `${summary.reductionPct.toFixed(2)}% fewer`;
  $("bar").style.width = `${summary.reductionPct.toFixed(2)}%`;
  $("maxError").textContent = summary.maxError.toExponential(4);
  $("worstTrack").textContent = worst?.trackName ?? "—";
  $("hash").textContent = hash;
  $("dense").textContent = `Δ ${Math.max(0, denseDelta).toExponential(1)}`;
  $("violations").textContent = `${violations} / ${plans.length}`;
  $("worstRatio").textContent = `${worstRatio.toFixed(3)}× tol`;
  $("uniformNote").textContent = violations === plans.length
    ? "Uniform sampling at the same key count fails the tolerance on every track. The DP keeps the non-uniform bends instead."
    : `Uniform sampling at the same key count fails the tolerance on ${violations}/${plans.length} tracks; the worst is ${worstRatio.toFixed(2)}× the allowed error. One near-uniform circular track is a fair loss for this baseline.`;

  const atReference = Math.abs(tol - reference.tolerance) < 1e-12;
  if (atReference && hash === reference.planHash) {
    $("status").className = "badge";
    $("statusText").textContent = `NODE REFERENCE MATCH · ${hash}`;
    $("parity").textContent = `Live browser plan hash ${hash} equals the node-baked reference. ${summary.outputKeys} keys, max error ${summary.maxError.toExponential(4)}.`;
  } else if (atReference) {
    $("status").className = "badge warn";
    $("statusText").textContent = "HASH MISMATCH";
    $("parity").textContent = `Browser ${hash} != node reference ${reference.planHash}. This must be treated as a failure, not hidden.`;
  } else {
    $("status").className = "badge warn";
    $("statusText").textContent = `LIVE · ${hash}`;
    $("parity").textContent = `Live plan at tolerance ${tol.toFixed(3)}. Reference-only parity is checked at 0.010 (${reference.planHash}).`;
  }

  // Rebuild candidate geometry, preserving the grey source lines.
  for (let i = 0; i < trackGroups.length; i++) {
    const g = trackGroups[i];
    if (g.candidate) {
      g.candidate.geometry.dispose();
      g.candidate.material.dispose();
      scene.remove(g.candidate);
    }
    if (g.keyPoints) {
      g.keyPoints.geometry.dispose();
      g.keyPoints.material.dispose();
      scene.remove(g.keyPoints);
    }
    const track = motion.tracks[i];
    const p = plans[i];
    const pts = positionsFor(track, p.keptIndices, i);
    g.candidate = lineFrom(pts, COLORS[i % COLORS.length], 1);
    g.candidate.renderOrder = 3;
    scene.add(g.candidate);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    g.keyPoints = new THREE.Points(pg, new THREE.PointsMaterial({
      color: COLORS[i % COLORS.length], size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.9,
    }));
    scene.add(g.keyPoints);
  }
  currentPlans = plans;
}

function buildScene() {
  for (let i = 0; i < motion.tracks.length; i++) {
    const track = motion.tracks[i];
    const all = Array.from({ length: track.times.length }, (_, q) => q);
    const src = lineFrom(positionsFor(track, all, i), 0x26364a, 0.65);
    src.renderOrder = 1;
    scene.add(src);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(track.dim === 3 ? 0.075 : 0.055, 12, 10),
      new THREE.MeshBasicMaterial({ color: COLORS[i % COLORS.length] }),
    );
    marker.renderOrder = 5;
    scene.add(marker);
    markers.push(marker);
    trackGroups.push({ source: src, marker });

    const item = document.createElement("span");
    item.innerHTML = `<i style="background:#${COLORS[i].toString(16).padStart(6, "0")}"></i>${track.name}`;
    $("legend").appendChild(item);
  }
  update(Number($("tol").value));
}

function loop() {
  requestAnimationFrame(loop);
  const u = (clock.getElapsedTime() % DURATION) / DURATION;
  for (let i = 0; i < motion.tracks.length; i++) {
    const track = motion.tracks[i];
    const p = currentPlans[i];
    if (!p) continue;
    const t = track.times[0] + u * DURATION;
    const vals = evalPlanAt(track.times, track.values, track.dim, p.keptIndices, t);
    markers[i].position.copy(plotPoint(track, t, vals, track.dim, i));
  }
  controls.update();
  renderer.render(scene, camera);
}

$("tol").addEventListener("input", (e) => {
  const v = e.target.valueAsNumber;
  $("tolValue").textContent = v.toFixed(3);
  if (scheduled) cancelAnimationFrame(scheduled);
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    update(v);
  });
});

addEventListener("resize", () => {
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(stage.clientWidth, stage.clientHeight);
});

buildScene();
loop();
