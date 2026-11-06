# Development Status

## Version and Release

- Current standard version: 0.3.30. Package, lock file, engine manifest, SDK, compiler, and examples use the same version.
- A push to main attempts an npm latest release through GitHub Actions trusted publishing. GitHub Releases use standard version tags without pre-release suffixes.
- The active project policy permits compilation and build steps only. Tests, browsers, GPU probes, performance checks, runtime checks, and registry verification are not run unless explicitly authorized.

## Current Scope

- The public SDK, compiler, runtime, renderer, asset pipeline, and CLI are available through pelican-engine.
- WebGPU, path tracing, controlled compute, and WebGL2 fallback have development implementations, but complete quality, performance, compatibility, and resource-lifecycle behavior remain unverified.
- A known rigid-body first-step removal issue remains open. Historical candidates and risky snapshots are archived evidence, not current acceptance evidence.
- Navigation supports batch obstacle updates for a finite orthogonal grid; this is not continuous-world streaming or physics integration.
- Ropes support manual and automatic fixed stepping, sampled sphere bindings, segmented presentation, segment contacts, and non-adjacent self-contact. Full two-way coupling, cross-rope contact, continuous collision, and tearing remain incomplete.
- Cloth supports triangular distance constraints, approximate bending, anchors, forces, sampled particle and surface contacts, non-adjacent particle self-contact, dynamic sphere bindings, optional approximate reactions, snapshots, and dynamic mesh presentation. Full continuous collision, rigid-body coupling, friction, and tearing remain incomplete.
- Rope and cloth runtime behavior, stability, performance, rendering, and snapshot compatibility remain unverified. Missing capabilities must not be described as complete first-release support.

## Single-Line Development

Only the main worktree is active. Git has one registered worktree and no .git/worktrees directory. Historical snapshots, patches, evidence, and recovery refs are retained as archives; unreviewed unique work is not merged or deleted blindly.

Each change area contains one feature, fix, or next standard version. Changes are committed and pushed promptly; the workflow does not wait for a milestone. Version locks, API indexes, documents, and examples are updated together.

## Release Boundary

Every main push attempts npm latest publication. Published versions are never overwritten. Unverified behavior is explicitly marked and is not replaced by historical reports.

- Cloth automatic-step rollback now restores pruned body binding definitions together with solver state; this lifecycle fix is unverified.
