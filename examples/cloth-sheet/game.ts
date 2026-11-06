import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "ClothExampleState", schema: { initialized: { type: "boolean", default: false } } });
const sheet = defineMaterial({ id: "sheet-material", color: "#db9b54", roughness: 0.8, side: "double" });
const simulate = defineSystem({ id: "cloth-example", phase: "prePhysics", reads: ["ClothExampleState"], writes: ["ClothExampleState"], run(ctx) {
  if (!ctx.getComponent("state", State).initialized) {
    ctx.cloth.create({ id: "sheet", autoStep: true, mass: 0.15, radius: 0.05,
      points: [[-1, 2, 0], [0, 2, 0], [1, 2, 0], [-1, 1, 0], [0, 1, 0], [1, 1, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0]],
      triangles: [[0, 3, 1], [1, 3, 4], [1, 4, 2], [2, 4, 5], [3, 6, 4], [4, 6, 7], [4, 7, 5], [5, 7, 8]],
      anchors: [{ index: 0, position: [-1, 2, 0] }, { index: 2, position: [1, 2, 0] }],
      visual: { material: "sheet-material" },
      bodyColliders: [{ id: "sphere", entity: "cloth-ball" }],
      bodyReactions: true,
    });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.held("wind")) for (const index of [3, 4, 5, 6, 7, 8]) ctx.cloth.applyForce("sheet", index, [0, 0, 2]);
} });
export default defineGame({ id: "cloth-sheet", components: [State], materials: [sheet], systems: [simulate], input: { wind: [" "] },
  scene: defineScene({ id: "cloth-sheet-scene", camera: { position: [0, 1.2, 6], target: [0, 1.1, 0], fov: 45 },
    environment: { background: "#17252a", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "cloth-ball", transform: { position: [0, 0.7, 0.25] }, mesh: { geometry: { kind: "sphere", radius: 0.35 }, material: sheet }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "sphere", radius: 0.35 } } },
      { id: "sun", transform: { position: [2, 5, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
