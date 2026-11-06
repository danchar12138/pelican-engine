# Rope and dynamic sphere example

This development example explicitly binds a rope collider to a dynamic sphere.
The host samples the sphere's velocity and effective mass after its physics step,
then advances the rope with a virtual body and applies the opposite normal impulse.
The boxes mark particle positions; there is no rope mesh. Actual body displacement
responds on its next physics step. Virtual transform changes are first-order; ropes
are processed sequentially without shared substeps. Friction, restitution and
continuous collision are not implemented; only detected overlaps are resolved. This is not a complete or validated
solver; a native failure may leave partial host state and requires restoring a
known-good checkpoint.

From the engine checkout, build with:

```sh
node --import tsx tools/cli.ts build --project examples/rope-reaction
```

The example has been compiled only under the current project policy; no runtime,
browser, stability or snapshot compatibility validation is claimed.
