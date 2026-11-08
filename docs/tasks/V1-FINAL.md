# 1.0 Final Scope

Decision D60 freezes the final implementation scope to three integration areas.
Older roadmap/CAP work is retained for later development, not added to this
delivery. This file tracks implementation, not runtime acceptance.

## Simulation Coupling

- [x] Advance native rigid bodies and rope/cloth/soft-body/fluid participants on
  a shared substep clock, rather than advancing each whole tick independently.
- [x] Exchange two-way rigid reactions within substeps and resolve shared
  contacts with constitutive constraints, CCD and friction.
- [x] Retain bounded scheduling, queued-force semantics, fixed-tick identity,
  reconstruction history, explicit faults and recoverable owner boundaries.

## Dynamic World Lifecycle

- [ ] Load/unload dynamic and character prefab roots with retained physical and
  animation state, not only static transform/component records.
- [ ] Preserve ownership and references during unload, deletion, reactivation
  and host restoration; block or detach incompatible cross-chunk dependencies.
- [ ] Synchronize terrain/navigation/physics/presentation changes and release or
  suspend owned resources without binding stale identities to replacement IDs.

## Full-Body Animation Integration

- [ ] Connect terrain/physics grounding to coordinated multi-chain IK with body
  adjustment and target/pose state retained in snapshots.
- [ ] Use actual character displacement to coordinate root motion and the
  displayed pose; keep collision and cinematic ownership explicit.
- [ ] Reconcile model identity, residency and animation ownership across world
  lifecycle transitions and cinematic handoff.

## Delivery

- [ ] Update public declarations, guides and explicit version locks together.
- [ ] Compile and build source, API index and npm distribution only. Do not run
  or author tests, browsers, GPU probes, smoke checks or acceptance validation.
- [ ] Commit the integrated feature batches on main; publish the completed
  1.0.0 source, tag, GitHub milestone Release and npm latest through OIDC.
- [ ] Report exact publication results and explicitly defer runtime acceptance
  until after 1.0. Do not equate compilation with safety or stability.
