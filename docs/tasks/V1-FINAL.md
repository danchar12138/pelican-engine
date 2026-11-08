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

- [x] Load/unload dynamic and character prefab roots with retained physical and
  animation state, not only static transform/component records.
- [x] Preserve ownership and references during unload, deletion, reactivation
  and host restoration; block or detach incompatible cross-chunk dependencies.
- [x] Synchronize terrain/navigation/physics/presentation changes and release or
  suspend owned resources without binding stale identities to replacement IDs.

## Full-Body Animation Integration

- [x] Connect terrain/physics grounding to coordinated multi-chain IK with body
  adjustment and target/pose state retained in snapshots.
- [x] Use actual character displacement to coordinate root motion and the
  displayed pose; keep collision and cinematic ownership explicit.
- [x] Reconcile model identity, residency and animation ownership across world
  lifecycle transitions and cinematic handoff.

## Delivery

- [x] Update public declarations, guides and explicit version locks together.
- [x] Compile and build source, API index and npm distribution only. Do not run
  or author tests, browsers, GPU probes, smoke checks or acceptance validation.

The publication transaction commits the integrated batch on main and delivers
the source, standard version tag, GitHub milestone Release and npm latest through
OIDC. Its actual outcome is recorded by the immutable tag, GitHub Release and
Actions publish result, not pre-asserted by this source checklist. See
[1.0 release notes](../releases/1.0.0.md). Runtime acceptance is deferred until
after 1.0; compilation is not safety or stability evidence.

## Implementation Boundaries

Dynamic chunks park serializable body velocities, gravity/sleep/character state,
internal joints, model animation and wholly owned material solvers. Shared terrain
and navigation grids remain global services. Cross-boundary joints, solver bindings,
stance supports, active navigation/cinematic bindings, attached children, visible
world UI, camera follow and spatial voices must be detached before unloading.
Native objects and solver instances are released; prepared asset templates remain
a shared cache. This is not asynchronous asset streaming or origin rebasing.

Grounding coordinates 1..8 existing IK chains using downward physics/terrain
probes, bounded body adjustment, surface orientation and support-local stance
anchors. It uses world Y-up. Character collision feedback retimes ordinary
locomotion; it does not override cinematic time or implement ragdoll balance.
All runtime, numerical, rendering, lifetime and historical recovery behavior is
unverified. Existing v3 fixtures and historical evidence are not modified.
