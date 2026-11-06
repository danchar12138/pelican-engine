import {
  defineGame,
  defineScene,
  defineSystem,
  defineComponent,
  definePrefab,
  defineMaterial,
  defineAsset,
} from "pelican-engine";

const fox = defineAsset({
  id: "fox",
  type: "model",
  path: "assets/Fox.glb",
  license: "CC0-1.0 AND CC-BY-4.0",
  source:
    "KhronosGroup/glTF-Sample-Assets@8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Fox",
  attribution:
    "PixelMannen model; tomkranis animation; AsoboStudio and scurest glTF conversion.",
});
const white = defineMaterial({ id: "white", color: "#cbd2d5", roughness: 0.8 });
const blue = defineMaterial({ id: "blue", color: "#258bb8", roughness: 0.65 });
const pink = defineMaterial({ id: "pink", color: "#d34d72", roughness: 0.65 });
const green = defineMaterial({ id: "green", color: "#4aab67", roughness: 0.8 });
const emission = defineMaterial({
  id: "emission",
  color: "#ffffff",
  emissive: "#ffe5c1",
  emissiveIntensity: 3,
  roughness: 0.5,
});
const subjectBlue = definePrefab({
  id: "subject-blue",
  mesh: { geometry: { kind: "box", size: [1.2, 1.2, 1.2] }, material: blue },
});
const subjectPink = definePrefab({
  id: "subject-pink",
  mesh: { geometry: { kind: "box", size: [1.2, 1.2, 1.2] }, material: pink },
});
const panel = definePrefab({
  id: "screen-panel",
  mesh: { geometry: { kind: "box", size: [1.4, 2, 0.15] }, material: green },
});
const State = defineComponent({
  id: "TemporalState",
  schema: {
    initialized: { type: "boolean", default: false },
    object: { type: "boolean", default: false },
    camera: { type: "boolean", default: false },
    skin: { type: "boolean", default: false },
    blocker: { type: "boolean", default: true },
    pink: { type: "boolean", default: false },
    light: { type: "boolean", default: false },
  },
});
const controls = defineSystem({
  id: "temporal-controls",
  phase: "input",
  reads: ["TemporalState"],
  writes: ["TemporalState", "Transform"],
  structural: true,
  run(ctx) {
    const s = { ...ctx.getComponent("control", State) };
    if (!s.initialized) {
      ctx.animation.play("animated", "Run", { speed: 0 });
      s.initialized = true;
    }
    if (ctx.input.pressed("object")) s.object = !s.object;
    if (ctx.input.pressed("camera")) s.camera = !s.camera;
    if (ctx.input.pressed("skin")) {
      s.skin = !s.skin;
      ctx.animation.play("animated", "Run", { speed: s.skin ? 1 : 0 });
    }
    if (ctx.input.pressed("stop")) {
      s.object = false;
      s.camera = false;
      s.skin = false;
      ctx.animation.play("animated", "Run", { speed: 0 });
    }
    if (ctx.input.pressed("blocker")) {
      if (s.blocker) ctx.entities.destroy("blocker");
      else
        ctx.entities.spawn({
          id: "blocker",
          prefab: "screen-panel",
          transform: { position: [0, 1, 1.7] },
        });
      s.blocker = !s.blocker;
    }
    if (ctx.input.pressed("material")) {
      ctx.entities.destroy("subject");
      ctx.entities.spawn({
        id: "subject",
        prefab: s.pink ? "subject-blue" : "subject-pink",
        transform: { position: [-1, 0.6, 0] },
      });
      s.pink = !s.pink;
    }
    if (ctx.input.pressed("light")) {
      s.light = !s.light;
      ctx.setTransform("sun", { position: s.light ? [4, 3, -2] : [-3, 5, 4] });
    }
    if (ctx.input.pressed("path")) ctx.render.configure({ mode: "path" });
    if (ctx.input.pressed("hybrid")) ctx.render.configure({ mode: "hybrid" });
    if (ctx.input.pressed("raster")) ctx.render.configure({ mode: "raster" });
    if (ctx.input.pressed("denoise"))
      ctx.render.configure({ denoise: !ctx.render.state().denoise });
    if (ctx.input.pressed("samples"))
      ctx.render.configure({
        samplesPerFrame: ctx.render.state().samplesPerFrame === 1 ? 2 : 1,
      });
    ctx.setComponent("control", State, s);
  },
});
const movement = defineSystem({
  id: "temporal-movement",
  phase: "update",
  reads: ["TemporalState"],
  writes: ["Transform"],
  run(ctx, dt) {
    const s = ctx.getComponent("control", State),
      t = ctx.time.elapsed;
    if (s.object)
      ctx.setTransform("subject", {
        position: [-1 + Math.sin(t * 2) * 0.7, 0.6, 0],
        rotation: [0, t * 0.4, 0],
      });
    if (s.camera) ctx.camera.orbit(dt * 0.35);
  },
});
export default defineGame({
  id: "dynamic-sdk-game-validation",
  scene: defineScene({
    id: "temporal",
    camera: {
      position: [0, 2.5, 6],
      target: [0, 0.8, 0],
      fov: 46,
      near: 0.05,
      far: 40,
    },
    follow: {
      entity: "camera-target",
      distance: 6,
      height: 2.5,
      lookHeight: 0.8,
      yaw: 0,
      smoothing: 0,
    },
    environment: {
      background: "#293a49",
      ambientIntensity: 0.3,
      lighting: "none",
    },
    entities: [
      { id: "control", components: [{ component: State }] },
      { id: "camera-target" },
      {
        id: "floor",
        transform: { position: [0, -0.15, -1] },
        mesh: {
          geometry: { kind: "box", size: [10, 0.3, 9] },
          material: white,
        },
      },
      {
        id: "wall",
        transform: { position: [0, 1.5, -3] },
        mesh: {
          geometry: { kind: "box", size: [10, 3, 0.2] },
          material: white,
        },
      },
      {
        id: "stripe-left",
        transform: { position: [-2.5, 1, -2.8] },
        mesh: {
          geometry: { kind: "box", size: [0.45, 2, 0.15] },
          material: pink,
        },
      },
      {
        id: "stripe-right",
        transform: { position: [2.5, 1, -2.8] },
        mesh: {
          geometry: { kind: "box", size: [0.45, 2, 0.15] },
          material: blue,
        },
      },
      {
        id: "stripe-green",
        transform: { position: [-3.5, 1, -2.8] },
        mesh: {
          geometry: { kind: "box", size: [0.45, 2, 0.15] },
          material: green,
        },
      },
      {
        id: "subject",
        prefab: "subject-blue",
        transform: { position: [-1, 0.6, 0] },
      },
      {
        id: "blocker",
        prefab: "screen-panel",
        transform: { position: [0, 1, 1.7] },
      },
      {
        id: "animated",
        transform: { position: [2.1, 0, 0.6], rotation: [0, -0.7, 0] },
        model: {
          asset: fox,
          scale: 0.025,
          animation: { clip: "Run", speed: 1, loop: true },
        },
      },
      {
        id: "sun",
        transform: { position: [-3, 5, 4] },
        light: { kind: "directional", color: "#ffffff", intensity: 1.5 },
      },
      {
        id: "emitter",
        transform: { position: [0, 2.8, -1] },
        mesh: {
          geometry: { kind: "box", size: [1.8, 0.08, 0.5] },
          material: emission,
        },
      },
    ],
  }),
  assets: [fox],
  materials: [white, blue, pink, green, emission],
  prefabs: [subjectBlue, subjectPink, panel],
  components: [State],
  systems: [controls, movement],
  input: {
    object: ["o"],
    camera: ["c"],
    skin: ["a"],
    stop: ["f"],
    blocker: ["b"],
    material: ["m"],
    light: ["l"],
    path: ["3"],
    hybrid: ["2"],
    raster: ["1"],
    denoise: ["n"],
    samples: ["q"],
  },
  render: {
    mode: "path",
    samplesPerFrame: 1,
    maxBounces: 3,
    denoise: true,
    denoiseIterations: 2,
  },
});
