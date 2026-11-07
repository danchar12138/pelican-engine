# Development Status

## Version and Release

- Current standard version: 0.3.35. Package, lock file, engine manifest, SDK, compiler, and examples use the same version.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. GitHub Releases use standard version tags without pre-release suffixes.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- A known rigid-body first-step removal issue remains open. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- Navigation supports batch obstacle and weighted cell-cost updates for a finite orthogonal grid; this is not continuous-world streaming or physics integration. Weighted routing is not runtime-validated.
- Ropes support manual and automatic fixed stepping, sampled sphere bindings, segmented presentation, segment contacts, and non-adjacent self-contact. Full two-way coupling, cross-rope contact, continuous collision, and tearing remain incomplete.
- Cloth supports triangular distance constraints, approximate bending, anchors, forces, sampled particle and surface contacts, non-adjacent particle self-contact, dynamic sphere bindings, optional approximate reactions, snapshots, and dynamic mesh presentation. Full continuous collision, rigid-body coupling, friction, and tearing remain incomplete.
- Soft bodies expose a bounded CPU tetrahedral reference service with configurable lattice dimensions, fixed-step scheduling, snapshots, particle impulses, sampled body bindings and dynamic surface presentation. Complete body coupling, tearing, continuous collision, GPU solving, runtime stability and performance remain incomplete or unverified. The configurable lattice and snapshot configuration checks are local changes after 0.3.35, not part of that published version.
- Rope and cloth runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified. Missing capabilities must not be described as complete first-release support.

## Single-Line Development

Only the main worktree is active. Git has one registered worktree and no .git/worktrees directory. The old local snapshot directories were deleted before a complete uniqueness audit; some historical candidates may not be recoverable or integrated. Retained Git archive references and formal evidence remain historical, not proof that every candidate was merged.

Four local `refs/pelican-archive/worktrees/` references retain commits outside the current main ancestry. The acceptance-audit implementation and audio fade/priority core are present in current source, but the archived commits themselves were not merged. The public-joints candidate remains unmerged because the recorded native-history failure is unresolved. The independent baseline snapshot contains 3,559 evidence paths and one documentation path not tracked by the current main tree; the reference is retained to preserve access. These observations do not establish runtime correctness or prove that all previously deleted snapshot contents were recovered.

Each delivery batch contains a meaningful feature or coordinated version increment. Small internal fixes are accumulated instead of triggering a separate CI run for every patch. Version locks, API indexes, documents, and examples are updated together at the batch boundary.

## Release Boundary

Every main push attempts npm latest publication. Published versions are never overwritten. Unverified behavior is explicitly marked and is not replaced by historical reports.

- The 0.3.35 line adds the bounded CPU WCSPH fluid and tetrahedral soft-body services, dynamic surface presentation, and refreshed fluid body bindings. Runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified.
