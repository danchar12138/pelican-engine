# M3 Surface Gallery

Development scene using the public SDK. `npm run dev` currently loads this scene by default; its implementation is still being integrated and is not an accepted M3 release.

- `1`, `2`, `3`: raster, hybrid, path.
- `Space`: toggle rigid mesh motion.
- `N`: toggle the spatial denoiser.
- `D`, `I`: toggle direct and indirect lighting for contribution checks.

Fox and WaterBottle retain the fixed source and license metadata copied from the M2 asset set. Rendering controls belong to `game.render` and `ctx.render.configure/state`; game code never calls Three.js or raw GPU APIs.

Hybrid rasterizes primary visibility and then evaluates the same surface/light transport with actual shadow and secondary rays. It does not alpha-blend a separate uncorrelated image over raster. Path mode uses surface BVH ray traversal. Both paths use opaque GGX, supported point/directional lights, emissive-geometry sampling/MIS and the captured studio HDR environment. Unsupported physical-extension/transmission combinations remain explicit. Spatial denoising is not temporal motion reconstruction.

The image, surface numeric, dynamic-ray and static-production probes live in `tools/m3-image-probe.ts`, `surface-gpu-probe.ts`, `surface-ray-gpu-probe.ts`, and `m3-static-probe.ts`. They are development evidence, not the full milestone acceptance verifier. Current limitations and remaining work are listed in `docs/ARCHITECTURE.md`.
