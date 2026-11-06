# Dynamic SDK game probe

This development probe compiles `examples/m3-dynamic-sdk`, a copy of the public SDK temporal game with a larger, forward-positioned fox, and starts it through the ordinary generated project entry. It exercises object movement, camera orbit, the `Run` animation, blocker destruction and respawn, subject material replacement through prefab replacement, and directional light movement in raster, path and hybrid modes. The original temporal example is unchanged.

With the GPU reserved exclusively, run from the worktree root:

```powershell
npx tsx tools/m3-dynamic-sdk-game-probe.ts --exclusive-gpu --output .pelican/dynamic-sdk/manual
```

The probe requires a non-fallback WebGPU adapter. Each operation writes before/after canvas PNGs and inspect JSON, plus `dynamic-sdk-game.json` with the source fingerprint, per-case results and errors. For animation it also records a second static capture and browser snapshots, verifies that the Run action time advances with camera and entity transforms fixed, and requires both whole-frame and right-side image changes to exceed twice the measured static noise. This is not reference-image fidelity or conclusive proof of deformation: lighting and stochastic sampling can still influence the comparison. Thresholds are probe-specific and have not been calibrated on hardware. Existing M3 thresholds are unchanged.

CPU checks, no GPU:

```powershell
npx tsx --test tests/m3-dynamic-sdk-game-probe.test.ts
npm run typecheck
```

The CPU test compiles and executes the same game with the real runtime and game services, but stubs the animation service. It does not render, inspect bone deformation, establish GPU compatibility, test an installed npm package, or produce screenshots. A subsequent run on one nonfallback NVIDIA WebGPU device passed all 21 mode/operation cases; the initial occluded-animation failure and the adjusted-scene run are retained at `evidence/m3/development/dynamic-sdk-1793943920267/`. Animation checks compare a still-frame noise baseline, animation time and a region containing the visible fox; coarse image differences are not a physical reference or proof of all dynamic rendering cases. This is development evidence, not formal M3 acceptance.
