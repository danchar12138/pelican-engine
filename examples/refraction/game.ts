import {
  defineGame,
  defineScene,
  defineMaterial,
  defineSystem,
} from "pelican-engine";
const white = defineMaterial({
  id: "white",
  color: "#ffffff",
  roughness: 1,
  metalness: 0,
});
const absorbing = defineMaterial({
  id: "absorbing",
  color: "#ffffff",
  transmission: 1,
  ior: 1,
  roughness: 0,
  metalness: 0,
  attenuationColor: "#80c0e0",
  attenuationDistance: 1,
});
const clear = defineMaterial({
  id: "clear",
  color: "#ffffff",
  transmission: 1,
  ior: 1,
  roughness: 0,
  metalness: 0,
});
const refracting = defineMaterial({
  id: "refracting",
  color: "#ffffff",
  transmission: 1,
  ior: 1.5,
  roughness: 0,
  metalness: 0,
});
const rough = defineMaterial({
  id: "rough",
  color: "#ffffff",
  transmission: 1,
  ior: 1.5,
  roughness: 0.25,
  metalness: 0,
});
const red = defineMaterial({
  id: "red",
  color: "#c82642",
  emissive: "#c82642",
  emissiveIntensity: 1,
  roughness: 0.5,
});
const blue = defineMaterial({
  id: "blue",
  color: "#246bd8",
  emissive: "#246bd8",
  emissiveIntensity: 1,
  roughness: 0.5,
});
const outside = defineScene({
  id: "outside",
  camera: {
    position: [0, 0, 4],
    target: [0, 0, 0],
    near: 0.05,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "volume",
      mesh: { geometry: { kind: "box", size: [2, 2, 1] }, material: absorbing },
    },
  ],
});
const inside = defineScene({
  id: "inside",
  camera: {
    position: [0, 0, 0],
    target: [0, 0, -1],
    near: 0.01,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "volume",
      mesh: { geometry: { kind: "box", size: [2, 2, 2] }, material: absorbing },
    },
  ],
});
const nested = defineScene({
  id: "nested",
  camera: {
    position: [0, 0, 4],
    target: [0, 0, 0],
    near: 0.05,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "outer",
      mesh: { geometry: { kind: "box", size: [3, 3, 3] }, material: absorbing },
    },
    {
      id: "inner",
      mesh: { geometry: { kind: "box", size: [1, 1, 1] }, material: clear },
    },
  ],
});
const nestedInside = defineScene({
  id: "nested-inside",
  camera: {
    position: [0, 0, 0],
    target: [0, 0, -1],
    near: 0.01,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "outer",
      mesh: { geometry: { kind: "box", size: [3, 3, 3] }, material: absorbing },
    },
    {
      id: "inner",
      mesh: { geometry: { kind: "box", size: [1, 1, 1] }, material: clear },
    },
  ],
});
const optics = defineScene({
  id: "optics",
  camera: {
    position: [0, 0.1, 4],
    target: [0, 0, 0],
    near: 0.05,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "glass",
      mesh: {
        geometry: { kind: "sphere", radius: 0.8, segments: 32 },
        material: refracting,
      },
    },
    {
      id: "left",
      transform: { position: [-0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: red },
    },
    {
      id: "right",
      transform: { position: [0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: blue },
    },
  ],
});
const roughOptics = defineScene({
  id: "rough-optics",
  camera: {
    position: [0, 0.1, 4],
    target: [0, 0, 0],
    near: 0.05,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "glass",
      mesh: {
        geometry: { kind: "sphere", radius: 0.8, segments: 32 },
        material: rough,
      },
    },
    {
      id: "left",
      transform: { position: [-0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: red },
    },
    {
      id: "right",
      transform: { position: [0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: blue },
    },
  ],
});
const straightOptics = defineScene({
  ...optics,
  id: "straight-optics",
  entities: [
    {
      id: "glass",
      mesh: {
        geometry: { kind: "sphere", radius: 0.8, segments: 32 },
        material: clear,
      },
    },
    {
      id: "left",
      transform: { position: [-0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: red },
    },
    {
      id: "right",
      transform: { position: [0.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: blue },
    },
  ],
});
const smallOptics = defineScene({
  ...optics,
  id: "small-optics",
  camera: {
    position: [0, 0.001, 0.04],
    target: [0, 0, 0],
    near: 0.0005,
    fov: 35,
    far: 0.3,
  },
  entities: [
    {
      id: "glass",
      mesh: {
        geometry: { kind: "sphere", radius: 0.008, segments: 32 },
        material: refracting,
      },
    },
    {
      id: "left",
      transform: { position: [-0.005, 0, -0.02] },
      mesh: {
        geometry: { kind: "box", size: [0.01, 0.03, 0.001] },
        material: red,
      },
    },
    {
      id: "right",
      transform: { position: [0.005, 0, -0.02] },
      mesh: {
        geometry: { kind: "box", size: [0.01, 0.03, 0.001] },
        material: blue,
      },
    },
  ],
});
const translatedOptics = defineScene({
  ...optics,
  id: "translated-optics",
  camera: {
    position: [1000, 0.1, 4],
    target: [1000, 0, 0],
    near: 0.05,
    fov: 35,
    far: 30,
  },
  entities: [
    {
      id: "glass",
      transform: { position: [1000, 0, 0] },
      mesh: {
        geometry: { kind: "sphere", radius: 0.8, segments: 32 },
        material: refracting,
      },
    },
    {
      id: "left",
      transform: { position: [999.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: red },
    },
    {
      id: "right",
      transform: { position: [1000.5, 0, -2] },
      mesh: { geometry: { kind: "box", size: [1, 3, 0.1] }, material: blue },
    },
  ],
});
const sphereInside = defineScene({
  id: "sphere-inside",
  camera: {
    position: [0, 0, 0],
    target: [0, 0, -1],
    near: 0.01,
    fov: 35,
    far: 30,
  },
  environment: { background: "#ffffff", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "glass",
      mesh: {
        geometry: { kind: "sphere", radius: 0.8, segments: 32 },
        material: refracting,
      },
    },
  ],
});
const litAbsorbing = defineScene({
  id: "lit-absorbing",
  camera: {
    position: [0, 0, 1],
    target: [0, 0, 0],
    near: 0.01,
    fov: 35,
    far: 30,
  },
  environment: { background: "#000000", ambientIntensity: 0, lighting: "none" },
  entities: [
    {
      id: "outer",
      mesh: { geometry: { kind: "box", size: [4, 4, 4] }, material: absorbing },
    },
    {
      id: "surface",
      transform: { position: [0, 0, -0.05] },
      mesh: { geometry: { kind: "box", size: [2, 2, 0.1] }, material: white },
    },
    {
      id: "light",
      transform: { position: [0, 0, 1] },
      light: { kind: "point", color: "#ffffff", intensity: 3 },
    },
  ],
});
const litClear = defineScene({
  ...litAbsorbing,
  id: "lit-clear",
  entities: [
    {
      id: "outer",
      mesh: { geometry: { kind: "box", size: [4, 4, 4] }, material: clear },
    },
    {
      id: "surface",
      transform: { position: [0, 0, -0.05] },
      mesh: { geometry: { kind: "box", size: [2, 2, 0.1] }, material: white },
    },
    {
      id: "light",
      transform: { position: [0, 0, 1] },
      light: { kind: "point", color: "#ffffff", intensity: 3 },
    },
  ],
});
const lightingMode = defineSystem({
  id: "refraction-lighting-mode",
  run(ctx) {
    const scene = ctx.scenes.current();
    const lit = scene === "lit-clear" || scene === "lit-absorbing";
    ctx.render.configure({ directLighting: lit, indirectLighting: !lit });
  },
});
export default defineGame({
  id: "m3-dielectric-volume",
  scene: outside,
  scenes: [
    inside,
    nested,
    nestedInside,
    optics,
    roughOptics,
    straightOptics,
    smallOptics,
    translatedOptics,
    sphereInside,
    litAbsorbing,
    litClear,
  ],
  materials: [absorbing, clear, refracting, rough, red, blue, white],
  systems: [lightingMode],
  render: {
    mode: "path",
    samplesPerFrame: 1,
    maxBounces: 12,
    directLighting: false,
    indirectLighting: true,
    denoise: false,
  },
});
