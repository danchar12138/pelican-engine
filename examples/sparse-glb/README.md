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

The runtime model loader normalizes sparse accessors into tightly packed GLB
buffer views before invoking Three.js. This keeps the source asset lossless and
allows 32-bit sparse matrix and interleaved-base layouts to follow the same loader path.
The normalization is bounded and reports a stable asset error when the expanded
data cannot be represented safely. This change has not been runtime-validated.
