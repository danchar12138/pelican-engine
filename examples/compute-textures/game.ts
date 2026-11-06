import { defineComponent, defineCompute, defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";
const stats = defineComponent({ id: "TextureStats", schema: { phase: { type: "number", default: 0 }, busyError: { type: "string", default: "" }, taskErrors: { type: "string", default: "" } } });
const makeGraph = {
  nodes: [{ id: "pixel", op: "input", name: "pixelCoord" }, { id: "size", op: "input", name: "outputSize" },
    { id: "half", op: "vec2", value: [0.5, 0.5] }, { id: "center", op: "add", inputs: ["pixel", "half"] },
    { id: "uv", op: "safeDivide", inputs: ["center", "size"] }, { id: "direct", op: "input", name: "uv" },
    { id: "r", op: "swizzle", components: "x", inputs: ["uv"] }, { id: "g", op: "swizzle", components: "y", inputs: ["direct"] },
    { id: "index", op: "input", name: "index" }, { id: "four", op: "float", value: 4 }, { id: "b", op: "safeDivide", inputs: ["index", "four"] },
    { id: "one", op: "float", value: 1 }, { id: "out", op: "compose4", inputs: ["r", "g", "b", "one"] }], output: "out",
} as const;
const make = defineCompute({ id: "make", count: 4, workgroupSize: 4, outputType: "vec4", graph: makeGraph });
const feedback = defineCompute({ id: "feedback", count: 4, workgroupSize: 4, outputType: "vec4", textures: [{ name: "field", filter: "nearest" }], graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "old", op: "sampleTexture", texture: "field", inputs: ["uv"] },
    { id: "delta", op: "vec4", value: [0.125, 0.0625, 0, 0] }, { id: "out", op: "add", inputs: ["old", "delta"] }], output: "out",
} });
const makeWide = defineCompute({ id: "makeWide", count: 6, workgroupSize: 2, outputType: "vec4", graph: makeGraph });
const copyWide = defineCompute({ id: "copyWide", count: 6, workgroupSize: 2, outputType: "vec4", textures: [{ name: "field", filter: "nearest" }], graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "out", op: "sampleTexture", texture: "field", inputs: ["uv"] }], output: "out",
} });
const sample = defineCompute({ id: "sample", count: 2, workgroupSize: 2, outputType: "vec3", textures: [{ name: "field", filter: "linear" }], graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "rgba", op: "sampleTexture", texture: "field", inputs: ["uv"] },
    { id: "out", op: "swizzle", components: "rgb", inputs: ["rgba"] }], output: "out",
} });
const nearest = defineCompute({ id: "nearest", count: 1, workgroupSize: 1, outputType: "vec4", textures: [{ name: "field", filter: "nearest", wrapU: "repeat", wrapV: "mirror" }], graph: {
  nodes: [{ id: "uv", op: "vec2", value: [1.25, -0.25] }, { id: "out", op: "sampleTexture", texture: "field", inputs: ["uv"] }], output: "out",
} });
const linear = defineCompute({ id: "linear", count: 1, workgroupSize: 1, outputType: "vec4", textures: [{ name: "field", filter: "linear", wrapU: "repeat", wrapV: "mirror" }], graph: {
  nodes: [{ id: "uv", op: "vec2", value: [1, -0.25] }, { id: "out", op: "sampleTexture", texture: "field", inputs: ["uv"] }], output: "out",
} });
const invalid = defineCompute({ id: "invalid", count: 4, workgroupSize: 4, outputType: "vec4", textures: [{ name: "field" }], graph: {
  nodes: [{ id: "huge", op: "vec2", value: [1e38, 1e38] }, { id: "scale", op: "float", value: 1e38 },
    { id: "uv", op: "multiply", inputs: ["huge", "scale"] }, { id: "out", op: "sampleTexture", texture: "field", inputs: ["uv"] }], output: "out",
} });
const material = defineMaterial({ id: "palette", buffers: [{ name: "colors", type: "vec3", buffer: "current", count: 2 }], graphs: {
  baseColor: { nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "x", op: "swizzle", components: "x", inputs: ["uv"] }, { id: "two", op: "float", value: 2 },
    { id: "scale", op: "multiply", inputs: ["x", "two"] }, { id: "index", op: "floor", inputs: ["scale"] }, { id: "out", op: "readBuffer", buffer: "colors", inputs: ["index"] }], output: "out" },
  emissive: { nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "x", op: "swizzle", components: "x", inputs: ["uv"] }, { id: "two", op: "float", value: 2 },
    { id: "scale", op: "multiply", inputs: ["x", "two"] }, { id: "index", op: "floor", inputs: ["scale"] }, { id: "out", op: "readBuffer", buffer: "colors", inputs: ["index"] }], output: "out" },
} });
const copy = definePostProcess({ id: "copy", graph: { nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "out", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] }], output: "out" } });
const system = defineSystem({ id: "textures", phase: "update", reads: ["TextureStats"], writes: ["TextureStats"], run(engine) {
  const field = engine.compute.resolveTexture("field"), current = engine.compute.resolve("current");
  engine.setComponent("stats", stats, { taskErrors: engine.compute.tasks().flatMap(t => t.state.error ? [t.state.error.code] : []).join(",") });
  const phase = engine.getComponent("stats", stats).phase;
  if (phase === 0) {
    const generated = engine.compute.dispatch(make, { output: field });
    const updated = engine.compute.dispatch(feedback, { output: field, textures: { field: { task: generated } } });
    engine.compute.dispatch(sample, { output: current, textures: { field: { task: updated } } });
    engine.compute.dispatch(sample, { output: engine.compute.resolve("old"), textures: { field: { task: generated } }, after: [updated] });
    engine.compute.dispatch(sample, { output: engine.compute.resolve("captured"), textures: { field }, after: [updated] });
    engine.compute.dispatch(nearest, { output: engine.compute.resolve("nearest"), textures: { field: { task: updated } } });
    engine.compute.dispatch(linear, { output: engine.compute.resolve("linear"), textures: { field: { task: updated } } });
    const wide = engine.compute.dispatch(makeWide, { output: engine.compute.resolveTexture("wide") });
    engine.compute.dispatch(copyWide, { output: engine.compute.resolveTexture("wideCopy"), textures: { field: { task: wide } } });
    try { engine.compute.releaseTexture(field); }
    catch (error) { engine.setComponent("stats", stats, { busyError: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); }
    engine.setComponent("stats", stats, { phase: 1 }); return;
  }
  if (phase === 1) {
    const first = engine.compute.tasks()[0];
    if (first) engine.compute.dispatch(sample, { output: engine.compute.resolve("late"), textures: { field: { task: first.handle } } });
    engine.setComponent("stats", stats, { phase: 2 });
  }
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean }; if (!input.pressed) continue;
    if (input.key === "r") for (const task of [...engine.compute.tasks()].reverse()) engine.compute.releaseTask(task.handle);
    if (input.key === "u") {
      const updated = engine.compute.dispatch(feedback, { output: field, textures: { field } });
      engine.compute.dispatch(sample, { output: current, textures: { field: { task: updated } } });
    }
    if (input.key === "f" || input.key === "c") {
      const failed = engine.compute.dispatch(input.key === "f" ? invalid : feedback, { output: field, textures: { field } });
      engine.compute.dispatch(sample, { output: current, textures: { field: { task: failed } } });
      engine.compute.dispatch(sample, { output: engine.compute.resolve("late"), textures: { field } });
      if (input.key === "c") engine.compute.cancel(failed);
    }
    if (input.key === "w") {
      engine.compute.writeTexture(field, [[0.9, 0.2, 0.1, 1]], { x: 0, y: 0, width: 1, height: 1 });
      engine.compute.dispatch(sample, { output: current, textures: { field } });
    }
  }
} });
export default defineGame({ id: "compute-textures", components: [stats], systems: [system], computes: [make, feedback, sample, nearest, linear, invalid, makeWide, copyWide],
  computeTextures: [{ id: "field", width: 2, height: 2 }, { id: "wide", width: 3, height: 2 }, { id: "wideCopy", width: 3, height: 2 }], computeBuffers: [
    { id: "current", type: "vec3", count: 2 }, { id: "old", type: "vec3", count: 2 },
    { id: "captured", type: "vec3", count: 2 }, { id: "late", type: "vec3", count: 2 },
    { id: "nearest", type: "vec4", count: 1 }, { id: "linear", type: "vec4", count: 1 },
  ], postProcesses: [copy], render: { debug: "albedo", maxBounces: 1, samplesPerFrame: 1 },
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "plane", mesh: { geometry: { kind: "plane", size: [4, 3] }, material } }, { id: "stats", components: [{ component: stats }] },
  ] }),
});
