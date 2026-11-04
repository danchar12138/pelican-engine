# M0 evidence index

These files are recorded execution evidence, not a claim that the complete engine is finished. The authoritative milestone result is `acceptance.json`; failures are retained in `attempts/`.

- `environment.json`: redacted Windows, hardware, driver and locked tool inventory.
- `compiler.json`, `scene.ir.json`: current compiled prototype and whole-project cache report.
- `typecheck.txt`, `unit-tests.txt`: actual strict check and complete CPU test output.
- `rigidbody.json`: real Rapier 2D/3D WASM candidate assessment.
- `simulation.json`: four CPU reference simulations with contact/one-way controls and checkpoint/lifecycle measurements.
- `world.json`: finite chunk transactions, persistence, cancellation, real height/mesh/navigation data and precision checks.
- `render.json`: headed hardware WebGPU, graph dispatch/readback, isolated deformation/ray tests, dynamic modes, geometry/state recovery and native 1080p measurements.
- `sequence-path-*.png`: a four-frame dynamic path sequence, not static convergence substituted for motion.
- `simulation-*.png`, `world-edited-path.png`: simulated/edited geometry rendered through the same BVH path.
- `deploy.json`, `dist.png`: plain static server subpath, production developer hooks absent.
- `ai-workflow.json` and `ai/`: independent, frozen ZIP and external-directory game development, source identity and original execution artifacts.

`fenceWallMs` is a serialized step plus GPU completion wait, not sustained presentation FPS. `gpuComputeMs` measures tracer compute only. Full quality, denoising, representative assets and large-load performance remain later milestone work. Software triangle-BVH tracing here executes on a verified hardware adapter; it is not a claim that WebGPU exposes dedicated hardware ray-query acceleration.

Public reports remove local account/root paths and credentials. Any synthetic records in unit tests validate gate behavior only; they are not graphics acceptance evidence.
