# Native fragment buffer slots

`compileSurfaceGraphs(snapshot, bindings, maxMaterialBytes?)` returns `bufferCopies`
with the generated WGSL and CPU parameter `rows`. Each copy contains the original
compute `descriptor`, absolute destination `byteOffset` in the material table,
`count`, `type`, material ID and slot name. Only output-reachable fragment reads
reserve space; vertex declarations do not reserve native fragment slots.

All materials' time and parameter rows come first. Each needed slot then reserves
`ceil(count / 8)` zero-filled `SurfaceMaterial` rows (32 floats / 128 bytes each).
The shader reads `row + element / 8` and selects one of `base`, `factors`,
`emission`, `maps0`, `maps1`, `normal`, `physical`, `attenuation` using `element % 8`.
Typed helpers swizzle vector/scalar values and convert bool from the first lane.
Negative, fractional, nonfinite and out-of-count indexes return typed zero before
any storage access. Nonfinite values are rejected by their f32 exponent bits.

`SurfaceTracer.update(scene, knownGraphs?, motionEnabled?, graphs?, computeSource?)`
accepts the engine-private `ComputeResidentSource` as its fifth argument. A used
fragment slot without this source fails with `TC_RENDER_BUFFER_CAPABILITY`.
Unused slots and scenes without fragment reads need no compute source.

The tracer validates the complete plan and all resident views before table uploads
or copy encoding. The combined table must fit both device buffer limits, including
allocation alignment. Views must match type, count and revision, have sufficient
bytes and `COPY_SRC` usage, be unmapped, and belong to a different buffer from the
material destination. Invalid resources fail with `TC_RENDER_BUFFER_RESOURCE`;
oversized tables fail with `TC_RENDER_BUFFER_LIMIT`.

After CPU material-table uploads, the tracer copies `count * 16` bytes per needed
slot from `computeSource.resident(descriptor).buffer` into the existing material
storage buffer. CPU uploads contain only material properties, graph parameters and
zero placeholders. Compute result elements are never read or packed by this path.
No additional storage binding is introduced.

Source key/revision/buffer identity, destination buffer/offset, type and count are
tracked. Unchanged updates skip GPU copies. Any material-table upload or allocation
forces all active slot ranges to be copied again. Source identity/revision and slot
layout changes invalidate accumulation and temporal history even when CPU
placeholder rows are identical. Source keys, revisions and values do not enter the
shader source; count/type changes rebuild typed helpers and update reservations.

`inspect().materialGraphs.bufferSlots` contains:

- `slots`: number of active native fragment slots.
- `gpuCopies`: cumulative slot copies in the current content lifecycle.
- `gpuCopyBytes`: cumulative bytes copied in that lifecycle.
- `cpuResultUploads`: always `0`.
- `bindings`: plain `{ material, name, type, count, key, revision, byteOffset }`
  records, with no GPU handles.

`materialGraphs.parameterRows` counts time/parameter rows only. `clearContent()`
and `dispose()` clear slot tracking and counters. The tracer owns the material
buffer; it never destroys borrowed compute source buffers.

Focused validation is in `tests/fragment-buffer-tracer.test.ts`. Its CPU command
recorder checks plans, WGSL structure, update ordering, copy reuse, history reset,
validation and resource ownership. It does not execute WGSL or constitute hardware
pixel validation; browser/path/hybrid integration and GPU checks belong to main.
