# Changelog

## Unreleased

- Add dynamic game UI controls, editable layout, and generation-aware input events and snapshots. Runtime behavior is unverified.

## 0.5.1 - 2026-11-07

- Development batch only: tests, runtime behavior, graphics, hardware, performance, stability, and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add grid-following point agents with fixed-tick movement, bounded obstacle/cost replanning and snapshot state. Runtime behavior is unverified; this is not physics or crowd avoidance.

- Allow chunk-owned static prefab roots to be built and removed at runtime, with bounded deferred active-chunk edits and snapshot persistence. Runtime behavior is unverified.

- Add bounded focus-based chunk residency for static prefab roots, including transform/component preservation and host snapshots. Runtime behavior is unverified; this is not asset or dynamic-physics streaming.

- Add optional diagonal weighted grid paths with blocked-corner protection. Runtime behavior is unverified.

- Add model animation clip discovery, pause/resume, seeking and speed control, including snapshot suspension state. Runtime behavior is unverified.

## 0.4.1 - 2026-11-07

- Bundle the accumulated simulation, graphics, asset and API improvements after 0.3.35, including fluid and soft-body forces and manual colliders.
- Add a conservative live-path guard against removal of moving physics bodies before the first physics step. The underlying issue and historical snapshot risks remain open.
- Build-only development release: runtime, hardware, stability, performance, and snapshot behavior have not been verified. This does not declare M4 or the complete engine finished.

- Normalize sparse GLB accessors for inspection, optimization and model loading.
- Extend GLB material handling with emissive strength and texture transforms.
- Improve fluid and soft-body binding, presentation and state lifecycle.
- Add an animation clip starting-time option.
- Build-only development; runtime, hardware, performance and snapshot behavior remain unverified.

## 0.3.34 - 2026-11-07

- Added a soft-body sphere-binding example.

## 0.3.33 - 2026-11-07

- Added a dynamic sphere binding and approximate reaction option for soft bodies.


## 0.3.32 - 2026-11-07

- Added the public `ctx.softBodies` service backed by the bounded CPU tetrahedral XPBD reference solver.
- Added dynamic soft-body surface presentation and automatic fixed-step scheduling.
- Refreshed fluid body bindings before every automatic tick instead of sampling only at creation.
- Build-only release; runtime, stability, performance, rendering, and snapshot compatibility remain unverified.

## 0.5.0 - 2026-11-06

- Added optional fluid binding to one dynamic sphere with fixed-step WCSPH sampling and approximate reaction impulse submission.
- Added fluid particle presentation and the fluid-basin example.
- This release is build-only; fluid runtime, stability, performance, rendering, and snapshot compatibility were not verified.

## 0.3.31 - 2026-11-06

- Made cloth and rope reaction batches recoverable: a failed native action rebuilds physics state and history from the pre-batch snapshot before the host fault is reported.
- Build-only release; runtime rollback behavior was not verified.

## 0.3.30 - 2026-11-06

- Restored cloth binding definitions together with solver state when an automatic cloth tick fails, preventing destroyed-body pruning from surviving rollback.
- Build-only release; runtime and snapshot behavior were not verified.

## 0.3.29 - 2026-11-06

- Rewrote the public release and status documents as clean standard-version documentation.
- Preserved the current unverified/build-only boundary; no runtime, stability, performance, or snapshot claim was added.

## 0.3.28 - 2026-11-06

- Consolidated the release notes, development status, API index, version locks, and example locks.
- Removed duplicate and malformed release entries.

## 0.3.27 - 2026-11-06

- Cloth triangle-surface contacts support sampled spheres and planes with discrete projection and reaction output.

## 0.3.26 - 2026-11-06

- Cloth body bindings support the explicit bodyReactions option for approximate reaction impulses; it is disabled by default.

## 0.3.25 - 2026-11-06

- Cloth body binding creation, world preflight, and snapshot restore now reject stale or non-physical bindings.

## 0.3.24 - 2026-11-06

- The cloth example uses the dynamic sphere binding API instead of manual static sampling.

## 0.3.23 - 2026-11-06

- Automatic cloth stepping can sample live dynamic non-trigger spheres as one-way moving obstacles.

## 0.3.22 - 2026-11-06

- Cloth triangle-surface contacts support sampled spheres with closest-point projection.

## 0.3.21 - 2026-11-06

- Historical cloth snapshots without selfCollisions restore in legacy particle-only mode.

## 0.3.20 - 2026-11-06

- Cloth self-collision state migration and snapshot validation were corrected.

## 0.3.19 - 2026-11-06

- Added discrete non-adjacent cloth particle self-collision with a switch and snapshot state.

## 0.3.18 - 2026-11-06

- Added the triangular cloth foundation: distance constraints, approximate bending, anchors, forces, sampled contacts, host snapshots, and dynamic mesh presentation.

## 0.3.17 - 2026-11-06

- Added discrete non-adjacent rope self-contact with broad-phase filtering.

## 0.3.16 - 2026-11-06

- Added discrete rope segment and sphere contact.

## 0.3.15 - 2026-11-06

- Added segmented rope presentation that follows simulated particles.
