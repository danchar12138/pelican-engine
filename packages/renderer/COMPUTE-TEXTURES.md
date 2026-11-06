# Compute texture executor

The frozen boundary is `docs/tasks/M3-COMPUTE-TEXTURES.md`. This executor accepts
named `request.textures` matching `kernel.textures`. A texture descriptor has
`type: "vec4"`, `texture: { width, height }`, and exactly `width * height` packed
values. Buffer and sampled texture bindings are checked separately. Texture
shapes, resource type/count, exact packed revision bits, declaration options and
actual device dimensions/binding limits are validated before GPU allocations.
Buffer-only work does not require texture limits or texture usage constants.

Each texture checkpoint owns a packed storage buffer and an rgba32float GPU
texture. The initial CPU checkpoint uploads both representations; texture data
uses `queue.writeTexture`, with tightly packed rows. `textureResident` returns
only the renderer-private texture, width, height and revision. `resident` returns
the buffer mirror with the existing private buffer view shape. Texture views
exist only while constructing internal bind groups.

Sampled bindings use `texture_2d<f32>` and an explicit unfilterable-float layout.
WGSL implements nearest or bilinear filtering with `textureLoad`; defaults are
linear filtering and clamp on each axis. Repeat and mirrored repeat normalize
finite UVs before conversion to texel indices, including huge finite f32 values.
Integer addressing also applies to every bilinear tap. Nonfinite UVs set fault
bit 4. Readback preserves bounds (bit 1), nonfinite result (bit 2), then texture
coordinate (bit 4) error priority. Bit 4 is unknown for a shader with no texture
bindings, preserving the buffer-only unknown-fault diagnostic.

`pixelCoord`, `outputSize` and centered `uv` use the output dimensions; buffer
outputs use `count` by one. A texture output is written by the same invocation to
both a real `texture_storage_2d<rgba32float, write>` and the packed output buffer.
CPU readback verifies the buffer and all error scopes before either resource
becomes a candidate. `commit` publishes the pair at one revision with no GPU
writes. Retained feedback and exact task-result versions reuse the GPU texture
and mirror without any CPU uploads. Candidates, collected versions, released
keys, cancellation, failed dispatches, disposal and device loss destroy owned
pairs together. Nonretained output pairs are temporary.

Ordinary dispatch snapshots may carry the additive private `captured: true`
marker. An unknown older captured CPU checkpoint can upload after a pure
producer has committed newer versions. Exact GPU history always takes priority,
including its packed-bit and shape checks. Unmarked unknown older descriptors
remain errors; collected computed task history has no unmarked upload fallback.
The highest checkpoint/commit metadata survives cache replacement and collection
until release, so staging an older captured revision cannot forget the newer
revision or permit a same-revision content collision. This worktree reads the
additive marker without editing the runtime contract owned by main.

`inspect()` adds `liveTextures`, `textureUploads`, `textureResidentHits` and
`storageTextureDispatches`. Texture hits count existing GPU textures selected by
sampling or `textureResident`; ordinary buffer mirror lookups keep their existing
counters. Texture uploads count successful native texture writes separately from
`uploads = inputUploads + checkpointUploads`, which continues to count packed
buffer uploads. Parameter and fault writes are excluded. `allocations` includes
buffers and textures. `residentBytes` includes both committed representations;
`cachedBytes` continues to count packed CPU input bytes.

Focused verification:

```sh
node --import tsx --test tests/compute-texture-executor.test.ts tests/compute-executor.test.ts tests/compute-resident.test.ts
```

These mocks inspect ownership, layouts, emitted WGSL, fault decoding and paired
publication. They inject readback and do not evaluate WGSL or provide numerical
GPU evidence. Main owns real hardware sampling/storage validation and integrated
compiler/runtime/type checks. No GPU probe, full suite, installation or platform
changes are part of this worktree.
