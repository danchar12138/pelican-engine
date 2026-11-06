import { defineAsset, defineGame, defineScene, defineSystem } from "pelican-engine";

const original = defineAsset({ id: "original", type: "model", path: "assets/sparse.glb", license: "MIT", source: "Procedural sparse triangle" });
const optimized = defineAsset({ id: "optimized", type: "model", path: "assets/optimized.glb", license: "MIT", source: "Losslessly optimized procedural sparse triangle" });
const controls = defineSystem({ id: "controls", phase: "input", writes: ["Transform"], run(ctx) {
  for (const event of ctx.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed || !["a", "b"].includes(input.key)) continue;
    const after = input.key === "a";
    ctx.setTransform("original", { position: after ? [100, 0, 0] : [0, 0, 0] });
    ctx.setTransform("optimized", { position: after ? [0, 0, 0] : [100, 0, 0] });
  }
} });
export default defineGame({ id: "sparse-glb", assets: [original, optimized], systems: [controls],
  render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 },
    environment: { background: "#000000", ambientIntensity: 0 }, entities: [
      { id: "original", model: { asset: original, castShadow: false } },
      { id: "optimized", transform: { position: [100, 0, 0] }, model: { asset: optimized, castShadow: false } },
      { id: "sun", transform: { position: [0, 0, 8] }, light: { kind: "directional", intensity: 4, target: [0, 0, 0] } },
    ] }),
});
