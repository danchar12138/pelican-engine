import { defineComponent, defineCompute, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const Statistics = defineComponent({ id: "ComputeStatistics", schema: {
  dispatches: { type: "number", default: 0 },
  positionX: { type: "number", default: -1.5 },
  available: { type: "boolean", default: false },
  failure: { type: "string", default: "" },
} });
const move = defineCompute({
  id: "integrate", count: 4, workgroupSize: 4, outputType: "vec3",
  buffers: [{ name: "positions", type: "vec3" }, { name: "velocities", type: "vec3" }],
  graph: {
    parameters: [{ name: "dt", type: "float", default: 0 }],
    nodes: [
      { id: "i", op: "input", name: "index" },
      { id: "p", op: "readBuffer", buffer: "positions", inputs: ["i"] },
      { id: "v", op: "readBuffer", buffer: "velocities", inputs: ["i"] },
      { id: "dt", op: "parameter", name: "dt" },
      { id: "delta", op: "multiply", inputs: ["v", "dt"] },
      { id: "next", op: "add", inputs: ["p", "delta"] },
    ], output: "next",
  },
});
const red = defineMaterial({ id: "red", color: "#dd5365", roughness: 0.4 });
const blue = defineMaterial({ id: "blue", color: "#4389da", roughness: 0.4 });
const green = defineMaterial({ id: "green", color: "#42b89f", roughness: 0.4 });
const gold = defineMaterial({ id: "gold", color: "#e6bd4e", roughness: 0.4 });
const floor = defineMaterial({ id: "floor", color: "#8797a3", roughness: 0.8 });
const scene = defineScene({ id: "feedback", camera: { position: [5, 5, 7], target: [0, 0, 0] }, environment: { background: "#111820", ambientIntensity: 1 }, entities: [
  { id: "statistics", components: [{ component: Statistics }] },
  { id: "p0", transform: { position: [-1.5, 0.3, -1] }, mesh: { geometry: { kind: "box", size: [0.5, 0.5, 0.5] }, material: red } },
  { id: "p1", transform: { position: [-0.5, 0.3, 0] }, mesh: { geometry: { kind: "box", size: [0.5, 0.5, 0.5] }, material: blue } },
  { id: "p2", transform: { position: [0.5, 0.3, 0] }, mesh: { geometry: { kind: "box", size: [0.5, 0.5, 0.5] }, material: green } },
  { id: "p3", transform: { position: [1.5, 0.3, 1] }, mesh: { geometry: { kind: "box", size: [0.5, 0.5, 0.5] }, material: gold } },
  { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [9, 0.2, 5] }, material: floor } },
  { id: "sun", transform: { position: [2, 7, 3] }, light: { kind: "directional", intensity: 3 } },
] });
const feedback = defineSystem({ id: "feedback", phase: "update", reads: ["ComputeStatistics"], writes: ["ComputeStatistics", "Transform"], run(engine, dt) {
  const stats = engine.getComponent("statistics", Statistics);
  if (!engine.render.capabilities().compute) {
    engine.setComponent("statistics", Statistics, { available: false, failure: "TC_RENDER_COMPUTE_UNAVAILABLE" });
    return;
  }
  if (engine.time.tick === 1) {
    engine.compute.createBuffer({ id: "positions", type: "vec3", count: 4, data: [[-1.5, 0.3, -1], [-0.5, 0.3, 0], [0.5, 0.3, 0], [1.5, 0.3, 1]] });
    engine.compute.createBuffer({ id: "velocities", type: "vec3", count: 4, data: [[0.6, 0, 0], [0, 0, 0.3], [0, 0, -0.3], [-0.6, 0, 0]] });
  }
  for (const task of engine.compute.tasks()) {
    if (task.state.status === "failed") throw Error(task.state.error!.message);
    if (task.state.status === "succeeded" || task.state.status === "cancelled") engine.compute.releaseTask(task.handle);
  }
  const positions = engine.compute.resolve("positions");
  const values = engine.compute.readBuffer(positions);
  for (let i = 0; i < values.length; i++) engine.setTransform("p" + i, { position: values[i] as readonly [number, number, number] });
  engine.setComponent("statistics", Statistics, { available: true, dispatches: stats.dispatches + 1, positionX: (values[0] as readonly number[])[0] });
  engine.compute.dispatch(move, { output: positions, bindings: { positions, velocities: engine.compute.resolve("velocities") }, parameters: { dt: engine.input.held("reverse") ? -dt : dt } });
} });
export default defineGame({ id: "managed-compute-feedback", scene, components: [Statistics], systems: [feedback], computes: [move], input: { reverse: ["r"] } });
