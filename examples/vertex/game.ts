import { defineAsset, defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";

const height = defineAsset({ id: "height", path: "assets/height.png", type: "texture", colorSpace: "linear", license: "MIT", source: "Procedural Pelican Engine vertex test data" });
const model = defineAsset({ id: "skinned", path: "assets/skinned.glb", type: "model", license: "MIT", source: "Procedural Pelican Engine skinned/morph test fixture" });
const deformation = {
  position: {
    parameters: [
      { name: "offset", type: "vec3", default: [-8, 0, 0] },
      { name: "amplitude", type: "float", default: 0.2 },
      { name: "frequency", type: "float", default: 2 },
      { name: "textureWeight", type: "float", default: 0 },
    ],
    nodes: [
      { id: "p", op: "input", name: "positionLocal" },
      { id: "y", op: "swizzle", components: "y", inputs: ["p"] },
      { id: "frequency", op: "parameter", name: "frequency" },
      { id: "scaled", op: "multiply", inputs: ["y", "frequency"] },
      { id: "time", op: "time" },
      { id: "phase", op: "add", inputs: ["scaled", "time"] },
      { id: "wave", op: "sin", inputs: ["phase"] },
      { id: "amplitude", op: "parameter", name: "amplitude" },
      { id: "dx", op: "multiply", inputs: ["wave", "amplitude"] },
      { id: "uv", op: "vec2", value: [0.5, 0.5] },
      { id: "height", op: "sampleTexture", texture: height, inputs: ["uv"] },
      { id: "value", op: "swizzle", components: "r", inputs: ["height"] },
      { id: "weight", op: "parameter", name: "textureWeight" },
      { id: "dz", op: "multiply", inputs: ["value", "weight"] },
      { id: "zero", op: "float", value: 0 },
      { id: "delta", op: "compose3", inputs: ["dx", "zero", "dz"] },
      { id: "offset", op: "parameter", name: "offset" },
      { id: "deformed", op: "add", inputs: ["p", "delta"] },
      { id: "out", op: "add", inputs: ["deformed", "offset"] },
    ], output: "out",
  },
  normal: {
    parameters: [{ name: "amplitude", type: "float", default: 0.2 }, { name: "frequency", type: "float", default: 2 }],
    nodes: [
      { id: "p", op: "input", name: "positionLocal" },
      { id: "n", op: "input", name: "normalLocal" },
      { id: "y", op: "swizzle", components: "y", inputs: ["p"] },
      { id: "frequency", op: "parameter", name: "frequency" },
      { id: "scaled", op: "multiply", inputs: ["y", "frequency"] },
      { id: "time", op: "time" },
      { id: "phase", op: "add", inputs: ["scaled", "time"] },
      { id: "cos", op: "cos", inputs: ["phase"] },
      { id: "amplitude", op: "parameter", name: "amplitude" },
      { id: "slope", op: "multiply", inputs: ["amplitude", "frequency"] },
      { id: "derivative", op: "multiply", inputs: ["cos", "slope"] },
      { id: "nx", op: "swizzle", components: "x", inputs: ["n"] },
      { id: "ny", op: "swizzle", components: "y", inputs: ["n"] },
      { id: "nz", op: "swizzle", components: "z", inputs: ["n"] },
      { id: "change", op: "multiply", inputs: ["derivative", "nx"] },
      { id: "nextY", op: "subtract", inputs: ["ny", "change"] },
      { id: "vector", op: "compose3", inputs: ["nx", "nextY", "nz"] },
      { id: "out", op: "normalize", inputs: ["vector"] },
    ], output: "out",
  },
} as const;
const red = defineMaterial({ id: "deformed", color: "#d85b47", roughness: 0.5, emissive: "#441711", emissiveIntensity: 0.5, vertex: deformation });
const blue = defineMaterial({ id: "skinnedMaterial", color: "#348dca", roughness: 0.5, vertex: deformation });
const diagnostic = definePostProcess({ id: "vertexView", enabled: false, graph: {
  parameters: [{ name: "view", type: "float", default: 0 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "depth", op: "sampleFrame", channel: "scene.depth", inputs: ["uv"] },
    { id: "distance", op: "swizzle", components: "r", inputs: ["depth"] },
    { id: "scale", op: "float", value: 0.1 },
    { id: "scaled", op: "multiply", inputs: ["distance", "scale"] },
    { id: "one", op: "float", value: 1 },
    { id: "depth4", op: "compose4", inputs: ["scaled", "scaled", "scaled", "one"] },
    { id: "normal", op: "sampleFrame", channel: "scene.normal", inputs: ["uv"] },
    { id: "rgb", op: "swizzle", components: "rgb", inputs: ["normal"] },
    { id: "half", op: "float", value: 0.5 },
    { id: "half3", op: "vec3", value: [0.5, 0.5, 0.5] },
    { id: "normalScaled", op: "multiply", inputs: ["rgb", "half"] },
    { id: "normalColor", op: "add", inputs: ["normalScaled", "half3"] },
    { id: "r", op: "swizzle", components: "r", inputs: ["normalColor"] },
    { id: "g", op: "swizzle", components: "g", inputs: ["normalColor"] },
    { id: "b", op: "swizzle", components: "b", inputs: ["normalColor"] },
    { id: "normal4", op: "compose4", inputs: ["r", "g", "b", "one"] },
    { id: "view", op: "parameter", name: "view" },
    { id: "isNormal", op: "equal", inputs: ["view", "one"] },
    { id: "out", op: "select", inputs: ["depth4", "normal4", "isNormal"] },
  ], output: "out",
} });
const controls = defineSystem({ id: "vertexControls", phase: "input", run(engine) {
  if (engine.time.tick === 1) engine.render.setMaterialParameter("skinnedMaterial", "offset", [-5, 0, 0]);
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    if (input.key === "o") engine.render.setMaterialParameter("deformed", "offset", [-6, 0, 0]);
    if (input.key === "c") engine.render.setMaterialParameter("deformed", "offset", [-8, 0, 0]);
    if (input.key === "t") engine.render.setMaterialParameter("deformed", "textureWeight", 1);
    if (input.key === "b") engine.render.setMaterialParameter("deformed", "amplitude", 0.35);
    if (input.key === "v" || input.key === "n") {
      engine.render.effects.configure("vertexView", { enabled: true });
      engine.render.effects.setParameter("vertexView", "view", input.key === "n" ? 1 : 0);
      engine.render.configure({ debug: input.key === "n" ? "normal" : "depth" });
    }
    if (input.key === "x") { engine.render.effects.configure("vertexView", { enabled: false }); engine.render.configure({ debug: "beauty" }); }
  }
} });
export default defineGame({ id: "controlled-vertex", scene: defineScene({ id: "scene", camera: { position: [0, 0, 7], target: [0, 0, 0], fov: 45 }, environment: { background: "#101923", ambientIntensity: 0.8 }, entities: [
  { id: "sphere", transform: { position: [8, 0, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.8, segments: 20 }, material: red } },
  { id: "skin", transform: { position: [3, -0.6, 0] }, model: { asset: model, material: blue, animation: { clip: "sway" } } },
  { id: "sun", transform: { position: [2, 6, 5] }, light: { kind: "directional", intensity: 3 } },
] }), systems: [controls], postProcesses: [diagnostic], render: { maxBounces: 2, samplesPerFrame: 1 } });
