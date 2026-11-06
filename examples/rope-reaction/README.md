# Rope and dynamic sphere example

This development example explicitly binds a rope collider to a dynamic sphere.
The host samples the real sphere after its physics step, advances the rope, and
applies the particle projection's opposite normal impulse to the body. The boxes
mark particle positions; there is no rope mesh. The body's displacement responds
on its next physics step. The rope solver does not include the body's effective
mass or velocity, friction, continuous collision or fully coupled substeps. This
is not a complete or validated two-way physics solver; a native failure may leave
partial host state and requires restoring a known-good checkpoint.

From the engine checkout, build with:

```sh
node --import tsx tools/cli.ts build --project examples/rope-reaction
```

The example has been compiled only under the current project policy; no runtime,
browser, stability or snapshot compatibility validation is claimed.
