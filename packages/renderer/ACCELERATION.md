# Surface acceleration (M3)

CPU BVH over the immutable world-space triangles produced by existing
`surface.ts`. This module supplies a stable buffer layout for GPU integration.
It implements CPU build, CPU refit, and a CPU nearest-hit reference query.
It does not implement GPU refit, hardware ray tracing, BLAS/TLAS, GPU traversal,
or material/alpha evaluation during intersection. CPU measurements are not
GPU performance evidence.

## Fixed exports

```ts
import { createSurfaceAcceleration } from "./src/acceleration.ts";
import type {
  AccelerationFrame,
  AccelerationHit,
  AccelerationInspection,
  SurfaceAcceleration,
} from "./src/acceleration.ts";

const acceleration = createSurfaceAcceleration();
const frame = acceleration.update(snapshot); // snapshot: SurfaceScene
const hit = acceleration.intersect([0, 0, 3], [0, 0, -2], Infinity);
const json = acceleration.inspect(); // fresh JSON-serializable object
acceleration.dispose();
```

The factory returns exactly these four methods:

- `update(snapshot: SurfaceScene): AccelerationFrame`
- `intersect(origin: SurfaceVec3, direction: SurfaceVec3, maxDistance?: number): AccelerationHit | null`
- `inspect(): AccelerationInspection`
- `dispose(): void`

`AccelerationHit` contains `distance: number`, `triangleIndex: number`,
`barycentric: SurfaceVec3`, and `normal: SurfaceVec3`. Surface types are
imported from the existing surface module. `AccelerationInspection` describes
JSON data, rather than TypeScript's global `JSON` utility object type. It contains
revision, topologyRevision, changes, metrics, updates, rebuilds, and refits.

```ts
interface AccelerationFrame {
  readonly nodes: Float32Array;
  readonly sourceIndices: Uint32Array;
  readonly orderedTriangles: readonly SurfaceTriangle[];
  readonly revision: number;
  readonly topologyRevision: number;
  readonly changes: {
    readonly kind: "rebuild" | "refit" | "materials" | "none";
    readonly nodeRanges: { offset: number; count: number }[];
  };
  readonly metrics: {
    readonly buildMs: number;
    readonly refitMs: number;
    readonly triangles: number;
    readonly nodes: number;
    readonly depth: number;
  };
}
```

## GPU buffer contract

Root is node index 0. Each node occupies **8 Float32 elements (32 bytes)**:

| Element  | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| 0, 1, 2  | min x, y, z                                                              |
| 3 (lo.w) | internal: left child node index; leaf: first ordered triangle slot       |
| 4, 5, 6  | max x, y, z                                                              |
| 7 (hi.w) | internal: negative right child node index; leaf: positive triangle count |

Use `hi.w > 0` for a leaf and `hi.w < 0` for an internal node.
Internal left child is `lo.w` and right child is `-hi.w`. These values
are numeric floats, not bitcast integers or byte offsets. There is no valid
zero-count node. Empty trees have zero-length nodes/sourceIndices/orderedTriangles;
the caller must skip GPU root access. Removing the final triangle emits
`rebuild` with empty ranges, so also update the GPU triangle/node count.

`sourceIndices` has one Uint32 per ordered triangle slot.
`orderedTriangles[slot] === snapshot.triangles[sourceIndices[slot]]`.
Leaf slots index this order. CPU hits return an index in the latest accepted
snapshot. There is no packed triangle attribute buffer in this API: the GPU
caller packs current orderedTriangles using its own attribute layout.

**nodeRanges offsets and counts are float element units**, both multiples of 8.
Multiply by 4 for byte offsets/counts when uploading. Rebuild emits the entire
nonempty node buffer. Refit compares all eight elements of every node and emits
only changed nodes, merging adjacent changed nodes into maximal consecutive
ranges. The CPU still visits all nodes; sparse ranges do not imply sparse CPU
work. A vertex can move inside an unchanged leaf envelope: kind is refit and
nodeRanges can be empty, while triangle positions still require upload.

Bounds round outwards to Float32, enclosing original double-precision positions,
including positions between representable floats. Parents are exact unions of
child bounds. Numeric node indices and leaf starts must be exact Float32
integers (through 2^24); exceeding that encoding capacity rejects with
BUFFER_CAPACITY. This is a buffer representation constraint, not a scene-count
or traversal-depth cap.

## Updates and ownership

Stable geometry identity is the tuple:
objectUuid, geometryUuid, instanceId, groupIndex, elementOffset, vertexIndices.
Material UUID and material index are excluded. Duplicate identities reject.

| Change                                                                   | Kind      | Tree behavior                                                                   |
| ------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------- |
| First update, added/removed/changed identity                             | rebuild   | Median partition on widest centroid axis; leaves of at most four                |
| Same identities, different positions                                     | refit     | Preserve leaf slots and all node pointers; update leaves then parents bottom-up |
| Same identities/positions, different UV/normal/material/texture/metadata | materials | Preserve all node values; use current triangles/materials                       |
| Same identities/positions, different source list order                   | materials | Preserve leaf slots; remap sourceIndices to current snapshot                    |
| All snapshot data equal                                                  | none      | Preserve tree and revision                                                      |

Reorder combined with position changes is refit. Visibility and instance-count
changes appear as identity additions/removals and rebuild. Instance matrices,
object transforms, morph, skinning, or other supported surface deformation that
keep identities and change extracted positions use refit. This module does
not perform extraction or animation. Material visibility removing triangles
rebuilds; material replacement and side changes preserve nodes.

`revision` increments on every successful non-none update, including a pure
source reordering. `topologyRevision` increments only on rebuild. Initial
values before first update are zero; first empty update is also a rebuild.
Positions and material data changing together take refit priority. `none`
compares actual snapshot data, including textures and diagnostics; new object
references with equal data are none. Source timestamps or versions absent from
SurfaceScene cannot be observed by this layer.

The input contract is a deeply immutable SurfaceScene, as supplied by
extractSurfaceScene. The module does not mutate or freeze input. Returned
orderedTriangles arrays, frame wrappers and metrics are frozen; triangle objects
are shared with that immutable input. nodeRanges retains the fixed mutable-array
API and is a caller-owned copy, independent of inspection and future updates.
Every returned nodes/sourceIndices buffer is
a separate caller-owned copy, also for materials/none updates. Mutating or
transferring/detaching these typed arrays cannot affect queries, cached state,
or future updates. Subsequent updates/dispose never mutate any previously
returned frame. Typed arrays themselves are deliberately not deep-frozen.
Keep the input immutable for as long as frames/acceleration use it.

Validation and candidate allocations finish before publication. Non-finite
snapshot numbers, degenerate triangles, singular normal matrices, duplicate
identities, missing/invalid materials, and positions outside finite Float32
bounds reject atomically: the last scene, revisions, counters and queries
remain available. Numerically underflowed triangle area is also rejected.
Errors are SurfaceAccelerationError with stable codes prefixed
`TC_ACCELERATION_`: INVALID_SNAPSHOT, INVALID_MATERIAL,
DEGENERATE_TRIANGLE, DUPLICATE_IDENTITY, BUFFER_CAPACITY, INVALID_RAY,
INVALID_DISTANCE, DISPOSED. Messages identify the triangle/property where
applicable and suggest correction or re-extraction.

dispose releases internal references and is idempotent. update/intersect/inspect
after disposal reject with DISPOSED. Before first update, inspect returns zero
metrics/counters and intersect returns null for valid rays. inspect returns
fresh plain JSON data without live scene references.

## CPU ray reference

Direction is normalized robustly before traversal: distance and maxDistance
are world units regardless of direction length. Origin/direction must contain
three finite numbers; direction must be nonzero. maxDistance defaults to
positive Infinity. Nonnegative finite values and positive Infinity are valid,
including zero. NaN, negative values and negative Infinity reject. Hits include
t = 0 and the exact maxDistance boundary; zero distance is +0. Invalid rays
reject even on empty scenes. Parallel slab axes, zero-thickness bounds and
origins inside bounds are handled explicitly. Misses return null.
Equal-distance ties select the lowest current snapshot index.

Intersection uses actual world-space winding corrected by the inverse-transpose
normalMatrix determinant sign for mirrored transforms. This matches Three's
local-space triangle front/back/double culling without deriving geometric front
from vertex normals. Barycentric coordinates retain original vertex order.

Normal is normalized barycentric interpolation of world-space vertex normals;
zero interpolated normals fall back to the world-space geometric cross product.
Back-side materials invert it; double-side back hits also invert it, matching
surface sampling. Custom shading normals can differ from geometric normals.
Normal maps, alpha masks/blending, texture sampling and transmission do not
affect hit acceptance or returned normal. Sample material attributes after a hit;
transparent cutouts require caller continuation.

## Cost and verification

buildMs/refitMs use CPU performance.now(). On their respective kinds they
include validation, identity matching, comparison, tree work, dirty-range
scanning and exported buffer/ordered-array copies up to final frame publication.
They exclude extraction and GPU uploads/execution. The other timing is zero;
materials/none have both timings zero although validation, equality checks and
copies still cost CPU time. Timings are per-update, not cumulative.

Refit is O(triangles + nodes + snapshot payload validation), visiting the
whole tree without repartitioning. Build sorts each median partition, with
O(N log^2 N) worst-case comparison work. Median splits bound recursive build
depth logarithmically even for coincident centroids. Depth counts root as 1
and empty as 0. CPU traversal uses a growing stack bounded by tree depth,
without a fixed shader-stack limit or invented 128K scene cap. Repeated
deformations can reduce traversal quality because partitions remain fixed.

Reproduce using existing dependencies:

```sh
npx tsc --noEmit
npx tsx --test tests/acceleration.test.ts tests/render.test.ts tests/surface.test.ts
npx prettier --check packages/renderer/src/acceleration.ts tests/acceleration.test.ts packages/renderer/ACCELERATION.md
```

Tests cover raw pointer stability through deformations crossing original
partitions, exact parent/leaf containment and dirty ranges, actual Three
transform/morph extraction, visibility/instance/topology transitions, source
reordering, two-group sides against Three Raycaster, mirrored transforms and
opposing normal attributes, seeded brute-force rays, material/texture caches,
immutable/isolated/transferred frame buffers, atomic rejection, empty/disposal
states, and build/refit/query for 131073 coincident-centroid triangles.
These checks require no browser or GPU.
