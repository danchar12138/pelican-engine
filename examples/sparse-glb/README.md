# Sparse GLB public game

The triangle is authored with a zero-initialized POSITION accessor and two
sparse replacements. Press A for the optimized asset and B for the original.
The game imports only the public SDK. Both generated GLBs are MIT-licensed.

From the repository root, run the CPU preflight and the software browser probe:

    npx tsx tools/sparse-glb-browser-probe.ts --cpu-only
  npx tsx tools/sparse-glb-browser-probe.ts

The browser probe explicitly disables WebGPU and requires a verified
SwiftShader WebGL2 renderer before loading the game. It checks real canvas
pixels and compares original and optimized frames, allowing up to 0.1% of
pixels to differ by more than three levels per channel. It is not hardware GPU
or full renderer acceptance evidence. Generate the fixtures into a new empty
directory using the exported prepareSparseAssets function; the generator will
not overwrite existing assets.

This example verifies only its zero-base VEC3 sparse positions. The locked
Three.js GLTFLoader rejects sparse MAT4 and silently decodes sparse accessors
with an interleaved base incorrectly. The browser probe reproduces both issues;
asset inspection support is not a claim of renderer support for these cases.
Until the runtime loading path is fixed, do not feed those assets to it.
