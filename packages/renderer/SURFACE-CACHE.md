# Surface mesh cache / repeated validation

Scope: internal CPU surface preparation for M3. This is not M3 acceptance or a GPU performance result. Only surface.ts, surface-capture.ts, acceleration.ts, tests/surface-cache.test.ts and this document are part of this change. No SDK, dependencies, renderer main class, acceleration frame API, GPU refit or BLAS changes.

## Ownership and API

```ts
const meshCache = createSurfaceMeshCache();
const surface = extractSurfaceScene(scene, {
  meshCache,
  textureCache, // optional existing texture/pixel cache
  materialAdapter,
  decodedTextureProvider,
});
meshCache.inspect(); // { disposed, meshes, triangles, hits, misses, capacity }
meshCache.clear(); // release all retained mesh/signature/triangle records and reset counts
meshCache.dispose(); // clear, then reject extraction with SURFACE_MESH_CACHE_DISPOSED
```

SurfaceExtractionOptions.meshCache is optional. Without it extraction continues to allocate fresh triangles and retains the existing spatial, deformation, material and error semantics. The cache belongs to one content owner, not to a global scene-identity lookup. It retains at most one successful triangle generation per encountered mesh until replacement, clear or dispose; hidden/removed meshes remain retained until clear/dispose. Published snapshots may independently retain old triangles after the owner releases its records. No fixed resource capacity is imposed.

createSurfaceCapture owns one mesh cache alongside its texture cache, decoded pixel provider and material adapters. capture(scene, knownColorGraphs) and its returned surface/lights/lightIds/environment/environmentTexture fields are unchanged. inspect().meshes exposes mesh cache inspection; clear/dispose release all four owned caches/resources. Calling clear does not dispose borrowed Three meshes, geometry, textures or materials.

Every extraction still traverses visibility/layers/noTrace and returns fresh frozen scene/triangle/material/texture/diagnostic arrays. A hit reuses the exact deeply frozen SurfaceTriangle and all of its vertex/vector/identity arrays. Unchanged meshes in mixed static/dynamic scenes keep those references; only meshes with changed signatures extract vertices again. Reuse is per mesh, not per instance or per vertex inside a changed mesh. Frozen records detach all scalar data from borrowed Three arrays. Earlier snapshots remain unchanged.

## Signature and validation boundary

The signature copies scalar state and includes:

- Mesh/geometry UUID and object identity; geometry type, index and all attribute identities, constructors/typed array identities and types, counts, item sizes, normalized flags, CPU accessor identity, buffer version, interleaved data identity/version/stride/count/offset and Float16/GPU type flags.
- drawRange and all groups, material assignment order/identity/UUID/visibility, and resolved side/flatShading/vertexColors flags. Source UUID/material/group identity is always retained, including adapted Node materials.
- Current composed local, stored local/world and computed world matrices; ancestor identity, visibility, layer masks and matrix update policies. Source matrices are never updated by extractSurfaceScene. The existing capture owner still calls scene.updateMatrixWorld as before.
- Instance count, matrix/color attribute identity/version/count/type and actual active matrix/color scalars. setMatrixAt/setColorAt without needsUpdate is observed immediately. A changed instance causes its whole mesh to re-extract.
- Morph influence values/count, relative mode and every morph target attribute identity/version/count/type. Weight changes are observed without needsUpdate.
- Skin skeleton/bone identities, actual computed and stored bone/ancestor matrices, every inverse matrix, bind mode, bind matrix and bind inverse. No skeleton palette update or mutation is used to detect bones. Bone matrix/pose changes are observed without uploading or updating bone textures.

Ordinary geometry/index/morph-target buffer contents changed in place without needsUpdate have the same explicit upload/version boundary as Three buffers. Increment the attribute version via needsUpdate, including interleavedAttribute.data.needsUpdate, to make those edits observable. Replacing an attribute or its typed array is observable without that increment. Object/Bone/Morph-influence/visibility/instance-transform changes do not rely on buffer versions.

Material adaptation, material factors, extension/shader/NodeGraph checks, texture collection/cache checks and material records run each extraction. Color/emissive/roughness/opacity and other uniform factor changes therefore refresh materials without rebuilding triangles. A known engine uniform color graph retains the original material UUID and current evaluated color; removing its known-graph authorization or adding an unsupported node still fails on a warm mesh. The vertex-affecting material flags and side conservatively invalidate mesh triangles. Texture sampler/provider/version changes pass through the existing texture cache; unchanged decoded pixel arrays are not expanded again. Diagnostics, including missing-tangent normal-map diagnostics, are regenerated even when vertices are reused.

Current geometry shape/type/count, hook/deformation, material/group, option and scene checks still precede reuse. A signature miss runs the complete original vertex/morph/skin/transform/finite/degeneracy extraction. Invalid captures never publish an entry for that attempted mesh generation. There is no whole-scene unchanged shortcut.

## Acceleration validation

Each acceleration instance owns weak sets for recursively validated frozen data and validated triangle geometry. The recursive proof visits all own data children (including non-enumerable/symbol children), rejects non-finite numbers and cycles, and memoizes only recursively frozen plain records/arrays. Frozen accessors and custom prototypes are not treated as immutable proof. The triangle geometry set is populated only after normal matrices, indices, vertex vectors, finite Float32 position bounds and nondegenerate geometry pass validation and the recursive immutable proof succeeds.

Subsequent snapshots containing the same proven triangle may skip that vector/normal-matrix/area work. Material existence/reference and triangle identity/uniqueness checks still run for every snapshot. Mutable or partially frozen children are traversed and geometrically validated on every update, so a later NaN/Infinity, singular matrix, invalid index or cycle cannot pass through the cache. dispose replaces both weak sets and clears existing acceleration state. The acceleration frame shape and CPU BVH update/refit behavior are unchanged.

## Verification

Executed in the independent worktree on 2026-11-04 with Node v24.15.0 / Three 0.187.0:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --import tsx --test tests/surface.test.ts tests/acceleration.test.ts tests/surface-cache.test.ts tests/surface-gpu.test.ts tests/bsdf.test.ts tests/denoiser.test.ts tests/render-settings.test.ts
node --import tsx --test tests/texture-pixels.test.ts
```

Typecheck passed. The seven-file suite passed 85 tests and skipped its 2 GPU opt-in tests (87 total). Texture tests passed all 11, including Chromium Fox/WaterBottle texture extraction, cached reads and 23 image checks. The final surface-cache test file was run again after adding mutable-child vector/matrix/index/cycle regressions: all 9 passed. These CPU/texture results do not replace the main branch's PT/hybrid rendered-image checks.

New assertions cover 80% static meshes with skin/morph/instance animation; exact triangle/vertex/vector reference reuse; transforms/ancestry, explicit world policy, bones/inverses/binds, morph target/influence, instance count/matrix/color, buffer/index/interleaved versions, draw ranges/groups, material flags/UUID/visibility, runtime uniform graph colors and invalid warm paths; earlier snapshot isolation and clear/dispose; repeated acceleration validation with partial freezing, accessors, singular matrices, invalid indices, NaN/Infinity, missing materials, duplicate identities and cycles. No elapsed-time thresholds are assertions.

## Generated CPU sample

A sequential isolated run of the final test produces the raw JSON below. 100 meshes, 5494 triangles: 80 static meshes contribute 4414 triangles; 20 animated meshes contribute 1080 (7 skin, 7 morph, 6 single-instance meshes). One shared 64x64 CPU DataTexture is present. Samples move actual bones, morph influences and instance matrices each frame. Each mode primes extraction and acceleration before its five samples. The static mode stops all those animations. Capture timing is extractSurfaceScene only; update timing is acceleration.update, including validation and existing CPU BVH refit and frame copies. The capture owner's lights/environment traversal is not included.

The uncached comparator disables meshCache while retaining textureCache and the same optimized acceleration implementation. It is the original full-extraction allocation path, **not a measurement of the pre-change validator**. The user's real browser warm capture 44.5ms/update 69ms remains an external reference for a later same-scene main-branch comparison. Absolute CPU samples vary with JIT/GC/load and must not be interpreted as browser/GPU throughput. Reused/new triangle and vertex references are deterministic behavior/allocation proxies, not measured heap bytes; signatures, frame arrays and material records still allocate.

| Mode            | capture median ms | update median ms | reused/new triangles per frame | reused/new vertex records |
| --------------- | ----------------: | ---------------: | ------------------------------ | ------------------------- |
| uncachedDynamic |           41.6207 |         109.3769 | 0/5494                         | 0/16482                   |
| cachedDynamic   |           10.4573 |          35.9010 | 4414/1080                      | 13242/3240                |
| cachedStatic    |            1.1716 |          12.0891 | 5494/0                         | 16482/0                   |

All samples retained the same decoded texture pixel reference. Raw milliseconds and reference counts (no filtering or discarded samples):

```json
{
  "node": "v24.15.0",
  "samples": [
    {
      "mode": "uncachedDynamic",
      "sample": 0,
      "triangles": 5494,
      "captureMs": 57.3802,
      "updateMs": 125.98529999999994,
      "reusedTriangles": 0,
      "newTriangles": 5494,
      "reusedVertexRecords": 0,
      "newVertexRecords": 16482,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "uncachedDynamic",
      "sample": 1,
      "triangles": 5494,
      "captureMs": 44.83069999999998,
      "updateMs": 83.0421,
      "reusedTriangles": 0,
      "newTriangles": 5494,
      "reusedVertexRecords": 0,
      "newVertexRecords": 16482,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "uncachedDynamic",
      "sample": 2,
      "triangles": 5494,
      "captureMs": 41.483100000000036,
      "updateMs": 109.37689999999998,
      "reusedTriangles": 0,
      "newTriangles": 5494,
      "reusedVertexRecords": 0,
      "newVertexRecords": 16482,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "uncachedDynamic",
      "sample": 3,
      "triangles": 5494,
      "captureMs": 38.090400000000045,
      "updateMs": 93.78399999999999,
      "reusedTriangles": 0,
      "newTriangles": 5494,
      "reusedVertexRecords": 0,
      "newVertexRecords": 16482,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "uncachedDynamic",
      "sample": 4,
      "triangles": 5494,
      "captureMs": 41.62069999999994,
      "updateMs": 145.98530000000005,
      "reusedTriangles": 0,
      "newTriangles": 5494,
      "reusedVertexRecords": 0,
      "newVertexRecords": 16482,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedDynamic",
      "sample": 0,
      "triangles": 5494,
      "captureMs": 10.457300000000032,
      "updateMs": 33.49569999999994,
      "reusedTriangles": 4414,
      "newTriangles": 1080,
      "reusedVertexRecords": 13242,
      "newVertexRecords": 3240,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedDynamic",
      "sample": 1,
      "triangles": 5494,
      "captureMs": 8.271000000000186,
      "updateMs": 38.112699999999904,
      "reusedTriangles": 4414,
      "newTriangles": 1080,
      "reusedVertexRecords": 13242,
      "newVertexRecords": 3240,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedDynamic",
      "sample": 2,
      "triangles": 5494,
      "captureMs": 11.111499999999978,
      "updateMs": 43.83529999999996,
      "reusedTriangles": 4414,
      "newTriangles": 1080,
      "reusedVertexRecords": 13242,
      "newVertexRecords": 3240,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedDynamic",
      "sample": 3,
      "triangles": 5494,
      "captureMs": 14.927599999999984,
      "updateMs": 35.90100000000007,
      "reusedTriangles": 4414,
      "newTriangles": 1080,
      "reusedVertexRecords": 13242,
      "newVertexRecords": 3240,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedDynamic",
      "sample": 4,
      "triangles": 5494,
      "captureMs": 9.691499999999905,
      "updateMs": 35.8257000000001,
      "reusedTriangles": 4414,
      "newTriangles": 1080,
      "reusedVertexRecords": 13242,
      "newVertexRecords": 3240,
      "texturePixelsSame": true,
      "kind": "refit"
    },
    {
      "mode": "cachedStatic",
      "sample": 0,
      "triangles": 5494,
      "captureMs": 1.1715999999998985,
      "updateMs": 11.026299999999992,
      "reusedTriangles": 5494,
      "newTriangles": 0,
      "reusedVertexRecords": 16482,
      "newVertexRecords": 0,
      "texturePixelsSame": true,
      "kind": "none"
    },
    {
      "mode": "cachedStatic",
      "sample": 1,
      "triangles": 5494,
      "captureMs": 1.1010999999998603,
      "updateMs": 11.962000000000216,
      "reusedTriangles": 5494,
      "newTriangles": 0,
      "reusedVertexRecords": 16482,
      "newVertexRecords": 0,
      "texturePixelsSame": true,
      "kind": "none"
    },
    {
      "mode": "cachedStatic",
      "sample": 2,
      "triangles": 5494,
      "captureMs": 1.2078999999998814,
      "updateMs": 13.703800000000001,
      "reusedTriangles": 5494,
      "newTriangles": 0,
      "reusedVertexRecords": 16482,
      "newVertexRecords": 0,
      "texturePixelsSame": true,
      "kind": "none"
    },
    {
      "mode": "cachedStatic",
      "sample": 3,
      "triangles": 5494,
      "captureMs": 2.02819999999997,
      "updateMs": 20.219400000000178,
      "reusedTriangles": 5494,
      "newTriangles": 0,
      "reusedVertexRecords": 16482,
      "newVertexRecords": 0,
      "texturePixelsSame": true,
      "kind": "none"
    },
    {
      "mode": "cachedStatic",
      "sample": 4,
      "triangles": 5494,
      "captureMs": 1.1204999999999927,
      "updateMs": 12.089100000000144,
      "reusedTriangles": 5494,
      "newTriangles": 0,
      "reusedVertexRecords": 16482,
      "newVertexRecords": 0,
      "texturePixelsSame": true,
      "kind": "none"
    }
  ]
}
```
