# Kinematic Contact Regression

The independent ZIP workflow found that a character could become stuck after contacting a kinematic gate. This public-SDK scene retains the original character/floor/gate setup and keeps the gate kinematic.

```sh
npm run dev -- --project examples/physics-risk --port 4184
```

S walks toward the closed gate; W retreats; E raises it. `tools/m2-physics-probe.ts` asserts blocking contact, retreat, opening, traversal, snapshot restore and recorded replay in real WebGPU. CPU tests also cover support removal, ledges, thin opposing solids and corners. A fixed-collider gameplay workaround is not acceptance of this regression.
