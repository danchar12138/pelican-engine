# Development Status

## Version and Release

- Current source version: 0.7.0. Package, lock file, engine manifest, SDK, compiler, and active example locks use the same version. Registry and GitHub publication depend on the actual release run.
- Historical tags `v0.4.0`, `v0.5.0`, and `v0.6.0` already exist and do not establish completion of those version lines. Those occupied historical identities are preserved; `0.7.0` is the intended development batch version.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. The 0.7.0 development batch removes the duplicate main-push build job and makes an already-published version fail explicitly rather than silently skip. Workflow and registry outcomes depend on the actual release run. GitHub Releases use standard version tags without pre-release suffixes.
- The old release-event gate in `tools/npm/publish-gate.ts` is retained for historical reference only and is not a current npm publication prerequisite.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- The 0.7.0 batch makes scene, model, texture and audio cleanup best-effort across individual disposal failures, shares in-flight dispose promises and retains cleanup diagnostics. It also adds a plan/apply/restore command for project version locks with backup and hash guards, not API, dependency or save migration. Builds now stage output and retain prior dist in a workspace backup before replacement. Cleanup, build rollback, migration, recovery and absence of leaks are not runtime-validated; failures after a scene commit do not guarantee rollback.
- Changes after 0.3.35 include spot lights, local light falloff, light and mesh shadow flags in direct tracing, and GLB unlit materials and punctual lights. These changes have not been runtime-validated.
- The 0.4.1 simulation/API batch also adds runtime gravity control and particle velocity/nearest-particle queries for rope, cloth, fluid and soft bodies; atomic batched impulses and anchor updates; and sphere/box/capsule rigid-body overlap queries. These APIs have only been type-compiled and built, not behavior-validated.
- The 0.4.1 batch adds one-tick forces and manually sampled sphere/plane/axis-aligned box colliders to fluid and soft bodies, improves sampled-collider snapshot restoration, and tightens HDR metadata and scanline diagnostics. It has not been behavior-validated; manual colliders are discrete and do not react on rigid bodies.
- A known rigid-body first-step removal issue remains open. A conservative live-path guard rejects removing moving bodies before the first physics step; it does not protect historical replay and is not runtime-validated. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- The 0.5.1 development batch adds bounded focus-based residency and runtime construction/removal for static prefab roots, with transform/component preservation, queued edits and host snapshots. It does not stream assets, dynamic physics, animation state, terrain or cross-system transactions; runtime behavior is unverified.
- Model animation adds clip listing, pause/resume of active clips and fades, current-clip seek and speed control, and snapshot suspension persistence. These controls have not been runtime-validated; IK, layering and advanced animation systems remain incomplete.
- The 0.6.1 development batch adds dynamic text, bar, button and input creation/removal, runtime layout changes and snapshot-preserved control generations. A bounded inventory service adds stackable item definitions, containers, split/merge, atomic transfers and snapshots; a quest service tracks prerequisites, objectives and statuses; a dialogue service tracks branching text sessions; localization adds explicit catalogs, fallback, placeholders and Intl plural/number formatting. DOM input, gameplay/localization behavior and restoration are unverified; equipment, advanced dialogue, full layout, automatic localization binding and accessibility remain incomplete.
- Navigation supports batch obstacle and weighted cell-cost updates, optional diagonal paths, and fixed-step movement of non-physical root entities with bounded automatic replanning. It is not continuous-world streaming, physics integration or crowd avoidance. Routing, agent motion and snapshots are not runtime-validated.
- Ropes support manual and automatic fixed stepping, sampled sphere bindings, segmented presentation, segment contacts, and non-adjacent self-contact. Full two-way coupling, cross-rope contact, continuous collision, and tearing remain incomplete.
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
