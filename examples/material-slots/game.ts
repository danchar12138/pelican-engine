import { defineAsset, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const panels = defineAsset({ id: "panels", type: "model", path: "assets/panels.glb", license: "MIT", source: "Procedural Pelican material slot fixture" });
const green = defineMaterial({ id: "green", color: "#00ff00", roughness: 0.8, metalness: 0 });
const controls = defineSystem({ id: "controls", phase: "input", writes: ["Transform"], run(ctx) {
  for (const event of ctx.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed || (input.key !== "b" && input.key !== "a")) continue;
    const after = input.key === "a";
    ctx.setTransform("before", { position: after ? [100, 0, 0] : [0, 0, 0] });
    ctx.setTransform("after", { position: after ? [0, 0, 0] : [100, 0, 0] });
  }
} });

export default defineGame({ id: "material-slots", assets: [panels], systems: [controls],
  render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 },
    environment: { background: "#000000", ambientIntensity: 0 }, entities: [
      { id: "before", model: { asset: panels, castShadow: false } },
      { id: "after", transform: { position: [100, 0, 0] }, model: { asset: panels, materialSlots: { Paint: green }, castShadow: false } },
      { id: "sun", transform: { position: [0, 0, 8] }, light: { kind: "directional", intensity: 4, target: [0, 0, 0] } },
    ] }),
});
