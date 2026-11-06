# Pelican Engine Public SDK

M1 provides a compiled SDK and an authoritative CPU runtime foundation, not the complete first-release engine. The public source entry is src/index.ts. Game code imports only pelican-engine; the compiler resolves that alias for external directories without Git. Current use: docs/M1-USAGE.md. Generated signatures: docs/api/REFERENCE.md.

## Authoring model

- Export a default defineGame({ id, scene, systems, ... }) from game.ts.
- Declare data through defineComponent, definePrefab, defineScene, defineMaterial, defineCompute and defineAsset.
- Write synchronous defineSystem({ id, run(engine, dt) { ... } }) functions for gameplay. dt is seconds.
- Store mutable gameplay state in components. Access entities through EngineFacade; use setTransform/setComponent to commit changes. A component argument can be its typed definition or ID.
- Declare definitions as const, with literal values, const references, local named imports, arrays, objects and supported static arithmetic. Do not execute initialization code at module top level.
- Use project-local functions inside gameplay systems. Source modules are parsed and typechecked during compilation, never imported by the compiler.

The executable example is ../../examples/m0/game.ts. It declares a typed Motion component, a prefab, materials, a scene, a compute graph and a system that actually changes entity rotation.

## M0 graph subset

Supported nodes: float, vec3, time, sin, add, multiply. Inputs refer to node IDs. The compiler checks missing nodes, cycles, arity, finite f32 constants and type compatibility. add requires matching types; multiply supports matching types and scalar-vector multiplication. Material output is vec3. Compute output is explicitly float or vec3.

Graphs do not expose Three.js, TSL, GPUDevice or source shader strings. The renderer translates accepted graph IR; compiler acceptance is not proof of GPU execution. M0 has no arbitrary loops, storage reads/writes, textures in custom graphs or general compute kernel programming.

## Current boundaries

## Orthogonal grid navigation

Game systems can call `ctx.navigation.createGrid({ id, owner, width, height, blocked, searchCellBudget })`, where `blocked` is an optional array of integer `{ x, y }` cells. Grids use four orthogonal neighbors and have at most 4294967295 cells. Search generates neighbors on demand and does not allocate the entire grid. `searchCellBudget` limits the distinct cells admitted to a search, including its endpoints; it defaults to 65536. If another cell is needed beyond the budget, the search stops with `TC_NAVIGATION_CAPACITY`; an unfinished search is never reported unreachable. Games can explicitly set a larger positive integer budget after assessing device memory and CPU, or reduce and partition the search. The budget is not a byte-level memory guarantee. `setBlocked(id, cell, boolean)` updates an obstacle immediately. `findPath(id, start, end)` returns deterministic shortest-path cell coordinates including both endpoints. A blocked endpoint throws `TC_NAVIGATION_BLOCKED`, a destination is `TC_NAVIGATION_UNREACHABLE` only after search exhaustion, and invalid definitions or coordinates throw `TC_NAVIGATION_GRID` or `TC_NAVIGATION_CELL`. Duplicate and unknown grid IDs throw `TC_NAVIGATION_DUPLICATE` and `TC_NAVIGATION_MISSING`.

`destroyGrid(id)` removes a grid; `destroyOwner(owner)` removes all grids with that explicit string owner. Owners are not entity handles and are not automatically cleaned up when an entity is destroyed. Grid data and current obstacles are included in host snapshots; old snapshots restore an empty navigation state. This is a small 2D grid capability, not NPC steering, flying, underwater or continuous-world navigation, and does not complete M5.

Geometry: box, sphere and plane. Lights: directional and point. Components: number, boolean, string and vec3 fields. Systems use input/prePhysics/physics/postPhysics/update/presentation with dependencies and explicit read/write access. SystemContext includes fixed time, random source, events and queued entity commands. Prefabs support inheritance and per-field component overrides. Asset conversion and optimized rendering are extended in M2.

The SoA world, generation-checked entities, schedule, atomic structural commits, resource lifecycle, snapshots and controlled replay are implemented. Full physics, animation, UI, world streaming and production graphical programming from the complete product plan remain later milestones.
