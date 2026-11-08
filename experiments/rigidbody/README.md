# M0 Rapier WASM candidate probe

Node-only evaluation of the installed `@dimforge/rapier2d-compat` and
`@dimforge/rapier3d-compat` 0.21.0 JS/WASM packages (Apache-2.0).

```ts
import { runRigidBodyProbe } from "./experiments/rigidbody/index.ts";

const report = await runRigidBodyProbe();
// { passed, versions, cases, limitations }; plain JSON, no owned native objects.
```

The main M0 verifier can assert `report.passed`, save this report to its chosen
evidence path, and append a `rigidbody` check. This experiment does not write to
the root evidence directory, change the verifier, or touch existing simulation
prototypes. Report types are exported from `index.ts`.

Run from the repository directory:

```sh
node --import tsx experiments/rigidbody/run-probe.ts
node --import tsx --test tests/rigidbody.test.ts
```

Each dimension creates five bodies, four colliders and a fixed impulse joint.
A box falls onto a ground plane and settles, a restitution ball bounces, and a
joint holds another dynamic body against gravity. The experiment runs 240 ticks
at 1/60 second, counts collision start/stop events and actual contact manifolds,
and verifies a ray hit's opaque collider handle plus a separate ray miss.

At tick 30, during free fall, the experiment calls `World.takeSnapshot()`.
It passes those actual bytes to `World.restoreSnapshot()`, checks body/collider/
joint handles, and compares every subsequent tick's positions, rotations,
linear/angular velocities and sleep state, plus collision event sequence.
The tolerance is 1e-5. The restored world has its own event queue. Snapshots do
not serialize application state or queued external events.

The report measures public `init()` wall time, 240 native step wall times,
snapshot capture/restore wall times, byte count and replay step wall time.
Module import time is excluded. There is no artificial warmup: JIT/first-use
costs may dominate a tiny scene. Initialization is shared across probe calls;
`cached: true` reports the original initialization measurement. If other code
initializes these modules first, that first probe measurement is already warm.

Eight populated create/restore/free cycles track 16 worlds and 16 separate event
queues per dimension. Cleanup runs in `finally`; tests also inject failures
during setup, queue creation, stepping, capture, restoration, replay, subsequent
cycles and cleanup. Balanced explicit calls establish resource ownership, not
an allocator/heap leak proof. The public barrel exports only the async probe;
its result contains finite plain data, never live worlds or methods.

The snapshot error boundary normalizes invalid type, empty, truncated and
garbage data into `RIGIDBODY_CHECKPOINT_INVALID` with a dimension and recovery
hint. The actual installed `restoreSnapshot` can return `null`, although its
TypeScript declaration says `World`. This is handled explicitly. Native bytes
have no application version/checksum envelope here. Compatibility across
package versions, dimensions, architectures or runtimes is not established.

The installed public JS runtime **does export soft-body APIs** in both
dimensions: `SoftBody`, `SoftBodyDesc`, `SoftBodySet`, `World.createSoftBody`,
and related methods. Runtime inspection records the exports and public
descriptor factories, including 2D `grid` and 3D `cloth`. These are API presence
observations only; this probe does not create or validate soft-body simulations.
It does not replace or change the existing XPBD/WCSPH experiments.

API choices come from the installed packages' `dist/init.d.ts`,
`dist/pipeline/world.d.ts`, `dist/pipeline/event_queue.d.ts`,
`dist/dynamics/impulse_joint.d.ts`, `dist/dynamics/soft_body.d.ts` and
`dist/geometry/{ray,narrow_phase}.d.ts`, verified against actual runtime calls.
The 0.21.0 compat wrapper source included in `dist/rapier.mjs.map` already calls
its internal WASM initializer with `{ module_or_path: ... }`. The documented
public signature remains `init(): Promise<void>`; this probe calls `init()`
and does not suppress warnings or invent an `init({})` overload.

This is a small CPU/WASM candidate check. Vehicle dynamics, other joint kinds,
CCD, large scenes, production/browser adapters, GPU execution and complete
soft-body acceptance remain outside its measured claims. All limitations are
also returned in the report for mainline evidence collection.
