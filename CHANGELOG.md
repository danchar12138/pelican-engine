# Changelog

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
