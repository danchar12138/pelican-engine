import { defineGame, defineScene, defineMaterial, definePostProcess, defineRenderExtension, defineSystem } from "pelican-engine";

const paint = defineMaterial({ id: "paint", color: "#29bca8", roughness: 0.35 });
const tint = definePostProcess({ id: "tint", graph: {
  parameters: [{ name: "amount", type: "float", default: 0.92 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "scene", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] },
    { id: "amount", op: "parameter", name: "amount" },
    { id: "result", op: "multiply", inputs: ["scene", "amount"] },
  ], output: "result",
} });
const extension = defineRenderExtension({ id: "presentation", version: "1", postProcesses: [tint],
  systems: [defineSystem({ id: "presentation", phase: "presentation" })],
  create() { return { systems: { presentation(ctx) { ctx.render.effects.setParameter("tint", "amount", 0.9 + 0.1 * Math.sin(ctx.time.elapsed)); } } }; },
});
export default defineGame({ id: "managed-rendering", extensions: [extension], services: { physics3d: "disabled" }, materials: [paint],
  scene: defineScene({ id: "main", camera: { position: [0, 1, 4], target: [0, 0.5, 0] }, entities: [
    { id: "custom", mesh: { material: paint, geometry: { kind: "buffer", positions: [-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0], uv: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] } } },
    { id: "sun", transform: { position: [2, 4, 5] }, light: { kind: "directional", intensity: 4 } },
  ] }),
});
