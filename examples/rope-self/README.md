# Rope self-contact example

A rope starts with two non-adjacent segments crossing. The default discrete
self-contact solver projects movable endpoints apart. Space applies an impulse to
the free endpoint. Presentation uses capped cylinder segments, not a continuous
tube. Adjacent segments are excluded; separate ropes, continuous collision,
friction and guaranteed collision-free motion are not implemented here.

From the engine checkout, build with:

```sh
node --import tsx tools/cli.ts build --project examples/rope-self
```

This example is compiled only; visual behavior, stability, performance and
snapshot compatibility have not been runtime validated.
