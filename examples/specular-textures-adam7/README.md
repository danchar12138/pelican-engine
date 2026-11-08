# Low-bit Adam7 specular texture probe

The original MIT fixture uses a two-bit indexed Adam7 PNG with transparent
palette entries for the glTF specular color. Run from the repository root:

```sh
node --import tsx tools/prepare-specular-adam7-glb.ts
node --import tsx tools/specular-textures-game-probe.ts --exclusive-gpu --project examples/specular-textures-adam7 --output .pelican/specular-textures-adam7
```

This is a small development probe, not complete M3 acceptance.
