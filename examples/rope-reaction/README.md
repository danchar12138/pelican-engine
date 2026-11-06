# Rope contact reaction example

This development example samples a dynamic sphere before each physics step,
then applies rope projection reaction impulses after the rope step. The boxes
mark particle positions; there is no rope mesh. The sampled sphere can lag the
actual rigid body, and the particle solver does not use the body's velocity,
rotational inertia, friction or continuous collision detection. This is not a
fully coupled or validated physics solver; applying the linear and angular
impulses is not atomic if a host tick fails.

From the engine checkout, build with:

```sh
node --import tsx tools/cli.ts build --project examples/rope-reaction
```

The example has been compiled only under the current project policy; no runtime,
browser, stability or snapshot compatibility validation is claimed.
