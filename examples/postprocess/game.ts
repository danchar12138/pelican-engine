import { defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";

const surface = defineMaterial({ id: "surface", color: "#b55336", roughness: 0.5, emissive: "#542413", emissiveIntensity: 0.7 });
const marker = defineMaterial({ id: "marker", color: "#107a24", emissive: "#10d020", emissiveIntensity: 2, roughness: 1 });
const grade = definePostProcess({ id: "grade", graph: {
  parameters: [{ name: "gain", type: "float", default: 1 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "color", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] },
    { id: "rgb", op: "swizzle", components: "rgb", inputs: ["color"] },
    { id: "gain", op: "parameter", name: "gain" },
    { id: "graded", op: "multiply", inputs: ["rgb", "gain"] },
    { id: "r", op: "swizzle", components: "r", inputs: ["graded"] },
    { id: "g", op: "swizzle", components: "g", inputs: ["graded"] },
    { id: "b", op: "swizzle", components: "b", inputs: ["graded"] },
    { id: "one", op: "float", value: 1 },
    { id: "out", op: "compose4", inputs: ["r", "g", "b", "one"] },
  ], output: "out",
} });
const channels = definePostProcess({ id: "channels", graph: {
  parameters: [{ name: "view", type: "float", default: 0 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "beauty", op: "sampleFrame", channel: "grade", inputs: ["uv"] },
    { id: "normal", op: "sampleFrame", channel: "scene.normal", inputs: ["uv"] },
    { id: "normalRGB", op: "swizzle", components: "rgb", inputs: ["normal"] },
    { id: "half", op: "float", value: 0.5 },
    { id: "half3", op: "vec3", value: [0.5, 0.5, 0.5] },
    { id: "scaledNormal", op: "multiply", inputs: ["normalRGB", "half"] },
    { id: "normalView", op: "add", inputs: ["scaledNormal", "half3"] },
    { id: "nr", op: "swizzle", components: "r", inputs: ["normalView"] },
    { id: "ng", op: "swizzle", components: "g", inputs: ["normalView"] },
    { id: "nb", op: "swizzle", components: "b", inputs: ["normalView"] },
    { id: "one", op: "float", value: 1 },
    { id: "normal4", op: "compose4", inputs: ["nr", "ng", "nb", "one"] },
    { id: "depth", op: "sampleFrame", channel: "scene.depth", inputs: ["uv"] },
    { id: "distance", op: "swizzle", components: "r", inputs: ["depth"] },
    { id: "scale", op: "float", value: 0.1 },
    { id: "depthView", op: "multiply", inputs: ["distance", "scale"] },
    { id: "depth4", op: "compose4", inputs: ["depthView", "depthView", "depthView", "one"] },
    { id: "view", op: "parameter", name: "view" },
    { id: "zero", op: "float", value: 0 },
    { id: "two", op: "float", value: 2 },
    { id: "isNormal", op: "equal", inputs: ["view", "one"] },
    { id: "isDepth", op: "equal", inputs: ["view", "two"] },
    { id: "pickNormal", op: "select", inputs: ["beauty", "normal4", "isNormal"] },
    { id: "out", op: "select", inputs: ["pickNormal", "depth4", "isDepth"] },
  ], output: "out",
} });
const echo = definePostProcess({ id: "echo", graph: {
  parameters: [{ name: "weight", type: "float", default: 0 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "current", op: "sampleFrame", channel: "channels", inputs: ["uv"] },
    { id: "previous", op: "sampleHistory", channel: "echo", inputs: ["uv"] },
    { id: "weight", op: "parameter", name: "weight" },
    { id: "mixed", op: "mix", inputs: ["current", "previous", "weight"] },
    { id: "r", op: "swizzle", components: "r", inputs: ["mixed"] },
    { id: "g", op: "swizzle", components: "g", inputs: ["mixed"] },
    { id: "b", op: "swizzle", components: "b", inputs: ["mixed"] },
    { id: "one", op: "float", value: 1 },
    { id: "out", op: "compose4", inputs: ["r", "g", "b", "one"] },
  ], output: "out",
} });
const controls = defineSystem({ id: "effects", phase: "input", run(engine) {
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    if (input.key === "0" || input.key === "1") {
      for (const id of ["grade", "channels", "echo"]) engine.render.effects.configure(id, { enabled: input.key === "1" });
      engine.render.effects.setParameter("grade", "gain", 1);
      engine.render.effects.setParameter("channels", "view", 0);
      engine.render.effects.setParameter("echo", "weight", 0);
      engine.render.effects.resetHistory();
    }
    if (input.key === "g") engine.render.effects.setParameter("grade", "gain", 0.25);
    if (input.key === "b") engine.render.effects.setParameter("grade", "gain", 0);
    if (input.key === "n") engine.render.effects.setParameter("channels", "view", 1);
    if (input.key === "z") engine.render.effects.setParameter("channels", "view", 2);
    if (input.key === "e") { engine.render.effects.setParameter("echo", "weight", 0.5); engine.render.effects.resetHistory(); }
    if (input.key === "r") engine.render.effects.resetHistory();
  }
} });
export default defineGame({ id: "controlled-postprocess", scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 }, environment: { background: "#101923", ambientIntensity: 0.7 }, entities: [
  { id: "box", mesh: { geometry: { kind: "box", size: [2, 2, 1] }, material: surface } },
  { id: "orientation", transform: { position: [-1.6, 0.7, 0.5] }, mesh: { geometry: { kind: "box", size: [0.4, 0.4, 0.4] }, material: marker } },
  { id: "sun", transform: { position: [2, 4, 5] }, light: { kind: "directional", intensity: 3 } },
] }), systems: [controls], postProcesses: [grade, channels, echo], render: { samplesPerFrame: 1, maxBounces: 2 } });
