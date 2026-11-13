# Motion Prune Lab

**Promise:** prune **1,542** translation / scale / morph-weight keyframes to **414** (**73.15% fewer**) while every reconstructed sample stays within **0.010** world units; an independent uniform baseline given the *same* 414-key payload violates that tolerance on **5 / 6** tracks, worst **10.89×** the allowed error.

Upstream: none

Most glTF animation exporters bake every frame. Resampling and "decimate" tools usually reduce keys with a heuristic and report a visual result, not a verified error. This lab does the narrow, verifiable thing: for a piecewise-linear track it computes the **global minimum keyframe count** among endpoint-preserving subsets, and returns a certificate that the *continuous* playback error is below the requested tolerance. The browser runs the same `src/core.mjs` as node and compares its live plan hash with the node-baked `data/reference.json`.

## Run

```bash
node tools/gen-sample.mjs      # deterministic data (6 tracks × 257 keys)
node bench/verify.mjs          # 70 assertions, independent oracle, exit 1 on failure
node bench/bench.mjs           # cold + warmup + 7 samples -> bench/result.json
python3 -m http.server 4173     # then open http://127.0.0.1:4173/
```

No install step. The page pins `three@0.169.0` via an import map from jsDelivr; the 3D view is optional — all evidence is produced by the node commands above.

## Why the result is exact

Let `f(t)` be the source track (linear between every original key) and `g(t)` the candidate (linear between the kept subset). On each original time interval both are linear, so `f(t) - g(t)` is linear and its Euclidean norm is convex. A convex function on a closed interval takes its maximum at an endpoint, therefore

> maximum error over continuous time = maximum error at the original key times.

`continuousError()` still samples 6 interior points per interval (1,792 samples per track) and reports the maximum; in this dataset the dense maximum equals the key maximum to the last printed digit for 6/6 tracks. `bench/verify.mjs` also brute-forces all endpoint-preserving subsets for 12 small tracks × 4 tolerances = 48 cases: the DP's key count matches the exact minimum in **48/48** cases.

The DP is deliberately not a new algorithm: minimum-link / keyframe-subset DP is textbook. What is packaged here is the glTF-track use case, the continuous-time certificate, the independent uniform baseline, and the node↔browser plan hash.

## Evidence

`bench/result.json` is the raw record; the table below is copied from it.

| track | input | DP keys | DP max error | uniform @ same keys | uniform / tolerance |
|---|---:|---:|---:|---:|---:|
| root-figure8 | 257 | 222 | 9.9166e-3 | 4.1632e-2 | 4.16× |
| hand-swing | 257 | 99 | 9.8098e-3 | 1.8043e-2 | 1.80× |
| camera-dolly | 257 | 17 | 9.6270e-3 | 1.8470e-2 | 1.85× |
| loop-orbit | 257 | 30 | 9.2628e-3 | 9.2813e-3 | 0.93× |
| impact-decay | 257 | 31 | 9.6486e-3 | 1.0891e-1 | 10.89× |
| morph-weight | 257 | 15 | 9.8422e-3 | 8.8487e-2 | 8.85× |
| **total** | **1,542** | **414** | **9.9166e-3** | — | **5/6 violate** |

`loop-orbit` is an honest loss for the baseline: a constant-speed circle is nearly uniform, so uniform sampling at 30 keys happens to stay inside 0.010. We report that instead of hiding it. `root-figure8` keeps 222 keys because the generated root track has 0.035-amplitude deterministic jitter; that is a hard track, not a failed compression.

Other measured facts:

- `bench/verify.mjs`: **70 passed / 0 failed**, exit 0. It checks reference equality, per-track error ≤ tolerance, dense continuous recheck, 48 brute-force optimality cases, 5 scales × 6 tracks of plan invariance (`1e-6 … 1e6` with tolerance scaled proportionally), loop seam, constant/linear edge cases, invalid-input rejection, and core purity.
- Generator determinism: running `node tools/gen-sample.mjs` twice gives byte-identical `data/motion.json` and `data/reference.json` (checked with `sha256sum -c`), plan hash `87a1c3e6`.
- Timing (cold + 1 warmup + 7 samples, one sample = all 6 tracks at tolerance 0.01): DP median **129.726 ms**, p95 **142.391 ms**, cold **137.439 ms**, RSD **3.35%**. The independent uniform baseline at the same key counts is **0.203 ms** median (RSD **37.1%**, sub-millisecond clock noise) — **the DP is 638× slower**. No speed advantage is claimed; this is a build-time optimization cost.
- No `three` / DOM import in `src/core.mjs`; `node -e "import('./src/core.mjs')"` succeeds.

## 本轮创新

**B 档。** 把「端点保持的全局最小关键帧数 DP」用在 glTF translation / scale / morph-weight 轨道上，并把「连续时间最大误差 == 原关键帧最大误差」写成可复算的证书；浏览器拖动容差时用同一个 `src/core.mjs` 现场重算关键帧数、误差和 FNV 计划哈希，在默认容差下必须与 node 烘焙值逐位相等。与 glTF-Transform 的 `resample`、Blender 的 decimate 等启发式不同，这里给出的是该模型下可被暴力枚举复核的最小关键帧数，而不是「看起来差不多」；我们**不声称发明 DP**，只声称这个组合与证书此前没有在本团队/该场景落地。台账中最近的动画相关条目只涉及 SVG 关键帧时间线，不涉及 glTF 平移轨道或最优关键帧数。

## Known limitations

- **Translation / scale / morph weights only.** Quaternion rotation tracks are deliberately rejected: slerp is nonlinear between keys, so the linear-difference proof does not apply. Do not feed rotation tracks into this core.
- **Absolute tolerance.** The effective measured range is 1e-6 … 1e6 with tolerance scaled by the same factor; below that the `1e-15` numerical slack used in the DP comparison can change borderline decisions. Tolerance is in the track's own units.
- **Exact for this model only.** "Minimum" means minimum number of *original* keys retained, with straight-segment reconstruction and both endpoints kept. It does not search new key positions, Bezier segments, quaternion slerp, or curve fitting.
- **O(n³) DP.** Measured at 257 keys/track; a few hundred keys is the intended range. Thousands of keys per track will be slow and should use a windowed approximation, which would no longer be globally exact.
- **No glTF parser.** The dataset is a glTF-shaped JSON schema with raw time/value arrays. A real `.gltf` importer is an adapter, not included or claimed.
- **Browser evidence is static.** The page starts with HTTP 200 and a pinned import map, and its JS calls the same core. No browser automation or GPU screenshot is used, so the 3D rendering itself is not claimed as pixel-verified.
- **Loop seam is position-only.** Endpoints are forced equal for the loop track; derivative/C1 continuity across the seam is not certified.

## Layout

```
index.html            import map + UI
main.js               three.js scene, orbit controls, live core calls
src/core.mjs          pure DP, certificate, hashing (no three/DOM/IO)
baseline/uniform.mjs  independent uniform baseline (no core import)
tools/gen-sample.mjs  deterministic 6-track dataset + reference
bench/verify.mjs      70 assertions + brute-force oracle
bench/bench.mjs       cold + 7-sample timing
bench/result.json     measured numbers
```

MIT © 2026 llinok111.
