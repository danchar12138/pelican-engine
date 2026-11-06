# Cloth sheet example

This example creates an anchored triangular CPU cloth with an optional deforming
visual. Hold Space to apply force to movable particles. The sampled sphere acts
on cloth particles only and is not a rendered or dynamic rigid body. Bending is
a distance-constraint approximation; cloth faces, self-contact, rigid-body
reaction, tearing and continuous collision are not implemented.

From the engine checkout:

```sh
node --import tsx tools/cli.ts build --project examples/cloth-sheet
```

The example has only been compiled. Runtime behavior, visual output, stability,
performance, GPU lifecycle and snapshot compatibility have not been validated.
