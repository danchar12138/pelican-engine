import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "SoftBodyExampleState", schema: { initialized: { type: "boolean", default: false } } });
const material = defineMaterial({ id: "soft-body-material", color: "#6cc4d8", roughness: 0.55, side: "double" });
const simulate = defineSystem({ id: "softbody-ball", phase: "prePhysics", reads: ["SoftBodyExampleState"], writes: ["SoftBodyExampleState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.softBodies.create({
      id: "ball",
      autoStep: true,
      gravity: [0, -2, 0],
      visual: { material: "soft-body-material" },
      bodyColliders: [{ id: "sphere", entity: "soft-body-sphere" }],
      bodyReactions: true,
    });
    ctx.setComponent("state", State, { initialized: true });
  }
} });

export default defineGame({ id: "softbody-ball", components: [State], materials: [material], systems: [simulate],
  scene: defineScene({ id: "softbody-ball-scene", camera: { position: [0, 1.4, 5], target: [0, 0.5, 0], fov: 45 },
    environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "soft-body-sphere", transform: { position: [0, 0.35, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.35 }, material }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "sphere", radius: 0.35 } } },
      { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }) });
