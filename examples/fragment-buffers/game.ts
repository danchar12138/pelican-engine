import { defineComponent, defineCompute, defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";

const stats = defineComponent({ id: "SlotStats", schema: { releaseError: { type: "string", default: "" } } });
const advance = defineCompute({ id: "advance", count: 2, workgroupSize: 2, outputType: "vec3",
  buffers: [{ name: "previous", type: "vec3" }], graph: {
    nodes: [{ id: "index", op: "input", name: "index" }, { id: "old", op: "readBuffer", buffer: "previous", inputs: ["index"] },
      { id: "delta", op: "vec3", value: [0.02, 0, 0.01] }, { id: "out", op: "add", inputs: ["old", "delta"] }], output: "out",
  } });
const lookup = {
  parameters: [{ name: "bias", type: "float", default: 0 }],
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "x", op: "swizzle", components: "x", inputs: ["uv"] },
    { id: "two", op: "float", value: 2 }, { id: "scaled", op: "multiply", inputs: ["x", "two"] },
    { id: "cell", op: "floor", inputs: ["scaled"] }, { id: "bias", op: "parameter", name: "bias" },
    { id: "index", op: "add", inputs: ["cell", "bias"] }, { id: "out", op: "readBuffer", buffer: "colors", inputs: ["index"] }], output: "out",
} as const;
const material = defineMaterial({ id: "palette", roughness: 1,
  buffers: [{ name: "colors", type: "vec3", count: 2, buffer: "primary" }], graphs: { baseColor: lookup, emissive: lookup },
});
const copy = definePostProcess({ id: "copy", graph: { nodes: [{ id: "uv", op: "input", name: "uv" },
  { id: "out", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] }], output: "out" } });
const palette = definePostProcess({ id: "palette", enabled: false,
  buffers: [{ name: "colors", type: "vec3", count: 2, buffer: "primary" }], graph: {
    parameters: [{ name: "bias", type: "float", default: 0 }],
    nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "x", op: "swizzle", components: "x", inputs: ["uv"] },
      { id: "two", op: "float", value: 2 }, { id: "scaled", op: "multiply", inputs: ["x", "two"] },
      { id: "cell", op: "floor", inputs: ["scaled"] }, { id: "bias", op: "parameter", name: "bias" },
      { id: "index", op: "add", inputs: ["cell", "bias"] }, { id: "value", op: "readBuffer", buffer: "colors", inputs: ["index"] },
      { id: "half", op: "float", value: 0.5 }, { id: "rgb", op: "multiply", inputs: ["value", "half"] },
      { id: "r", op: "swizzle", components: "x", inputs: ["rgb"] }, { id: "g", op: "swizzle", components: "y", inputs: ["rgb"] },
      { id: "b", op: "swizzle", components: "z", inputs: ["rgb"] }, { id: "one", op: "float", value: 1 },
      { id: "out", op: "compose4", inputs: ["r", "g", "b", "one"] }], output: "out",
  } });
const system = defineSystem({ id: "updatePalette", phase: "update", reads: ["SlotStats"], writes: ["SlotStats"], run(engine) {
  for (const t of engine.compute.tasks()) engine.compute.releaseTask(t.handle);
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean }; if (!input.pressed) continue;
    if (input.key === "e") engine.render.effects.configure("palette", { enabled: true });
    if (input.key === "i") engine.render.effects.configure("palette", { enabled: false });
    if (input.key === "o") engine.render.effects.setParameter("palette", "bias", 2);
    if (input.key === "j") engine.render.effects.setParameter("palette", "bias", 0.5);
    if (input.key === "n") engine.render.effects.setParameter("palette", "bias", -2);
    if (input.key === "0") engine.render.effects.setParameter("palette", "bias", 0);
    if (input.key === "m") engine.render.setMaterialParameter("palette", "bias", 2);
    if (input.key === "b") engine.render.setMaterialParameter("palette", "bias", 0);
    if (input.key === "a") {
      const alternative = engine.compute.resolve("alternative");
      engine.render.buffers.bind("palette", "colors", alternative);
      engine.render.effects.buffers.bind("palette", "colors", alternative);
    }
    if (input.key === "q") {
      try { engine.compute.releaseBuffer(engine.compute.resolve(engine.render.effects.buffers.state("palette").colors.id)); }
      catch (error) { engine.setComponent("stats", stats, { releaseError: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); }
    }
  }
  const previous = engine.compute.resolve(engine.render.buffers.state("palette").colors.id);
  engine.compute.dispatch(advance, { output: previous, bindings: { previous } });
} });
export default defineGame({ id: "fragment-buffers", components: [stats], systems: [system], computes: [advance],
  computeBuffers: [
    { id: "primary", type: "vec3", count: 2, data: [[0.05, 0.1, 0.15], [0.2, 0.3, 0.4]] },
    { id: "alternative", type: "vec3", count: 2, data: [[0.4, 0.1, 0.05], [0.1, 0.5, 0.2]] },
  ], postProcesses: [copy, palette], scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 },
    environment: { background: "#000000", ambientIntensity: 0 }, entities: [
      { id: "plane", mesh: { geometry: { kind: "plane", size: [4, 3] }, material } }, { id: "stats", components: [{ component: stats }] },
    ] }), render: { debug: "albedo", samplesPerFrame: 1, maxBounces: 1 },
});
