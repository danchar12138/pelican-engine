import {
  defineComponent,
  defineCompute,
  defineGame,
  defineMaterial,
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
export const Progress = defineComponent({
  id: "Progress",
  schema: {
    ticks: { type: "number", default: 0 },
    lastRandom: { type: "number", default: 0 },
    events: { type: "number", default: 0 },
  },
});
const copper = defineMaterial({
  id: "copper",
  color: "#db7836",
  roughness: 0.26,
  metalness: 0.65,
});
const floor = defineMaterial({ id: "floor", color: "#71839a", roughness: 0.8 });
const green = defineMaterial({
  id: "green",
  color: "#27bd75",
  roughness: 0.45,
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
const input = defineSystem({
  id: "input",
  phase: "input",
  reads: ["Motion"],
  writes: ["Transform"],
  run(engine) {
    for (const event of engine.events("input.key")) {
      const input = event.payload as { key: string; pressed: boolean };
      if (!input.pressed || !["ArrowLeft", "ArrowRight"].includes(input.key))
        continue;
      for (const id of engine.query(Motion)) {
        const transform = engine.getTransform(id);
        engine.setTransform(id, {
          position: [
            transform.position[0] + (input.key === "ArrowRight" ? 0.25 : -0.25),
            transform.position[1],
            transform.position[2],
          ],
        });
      }
    }
  },
});
const spin = defineSystem({
  id: "spin",
  phase: "update",
  reads: ["Motion"],
  writes: ["Transform", "Progress"],
  run(engine, dt) {
    for (const id of engine.query(Motion)) {
      const motion = engine.getComponent(id, Motion);
      if (!motion.enabled) continue;
      const transform = engine.getTransform(id);
      engine.setTransform(id, {
        rotation: [0, transform.rotation[1] + motion.speed * dt, 0],
      });
      const progress = engine.getComponent(id, Progress);
      engine.setComponent(id, Progress, {
        ticks: progress.ticks + 1,
        lastRandom: engine.random(),
      });
      if (progress.ticks === 0) engine.emit("started", { entity: id });
    }
  },
});
const observe = defineSystem({
  id: "observe",
  phase: "postPhysics",
  reads: [],
  writes: ["Progress"],
  run(engine) {
    for (const event of engine.events("started")) {
      const id = (event.payload as { entity: string }).entity;
      const progress = engine.getComponent(id, Progress);
      engine.setComponent(id, Progress, { events: progress.events + 1 });
    }
  },
});
export default defineGame({
  id: "m1-foundation",
  scene: defineScene({
    id: "foundation",
    camera: { position: [4, 3, 6], target: [0, 0.7, 0], fov: 45 },
    environment: { background: "#111d2a", ambientIntensity: 1.1 },
    entities: [
      {
        id: "spinner",
        mesh: {
          geometry: { kind: "box", size: [1.3, 1.3, 1.3] },
          material: copper,
        },
        transform: { position: [-0.9, 0.8, 0] },
        components: [{ component: Motion }, { component: Progress }],
      },
      {
        id: "orb",
        mesh: { geometry: { kind: "sphere", radius: 0.65 }, material: green },
        transform: { position: [1.1, 0.7, 0] },
      },
      {
        id: "ground",
        mesh: {
          geometry: { kind: "box", size: [12, 0.2, 12] },
          material: floor,
        },
        transform: { position: [0, -0.1, 0] },
      },
      {
        id: "sun",
        light: {
          kind: "directional",
          color: "#fff1d4",
          intensity: 4,
          castShadow: true,
        },
        transform: { position: [-3, 7, 4] },
      },
    ],
  }),
  systems: [spin, observe, input],
  computes: [pulse],
});

const acceptanceTypeError: number = "INTENTIONAL_TYPE_ERROR";
