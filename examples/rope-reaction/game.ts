import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "RopeReactionState", schema: { initialized: { type: "boolean", default: false } } });
const particle = defineMaterial({ id: "particle", color: "#e99b37", roughness: 0.6 });
const ball = defineMaterial({ id: "ball", color: "#32a8b0", roughness: 0.5 });
const prepare = defineSystem({ id: "rope-reaction-prepare", phase: "prePhysics", reads: ["RopeReactionState"], writes: ["RopeReactionState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.ropes.create({ id: "rope", autoStep: true, mass: 0.2,
      points: [[-1, 2, 0], [-0.5, 2, 0], [0, 2, 0], [0.5, 2, 0]],
      bodyColliders: [{ id: "ball-sample", entity: "ball" }],
    });
    ctx.ropes.setColliders("rope", [{ id: "floor", kind: "plane", normal: [0, 1, 0], offset: 0 }]);
    ctx.setComponent("state", State, { initialized: true });
  }
} });
const react = defineSystem({ id: "rope-reaction-display", phase: "postPhysics", run(ctx) {
  const state = ctx.ropes.inspect("rope");
  for (let i = 0; i < state.positions.length; i++) ctx.setTransform(`particle-${i}`, { position: state.positions[i] });
} });
export default defineGame({ id: "rope-reaction", components: [State], systems: [prepare, react],
  scene: defineScene({ id: "rope-reaction-scene", gravity: [0, 0, 0], camera: { position: [0, 2, 6], target: [0, 1, 0], fov: 45 },
    environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "ball", transform: { position: [0, 1.3, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.5 }, material: ball }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "sphere", radius: 0.5 } } },
      { id: "particle-0", transform: { position: [-1, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-1", transform: { position: [-0.5, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-2", transform: { position: [0, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "particle-3", transform: { position: [0.5, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.12, 0.12, 0.12] }, material: particle } },
      { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
