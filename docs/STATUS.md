# Development Status

## Version and Release

- Current source version: 0.11.0. Package, lock file, engine manifest, SDK, compiler, and active example locks use the same version. Registry and GitHub publication depend on the actual release run; this development batch is not a complete 1.0 release.
- Historical tags `v0.4.0`, `v0.5.0`, and `v0.6.0` already exist and do not establish completion of those version lines. Those occupied historical identities are preserved.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. Existing npm versions cannot be overwritten; the publication command reports failure rather than silently skipping. Workflow outcomes depend on the actual release run. GitHub Releases use standard version tags without pre-release suffixes.
- The 0.9.0 GitHub Release exists, but its npm workflow and one retry failed on November 7, 2026 with transparency-log HTTP 500 errors. This is not evidence that the npm version was published.
- The old release-event gate in `tools/npm/publish-gate.ts` is retained for historical reference only and is not a current npm publication prerequisite.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- Local development adds model-local CCD inverse-kinematics chains with selectable bones, target, weight, iterations, angular step limit and snapshot state. Chains run after base/additive animation; automatic grounding, retargeting, physical constraints and full-body IK remain incomplete. Solver behavior, rendering and restoration are unverified.

- Local development adds named additive model animation layers with optional bone-subtree masks, independent weight and playback controls, and snapshot state. This does not complete retargeting, root-motion handling or animation state machines; playback, interpolation, resource lifecycle and restoration are unverified.

- Local tracing development conservatively detects when a perspective camera’s near frustum may meet a medium bound and initializes media per primary sample at the near plane. Alpha-filtered transmissive shells in this case are explicitly rejected; GPU correctness, additional cost and hardware behavior are unverified.

- Local tracing development propagates each closed medium shell’s world winding to packed GPU geometry and orients physical shading normals against the outward boundary. Both authored global windings, including mirrors, have development implementations; GPU classification, graph normals, shading and hardware behavior remain unverified.

- Local tracing development initializes orthographic primary media per sample at the near plane from the closed-shell nesting hierarchy, using GPU boundary and ambiguity diagnostics. Alpha-filtered transmissive shells remain explicitly unsupported in this mode; classification, rendering, cost and hardware behavior are unverified.

- Local tracing development refreshes per-triangle medium IDs after medium catalog changes even when geometry is unchanged, and retains the previous committed revision on capture failure. Dynamic transmission updates, retry behavior and GPU rendering remain unverified.

- Local development adds orthographic WebGPU hybrid/path camera rays, raster-primary sampling and motion reprojection for normal scenes. Per-ray initial media are now implemented with explicit shell restrictions; the historical M0 sidecar remains perspective-only and WebGL2 remains raster-only. GPU behavior, jitter, clipping, denoising and recovery are unverified.

- Local cloth development uses a shared virtual rigid body for opt-in particle and sampled triangle contacts, including relative normal velocity, inverse mass/inertia, and barycentric surface mass with anchored vertices excluded. Contacts remain discrete and delayed, box orientation stays fixed during a split pass, and solvers are not unified. Runtime, stability, cost and restoration remain unverified.

- Local cloth development stages reactions across automatic cloth entries before one physics batch, instead of committing after each entry. A native commit can still partially apply, and other host systems are not rolled back; runtime and failure handling remain unverified.

- Local development uses a per-tick virtual dynamic sphere or box for fluid and soft-body reactions. Contact projection uses particle mass, rigid-body effective inverse mass/inertia and relative normal velocity; bodies shared by simulations of the same kind are processed in sorted order. This is discrete, delayed and approximate, with fixed box orientation and separate simulation passes; it is not continuous, frictional or a fully unified coupling. Runtime, stability, performance and snapshot behavior are unverified.

- Local development adds optional XYZ rotation to manually configured fluid and soft-body boxes; omitted rotations retain the previous axis-aligned path. Snapshot, collision, performance and runtime behavior remain unverified.

- Local development adds live dynamic sphere or oriented box samples for fluid and soft-body contacts, with optional delayed linear and world-origin angular reactions. Manually configured boxes also support optional rotation. This is discrete and not fully coupled or continuous collision; lifecycle, runtime, stability and snapshot compatibility remain unverified.

- Local development adds split-step rope contacts and reactions with dynamic 3D boxes, including sampled orientation and effective mass/inertia. The virtual box orientation stays fixed within the split step; collision, response, recovery and snapshot behavior remain unverified.

- Local development adds sampled cloth contact with live dynamic non-trigger 3D boxes as well as spheres, with optional delayed reactions and generation-aware binding. The current split-step approximation is not a unified or continuous collision solve. Runtime, native-failure and snapshot behavior remain unverified; unsafe 3D historical replay remains an open risk.
- Native reaction-application failures now report potentially partial state without automatically replaying physics history. The host faults; restart or known-good recovery is required and unverified.

- Local development adds manually sampled oriented box obstacles for rope particles and segments and cloth particles and sampled triangle points. The cloth samples do not guarantee all triangle/box contacts; contacts, stability and snapshot restoration remain unverified.

- The 0.10.0 development batch tracks material graph parameter/time changes and managed render-buffer/texture copies for path/hybrid recapture, retaining pending state after bridge failures and raster frames. GPU rendering and recovery remain unverified.

- The 0.10.0 development batch adds read-only discovery of project-lock backups and their current digests for the existing explicit restore workflow. This does not establish backup provenance or game/save compatibility; listing and restoration are unverified at runtime.

- The 0.10.0 development batch adds per-dynamic-body gravity scaling to 3D physics history. Native behavior, wakeup and snapshot replay remain unverified; the first-step deletion and unsafe historical replay defects remain open.

- The 0.10.0 development batch tracks entity creation, removal, parent and transform changes as pending scene revisions for tracing recapture. Runtime rendering and failure recovery remain unverified.

- The 0.10.0 development batch adds 2D circle and oriented-box overlap queries using the last completed physics step. Filtering, native recovery and runtime results are unverified.

- The 0.10.0 development batch preserves pending path/hybrid scene recapture while raster frames are drawn. Mode switches and failure recovery are unverified.

- The 0.10.0 development batch adds an optional fixed-clock maximum duration for audio voices, including loops and legacy unknown-duration sounds. Pause timing, reclamation and snapshot restoration remain unverified.

- The 0.10.0 development batch adds per-voice gain control and detached logical voice inspection. Audio output, lifecycle and snapshot restoration remain unverified.

- The 0.10.0 development batch marks runtime light and material surface changes for tracing recapture even when a draw otherwise has no scene-change flag. Raster and tracing behavior remain unverified.

- The 0.10.0 development batch adds bounded replanning around occupied cells after navigation agents wait; destination blocking, crossing paths and deadlocks still require game handling. Rerouting and snapshot restoration are unverified.

- The 0.10.0 development batch adds per-search temporary blocked navigation cells without mutating the shared grid. Automatic agent rerouting and runtime behavior remain unverified.

- The 0.10.0 development batch adds explicit normalized-time alignment for two blended model clips. It is not automatic phase matching or root-motion correction; playback and restoration remain unverified.

- The 0.10.0 development batch adds opt-in grid-cell reservations, waiting and bounded rerouting for navigation agents with identical mappings. This is not continuous crowd avoidance, physics collision or guaranteed deadlock resolution; behavior and snapshot restoration are unverified.

- The 0.10.0 development batch adds disabled button/input states and accessible labels, persisted in UI state. Keyboard, gamepad, IME, screen reader and snapshot behavior remain unverified; this is not a complete accessibility system.

- The 0.10.0 development batch adds runtime 3D rigid-body world gravity changes with history recording and dynamic-body wakeup. Character and other simulation gravities remain separate; runtime, wake and snapshot behavior are unverified, and the first-step removal defect remains open.

- The 0.10.0 development batch adds an asset-free composed gameplay recipe combining inventory, equipment, quests, conditional dialogue, manual camera and saves through the public API. The recipe and cross-service recovery are unverified.

- The 0.10.0 development batch improves the cold-reload watcher when file events overlap compilation and a later compilation hits cache or fails. This is not state-preserving hot reload; file watching and browser behavior remain unverified.

- The 0.10.0 development batch adds a staged tile/navigation/2D-collider update with full mapped-grid synchronization and explicit partial-state diagnostics. It is not a persistent binding or guaranteed native rollback; behavior and restoration remain unverified.

- The 0.10.0 development batch adds opt-in discrete non-edge-adjacent particle self-contact for tetrahedral soft bodies, with a cumulative projection counter. It does not handle continuous, surface or edge self-collision; stability, performance and snapshot behavior remain unverified.

- The 0.10.0 development batch adds runtime surface overrides for declared non-graph material channels, with snapshot persistence and graph ownership checks. Shared-material propagation, raster/tracing consistency and restoration are unverified.

- The 0.10.0 development batch adds two-clip weighted model animation blending and snapshot state. Local additive bone masks and basic CCD IK extend this, but automatic phase matching and full IK remain incomplete; blending and restoration are unverified.

- The 0.10.0 development batch adds optional global convolution reverb with deterministic generated impulse responses, dry fallback and snapshot-preserved settings. It is not room acoustics or per-bus sends; sound output, failure recovery, resource cleanup and restoration remain unverified.

- The 0.10.0 development batch adds per-session dialogue variables and equality-gated choices. Game code still maps quest/inventory state and applies consequences; runtime and snapshot behavior are unverified.

- The 0.10.0 development batch adds fixed-tick manual camera poses and linear transitions with snapshot state. Camera collision avoidance for manual poses, cinematic timelines, rendering and restoration remain incomplete or unverified.

- The 0.10.0 development batch accounts for the offset between a bound sphere collider and its rigid-body center of mass when applying fluid/soft-body normal reaction impulses. This remains discrete, approximate coupling; forces, torque, rollback and stability are unverified.

- The 0.10.0 development batch aligns authored and dynamic input length with the 4096 UTF-16-unit event limit and constrains browser commits without splitting surrogate pairs. IME, paste, focus and restoration remain unverified.

- The 0.10.0 development batch adds entity-following focus for static world chunk residency, with missing/invalid states and snapshot persistence. It does not stream dynamic physics or assets; following, transitions and restoration are unverified.

- The 0.10.0 development batch adds named equipment slots, item tag restrictions and atomic inventory/equipment transfers. Equipment and older snapshot compatibility have not been runtime-validated; item instances, stats and durability are not implemented.

- The 0.9.0 development batch exposes 3D sphere, box and capsule linear shape casts with live-entity and trigger filters. Query results, initial overlap handling and runtime behavior are unverified; this does not fix the 3D first-step removal defect.

- The 0.9.0 development batch adds fixed-step navigation following for live root entities, including grid-boundary diagnostics, target lifetime tracking and snapshot state. This remains point-agent movement without physics integration or crowd avoidance; following and restoration are unverified.

- The 0.9.0 development batch adds runtime intensity, linear RGB, visibility and directional/spot target overrides for declared entity/prefab lights, with snapshot state. It does not control embedded model lights. Raster, tracing, entity lifecycle and restoration behavior have not been runtime-validated.

- The 0.9.0 development batch adds locale-aware UI text/button bindings with snapshot persistence and explicit missing-translation diagnostics. Input controls are excluded; rendering, locale changes and restoration remain unverified.

- The 0.9.0 development batch adds opt-in direct-path spatial audio occlusion using 3D physics rays, gain and low-pass filtering. It is not diffraction or reverb; audio output, diagnostics and snapshot restoration have not been runtime-validated.

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- The 0.8.0 development batch generates asset-free game-author recipe documentation from source examples for both the repository and npm package, and aligns the default `create` template and project directory. It does not ship example projects or assets; the legacy asset-bearing `m2` template remains source-only. Cross-channel use is not runtime-validated.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- The 0.8.0 development batch adds an orthographic camera for raster scenes, with an explicit mode restriction for hybrid/path. The 0.9.0 development batch adds entity-bound atlas sprites, chunked editable tile maps and fixed-step tile animation, as well as explicit tile-to-navigation synchronization, XY-plane grid agents and fixed-body tile collider generation. Automatic collision binding, full 2D physics and the complete 2D engine remain incomplete. Rendering, synchronization, rollback, fallback, animation and snapshots are unverified.
- The 0.9.0 development batch adds standard-mapped single-gamepad gameplay input with analog samples, digital action bindings, deadzone and UI/game capture modes. Physical devices, focus, replay and snapshots remain unverified; nonstandard controllers, multiplayer and haptics remain incomplete.
- The 0.9.0 development batch adds an opt-in independent Rapier 2D XY world with box/circle/capsule bodies, impulses, sensors, events, last-step ray queries, fixed/revolute/rope/spring joints and a one-way kinematic character controller. Native failures require recovery or scene restart. It reconstructs validated structured state rather than restoring native snapshots; joint behavior, contact continuity, tile collision synchronization, runtime behavior and restoration remain unverified. The separate 3D joint and first-step removal gaps remain open.
- The 0.7.0 batch makes scene, model, texture and audio cleanup best-effort across individual disposal failures, shares in-flight dispose promises and retains cleanup diagnostics. It also adds a plan/apply/restore command for project version locks with backup and hash guards, not API, dependency or save migration. Builds now stage output and retain prior dist in a workspace backup before replacement. Cleanup, build rollback, migration, recovery and absence of leaks are not runtime-validated; failures after a scene commit do not guarantee rollback.
- A local sprite example build on 2026-11-07 initially failed with `TC_BUILD_COMMIT`; the original underlying cause was not reported. The failed stage remains locally at `examples/sprite-atlas/.pelican/dist-stage-iFd7Wq/`; a later build succeeded. Diagnostics now include the underlying cause, but the original failure remains unexplained and recovery has not been runtime-validated.
- Changes after 0.3.35 include spot lights, local light falloff, light and mesh shadow flags in direct tracing, and GLB unlit materials and punctual lights. These changes have not been runtime-validated.
- The 0.4.1 simulation/API batch also adds runtime gravity control and particle velocity/nearest-particle queries for rope, cloth, fluid and soft bodies; atomic batched impulses and anchor updates; and sphere/box/capsule rigid-body overlap queries. These APIs have only been type-compiled and built, not behavior-validated.
- The 0.4.1 batch adds one-tick forces and manually sampled sphere/plane/axis-aligned box colliders to fluid and soft bodies, improves sampled-collider snapshot restoration, and tightens HDR metadata and scanline diagnostics. It has not been behavior-validated; manual colliders are discrete and do not react on rigid bodies.
- A known rigid-body first-step removal issue remains open. A conservative live-path guard rejects removing moving bodies before the first physics step; it does not protect historical replay and is not runtime-validated. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- The 0.5.1 development batch adds bounded focus-based residency and runtime construction/removal for static prefab roots, with transform/component preservation, queued edits and host snapshots. It does not stream assets, dynamic physics, animation state, terrain or cross-system transactions; runtime behavior is unverified.
- Model animation adds clip listing, pause/resume of active clips and fades, current-clip seek and speed control, and snapshot suspension persistence. These controls have not been runtime-validated; advanced animation systems remain incomplete.
- The 0.6.1 development batch adds dynamic text, bar, button and input creation/removal, runtime layout changes and snapshot-preserved control generations. A bounded inventory service adds stackable item definitions, containers, split/merge, atomic transfers and snapshots; a quest service tracks prerequisites, objectives and statuses; a dialogue service tracks branching text sessions; localization adds explicit catalogs, fallback, placeholders and Intl plural/number formatting. DOM input, gameplay/localization behavior and restoration are unverified; advanced dialogue, full layout and accessibility remain incomplete.
- Navigation supports batch obstacle and weighted cell-cost updates, optional diagonal paths, and fixed-step movement of non-physical root entities with bounded automatic replanning. It is not continuous-world streaming, physics integration or crowd avoidance. Routing, agent motion and snapshots are not runtime-validated.
- Ropes support manual and automatic fixed stepping, sampled sphere and box bindings, segmented presentation, segment contacts, and non-adjacent self-contact. Full two-way coupling, cross-rope contact, continuous collision, and tearing remain incomplete.
- Cloth supports triangular distance constraints, approximate bending, anchors, forces, sampled particle and surface contacts, non-adjacent particle self-contact, dynamic sphere bindings, optional approximate reactions, snapshots, and dynamic mesh presentation. Full continuous collision, rigid-body coupling, friction, and tearing remain incomplete.
- Soft bodies expose a bounded CPU tetrahedral reference service with configurable lattice dimensions, fixed-step scheduling, snapshots, particle impulses, sampled body bindings and dynamic surface presentation. Complete body coupling, tearing, continuous collision, GPU solving, runtime stability and performance remain incomplete or unverified. The configurable lattice and snapshot configuration checks were added after 0.3.35.
- Rope and cloth runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified. Missing capabilities must not be described as complete first-release support.

## Single-Line Development

Only the main worktree is active. Git has one registered worktree and no .git/worktrees directory. The old local snapshot directories were deleted before a complete uniqueness audit; some historical candidates may not be recoverable or integrated. Retained Git archive references and formal evidence remain historical, not proof that every candidate was merged.

One local `refs/pelican-archive/consolidated` reference preserves four historical commits outside the current main ancestry as parents: acceptance audit `3bb3e618a17d0925a1a1fdb668b916a2d90b2775`, independent baseline `2ba364691255960bb9a3d4913d2e0afaad296762`, public joints `a8eea87488762bcbb95da67fdb08d622d05e9c43`, and audio fade/priority `38b86d2c06bd60255275bb5e8a3b791acfa93e22`. The archive commit is a preservation index, not a merge into main, and the local ref is not published automatically. The acceptance-audit implementation and audio core are present in current source; the public-joints candidate remains unmerged because the recorded native-history failure is unresolved. The independent baseline contains 3,559 evidence paths and one documentation path not tracked by current main. These observations do not establish runtime correctness or prove that all previously deleted snapshot contents were recovered.

Each delivery batch contains a meaningful feature or coordinated version increment. Small internal fixes are accumulated instead of triggering a separate CI run for every patch. Version locks, API indexes, documents, and examples are updated together at the batch boundary.

## Release Boundary

Every main push attempts npm latest publication. Published versions are never overwritten. Unverified behavior is explicitly marked and is not replaced by historical reports.

- The 0.3.35 line adds the bounded CPU WCSPH fluid and tetrahedral soft-body services, dynamic surface presentation, and refreshed fluid body bindings. Runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified.
