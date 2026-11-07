# Asset inspection (M2 subset)

`src/index.ts` exports the read-only, offline entry point:

```ts
inspectAsset(
  file: string,
  type: "model" | "texture" | "audio" | "binary",
): Promise<Record<string, unknown>>;
```

The inspector reads actual file bytes, validates the supported representation and
returns plain JSON. It does not read sidecar metadata, load external resources,
write to the source file, generate assets, or require a browser or online service.
Locked `@gltf-transform/core` and `@gltf-transform/extensions` read validated GLB documents. No dependencies are
installed or changed by this package.

## Explicit lossless optimization

`src/optimize.ts` exports `optimizeModel(input, output)` using locked glTF-Transform functions. It deduplicates resources while preserving unique names and welds bitwise-identical complete vertex streams. It verifies triangle count, static bounds, skin/joint counts, animation metadata and supported physical-material extension factors after processing. Output must be a new `.glb`; the source and existing outputs remain unchanged. The compiler validates the adopted output as any other asset. Tests compare actual triangle vertex streams, not just counts. This is not mesh quantization or texture transcoding.

The CLI exposes `optimize --project <game> --asset <model-id> --output <new-project-relative.glb>`. Keep the asset's source/license/attribution when updating its path. `build` also emits lossless HTTP Brotli/Gzip companions and a manifest; identity files remain available for ordinary static deployment.

Self-contained GLB sparse accessors with packed or zero-initialized bases are inspected after applying their indexed replacements. Indices must be strictly increasing and in range; offsets and buffer views are validated. The runtime model loader expands sparse accessors, including interleaved bases and 32-bit matrix accessors, into tightly packed buffer views before handing bytes to Three.js. Sparse normalization is bounded to 128 MiB of expanded accessor data and preserves the original asset bytes on disk. Sub-32-bit matrix accessors remain unsupported. This development change has only been compiled, not runtime-validated.

Material texture slots accept `KHR_texture_transform` offset, rotation, scale and UV-set override. UV sets, including specular texture slots, are limited to `TEXCOORD_0` and `TEXCOORD_1`. The optimizer preserves texture images, sampler settings and transforms across supported material slots. Specular UV1, rendering and optimizer behavior for this addition remain unverified at runtime.

## Metadata contract for compiler and services

Every successful result includes `format`, `bytes` (whole file length) and
`sha256` (lowercase SHA-256 of the exact whole file). Format comes from the file
bytes. Recognizable supported extensions with broken signatures are invalid;
unknown formats are unsupported. A binary is intentionally opaque, including an
empty binary, and receives only these three fields.

Model metadata has:

- `format: "glb"`, `version: "2.0"`, `bufferBytes` excluding BIN padding.
- Counts: `meshCount`, `primitiveCount`, `vertexCount`, `triangleCount`,
  `nodeCount`, `sceneCount`, `materialCount`, `textureCount`, `imageCount`,
  `skinCount`, `jointCount`, `animationCount`. Geometry counts sum primitive
  definitions, not scene instances; shared vertex accessors count once per
  primitive use. Triangle strips/fans contribute element count minus two.
  `jointCount` sums joints per skin, so shared joints may count in several skins.
- `meshes[]`: index, name, morph target count and `primitives[]` with actual
  vertex/element/triangle counts, primitive mode, material index or null, morph
  target count, and local bounds computed from vertex bytes.
- `materials[]`: index/name, `pbr` with base color/metallic/roughness factors,
  emissive factor, alpha mode, double-sided flag, and `textures` slots
`baseColor`, `metallicRoughness`, `normal`, `occlusion`, `emissive`. Supported
`KHR_materials_emissive_strength` factors are also included in material metadata. Slots hold
  glTF texture indices or null; defaults are glTF 2.0 defaults.
- `textures[]`: index/name, `image` index, and sampler index or null.
- `images[]`: index/name, encoded image bytes, `format`, `width`, `height`,
  `bitDepth`, `channels`, plus the texture format fields below. Image dimensions
  are pixels and are checked against the actual encoded payload.
- `skins[]`: index/name, `jointCount`, joint node indices, skeleton node index
  or null, inverse bind matrix accessor index or null.
- `bounds`: `{ min: number[3], max: number[3] }` or null with no scene geometry.
  `boundsScene` identifies the selected default scene (first scene if omitted),
  or null with no scene. `boundsSpace: "world-static-default-pose"`: exact
  transformed vertex bounds at the authored static pose, **without applying
  skin deformation, morph deformation or animation**. These are not animated
  motion bounds. Other scenes and orphan meshes still have primitive local bounds.

`animations` is an **object array, not `string[]`**:

```ts
{
  animationCount: 3,
  animations: [{
    index: 0,
    name: "Survey",        // Fox also has "Walk" and "Run"
    start: 0,              // seconds: earliest referenced input timestamp
    end: 3.4166667461395264,// seconds: latest referenced input timestamp
    duration: 3.4166667461395264, // seconds: end - start
    channelCount: 21,
    samplerCount: 21,
    keyframeCount: 1743,    // sums input counts per sampler, not per channel
    channels: [{
      node: 2,
      path: "rotation",    // translation | rotation | scale | weights
      sampler: 0,
      interpolation: "LINEAR", // LINEAR | STEP | CUBICSPLINE
      keyframeCount: 83,
    }],
  }],
}
```

The channel entry above illustrates the shape; use returned channel values.
Names preserve authored names. Missing/empty clip names become `animation_<index>`
to match the renderer's GLTFLoader. Name uniqueness is not guaranteed by glTF.
There is no top-level model `duration`. The compiler should narrow the unknown
metadata values, find `animations[].name === model.animation.clip`, and retain
this JSON result in `IR.metadata`. Compiler integration is outside this package.
A clip whose first timestamp is nonzero has `duration = end - start`; a runtime
using the original timeline must use `end` as its final timestamp.

Independent textures expose `width` and `height` **at the top level**, in pixels:

```ts
{ format: "png", bytes: 70, sha256: "...",
  width: 1, height: 1, bitDepth: 8, channels: 4,
  colorType: 6, hasAlpha: true }
{ format: "jpeg", bytes: 137, sha256: "...",
  width: 1, height: 1, bitDepth: 8, channels: 1,
  encoding: "baseline-huffman" }
```

PNG `channels` is the encoded color sample count (indexed PNG has one palette
index channel); `hasAlpha` includes a valid tRNS chunk. JPEG reports encoded frame
components. EXIF display orientation is not applied; dimensions describe pixels.
Radiance RGBE `.hdr` textures report `format: "hdr"`, `encoding: "rgbe"`,
three color channels and linear color space. This development implementation
supports `-Y/+X` orientation and modern scanline RLE or raw pixels, with at most
16,777,216 pixels; legacy run encoding is rejected. Runtime decoding uses Three's
HDRLoader with float32 data and has not been runtime-validated. Non-default
`GAMMA` or `EXPOSURE` metadata is rejected because the runtime decoder does not
apply those transforms.

Audio metadata has **top-level `duration` in seconds**, suitable for deterministic
sound lifetime accounting; there is no milliseconds conversion:

```ts
{ format: "wav", bytes: 60, sha256: "...", encoding: "pcm",
  channels: 2, sampleRate: 8000, bitsPerSample: 16,
  frameCount: 4, dataBytes: 16, duration: 0.0005 }
```

`frameCount` counts complete multi-channel sample frames and
`duration = frameCount / sampleRate`, not sample count divided by sample rate.
Float WAVE uses `encoding: "ieee-float"` and requires a matching `fact` frame count.

## Validation and explicit support limits

- **GLB**: core glTF 2.0, one JSON chunk followed by at most one embedded BIN.
  Checks actual file/chunk/buffer lengths, padding, view/accessor ranges, component
  sizes, alignment/stride, decoded finite values and declared bounds. Checks core
  node references, a tree without cycles or multiple parents, scene roots, TRS
  transforms, geometry/index/attribute consistency, PBR/image references, skins,
  joint indices/weights/inverse bind counts, animation targets, strictly increasing
  times, interpolation, output types/counts and quaternion normalization. Morph
  target attributes and weight animation counts are checked.
- Only embedded buffer views with checked **PNG or baseline JPEG** image data.
  Every URI (including data URI) is explicitly unsupported; missing embedded
  references are invalid. No filesystem or network fetch follows a resource URI.
- **PNG**: non-interlaced legal color types/depths; chunk lengths/order, CRC,
  required chunks, palette/transparency, zlib stream and exact decoded length,
  row filters, and palette pixel bounds. Unknown ancillary chunks are CRC-checked
  and ignored; their optional descriptive/color metadata is not interpreted.
- **JPEG**: 8-bit grayscale or three-component baseline sequential Huffman,
  single complete scan; quantization/Huffman tables, frame/scan components,
  entropy-coded DC/AC blocks, byte stuffing, restart sequence, padding and EOI.
  Does not reconstruct pixels/IDCT. APP/COM metadata is skipped and not interpreted.
- **Radiance RGBE**: bounded header, supported orientation, exact pixel data and
  modern scanline run lengths. Legacy run encoding and other orientations are
  unsupported. This applies to standalone textures, not embedded glTF images.
- **WAV**: little-endian RIFF/WAVE PCM (8/16/24/32-bit) and IEEE float (32/64-bit),
  one fmt and one nonempty data chunk; exact RIFF/chunk sizes and word padding,
  byte rate, frame alignment, finite float values, and fact count for float.
  Unknown ancillary chunks are bounded and skipped.
- Inspection limits: 256 MiB decompressed PNG, 16 million accessor scalar values,
  and 8 million JPEG blocks. Exceeding these gives an explicit unsupported error.

Remaining gaps deliberately return unsupported: `.gltf`, external/data resources,
glTF extensions other than the `KHR_materials_specular` factor and UV0/UV1 texture subset,
`KHR_materials_ior`, `KHR_materials_emissive_strength`, `KHR_materials_unlit`, `KHR_lights_punctual`, and `KHR_texture_transform` (including Draco/Meshopt/KTX2),
matrix accessors requiring column padding, cameras, joint/weight sets beyond 0, APNG,
progressive/lossless/arithmetic/multiple-scan/CMYK JPEG, RF64/RIFX/WAVE extensible,
compressed WAVE, MP3/Ogg/AAC and other image/audio codecs. The package does not
provide lossy transcoding, asset generation, a general-purpose authoring system,
or a complete glTF/asset capability claim. Supported subset validation is not a
replacement for a complete Khronos conformance validator.

## Diagnostics and verification

`AssetInspectionError` exposes `code`, `file`, `resource`, `suggestion`; its message
includes these identifiers and the concrete reason. Stable codes are:

- `TC_ASSET_MISSING`: path does not exist (ENOENT/ENOTDIR).
- `TC_ASSET_INVALID`: corrupted/truncated data, invalid supported schema, missing
  embedded references, or read errors such as trying to inspect a directory.
- `TC_ASSET_UNSUPPORTED`: format/encoding/extension/resource mode/inspection limit
  outside the subset above.

An embedded image diagnostic identifies `file#images/<index>`. A failed inspection
returns no partial metadata. Binary inspection intentionally validates no format.

From the worktree root, with the existing read-only dependency junction:

```powershell
node node_modules/prettier/bin/prettier.cjs --write packages/assets tests/assets.test.ts
node --import tsx --test tests/assets.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Tests inspect the real Fox and WaterBottle files under `examples/m2/assets`, assert
actual counts/hash/clip/PBR/texture values, and build independent binary fixtures
for corruption, missing resources, animations, skeletons, PNG, JPEG, WAV and binary.
Temporary fixtures live under this package and are cleaned after the tests.
