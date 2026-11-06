# Temporal Filter (Private Renderer API)

`src/temporal-filter.ts` exports `createTemporalFilter(device): Promise<TemporalFilter>`
and the pure CPU oracle `temporalFilterReference(input: TemporalReferenceInput): Float32Array`.
The mainline `SurfaceTracer` now integrates this filter after a separate primary
motion pass and before spatial a-trous. It uses the existing public `denoise`
setting; no GPU handles or shader source are exposed to game code. This remains
development integration, not complete temporal quality or M3 acceptance.

## GPU Contract

```ts
const filter = await createTemporalFilter(device);
const output = filter.encode(
  encoder,
  inputRadiance,
  normalDepth,
  albedoRoughness,
  reprojection,
  width,
  height,
  { enabled: true, reset: false, progressive: false },
);
// Submit this encoder before encoding a subsequent frame on another encoder.
// Consume/copy the borrowed output before later frames overwrite or resize it.
```

All four inputs contain `width * height` four-float pixels. Radiance RGB is linear;
its W is the actual accumulated sample count, not a frame number. Normal XYZ is
world-space, W is linear camera distance (miss: -1). Albedo RGB is linear in [0,1],
W is roughness in [0,1]. Reprojection is `(previousUV.x, previousUV.y,
expectedPreviousLinearCameraDistance, validFlag)`. Valid flag must be positive;
UVs use pixel centers `(pixel + 0.5) / dimensions` and the same image orientation
as the guide buffers. No velocity/UV conversion or Y flip is applied here.

Inputs require unmapped `STORAGE` buffers with actual capacity at least
`width * height * 16` bytes and vec4-aligned buffer sizes. Enabled normal/albedo
inputs also require `COPY_SRC`. Extra capacity is accepted; binding/copy ranges
are limited to the current image. Inputs bind read-only. Read-only inputs may
alias each other, but enabled inputs cannot alias any filter-owned buffer.
Cross-device/destroyed inputs and closed encoders cannot be fully identified by
synchronous JavaScript inspection: the caller must handle submission validation.

The kernel has exactly eight storage bindings, in order: current radiance,
normal/depth, albedo/roughness, reprojection, previous radiance, previous
normal/depth, previous albedo/roughness, destination. Binding 8 is a 16-byte
uniform. Only destination is writable. Dispatch is 8 by 8 with bounds checks.

The filter owns five buffers: two radiance buffers, previous normal/depth,
previous albedo/roughness, and one uniform buffer with two immutable, aligned
parameter slots (history off/on). These avoid queue uniform updates changing
previously recorded encodes. Each enabled call records one compute pass, then
`copyBufferToBuffer` for both current guides, then swaps radiance ownership.
An output is borrowed storage with `COPY_SRC`; do not destroy or map it.

## Pixel Rules

- Each bilinear history tap is checked separately for in-bounds support, finite
  radiance with positive samples, valid guides, expected-depth error at most
  `0.002 + 0.02 * expectedPreviousDistance`, normalized world-normal dot at least
  0.9, per-channel albedo difference at most 0.1, roughness difference at most 0.1.
- Invalid/offscreen reprojection rejects all history; offscreen taps are omitted,
  never clamped to duplicate edge pixels. Surviving support is normalized. Total
  support below 0.01 is rejected. Sample count is bilinearly averaged with each
  tap's prior count capped at 32, not multiplied by surviving support.
- History RGB is clamped to the YCoCg min/max of the current guided 3 by 3
  neighborhood. Neighbor guides use the same normal/material tests and the
  current center distance for their depth comparison. This conservative clamp
  does not infer changed lighting or scene identity.
- Result RGB is weighted by independent current samples and capped history
  samples. Result W is `current.w + effectiveHistoryCount` (can exceed 32; only
  history's contribution on the next call is capped). It is an effective weight
  after reprojection/clipping, not an exact statistical count of independent rays.
- Missing/reset history writes exact current, including current sample count.
  Misses, invalid guides, invalid motion and invalid current samples also keep
  current unchanged; NaN/Infinity are not silently replaced by black. Invalid
  history is excluded. Finite current RGB is not forced nonnegative. Degenerate
  normals (length squared outside (1e-12,1e12)) cannot reuse history.
- `progressive: true` explicitly means current input already contains earlier
  samples. It always writes exact current and updates history/guides, never adds
  earlier samples again. A current count greater than one does NOT imply this
  mode: an independent dynamic 2-spp frame still combines history by default.
- `enabled: false` returns the identical input buffer, records no passes/copies,
  allocates nothing and invalidates history. Existing allocations are retained.
  Synchronous argument validation still applies, except guide `COPY_SRC` is not
  needed. `reset()` invalidates history without allocations or GPU commands.

## Lifecycle And Invalidation

The integrator owns source snapshot, camera cut, scene, light, exposure/input
semantics and any other history invalidation: call `reset()` or pass `reset: true`.
Progressive accumulation itself must be reset by its owner when needed.
Changing either dimension replaces all five owned buffers and starts fresh.
Steady owned bytes are `4 * width * height * 16 + 2 * alignedUniformStride` and
each allocation set is limited to 512 MiB plus device storage/buffer/dispatch
limits. Transactional resize temporarily retains the old set until replacement
allocation, binding and command recording succeed.

Caller must submit frames in encode order, submit old commands before a resize
or disposal destroys their buffers, and not abandon successfully encoded frames
and subsequently reuse history without a reset. Do not submit an encoder after
an encode exception: it can contain partial commands. Synchronous replacement
failures destroy new resources and preserve old host ownership/history. There
are no encode-time error scopes (a synchronous method cannot await GPU errors);
caller-owned validation scopes must surround submission when validating on GPU.
After any asynchronous GPU failure, reset or recreate the filter as appropriate.

Creation uses an async pipeline, balanced validation scope, device-loss race and
10-second deadline. No owned GPU buffers exist until first enabled encode.
Device loss releases owned resources and prevents further encoding. `dispose()`
is idempotent and never destroys caller inputs. `inspect()` returns detached plain
JSON with entries/bytes, cumulative/last pass count, dimensions, host history-valid
flag, disposed/lost flags. History-valid means a frame was encoded, not that every
pixel accepted history or that submission was observed to complete.

## CPU Comparison

```ts
const expected = temporalFilterReference({
  width,
  height,
  inputRadiance,
  normalDepth,
  albedoRoughness,
  reprojection, // ArrayLike<number>
  previousRadiance,
  previousNormalDepth,
  previousAlbedoRoughness, // optional
  reset: false,
  progressive: false,
  enabled: true,
});
```

This stateless oracle does not retain arrays or mutate inputs. Feed it the prior
**filtered** radiance output and prior **unfiltered** current guides, or omit any
previous array to model missing history. On resize omit history. After a disabled
frame omit history on the next frame too. On progressive frames its exact-current
output becomes the next history. Output is a new `Float32Array`. Intermediates
are JS doubles, so compare GPU numbers using tolerances, not bitwise equality
except on ordinary exact-copy paths. Avoid threshold-boundary fixtures when
assessing arithmetic parity (f32 UVs, dot products and depths can round across a
threshold). NaN payload bit identity and extreme overflow are not CPU/GPU parity
guarantees.

## Evidence Boundary

Mainline integration uses the existing 72-float triangle prefix plus a 12-float
previous-position suffix, addressed through the same raw vec4 geometry binding.
Transport, primary raster and motion share a 368-byte uniform definition. The
four-plane radiance/guide storage buffer is unchanged; motion writes a separate
plane so native 1080p does not require a fifth plane in one storage binding.
The motion pass follows the transport's first-sample RNG and visibility. Hybrid
keeps raster visibility but reconstructs precise ray-space barycentrics on the
selected triangle rather than trusting raster subpixel interpolation. If that
face does not contain the precise pixel ray, primary ID -2 requests an exact
GPU closest-hit query in BOTH transport and motion. Barycentrics are not clamped
into a false medium boundary; the transport scatter RNG is preserved.

Geometry/camera motion resets progressive accumulation, not all temporal history.
New identities and depth/normal/material checks reject per-pixel history. Scene,
material/texture, semantic lighting, environment, medium and mode changes reset
history. Successful checkpoint restore invalidates after Host commit; failed
preflight leaves it untouched. Device reconstruction starts with fresh history.
GPU light-table index remaps are uploaded without pretending semantic lighting
changed. Moving emitting geometry still resets history conservatively.

Development hooks provide raw, temporal-only and final spatial outputs, plus
guides/motion. They are absent from the production control interface and are not
game SDK APIs. Progressive frames deliberately do not recompute motion; reading
it then raises `TC_MOTION_NOT_CURRENT` rather than returning stale data as current.
`denoiseIterations` controls spatial passes; `denoise=false` disables the entire
filter chain. Timing/owned-buffer scopes are reported separately.

`tests/temporal-filter.test.ts` exercises numeric CPU behavior and recording-fake
host lifecycle/ABI/ordering/rollback. Fakes never execute or validate WGSL.
These are limited validation, not full temporal acceptance: real GPU compilation,
numeric CPU/GPU comparisons, actual motion/previous-geometry integration,
disocclusion sequences, ghosting/noise/edge quality and end-to-end renderer
acceptance remain the integrating task's responsibility. No browser, GPU or
server probes are run by that isolated module's tests. Mainline development probes
add the original 18 independent CPU/GPU motion cases, an explicit refinement
contract for motion/transport, and actual path/hybrid motion sequences
in `examples/temporal`, including independent 2-spp frames, progressive-copy
semantics, disocclusion, spawn/material replacement, light changes, restore,
mode switching and device loss. Frozen-pose 256-spp references are from the same
integrator, not independent radiometric ground truth.

Remaining acceptance includes broad glossy/refractive/alpha motion, indirect
visibility changes, long ghosting/edge sequences, viewport/resolution transitions,
arbitrary resource failures and more hardware. A primary-surface motion vector
alone does not prove correct multi-bounce/refraction reprojection. No full M3
acceptance or performance target is inferred from the selected probes.
