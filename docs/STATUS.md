# Development Status

## Version and Release

- Current source version: 0.4.1. Package, lock file, engine manifest, SDK, compiler, and active example locks use the same version. Registry and GitHub publication depend on the actual release run.
- Historical tags `v0.4.0`, `v0.5.0`, and `v0.6.0` already exist and do not establish completion of those version lines. The occupied `0.4.0` identity is preserved; `0.4.1` is the intended batch version under D59.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. GitHub Releases use standard version tags without pre-release suffixes.
- The old release-event gate in `tools/npm/publish-gate.ts` is retained for historical reference only and is not a current npm publication prerequisite.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- Changes after 0.3.35 include spot lights, local light falloff, light and mesh shadow flags in direct tracing, and GLB unlit materials and punctual lights. These changes have not been runtime-validated.
- The 0.4.1 simulation/API batch also adds runtime gravity control and particle velocity/nearest-particle queries for rope, cloth, fluid and soft bodies; atomic batched impulses and anchor updates; and sphere/box/capsule rigid-body overlap queries. These APIs have only been type-compiled and built, not behavior-validated.
- The 0.4.1 batch adds one-tick forces and manually sampled sphere/plane/axis-aligned box colliders to fluid and soft bodies, improves sampled-collider snapshot restoration, and tightens HDR metadata and scanline diagnostics. It has not been behavior-validated; manual colliders are discrete and do not react on rigid bodies.
- A known rigid-body first-step removal issue remains open. A conservative live-path guard rejects removing moving bodies before the first physics step; it does not protect historical replay and is not runtime-validated. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- Navigation supports batch obstacle and weighted cell-cost updates for a finite orthogonal grid; this is not continuous-world streaming or physics integration. Weighted routing is not runtime-validated.
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
