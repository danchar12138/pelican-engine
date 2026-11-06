# Vertex Surface Extraction

Engine-private CPU extraction hooks in `src/surface.ts` implement the domain in
`src/vertex-contract.ts`. These are not SDK APIs or GPU execution evidence.

## Selection And Inputs

- `SurfaceExtractionOptions.meshFilter(mesh)` selects meshes before geometry,
  material, adapter, and deformation validation. Returning false skips that mesh,
  not its children. Visibility, layers, and `noTrace` keep their existing meaning.
- `vertexDeformer.evaluate(mesh, materialUuid, input)` runs for each extracted
  vertex in each material segment and instance. Shared indices may be evaluated
  more than once. Material UUIDs retain the original assigned material identity.
- `positionLocal` is after built-in morph, skin, and instance transforms, before
  object/parent world transforms. `vertexIndex` is the geometry index;
  `instanceIndex` is the native instance ID (zero for ordinary meshes).
- `normalLocal` is the normalized post-morph/skin normal transformed by the
  inverse transpose of the instance matrix. Without a normal attribute it is
  zero, preserving position-only graphs and the existing face-normal fallback.
- Optional `uv`/`uv1` are raw attribute coordinates, not texture-transformed.
  Existing normalized/interleaved accessors and count/size/finite checks apply.

## Outputs And Validation

An undefined result preserves the existing position and normal paths. A returned
position is absolute in the post-instance, pre-world domain, not a displacement;
world transforms apply once afterward. A supplied normal replaces the normal in
that domain and receives only the world inverse transpose and normalization.
Without a normal output, the original combined instance/world normal path stays
unchanged. Flat shading and absent normals still use the deformed triangle face.

Positions and normals must be finite (`SURFACE_NON_FINITE`); supplied normals must
be nonzero (`SURFACE_NORMAL_INVALID`). The graph evaluator owns the zero-graph-
normal fallback to its input normal before returning. Supplying a normal without
a normal attribute fails explicitly with `TC_VERTEX_NORMAL_ATTRIBUTE`. Degenerate
deformed faces retain `SURFACE_DEGENERATE_TRIANGLE` validation.

Tangents retain the old skin and combined direction transforms and handedness.
Neither normals nor tangents are automatically differentiated from position
deformation. No-deformer meshes retain their original numeric transform path.

## Cache And Sampling

Mesh cache signatures include deformer presence and a copy of each flat value
from `signature(mesh)`, in addition to existing geometry, morph, skin, instance,
group, material, and world state. The deformer must supply all relevant graph,
time, parameter, and texture versions/transforms. The signature values are the
semantic cache key, not the identity of the returned array or deformer object;
fresh arrays with equal values hit the cache. Do not return borrowed mutable
arrays/objects as individual values. A mesh is published only after successful
extraction and deep freezing; failed extraction leaves its prior entry intact.

`sampleSurfaceTexture(texture, uv)` validates finite UVs and delegates directly
to the existing material sampler at its base-level `magnification` footprint.
Texture matrix, wrapping, nearest/linear mag filter, decoded row orientation,
alpha, and sRGB conversion are shared, not reimplemented. Missing CPU pixels
retain the existing explicit error. This does not add mip/derivative sampling.

## Focused Verification

Run `node_modules/.bin/tsx --test tests/vertex-surface.test.ts` for CPU-only actual
Three mesh, morph/skin, instance/group, world, validation, filter, sampling, and
cache coverage. Related surface/cache regression tests are sufficient for this
isolated change; consolidated typechecking and GPU/browser integration belong
to the main task. No full-suite, M3, performance, or packaging acceptance is
implied.
