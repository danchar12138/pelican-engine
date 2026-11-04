# M0-06 finite world streaming / edit / recovery sidecar

This is an executable CPU prototype, not a complete terrain engine, navigation
library, rigid-body system or public production SDK. It has no dependency on
Three.js, simulation/, renderer/, a database, Git or a runtime AI service.

## Imports and minimal use

```ts
import {
  createWorldProbe,
  runWorldProbe,
  type WorldProbe,
  type WorldRenderState,
  type WorldAdapter,
} from "./experiments/world/index.ts";

const world = createWorldProbe();
await world.loadChunk([0, 0]);
await world.loadChunk([1, 0]);
await world.applyEdits([{ chunk: [0, 0], x: 4, z: 2, height: 2 }]);
const geometry = world.getRenderState();
const saved = JSON.stringify(world.snapshot());
await world.unloadChunk([0, 0]);
await world.loadChunk([0, 0]); // persistent edit is applied again
await world.restore(JSON.parse(saved));
world.dispose();
```

`createWorldProbe(options?)` returns a world instance. `runWorldProbe({seed?})`
returns a `Promise<WorldProbeReport>`. `index.ts` re-exports all contracts from
`types.ts`. The root/tool/SDK/renderer/simulation files are not changed here.

Defaults: seed 12345, 8-meter chunks, 4×4 cells / 5×5 vertices per chunk, a finite
3×3 map at chunk coordinates [-1,-1] through [1,1], Y-up. Configurable bounds are
limited to 8×8 chunks and grids to 16×16 cells. No infinite-world claim is made.

## Render / collision / navigation contract

```ts
interface WorldRenderState {
  epoch: number;
  origin: { chunk: [number, number]; offset: [number, number, number] };
  chunks: {
    id: string; // e.g. "chunk:0:0"
    coord: [number, number];
    version: number;
    positions: number[]; // flat XYZ in CURRENT ORIGIN-LOCAL coordinates
    indices: number[]; // outward / +Y-facing triangle indices
  }[];
}
```

The consumer should render these positions directly, without subtracting the
origin a second time. Rebuild/refit GPU/BVH data when `epoch` changes; unloading
removes the chunk from this complete resident set. The prototype does not
perform GPU uploads or acceleration-structure updates itself.

- `getCollisionState()` returns the same committed chunk IDs/versions, actual
  height arrays, cell spacing and origin-local offset. `sampleHeight({chunk,
local:[x,y,z]})` samples this committed consumer, using the **same triangular
  interpolation** as the render mesh; y in the query is ignored. The returned
  height is unshifted terrain Y; subtract origin.offset[1] for origin-local Y.
  A point exactly on the positive chunk edge normalizes into the next chunk.
- `getNavigationState()` returns a real four-neighbor cell graph with center
  positions, heights, neighbors and version references. Cells with too much
  corner height variation are removed; neighbor steps are limited as well.
  `findPath({chunk,cell:[x,z]}, {chunk,cell:[x,z]})` performs BFS over resident
  nodes, including cross-chunk edges. Unloaded, blocked or disconnected goals
  return `found:false`. There is no navmesh library hidden behind this result.
- Snapshots/render/inspect/navigation results are independent copies; mutating
  them cannot update the world. Every public mutation uses the transaction path.
- `epoch` increases for every successful publication, including restore and
  origin shift. Failed/discarded transactions do not increment it. Content
  `version` changes on edits and is persisted; restore may decrease versions,
  while epoch still increases. An origin shift changes no content version.

## Real edits and atomic consumer updates

Height edits address integer grid vertices, not arbitrary world samples. Shared
borders/corners use a single **global integer vertex key**. An edit updates all
containing chunks' revisions, including unloaded neighbors. Multiple edits to
one vertex in the same transaction use the last value; each affected chunk gets
one increment. Seeded base heights and persistent overrides produce the actual
new render triangles, collision samples and traversability graph.

Transactions are serialized. During asynchronous preparation, all public reads
see the previous fully committed state. Built-in render/physics/nav consumers
prepare real derived data into temporary artifacts; only after all preparations
succeed do they synchronously swap references and publish world state in one
JavaScript turn. Preparation failure discards artifacts. Commit failure rolls
back every attempted consumer, including the consumer whose commit threw.
Failure to honor rollback marks the world faulted rather than reporting success.

Additional adapters may be supplied using `options.adapters`:

```ts
interface WorldAdapter {
  name: string; // unique; render, physics and nav are reserved by built-ins
  prepare(
    transaction: WorldTransaction,
  ): PreparedWorldUpdate | Promise<PreparedWorldUpdate>;
  dispose?(): void;
}
interface PreparedWorldUpdate {
  commit(): void;
  rollback(): void;
  discard(): void;
}
```

Preparation receives its own copy of the prospective full resident world and
must not mutate currently visible resources. `commit`, `rollback` and `discard`
must be **synchronous, trusted, non-reentrant**; no observer callbacks, browser
frames, asynchronous side effects or world API reentry are allowed inside them.
Rollback must undo a partially failed commit and must not throw. Discard must
release only staged resources and must not throw. GPU preparation may be async;
publication must follow this contract. This is not distributed atomicity, thread
isolation or crash durability. `inspect().consumers` verifies built-in consumer
IDs/versions/epochs; arbitrary external adapters must supply their own tests.

For this finite experiment all resident artifacts are rebuilt on a transaction,
not just modified chunks. This makes consistency observable without pretending
that a full incremental terrain/BVH/nav pipeline exists.

## Async lifetime / cancellation semantics

- `loadChunk(coord)` returns `{status,id,generation,version}`. Status is `loaded`,
  `already-loaded`, `cancelled` or `stale`. Concurrent requests are versioned per
  chunk; a newer request supersedes the old one.
- `cancelLoad(coord)` aborts the signal and settles its load promise immediately.
  It does not wait for an uncooperative source. An eventual old success/error is
  consumed and cannot publish data or erase a newer pending request.
- `unloadChunk(coord)` cancels pending loads; stale prepared load results cannot
  resurrect a chunk. A newer load intent can invalidate a still-preparing unload.
- A committed edit invalidates pending builds for affected chunks. A restore
  invalidates all pending old-world builds after successful publication. A stale
  result does not retry automatically; the caller may explicitly request again.
- `beforeBuild(request,signal)` is an optional asynchronous I/O scheduling hook.
  Actual seeded height/mesh generation follows it; it is not a mock data source.
  Tests gate this boundary with promises, then exercise real generated data and
  adapters. No timers or guessed sleep durations are needed for race assertions.
- Chunk unload releases resident mesh/height/nav resources. Edits/revisions remain
  persistent until dispose. Snapshots contain only committed state and do not
  serialize promises, generations, adapters, metrics, GPU data or in-flight work.
- Dispose is idempotent, cancels callers, clears owned maps/artifacts and causes
  later operations to fail with `WORLD_DISPOSED`. Already-running async hooks
  cannot be forcibly terminated; their results are discarded after completion.

## Snapshot and split-coordinate precision

Snapshots contain a format/version, exact map configuration, origin, canonical
persistent vertex edits, chunk revisions, and resident height data. Restore
validates the finite bounds, indices, duplicates, finite values and regenerated
heights against persistent data before preparing consumers. It cannot silently
accept saved render data inconsistent with terrain edits. Configuration changes
are rejected; create a matching world before restoring. Timing and epoch are
not persistent simulation data. Caller may save/load the JSON with its own I/O.
No disk journal, incremental save, schema migration or crash recovery exists.

World positions stay split as `{chunk:[x,z], local:[x,y,z]}`. Origin conversion
subtracts integer chunk coordinates **before** scaling and adding local floats.
`toLocal` / `fromLocal` preserve useful precision around chunk coordinates of
100,000,000 without forming large absolute Float32 positions. There can still
be normal floating-point roundoff when adding/subtracting fractional origin
offsets; tests use a 1e-12 local tolerance for that case. This does not repair
precision already lost by a caller that provided global Float32 coordinates.

## Validation and actual measurements

From the repository root, using the main workspace's installed tools:

```powershell
node --import tsx --test tests/world.test.ts
node --import tsx experiments/world/run-probe.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --types node experiments/world/index.ts experiments/world/run-probe.ts tests/world.test.ts
```

Tests cover real geometry/collision/path changes, border/corner edits, leaving
and returning, JSON restore, active cancellation, asynchronous old success/error,
load/unload races, disposal during prepare, source retry, prepare/commit rollback,
broken rollback faulting, copy isolation and origin-local precision.

The report measures three 25-vertex/32-triangle chunks, a border edit that changes
a cross-chunk route from 4 to 6 nodes, 2,040-byte default snapshot JSON, exact
logical/geometry restoration (epoch excluded), cancellation/rollback evidence,
and eight create/restore/unload/dispose cycles. Values are measured by the probe,
not hardcoded success flags. `evidence.json` is written only by run-probe.ts.
The runner also reports process user/system CPU time over repeated probes to
reduce Windows CPU accounting quantization; wall time is not GPU time.
Resource counts prove explicit logical release only, not heap/GPU leak freedom.

Scope limits: no production terrain, LOD, caves, arbitrary topology edits,
continuous navigation, obstacle agents, rigid-body collision response, file
streaming, bandwidth simulation, worker concurrency or GPU/BVH verification.
These are intentionally small real data transactions for M0-06; mainline must
verify actual renderer / physics / navigation library adapters separately.
