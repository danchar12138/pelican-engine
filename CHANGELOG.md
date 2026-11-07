# Changelog

## Unreleased

- Add split-step particle/rigid-body effective-mass and normal-velocity reactions for fluid and soft-body contacts; runtime and stability remain unverified.

- Add optional orientation for manual fluid and soft-body box colliders; collision and snapshot behavior remain unverified.

- Add sampled dynamic oriented box contacts and optional delayed reactions for fluid and soft bodies; runtime, stability and snapshots remain unverified.

- Add split-step rope contact and reactions with dynamic 3D box bodies; runtime and snapshot behavior remain unverified.

- Add cloth contact with live dynamic 3D boxes and optional delayed reactions; native reaction failures report partial state without automatic history replay. Runtime behavior remains unverified.

- Add oriented sampled-box contacts for rope and cloth. Runtime and snapshot behavior remain unverified.

- Add sampled cloth-triangle contacts against axis-aligned boxes; runtime, stability and snapshot behavior remain unverified.

- Add discrete rope-segment contacts against sampled axis-aligned boxes; runtime and snapshot behavior remain unverified.

- Add manually sampled axis-aligned box contacts for rope and cloth particles; runtime behavior remains unverified.

## 0.10.0 - 2026-11-07

- Development batch only: built without tests or runtime, browser, GPU, performance, compatibility and recovery verification. The 3D first-step deletion defect and other 1.0 capabilities remain open.
- CI publishes the explicitly maintained version using OIDC; the npm registry rejects an existing version without a separate registry preflight.

- Track material graph parameter, time and managed GPU resource changes for path/hybrid recapture; runtime rendering remains unverified.

- Add read-only project-lock backup discovery for the explicit migration restore workflow; behavior remains unverified.

- Add per-body 3D gravity scaling with recorded state; runtime and snapshot replay remain unverified.

- Track runtime entity topology and transform changes for tracing recapture; rendering remains unverified.

- Add circle and oriented-box overlap queries to 2D physics; runtime behavior remains unverified.

- Preserve pending tracing recapture across raster frames and mode switches; runtime rendering remains unverified.

- Add optional fixed-clock maximum duration for audio voices; timing and restoration remain unverified.

- Add per-voice volume control and logical voice inspection; playback remains unverified.

- Mark runtime light and material changes for tracing recapture during unchanged draws; rendering behavior remains unverified.

- Add bounded occupied-cell rerouting for waiting navigation agents; runtime and snapshot behavior remain unverified.

- Add per-search temporary navigation obstacles without changing shared grid state; runtime behavior remains unverified.

- Add explicit normalized-time alignment for blended animation clips; runtime behavior remains unverified.

- Add opt-in grid-cell reservations and waiting for navigation agents; runtime behavior remains unverified.

- Add disabled button/input states and accessible UI labels; runtime and assistive-technology behavior remain unverified.

- Add runtime 3D rigid-body world gravity control with history recording; behavior and replay remain unverified.

- Add a composed public-API gameplay recipe covering inventory, equipment, quests, dialogue, camera and saves; runtime behavior remains unverified.

- Retain pending development reloads across coalesced file events and cache hits; watcher behavior remains unverified.

- Add staged tile, navigation and fixed 2D collider synchronization with explicit partial-state diagnostics; runtime behavior remains unverified.

- Add opt-in nonadjacent particle self-contact for soft bodies; behavior and cost remain unverified.

- Add runtime non-graph material surface overrides and snapshot state; raster/tracing behavior remains unverified.

- Add weighted two-clip model animation blending with snapshot state; runtime behavior remains unverified.

- Add configurable global convolution reverb with snapshot settings and dry fallback. Audio behavior remains unverified.

- Add dialogue session variables and equality-gated choices; runtime and snapshot behavior remain unverified.

- Add manual camera poses and fixed-tick camera transitions with snapshot state. Runtime behavior remains unverified.

- Account for collider-center offset in fluid and soft-body reaction torque; runtime behavior remains unverified.

- Align UI input length limits across authored controls, runtime updates and browser IME commits; runtime behavior remains unverified.

- Add entity-following focus for static world chunk residency, with diagnostics and snapshot state. Runtime behavior remains unverified.

- Add named equipment slots, tag restrictions and atomic inventory/equipment transfers. Runtime and snapshot restoration remain unverified.

## 0.9.0 - 2026-11-07

- Development batch only: tests, runtime behavior, graphics, hardware, performance, recovery and snapshot restoration are unverified. The full 1.0 scope remains incomplete.
- Add spatial audio occlusion, localized UI bindings, animated tiles, runtime light overrides, navigation target following and 3D shape sweep queries. Their runtime behavior is unverified.

- Add standard single-gamepad gameplay input, analog sampling, digital action bindings and UI/game capture modes. Hardware and runtime behavior are unverified.

- Add 2D capsule colliders and one-way kinematic character movement with deferred query refresh and snapshot state. Runtime behavior is unverified.

- Add 2D fixed, revolute, rope and spring joints with structured snapshot reconstruction and a fail-closed native recovery boundary. Runtime behavior is unverified.

- Add fixed 2D compound colliders and explicit tile-to-physics synchronization. Collision behavior and failure recovery are unverified.

- Add opt-in 2D rigid-body simulation with box/circle colliders, sensors, impulses, events and structured-state restoration. Runtime behavior is unverified.

- Add explicit tile-to-navigation synchronization and XY-plane grid agents. Runtime behavior and rollback are unverified.

- Add editable entity-bound atlas tile maps with chunked rendering and snapshot state. Collision/navigation coupling and runtime behavior remain unverified.

- Add entity-bound sprite atlas planes, fixed-step frame playback and explicit material alpha blending. Rendering and runtime behavior are unverified.

## 0.8.0 - 2026-11-07

- Development batch only: independent usage, tests, runtime behavior, graphics, hardware, performance, recovery and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add orthographic raster camera configuration for 2D-positioned and 2.5D content; hybrid/path are explicitly unavailable. Runtime behavior is unverified.

- Align the default `create` template and current-directory behavior for source and npm use. Runtime and cross-channel behavior are unverified.

- Generate offline npm game-author recipes from the same asset-free source examples used by the repository. Runtime and cross-channel use are unverified.

## 0.7.0 - 2026-11-07

- Development batch only: tests, runtime behavior, deployment, hardware, performance, resource lifecycle and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Stage build output and preserve an existing dist as a backup before replacement. Concurrent edits and failure recovery remain unverified.

- Add explicit project version-lock planning, backup-based apply and guarded restoration. API and save migration are not included; runtime behavior is unverified.

- Make scene, model and audio teardown continue after individual cleanup errors and preserve diagnostics. Runtime lifecycle and leak behavior are unverified.

- Avoid duplicate main-push build jobs and report immutable npm version collisions as workflow failures. Workflow behavior is unverified.

## 0.6.1 - 2026-11-07

- Development batch only: tests, runtime behavior, browser input, graphics, hardware, performance, stability and snapshot restoration have not been verified. M3–M8 and the full 1.0 scope remain incomplete.

- Add explicit localization catalogs, locale fallback, template substitution and Intl plural/number formatting. Runtime behavior is unverified.

- Add branching text dialogue definitions, choices and snapshot-preserved sessions. Runtime behavior is unverified.

- Add game-driven quest objectives, prerequisite tracking, completion and snapshots. Runtime behavior is unverified.

- Add stackable items and bounded inventory containers with atomic operations and snapshot state. Runtime behavior is unverified.

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
