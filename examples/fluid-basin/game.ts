import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";
const State = defineComponent({ id: "FluidState", schema: { initialized: { type: "boolean", default: false } } });
const marker = defineMaterial({ id: "marker", color: "#38a8b5", roughness: 0.45 });
const simulate = defineSystem({ id: "fluid-basin", phase: "prePhysics", reads: ["FluidState"], writes: ["FluidState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.fluid.create({ id: "basin", autoStep: true, seed: 7, gravity: [0, -2, 0], visual: { material: "marker", radius: 0.035 }, bodyColliders: [{ id: "fluid-sphere", entity: "fluid-body" }], bodyReactions: true });
    ctx.setComponent("state", State, { initialized: true });
  }
} });
export default defineGame({ id: "fluid-basin", components: [State], materials: [marker], systems: [simulate],
  scene: defineScene({ id: "fluid-scene", camera: { position: [0, 1.2, 5], target: [0, 0.3, 0], fov: 45 }, environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
    { id: "state", components: [{ component: State }] },
    { id: "fluid-body", transform: { position: [0, 0.4, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.35 }, material: marker }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "sphere", radius: 0.35 } } },
    { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
  ] }) });
