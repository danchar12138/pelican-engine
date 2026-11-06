import { defineAsset, defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "pelican-engine";
const panels = defineAsset({ id: "panels", type: "model", path: "assets/panels.glb", license: "MIT", source: "Procedural Pelican material slot fixture" });
const red = defineMaterial({ id: "probe-red", color: "#ff1010", roughness: 0.8, metalness: 0 });
const green = defineMaterial({ id: "probe-green", color: "#10ff10", roughness: 0.8, metalness: 0 });
const a = definePrefab({ id: "model-a", model: { asset: panels, materialSlots: { Paint: red }, castShadow: false } });
const b = definePrefab({ id: "model-b", model: { asset: panels, materialSlots: { Paint: green }, castShadow: false } });
const state = defineComponent({ id: "ProbeState", schema: { isB: { type: "boolean", default: false } } });
const controls = defineSystem({ id: "switch", phase: "input", reads: ["ProbeState"], writes: ["ProbeState", "Transform"], structural: true, run(ctx) {
  if (ctx.input.pressed("switch")) {
    const isB = !ctx.getComponent("control", state).isB;
    ctx.entities.destroy("subject");
    ctx.entities.spawn({ id: "subject", prefab: isB ? "model-b" : "model-a" });
    ctx.setComponent("control", state, { isB });
  }
} });
export default defineGame({ id: "prefab-model-probe", assets: [panels], materials: [red, green], prefabs: [a, b], components: [state], systems: [controls], input: { switch: ["m"] },
  render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "control", components: [{ component: state }] }, { id: "subject", prefab: "model-a" },
    { id: "sun", transform: { position: [0, 0, 8] }, light: { kind: "directional", intensity: 4, target: [0, 0, 0] } },
  ] }),
});
