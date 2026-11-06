import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

// The cubes show particle positions only; there is no built-in rope mesh yet.
const State = defineComponent({ id: "RopeExampleState", schema: {
  initialized: { type: "boolean", default: false },
} });
const particle = defineMaterial({ id: "particle", color: "#e99b37", roughness: 0.6 });
const floor = defineMaterial({ id: "floor", color: "#456575", roughness: 0.8 });
const simulate = defineSystem({ id: "rope-example", phase: "prePhysics", reads: ["RopeExampleState"], writes: ["RopeExampleState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.ropes.create({ id: "example", mass: 0.2, points: [[-1, 2, 0], [-0.5, 2, 0], [0, 2, 0], [0.5, 2, 0]] });
    ctx.ropes.setColliders("example", [{ id: "floor", kind: "plane", normal: [0, 1, 0], offset: 0 }]);
    ctx.setComponent("state", State, { initialized: true });
  }
  const state = ctx.ropes.step("example");
  for (let index = 0; index < state.positions.length; index++)
    ctx.setTransform(`particle-${index}`, { position: state.positions[index] });
} });
export default defineGame({ id: "rope-particles", components: [State], systems: [simulate],
  scene: defineScene({ id: "rope-scene", camera: { position: [0, 2, 6], target: [0, 1, 0], fov: 45 },
    environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [5, 0.2, 3] }, material: floor } },
      { id: "particle-0", transform: { position: [-1, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-1", transform: { position: [-0.5, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-2", transform: { position: [0, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-3", transform: { position: [0.5, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
