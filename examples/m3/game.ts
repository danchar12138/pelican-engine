import {
  defineGame,
  defineScene,
  defineMaterial,
  defineAsset,
  defineSystem,
  defineComponent,
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
const bottle = defineAsset({
  id: "bottle",
  type: "model",
  path: "assets/WaterBottle.glb",
  license: "CC0-1.0",
  source:
    "KhronosGroup/glTF-Sample-Assets@8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/WaterBottle",
  attribution: "Microsoft (2017).",
});
const ivory = defineMaterial({
  id: "ivory",
  color: "#c1c7c9",
  roughness: 0.65,
});
const copper = defineMaterial({
  id: "copper",
  color: "#ce8a54",
  roughness: 0.18,
  metalness: 1,
});
const teal = defineMaterial({
  id: "teal",
  color: "#24b8a9",
  roughness: 0.48,
  metalness: 0.25,
});
const red = defineMaterial({ id: "red", color: "#d9435e", roughness: 0.7 });
const emission = defineMaterial({
  id: "emission",
  color: "#fff0d5",
  emissive: "#ffe1ae",
  emissiveIntensity: 4,
  roughness: 0.4,
});
const Gallery = defineComponent({
  id: "Gallery",
  schema: { animate: { type: "boolean", default: true } },
});
const input = defineSystem({
  id: "gallery-input",
  phase: "input",
  reads: ["Gallery"],
  writes: ["Gallery"],
  run(ctx) {
    if (ctx.input.pressed("raster")) ctx.render.configure({ mode: "raster", denoise: false });
    if (ctx.input.pressed("hybrid")) ctx.render.configure({ mode: "hybrid", denoise: true, samplesPerFrame: 2, maxBounces: 8 });
    if (ctx.input.pressed("path")) ctx.render.configure({ mode: "path", denoise: true, samplesPerFrame: 2, maxBounces: 8 });
    if (ctx.input.pressed("motion"))
      ctx.setComponent("fox", Gallery, {
        animate: !ctx.getComponent("fox", Gallery).animate,
      });
    if (ctx.input.pressed("denoise"))
      ctx.render.configure({ denoise: !ctx.render.state().denoise });
    if (ctx.input.pressed("direct"))
      ctx.render.configure({
        directLighting: !ctx.render.state().directLighting,
      });
    if (ctx.input.pressed("indirect"))
      ctx.render.configure({
        indirectLighting: !ctx.render.state().indirectLighting,
      });
  },
});
const motion = defineSystem({
  id: "gallery-motion",
  phase: "update",
  reads: ["Gallery", "Transform"],
  writes: ["Transform"],
  run(ctx) {
    if (!ctx.getComponent("fox", Gallery).animate) return;
    const t = ctx.time.elapsed;
    ctx.setTransform("metal", {
      position: [-1.25 + Math.sin(t) * 0.35, 0.7, -0.2],
      rotation: [0, t * 0.4, 0],
    });
  },
});
export default defineGame({
  id: "m3-surface-gallery",
  scene: defineScene({
    id: "gallery",
    camera: { position: [4.8, 3.5, 7.5], target: [0, 1, 0], fov: 46, far: 80 },
    environment: {
      background: "#152333",
      ambientIntensity: 0.65,
      lighting: "studio",
    },
    entities: [
      {
        id: "floor",
        transform: { position: [0, -0.15, 0] },
        mesh: { geometry: { kind: "box", size: [9, 0.3, 8] }, material: ivory },
      },
      {
        id: "back",
        transform: { position: [0, 1.7, -2.7] },
        mesh: {
          geometry: { kind: "box", size: [9, 3.4, 0.2] },
          material: ivory,
        },
      },
      {
        id: "red-wall",
        transform: { position: [-3.5, 1.7, 0] },
        mesh: {
          geometry: { kind: "box", size: [0.2, 3.4, 5.4] },
          material: red,
        },
      },
      {
        id: "metal",
        transform: { position: [-1.25, 0.7, -0.2] },
        mesh: {
          geometry: { kind: "sphere", radius: 0.7, segments: 24 },
          material: copper,
        },
      },
      {
        id: "teal-block",
        transform: { position: [1.5, 0.5, -0.8], rotation: [0, 0.4, 0] },
        mesh: { geometry: { kind: "box", size: [1, 1, 1] }, material: teal },
      },
      {
        id: "fox",
        transform: { position: [0, 0.02, 1.2], rotation: [0, 0.5, 0] },
        model: { asset: fox, scale: 0.013, animation: { clip: "Survey" } },
        components: [{ component: Gallery }],
      },
      {
        id: "bottle",
        transform: { position: [1.4, 0.85, 0.6] },
        model: { asset: bottle, scale: 6 },
      },
      {
        id: "plinth",
        transform: { position: [1.4, 0.3, 0.6] },
        mesh: { geometry: { kind: "box", size: [1, 0.6, 1] }, material: ivory },
      },
      {
        id: "emitter",
        transform: { position: [0, 3, -1.6] },
        mesh: {
          geometry: { kind: "box", size: [1.8, 0.12, 0.5] },
          material: emission,
        },
      },
      {
        id: "key",
        transform: { position: [-2, 4, 3] },
        light: {
          kind: "point",
          color: "#ffe1b8",
          intensity: 90,
          castShadow: true,
        },
      },
      {
        id: "fill",
        transform: { position: [2.8, 2, -0.8] },
        light: { kind: "point", color: "#70caff", intensity: 24 },
      },
      {
        id: "sun",
        transform: { position: [-2, 6, 4] },
        light: {
          kind: "directional",
          target: [0, 0, 0],
          color: "#fff5e3",
          intensity: 1.8,
          castShadow: true,
        },
      },
    ],
  }),
  components: [Gallery],
  systems: [input, motion],
  materials: [ivory, copper, teal, red, emission],
  assets: [fox, bottle],
  input: {
    raster: ["1"],
    hybrid: ["2"],
    path: ["3"],
    motion: [" "],
    denoise: ["n"],
    direct: ["d"],
    indirect: ["i"],
  },
  render: { mode: "path", samplesPerFrame: 2, maxBounces: 8, denoise: true },
});
