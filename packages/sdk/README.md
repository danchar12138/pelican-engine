# threecat public SDK

M1 provides a compiled SDK and an authoritative CPU runtime foundation, not the complete first-release engine. The public source entry is src/index.ts. Game code imports only @threecat/sdk; the compiler resolves that alias for external directories without Git. Current use: docs/M1-USAGE.md. Generated signatures: docs/api/REFERENCE.md.

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

Geometry: box, sphere and plane. Lights: directional and point. Components: number, boolean, string and vec3 fields. Systems use input/prePhysics/physics/postPhysics/update/presentation with dependencies and explicit read/write access. SystemContext includes fixed time, random source, events and queued entity commands. Prefabs support inheritance and per-field component overrides. Asset conversion and optimized rendering are extended in M2.

The SoA world, generation-checked entities, schedule, atomic structural commits, resource lifecycle, snapshots and controlled replay are implemented. Full physics, animation, UI, world streaming and production graphical programming from the complete product plan remain later milestones.
