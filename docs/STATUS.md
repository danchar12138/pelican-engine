# Development Status

## Version and Release

- Current standard version: 0.6.0. Package, lock file, engine manifest, SDK, compiler, and examples use the same version.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. GitHub Releases use standard version tags without pre-release suffixes.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- A known rigid-body first-step removal issue remains open. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- Navigation supports batch obstacle updates for a finite orthogonal grid; this is not continuous-world streaming or physics integration.
- Ropes support manual and automatic fixed stepping, sampled sphere bindings, segmented presentation, segment contacts, and non-adjacent self-contact. Full two-way coupling, cross-rope contact, continuous collision, and tearing remain incomplete.
- Cloth supports triangular distance constraints, approximate bending, anchors, forces, sampled particle and surface contacts, non-adjacent particle self-contact, dynamic sphere bindings, optional approximate reactions, snapshots, and dynamic mesh presentation. Full continuous collision, rigid-body coupling, friction, and tearing remain incomplete.
- Soft bodies expose a bounded CPU tetrahedral reference service with fixed-step scheduling, snapshots, particle impulses and dynamic surface presentation. Body coupling, tearing, continuous collision, GPU solving, runtime stability and performance remain incomplete or unverified.
- Rope and cloth runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified. Missing capabilities must not be described as complete first-release support.

## Single-Line Development

Only the main worktree is active. Git has one registered worktree and no .git/worktrees directory. Historical snapshots, patches, evidence, and recovery refs are retained as archives; unreviewed unique work is not merged or deleted blindly.

Each delivery batch contains a meaningful feature or coordinated version increment. Small internal fixes are accumulated instead of triggering a separate CI run for every patch. Version locks, API indexes, documents, and examples are updated together at the batch boundary.

## Release Boundary

Every main push attempts npm latest publication. Published versions are never overwritten. Unverified behavior is explicitly marked and is not replaced by historical reports.

- The 0.5.0 line added the bounded CPU WCSPH fluid service with fixed-step Host scheduling, snapshots, optional particle presentation, and optional one-sphere binding with approximate reaction impulses.
- The 0.6.0 line adds a bounded CPU tetrahedral soft-body service and dynamic surface presentation, and refreshes fluid body bindings on every automatic tick. Runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified.
