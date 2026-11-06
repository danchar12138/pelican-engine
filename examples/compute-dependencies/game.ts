import {
  defineComponent, defineCompute, defineGame, defineMaterial,
  definePostProcess, defineScene, defineSystem,
} from "pelican-engine";

const stats = defineComponent({ id: "DependencyStats", schema: {
  phase: { type: "number", default: 0 },
  releaseError: { type: "string", default: "" },
  taskErrors: { type: "string", default: "" },
} });
const advance = defineCompute({ id: "advance", count: 1, workgroupSize: 1,
  outputType: "vec3", buffers: [{ name: "previous", type: "vec3" }], graph: {
    parameters: [{ name: "delta", type: "vec3", default: [0, 0, 0] }],
    nodes: [{ id: "zero", op: "float", value: 0 },
      { id: "p", op: "readBuffer", buffer: "previous", inputs: ["zero"] },
      { id: "delta", op: "parameter", name: "delta" },
      { id: "out", op: "add", inputs: ["p", "delta"] }], output: "out",
  } });
const invalid = defineCompute({ id: "invalid", count: 1, workgroupSize: 1,
  outputType: "vec3", buffers: [{ name: "previous", type: "vec3" }], graph: {
    nodes: [{ id: "index", op: "float", value: 9 },
      { id: "out", op: "readBuffer", buffer: "previous", inputs: ["index"] }], output: "out",
  } });
const material = defineMaterial({ id: "moving", color: "#ea8461", roughness: 0.5,
  buffers: [{ name: "offset", type: "vec3", buffer: "final", count: 1 }], vertex: { position: {
    nodes: [{ id: "p", op: "input", name: "positionLocal" },
      { id: "zero", op: "float", value: 0 },
      { id: "offset", op: "readBuffer", buffer: "offset", inputs: ["zero"] },
      { id: "out", op: "add", inputs: ["p", "offset"] }], output: "out",
  } } });
const depth = definePostProcess({ id: "depth", graph: {
  nodes: [{ id: "uv", op: "input", name: "uv" },
    { id: "sample", op: "sampleFrame", channel: "scene.depth", inputs: ["uv"] },
    { id: "d", op: "swizzle", components: "r", inputs: ["sample"] },
    { id: "scale", op: "float", value: 0.1 },
    { id: "value", op: "multiply", inputs: ["d", "scale"] },
    { id: "one", op: "float", value: 1 },
    { id: "out", op: "compose4", inputs: ["value", "value", "value", "one"] }], output: "out",
} });
const system = defineSystem({ id: "dependencies", phase: "update",
  reads: ["DependencyStats"], writes: ["DependencyStats"], run(engine) {
    const state = engine.compute.resolve("state"), branch = engine.compute.resolve("branch"),
      snapshot = engine.compute.resolve("snapshot"), final = engine.compute.resolve("final"),
      spare = engine.compute.resolve("spare");
    const phase = engine.getComponent("stats", stats).phase;
    const errors = engine.compute.tasks().flatMap(task => task.state.error ? [task.state.error.code] : []);
    engine.setComponent("stats", stats, { taskErrors: errors.join(",") });
    if (phase === 0) {
      const a = engine.compute.dispatch(advance, { output: state, bindings: { previous: state }, parameters: { delta: [0.1, 0, 0] } });
      const overwrite = engine.compute.dispatch(advance, { output: state, bindings: { previous: { task: a } }, parameters: { delta: [0.9, 0, 0] } });
      const b = engine.compute.dispatch(advance, { output: branch, bindings: { previous: { task: a } }, after: [overwrite], parameters: { delta: [0.2, 0, 0] } });
      engine.compute.dispatch(advance, { output: snapshot, bindings: { previous: state }, after: [overwrite], parameters: { delta: [0.4, 0, 0] } });
      engine.compute.dispatch(advance, { output: final, bindings: { previous: { task: b } }, parameters: { delta: [0, 0, 0.25] } });
      try { engine.compute.releaseTask(a); }
      catch (error) { engine.setComponent("stats", stats, { releaseError: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); }
      engine.setComponent("stats", stats, { phase: 1 });
      return;
    }
    if (phase === 1) {
      // Task handles are transient and omitted from snapshots. A restored game can rebuild its graph.
      const first = engine.compute.tasks()[0];
      if (first) engine.compute.dispatch(advance, { output: branch, bindings: { previous: { task: first.handle } }, parameters: { delta: [0.5, 0, 0] } });
      engine.setComponent("stats", stats, { phase: 2 });
    }
    for (const event of engine.events("input.key")) {
      const input = event.payload as { key: string; pressed: boolean };
      if (!input.pressed) continue;
      if (input.key === "r") {
        for (const task of [...engine.compute.tasks()].reverse()) engine.compute.releaseTask(task.handle);
      }
      if (input.key === "f" || input.key === "c") {
        const predecessor = engine.compute.dispatch(input.key === "f" ? invalid : advance, { output: spare, bindings: { previous: state } });
        engine.compute.dispatch(advance, { output: final, bindings: { previous: { task: predecessor } } });
        engine.compute.dispatch(advance, { output: branch, bindings: { previous: state }, after: [predecessor] });
        engine.compute.dispatch(advance, { output: snapshot, bindings: { previous: final }, parameters: { delta: [0.125, 0, 0] } });
        if (input.key === "c") engine.compute.cancel(predecessor);
      }
    }
  } });
export default defineGame({ id: "compute-dependencies", computes: [advance, invalid],
  computeBuffers: [
    { id: "state", type: "vec3", count: 1, data: [[-8, 0, 0]] },
    { id: "branch", type: "vec3", count: 1, data: [[-8, 0, 0]] },
    { id: "snapshot", type: "vec3", count: 1, data: [[-8, 0, 0]] },
    { id: "final", type: "vec3", count: 1, data: [[-8, 0, 0]] },
    { id: "spare", type: "vec3", count: 1, data: [[-8, 0, 0]] },
  ],
  components: [stats], systems: [system], postProcesses: [depth],
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 7], target: [0, 0, 0], fov: 45 },
    environment: { background: "#101923", ambientIntensity: 0.8 }, entities: [
      { id: "shape", transform: { position: [8, 0, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.8, segments: 20 }, material } },
      { id: "stats", components: [{ component: stats }] },
      { id: "sun", transform: { position: [2, 4, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }), render: { debug: "depth", maxBounces: 2, samplesPerFrame: 1 },
});
