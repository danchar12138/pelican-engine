# Previous Surface Positions

`src/surface-motion.ts` is an internal, CPU-only M3 temporal prerequisite. It
exports `packPreviousSurfacePositions(previous, current, ordered = current.triangles)`.
It does not change the public SDK or return GPU handles. Mainline `SurfaceTracer`
now uploads its output for the separate primary motion pass when denoising is
enabled; this helper remains geometry correspondence, not a history-validity test.

## Layout

The returned `{ data: Float32Array, matched: number, missing: number }` contains
one 12-float record for each **current** triangle in `ordered`:

```text
oldAx oldAy oldAz matchedFlag
oldBx oldBy oldBz 0
oldCx oldCy oldCz 0
```

Positions are previous extracted world-space coordinates, in the previous
triangle's original A/B/C vertex order, rounded to Float32. `matchedFlag` is 1
exactly when the geometry identity exists in both snapshots. Missing previous
history or an unmatched triangle produces twelve zeros, never current positions
with a valid flag. `matched + missing === current.triangles.length`. Removed
triangles produce no records; empty current snapshots produce fresh empty data.

## Identity And Validation

Matching uses exactly the identity expression from `acceleration.ts`:

```ts
JSON.stringify([
  objectUuid,
  geometryUuid,
  instanceId,
  groupIndex,
  elementOffset,
  vertexIndices,
]);
```

Material UUID/index, positions and normals are not identity. Transform changes,
position refits, skin/morph deformation, and material changes can retain matches.
Each added/changed identity is missing independently; array/leaf reordering does
not invalidate unchanged identities. Replacing an object or geometry UUID does.
UUID reuse with identical keys cannot be detected; callers own snapshot lifetime
and continuity, including intervening removal/recreation.

Both supplied snapshots must have version 1 and array-valued triangles, materials,
textures and diagnostics. Identity UUIDs must be nonempty strings; instance,
element and vertex indices must be nonnegative safe integers, with exactly
three dense vertex indices. Group indices are safe integers >= -1, preserving
the extractor's `groupIndex: -1` sentinel for single-material ungrouped meshes.
Both explicit-group and ungrouped extraction are tested. Duplicate identities in
either snapshot are errors.
`ordered` must be a complete identity permutation of current triangles: detached
triangle copies are accepted, but unknown, repeated, omitted or sparse entries
are rejected, even when previous history is absent.

Every previous triangle, including removed/unmatched triangles, must have exactly
three vertices with dense three-number positions. Coordinates must be finite
and within +/-3.4028234663852886e38. Ordinary Float32 rounding and underflow are
allowed; overflow, non-numbers and holes are rejected. Current/ordered coordinates
are not read. This is not a replacement for full surface extraction validation:
material/normal/light records are not validated by this packer.

Failures throw `Error` with `TC_SURFACE_MOTION_INVALID_SNAPSHOT`,
`TC_SURFACE_MOTION_INVALID_IDENTITY`, `TC_SURFACE_MOTION_DUPLICATE_IDENTITY`,
`TC_SURFACE_MOTION_INVALID_POSITION`, or `TC_SURFACE_MOTION_INVALID_ORDER` in the
message, plus the offending input location and a repair hint. Null/undefined
current snapshots also receive a stable snapshot diagnostic.

## Ownership And Limits

Each call returns a fresh object, typed array and buffer. It never mutates,
freezes or retains caller snapshots, triangle/order arrays or coordinates, and
maintains no history cache. Callers explicitly own previous/current lifetimes.

A match proves **geometry continuity only**. It does not establish material,
normal, lighting, visibility/disocclusion, camera, or accumulated-history validity.
This helper itself performs no projection/filtering or GPU operations. Its
mainline consumers are described in `TEMPORAL.md`; their selected development
tests do not turn geometry correspondence into complete M3 temporal acceptance
or a performance claim.

## CPU Verification

```powershell
node_modules/.bin/tsx.cmd --test tests/surface-motion.test.ts
npm.cmd run typecheck
```

Tests use actual Three extraction fixtures for parent/object transforms,
mirrors/instances, refit versus topology changes, material/order changes and
skin plus morph, plus malformed inputs, missing history and detached ownership.
No GPU, browser, server or performance workload is required.
