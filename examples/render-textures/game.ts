import { defineAsset, defineComponent, defineCompute, defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";
const asset = defineAsset({ id: "sourceImage", path: "assets/height.png", type: "texture", colorSpace: "srgb", license: "MIT", source: "Pelican deterministic test image" });
const stats = defineComponent({ id: "TextureSlotStats", schema: { releaseError: { type: "string", default: "" } } });
const update = defineCompute({ id: "update", count: 4, workgroupSize: 4, outputType: "vec4", textures: [{ name: "previous", filter: "nearest" }], graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "old", op: "sampleTexture", texture: "previous", inputs: ["uv"] },
    { id: "delta", op: "vec4", value: [0.03, 0.02, 0.01, 0] }, { id: "out", op: "add", inputs: ["old", "delta"] }], output: "out",
} });
const color = { nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "sample", op: "sampleTexture", texture: "image", inputs: ["uv"] }, { id: "out", op: "swizzle", components: "rgb", inputs: ["sample"] }], output: "out" } as const;
const material = defineMaterial({ id: "palette", textures: [{ name: "image", texture: "dynamic", width: 2, height: 2, filter: "linear", wrapU: "repeat", wrapV: "mirror" }],
  graphs: { baseColor: color, emissive: color }, vertex: { position: { nodes: [
    { id: "p", op: "input", name: "positionLocal" }, { id: "uv", op: "vec2", value: [0.25, 0.25] },
    { id: "sample", op: "sampleTexture", texture: "image", inputs: ["uv"] }, { id: "rgb", op: "swizzle", components: "rgb", inputs: ["sample"] },
    { id: "scale", op: "float", value: 0.1 }, { id: "offset", op: "multiply", inputs: ["rgb", "scale"] },
    { id: "out", op: "add", inputs: ["p", "offset"] }], output: "out" } } });
const copy = definePostProcess({ id: "copy", graph: { nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "out", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] }], output: "out" } });
const effect = definePostProcess({ id: "palette", enabled: false, textures: [{ name: "image", texture: "dynamic", width: 2, height: 2, filter: "linear", wrapU: "repeat", wrapV: "mirror" }], graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "rgba", op: "sampleTexture", texture: "image", inputs: ["uv"] }, { id: "half", op: "float", value: 0.5 },
    { id: "rgb", op: "swizzle", components: "rgb", inputs: ["rgba"] }, { id: "scaled", op: "multiply", inputs: ["rgb", "half"] },
    { id: "r", op: "swizzle", components: "x", inputs: ["scaled"] }, { id: "g", op: "swizzle", components: "y", inputs: ["scaled"] }, { id: "b", op: "swizzle", components: "z", inputs: ["scaled"] },
    { id: "one", op: "float", value: 1 }, { id: "out", op: "compose4", inputs: ["r", "g", "b", "one"] }], output: "out",
} });
const system = defineSystem({ id: "advance", phase: "update", reads: ["TextureSlotStats"], writes: ["TextureSlotStats"], run(engine) {
  for (const task of engine.compute.tasks()) engine.compute.releaseTask(task.handle);
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean }; if (!input.pressed) continue;
    if (input.key === "e") engine.render.effects.configure("palette", { enabled: true });
    if (input.key === "i") engine.render.effects.configure("palette", { enabled: false });
    if (input.key === "a") { const texture = engine.compute.resolveTexture("imported"); engine.render.textures.bind("palette", "image", texture); engine.render.effects.textures.bind("palette", "image", texture); }
    if (input.key === "p") { const texture = engine.compute.resolveTexture("dynamic"); engine.render.textures.bind("palette", "image", texture); engine.render.effects.textures.bind("palette", "image", texture); }
    if (input.key === "q") { try { engine.compute.releaseTexture(engine.compute.resolveTexture(engine.render.textures.state("palette").image.id)); } catch (error) { engine.setComponent("stats", stats, { releaseError: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); } }
  }
  const previous = engine.compute.resolveTexture(engine.render.textures.state("palette").image.id);
  engine.compute.dispatch(update, { output: previous, textures: { previous } });
} });
export default defineGame({ id: "render-textures", assets: [asset], components: [stats], systems: [system], computes: [update],
  computeTextures: [{ id: "dynamic", width: 2, height: 2, data: [[0.1,0.2,0.3,1],[0.6,0.2,0.1,1],[0.2,0.5,0.3,1],[0.7,0.5,0.4,1]] }, { id: "imported", asset }],
  postProcesses: [copy, effect], render: { debug: "albedo", maxBounces: 1, samplesPerFrame: 1 },
  scene: defineScene({ id: "scene", camera: { position: [0,0,5], target: [0,0,0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "plane", mesh: { geometry: { kind: "plane", size: [4,3] }, material } }, { id: "stats", components: [{ component: stats }] },
  ] }),
});
