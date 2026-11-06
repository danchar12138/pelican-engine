# CPU Medium Catalog

## Contract

Import directly from `src/medium.ts`. No SDK, integrator, GPU ABI, dependency,
surface extractor or existing test is changed by this module.

```ts
declare function createMediumCatalog(snapshot: SurfaceScene): {
  readonly volumes: readonly MediumVolume[];
  initial(origin: SurfaceVec3): readonly number[];
  inspect(): MediumInspection; // JSON-serializable, immutable
  dispose(): void;
};

interface MediumVolume {
  readonly id: number;
  readonly key: string;
  readonly ior: number;
  readonly sigma: SurfaceVec3;
  readonly bounds: { readonly min: SurfaceVec3; readonly max: SurfaceVec3 };
  readonly triangleIndices: readonly number[];
}
```

The factory has exactly one argument. Material physical fields are read through
a local structural extension of SurfaceMaterial. No source object is mutated or
frozen by the factory. Private position copies isolate classification from later
changes to geometry/materials. The returned catalog, volumes, tuples, indices,
inspection records and initial arrays are frozen, including nested containers.
Each initial call returns its own array, including empty results.

## Phase And Identity

- Key is exactly `JSON.stringify([triangle.objectUuid, triangle.instanceId])`.
  Material identity is never a volume identity. Instances remain separate.
- Wholly opaque objects are excluded. Every face of an included object/instance
  must have transmission greater than zero. Mixing opaque and transmissive faces
  fails with `TC_MEDIUM_PARTIAL_TRANSMISSION`; opaque coatings are not inferred.
- IDs are consecutive from 1, ordered by first triangle encounter. ID 0 is exterior
  air, not a stored volume. triangleIndices refer to the original snapshot array.
- Surface color, roughness, material UUID and positive transmission can vary.
  IOR and computed sigma must agree exactly across all faces, otherwise
  `TC_MEDIUM_INCONSISTENT_MEDIUM`. No implicit internal phase boundary is added.
- Default IOR is 1.5, attenuation color is linear white, attenuation distance is 0.
  IOR must be positive and finite; transmission must be finite in [0,1].
- For positive distance, sigma[c] = -ln(attenuationColor[c]) / distance in inverse
  world units. Thus exp(-sigma[c] \* distance) equals the linear attenuation color,
  without an sRGB conversion or multiplication by surface base color.
- Distance 0 disables absorption: all sigma channels are 0 even for color 0.
  Colors still must be finite and in [0,1]. At positive distance any zero channel
  fails with `TC_MEDIUM_ZERO_ATTENUATION`. Infinite absorption is not clamped or
  silently rerouted; the caller must choose an explicit opaque path or positive
  attenuation color. Nonfinite/float32-overflow sigma fails with
  `TC_MEDIUM_ABSORPTION_RANGE`. Ordinary float32 rounding remains the GPU's job.

## Geometry And Tolerance

Uses only the snapshot's expanded, already-deformed world-space vertex positions.
Indexed and nonindexed input, face-normal seams, instancing, skin/morph animation,
negative scale and nonuniform world transforms need no special source mutation.
Shading vertex normals do not determine topology or orientation. Finite,
nonsingular 3x3 normal matrices are validated; either determinant sign is accepted.
Both global windings are supported using the absolute signed enclosed volume.

Welding is explicit, deterministic and scale-relative. Per object/instance:

```text
weld = max(max world AABB extent * 1e-7,
           max absolute world coordinate * Number.EPSILON * 32)
```

Numeric nested spatial maps search the current and adjacent cells, then compare
Euclidean distance. The lowest previously encountered representative within weld
is chosen; no string parsing of positions and no transitive chain-merging is used.
The canonical position is that representative, not an averaged/mutated source
vertex. This supports repeated BoxGeometry vertices and Float32 sphere/glTF-like
near seams. Distinct gaps/features at or below this documented resolution cannot
be distinguished from seams; above-tolerance cracks are not filled. The fixed
factory deliberately has no hidden options. Actual tolerances are in inspect().

Every undirected welded edge must have exactly two opposite traversals. Every
vertex's incident face fan must be connected. Faces must have resolvable area,
and enclosed volume must exceed weld \* surface area. Holes, duplicate faces,
nonmanifold edges, pinched vertices, inconsistent local winding and zero-thickness
shells fail. Each volume must have one connected shell; disconnected components
and multiple-shell cavities fail with `TC_MEDIUM_MULTIPLE_SHELLS`. A connected
torus is allowed. Split disconnected solids into distinct objects/instances.

## Overlap And Initial Stack

Catalog construction validates every potentially overlapping pair. AABBs are
only a broad phase. Triangle vertex/face distance, segment/triangle intersections
and edge/edge distance detect surface crossings, tangency and coplanar contact.
Contact within the larger pair weld tolerance also fails. Such geometry throws
`TC_MEDIUM_OVERLAP` before an integrator can consume a wrong eta stack. There is
no priority/enter-order convention for overlapping media.

After excluding boundary contact, winding classification of a representative
vertex establishes containment of connected shells. Containers must form a chain.
The initial stack uses actual containment depth, not AABB size or volume ID order.
For example, first-encounter inner ID 1 and outer ID 2 return `[2, 1]` from inside
both. Disjoint rotated solids with overlapping AABBs are accepted; a sphere in a
torus hole is not falsely classified as contained. Exterior returns `[]`, not [0].

initial(origin) uses the oriented solid-angle winding sum over canonical triangles.
Three fixed non-axis ray directions independently check parity; distances are
deduplicated. A ray hitting a triangle edge/vertex is excluded from cross-checking,
not double-counted. Winding remains the classifier if such directions are
ambiguous; noninteger winding or any nondegenerate ray disagreement throws
`TC_MEDIUM_CLASSIFICATION`. Either global winding sign has the same inside result.
The boundary band is determined by point-to-triangle distance, including faces,
edges and vertices. Points on or within weld of a surface fail with
`TC_MEDIUM_BOUNDARY`. No hidden camera nudge selects a side.

## Lifecycle And Limits

dispose() is idempotent and releases private triangle/position/classification
storage. Subsequent volumes access or initial calls throw `TC_MEDIUM_DISPOSED`.
inspect() remains available with disposed: true and empty arrays; previously
obtained immutable results remain ordinary value snapshots. Inspection before
disposal includes volumes, per-ID weld and immediate parent IDs (0 for roots).

This is not a general self-intersection proof. A consistently oriented,
non-self-intersecting connected shell is a precondition beyond the implemented
topological/volume checks. Winding disagreement can diagnose some invalid cases,
but not all self-intersecting meshes are detected, especially without querying
affected points. Do not advertise all accepted input as geometrically proven.
No CSG, automatic hole repair, arbitrary overlapping phase priority, nested cavity
shell semantics or opaque-coating inference is implemented.

Construction copies all included triangles, checks topology and performs pairwise
triangle checks after AABB pruning: worst-case O(sum(Ti \* Tj)) across volume pairs.
initial is O(total included triangles) per query with four classification passes
on candidate solids. There is no animation cache, refit, BVH or GPU integration.
Rebuild from each changed immutable snapshot for correct current-frame behavior;
the mainline owns later caching, ID packing, medium-stack capacity and integration.

## Verification

Only three new paths belong to this work:

- `packages/renderer/src/medium.ts`
- `tests/medium.test.ts`
- `packages/renderer/MEDIUM.md`

The CPU tests use real locked Three geometry/extraction, then add physical flat
fields to the immutable snapshot in the test fixture. This isolates catalog tests
from the independently developed physical-material extractor. It is not an
end-to-end physical-material/GPU/integrator acceptance claim.

Coverage includes Box/Sphere, indexed/nonindexed seams, positive/negative world
transforms, instances, closed animated skin+morph, immutable source/output,
multimaterial phases, defaults and analytic Beer factors, partial opaque faces,
holes, duplicate/flipped/zero-area/zero-volume faces, nonmanifold vertex fans,
disconnected shells, finite inputs, boundary points, off-axis edge-hit rays,
true nested stacks and disjoint rotated/toroidal AABB counterexamples. The seeded
sphere test generates 1500 points, excludes a 0.012-radius tessellation-error band
around the analytic sphere surface, and compares more than 1400 accepted points.
An additional 120 seeded analytic box pairs check overlap/nesting/disjointness.

Commands (from this worktree; do not install or modify dependencies):

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/tsx/dist/cli.mjs --test tests/medium.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/medium.ts tests/medium.test.ts packages/renderer/MEDIUM.md
```

Validated on 2026-11-04 in the independent m3Medium worktree:

- Whole-repository TypeScript check: passed.
- Medium-specific tests: 24 passed.
- Combined medium, existing surface and existing surface-cache tests: 62 passed.
- Prettier check of the three new paths: passed.
- The other 1734 Git-listed tracked/untracked nonignored paths were hashed in
  sorted path order, including both path and bytes, before and after work. Their
  SHA-256 was unchanged:
  ```text
  69f41617cb1bc09e5028ec6fde2ef07c3dd1eb341d94c8293e3d7ac032740465
  ```
- No commit, push, dependency install, GPU test or integrator change was made.
