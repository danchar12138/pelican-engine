# threecat M0 public SDK

This is an implemented compiler prototype, not the complete production engine. The public source entry is src/index.ts. Game code imports only @threecat/sdk; the engine compiler resolves that alias even for an external game directory with no package.json or Git metadata.

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

Geometry: box, sphere and plane. Lights: directional and point. Components: number, boolean, string and vec3 fields. Systems: synchronous update phase only. Prefabs support inheritance and per-field component overrides. Assets are declared local texture/binary files; this prototype copies and hashes them but does not implement the final asset optimization pipeline.

Full physics, animation, UI, world streaming, graphical programming and production ECS APIs from the product plan are not implemented in this SDK prototype.
