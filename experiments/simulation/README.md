# M0 interactive CPU simulation prototype

This folder implements the M0 representative interaction experiment, **not** a
complete production physics system or the final public game SDK. No Three.js,
Rapier, WebGPU, AI service, or runtime package is imported by the solver.

## Entry point and integration

```ts
import {
  createSimulation,
  runSimulationProbe,
  type SimulationKind,
  type SimulationRenderState,
} from "./experiments/simulation/index.ts";

const simulation = createSimulation("cloth", { seed: 12345 });
simulation.step(); // exactly 1/60 simulated second, six substeps by default
const geometry = simulation.getRenderState();
const checkpoint = simulation.snapshot();
simulation.applyImpulse("body:0", [0, 0.1, 0]); // impulse, not prescribed animation
simulation.step(30);
simulation.restore(JSON.parse(JSON.stringify(checkpoint)));
simulation.dispose();
```

Kinds: `rope | cloth | softbody | fluid`. Options and return types are defined in
`types.ts`, re-exported by `index.ts`. `step(n)` runs n fixed steps, not a variable
delta in seconds. Caller owns scheduling; no RAF, worker or background process
is created. Positions are 3D, Y-up, meter-scale. Each scene occupies roughly
`x ∈ [-1.35,1.35], y ∈ [-1.05,1.65], z ∈ [-1.1,1.1]`.

Render JSON shape:

```ts
{
  kind: 'rope' | 'cloth' | 'softbody' | 'fluid';
  tick: number;
  bodies: { id: string; position: [number, number, number]; radius: number }[];
  particles: { id: string; position: [number, number, number]; radius: number }[];
  links: [number, number][];
  triangles: [number, number, number][];
}
```

- All link and triangle indices refer to **particles**, not bodies.
- Cloth provides 72 surface triangles; softbody provides 48 outward-wound surface
  triangles. Rope has links. Fluid exposes particles; surface reconstruction is
  not implemented. Links include structural, shear and/or bending constraints.
- IDs and topology remain stable during a simulation. Positions actually evolve.
- Every render/snapshot/inspect result owns independent arrays. Mutating results
  does not mutate the solver. Restore clones and validates before changing state.
- `tick` is restored with snapshots and is **not monotonic** across restoration.
  A renderer should synchronize after every step/restore, rather than discard a
  lower tick as stale. A snapshot contains no renderer/BVH/GPU resources.
- `inspect()` is allowed after dispose and reports zero owned resource counts;
  all mutating and geometry/snapshot operations then reject with `SIM_DISPOSED`.
  Dispose is idempotent. Create another instance to reload.

## Real numerical models and limits

| Kind     | Default load                                      | Solver                                                                                                      |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| rope     | 15 particles, 27 distance constraints             | XPBD stretch and compliant second-neighbor bending constraints; one fixed endpoint                          |
| cloth    | 49 particles, 226 distance constraints            | XPBD structural/shear and compliant bending constraints; two fixed corners                                  |
| softbody | 27 particles, 98 distance + 48 volume constraints | XPBD tetrahedral edge/volume constraints; free deformable solid                                             |
| fluid    | 64 particles                                      | Weakly compressible SPH (WCSPH), poly6 density, compressive pressure, spiky gradient and pairwise viscosity |

All four scenes contain a dynamic sphere of mass 0.35 and radius 0.25. Its
position and velocity are integrated, never scripted. Sphere/particle contact
projects both positions in inverse-mass proportion. Dividing corrections by the
substep gives the recorded equal-and-opposite impulse; corrected positions
update velocities. Pressure/viscosity forces are likewise equal-and-opposite.

Elastic constraint multipliers reset each substep and accumulate over solver
iterations with XPBD compliance scaled by `1 / substep²`. Softbody uses signed
tetrahedral volume and gradients; inspect reports both relative volume error
and minimum signed volume ratio. There are no prerecorded trajectories or
special-case motion offsets in step(). Seeded initialization only introduces
small geometric perturbations; no random forcing occurs during integration.

Walls are fixed, and pinned anchors exchange momentum with the environment.
Velocity damping dissipates energy. Momentum conservation is therefore tested
on an isolated single contact with zero gravity/velocity, separately from the
default anchored and bounded scenes. The prototype has no friction, torque,
rotation, restitution model, CCD, cloth self-collision, tearing, plasticity,
arbitrary triangle-mesh collision or cross-deformable solver coupling. Contact
is discrete sphere/particle contact and can tunnel at high speed / sparse mesh
resolution. Tiny scenes do not establish production-scale throughput.

SPH is O(n²), has no tensile/surface tension model or boundary-density correction,
and uses static wall projection. It is a real pressure/viscosity simulation but
not a high-fidelity incompressible liquid or buoyancy solver. It can spread into
a shallow particle film. No smooth liquid surface is generated. The pressure
force is separately tested using a compressed free cloud and momentum balance.

## Controls, reproducibility and reports

`runSimulationProbe({ seed?, steps?, kinds?, lifecycleCycles? })` is synchronous
and returns JSON-serializable `SimulationProbeReport`. Default 120 steps; the
recorded CLI run uses 240 steps (4 simulated seconds) and 12 lifecycle cycles.
Every kind is compared at every frame against:

1. Identical initial conditions with sphere/particle contacts disabled.
2. Identical initial conditions with contacts active but sphere reaction disabled.

The second still displaces particles; it does not apply a hidden force to the
sphere. The report requires nonzero contact/reaction and trajectory differences
for **both body and particles**, not merely visible movement. Separate tests
also use an active collider with a physical gap and require exactly no reaction.

Reports include throughout-run constraint errors, finite-state checks, speed,
pressure, peak control differences, serialized snapshot/render bytes, capture
and restore wall time, exact state/render replay differences, and owned-array
counts after repeated create/restore/run/dispose cycles. Thresholds are for the
specified small default scenes only: probe distance/volume relative error <0.1,
no inverted tetrahedra, sampled speed <20, body separation from both controls

> 1e-4, particle RMS separation >1e-4 from no-contact and >1e-5 from one-way.
> The test suite applies tighter default-scene stability thresholds.

`timing.*SolverWallMs` measures time executing the synchronous CPU solver using
`performance.now()`, excluding inspect/capture costs. It is not GPU time or OS
process CPU usage. `run-probe.ts` additionally records actual Node process user
and system CPU usage, whole probe wall time and CPU/runtime identification.
The process can have helper/GC threads, so CPU time may exceed wall time.
Measurements are local samples without CPU isolation, warmup guarantees or
hardware-independent performance promises. Geometry byte counts are JSON UTF-8,
not GPU buffer residency; snapshot bytes are JSON UTF-8, not process heap size.

Snapshots contain configuration, topology/rest state, positions, velocities,
tick and physical counters; CPU timing is diagnostic and resets on restore.
Topology is fixed per kind/seed and validated. Input validity failures do not
replace live state. Replay is same-runtime exact, not a cross-platform bitwise
claim. Disposal counts show explicit release, **not** an OS/GPU leak audit.

## Execute from the contributor repository root

After the main workspace has installed tsx/TypeScript:

```sh
node --import tsx --test tests/simulation.test.ts
node --import tsx experiments/simulation/run-probe.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --types node experiments/simulation/index.ts experiments/simulation/run-probe.ts tests/simulation.test.ts
```

The second command writes `experiments/simulation/evidence.json` and exits
nonzero if a probe check fails. No root/package/SDK/renderer/tool files are
modified by this prototype. This folder's implementation is original project
code; no third-party physics source was copied.

Actual WebGPU rendering, dynamic acceleration-structure updates, ray-traced
image comparison and GPU performance are **mainline integration work** and are
not claimed by the CPU report. Feed the returned triangles/positions and body /
particle spheres into that integration, then compare after motion and restore.
