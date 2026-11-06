import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "RopeSelfState", schema: { initialized: { type: "boolean", default: false } } });
const ropeMaterial = defineMaterial({ id: "rope-self-material", color: "#ec9d39", roughness: 0.5 });
const simulate = defineSystem({ id: "rope-self-demo", phase: "prePhysics", reads: ["RopeSelfState"], writes: ["RopeSelfState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.ropes.create({ id: "rope", autoStep: true, mass: 0.3, radius: 0.07, gravity: [0, 0, 0],
      points: [[-1, 2, 0], [1, 0.5, 0], [-1, 0.5, 0], [1, 2, 0]],
      visual: { material: "rope-self-material", radialSegments: 12 },
    });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("kick")) ctx.ropes.applyImpulse("rope", 3, [0, 0, 0.7]);
} });
export default defineGame({ id: "rope-self", components: [State], materials: [ropeMaterial], systems: [simulate], input: { kick: [" "] },
  scene: defineScene({ id: "rope-self-scene", camera: { position: [0, 1.5, 7], target: [0, 1.2, 0], fov: 45 },
    environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
