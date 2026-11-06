# 16-bit specular texture probe

This public-API fixture uses the same original MIT scene and authored pixels as
`examples/specular-textures`, with its embedded PNGs regenerated at 16-bit.
From the repository root:

```powershell
node --import tsx tools/prepare-specular-textures16-glb.ts
node --import tsx tools/specular-textures-game-probe.ts --exclusive-gpu --project examples/specular-textures-16 --output .pelican/specular-textures-16
```

The GPU probe requires exclusive access to a non-fallback WebGPU device. It is
a small rendering check, not complete format or milestone acceptance. See
`docs/tasks/M3-SPECULAR-TEXTURES.md` for color-metadata limitations and evidence.
