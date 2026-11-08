# 16-bit PNG metadata probe

This MIT fixture extends `examples/specular-textures-16` with standard sRGB
`gAMA`, `cHRM`, and `sRGB` PNG chunks. From the repository root:

```sh
node --import tsx tools/prepare-specular-textures16-glb.ts --metadata
node --import tsx tools/specular-textures-game-probe.ts --exclusive-gpu --project examples/specular-textures-16-metadata --output .pelican/specular-textures-16-metadata
```

This small hardware probe is not complete format or milestone acceptance.
