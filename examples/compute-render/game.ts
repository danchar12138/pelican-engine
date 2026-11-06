import { defineComponent, defineCompute, defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";

const stats = defineComponent({ id: "ResidentStats", schema: { releaseError: { type: "string", default: "" }, taskError: { type: "string", default: "" }, dispatches: { type: "number", default: 0 } } });
const move = defineCompute({ id: "advance", count: 1, workgroupSize: 1, outputType: "vec3", buffers: [{ name: "previous", type: "vec3" }], graph: {
  parameters: [{ name: "delta", type: "vec3", default: [0.01, 0, 0] }],
  nodes: [{ id: "zero", op: "float", value: 0 }, { id: "p", op: "readBuffer", buffer: "previous", inputs: ["zero"] }, { id: "delta", op: "parameter", name: "delta" }, { id: "out", op: "add", inputs: ["p", "delta"] }], output: "out",
} });
const invalid = defineCompute({ id: "invalidRead", count: 1, workgroupSize: 1, outputType: "vec3", buffers: [{ name: "previous", type: "vec3" }], graph: {
  nodes: [{ id: "invalid", op: "float", value: 2 }, { id: "out", op: "readBuffer", buffer: "previous", inputs: ["invalid"] }], output: "out",
} });
const material = defineMaterial({ id: "moving", color: "#d95c43", roughness: 0.5, emissive: "#28110c", buffers: [{ name: "offset", type: "vec3", buffer: "primary", count: 1 }], vertex: { position: {
  nodes: [{ id: "p", op: "input", name: "positionLocal" }, { id: "zero", op: "float", value: 0 }, { id: "offset", op: "readBuffer", buffer: "offset", inputs: ["zero"] }, { id: "out", op: "add", inputs: ["p", "offset"] }], output: "out",
} } });
const depth = definePostProcess({ id: "distance", graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" }, { id: "sample", op: "sampleFrame", channel: "scene.depth", inputs: ["uv"] }, { id: "d", op: "swizzle", components: "r", inputs: ["sample"] }, { id: "scale", op: "float", value: 0.1 }, { id: "value", op: "multiply", inputs: ["d", "scale"] }, { id: "one", op: "float", value: 1 }, { id: "out", op: "compose4", inputs: ["value", "value", "value", "one"] }], output: "out",
} });
const system = defineSystem({ id: "resident", phase: "update", reads: ["ResidentStats"], writes: ["ResidentStats"], run(engine) {
  for (const task of engine.compute.tasks()) {
    if (task.state.status === "failed") engine.setComponent("stats", stats, { taskError: task.state.error!.code });
    if (task.state.status === "succeeded" || task.state.status === "cancelled" || task.state.status === "failed") engine.compute.releaseTask(task.handle);
  }
  let fail = false, cancel = false;
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    if (input.key === "a") engine.render.buffers.bind("moving", "offset", engine.compute.resolve("alternative"));
    if (input.key === "p") engine.render.buffers.bind("moving", "offset", engine.compute.resolve("primary"));
    if (input.key === "f") fail = true;
    if (input.key === "c") cancel = true;
    if (input.key === "q") {
      try { engine.compute.releaseBuffer(engine.compute.resolve(engine.render.buffers.state("moving").offset.id)); }
      catch (error) { engine.setComponent("stats", stats, { releaseError: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); }
    }
  }
  const previous = engine.compute.resolve(engine.render.buffers.state("moving").offset.id);
  if (fail) { engine.compute.dispatch(invalid, { output: previous, bindings: { previous } }); return; }
  if (cancel) {
    const task = engine.compute.dispatch(move, { output: previous, bindings: { previous } });
    engine.compute.cancel(task);
    return;
  }
  engine.compute.dispatch(move, { output: previous, bindings: { previous }, parameters: { delta: engine.input.held("reverse") ? [-0.05, 0, 0] : [0.05, 0, 0] } });
  const data = engine.getComponent("stats", stats);
  engine.setComponent("stats", stats, { dispatches: data.dispatches + 1 });
} });
export default defineGame({ id: "compute-to-render", computeBuffers: [
  { id: "primary", type: "vec3", count: 1, data: [[-8, 0, 0]] },
  { id: "alternative", type: "vec3", count: 1, data: [[-9, 0, 0.6]] },
], scene: defineScene({ id: "scene", camera: { position: [0, 0, 7], target: [0, 0, 0], fov: 45 }, environment: { background: "#101923", ambientIntensity: 0.8 }, entities: [
  { id: "shape", transform: { position: [8, 0, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.8, segments: 20 }, material } },
  { id: "stats", components: [{ component: stats }] },
  { id: "sun", transform: { position: [2, 4, 5] }, light: { kind: "directional", intensity: 3 } },
] }), systems: [system], computes: [move, invalid], components: [stats], postProcesses: [depth], input: { reverse: ["r"] }, render: { debug: "depth", maxBounces: 2, samplesPerFrame: 1 } });
