# Material slots

This public SDK game loads an original two-primitive GLB. `Paint` is red and
`Trim` is blue. Press A to replace `Paint` with the green game material while
preserving `Trim`; press B to restore the unmodified instance. The authored
instances share geometry; the inactive instance is moved out of view.

The original MIT fixture is reproducible with
`npx tsx tools/prepare-material-slots-glb.ts` from the repository root.
The independent GPU check requires exclusive GPU access:

```
npx tsx tools/material-slots-game-probe.ts --exclusive-gpu --output .pelican/material-slots/manual
```

It writes six screenshots and `material-slots-game.json`, including failure and
cleanup details. This is a focused development probe, not full M3 acceptance.
The thresholds and screenshot locations were checked on one NVIDIA WebGPU device;
other devices and broader model/material combinations are not established by it.
