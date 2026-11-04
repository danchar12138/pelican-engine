import {
  defineComponent,
  defineCompute,
  defineGame,
  defineMaterial,
  definePrefab,
  defineScene,
  defineSystem,
} from "@threecat/sdk";

export const Motion = defineComponent({
  id: "Motion",
  schema: {
    speed: { type: "number", default: 0.8 },
    enabled: { type: "boolean", default: true },
  },
});
const copper = defineMaterial({
  id: "copper",
  color: "#db7836",
  roughness: 0.26,
  metalness: 0.65,
});
const floor = defineMaterial({
  id: "floor",
  color: "#71839a",
  roughness: 0.8,
  metalness: 0.05,
});
const animated = defineMaterial({
  id: "animated",
  color: "#4488dd",
  roughness: 0.35,
  graph: {
    nodes: [
      { id: "base", op: "vec3", value: [0.1, 0.4, 0.8] },
      { id: "clock", op: "time" },
      { id: "wave", op: "sin", inputs: ["clock"] },
      { id: "tint", op: "multiply", inputs: ["base", "wave"] },
      { id: "color", op: "add", inputs: ["base", "tint"] },
    ],
    output: "color",
  },
});
const pulse = defineCompute({
  id: "pulse",
  count: 16,
  workgroupSize: 16,
  outputType: "float",
  graph: {
    nodes: [
      { id: "clock", op: "time" },
      { id: "wave", op: "sin", inputs: ["clock"] },
    ],
    output: "wave",
  },
});
const Spinner = definePrefab({
  id: "Spinner",
  mesh: { geometry: { kind: "box", size: [1.4, 1.4, 1.4] }, material: copper },
  components: [{ component: Motion }],
});
const scene = defineScene({
  id: "m0-scene",
  camera: { position: [5, 3.8, 7], target: [0, 0.7, 0], fov: 45 },
  environment: { background: "#151c2b", ambientIntensity: 0.5 },
  entities: [
    {
      id: "m0-spinner",
      prefab: Spinner,
      transform: { position: [-2, 1, 1.5] },
    },
    { id: "m0-group", transform: { position: [6, 0, -2] } },
    {
      id: "m0-child",
      parent: "m0-group",
      mesh: {
        geometry: { kind: "box", size: [0.25, 0.25, 0.25] },
        material: copper,
      },
      transform: { position: [1, 0.5, 0] },
    },
    {
      id: "m0-orb",
      mesh: { geometry: { kind: "sphere", radius: 0.7 }, material: animated },
      transform: { position: [-3.8, 0.85, 1.5] },
    },
    {
      id: "m0-ground",
      mesh: {
        geometry: { kind: "box", size: [4.8, 0.2, 3.6] },
        material: floor,
      },
      transform: { position: [-2, 0.05, 1.5] },
    },
    {
      id: "m0-sun",
      light: {
        kind: "directional",
        intensity: 4,
        color: "#fff0d8",
        castShadow: true,
      },
      transform: { position: [-2, 7, 5] },
    },
  ],
});
const spin = defineSystem({
  id: "spin",
  phase: "update",
  run(engine, dt) {
    for (const id of engine.query(Motion)) {
      const motion = engine.getComponent(id, Motion);
      if (!motion.enabled) continue;
      const t = engine.getTransform(id);
      engine.setTransform(id, {
        rotation: [
          t.rotation[0],
          t.rotation[1] + motion.speed * dt * 2,
          t.rotation[2],
        ],
      });
    }
  },
});
export default defineGame({
  id: "m0-game",
  scene,
  systems: [spin],
  computes: [pulse],
});
