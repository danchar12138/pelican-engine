import { defineGame, defineMaterial, defineScene } from "pelican-engine";

const white = defineMaterial({ id: "white", color: "#d9d9d9", roughness: 0.7 });
const red = defineMaterial({ id: "red", color: "#b52d27", roughness: 0.8 });
const green = defineMaterial({ id: "green", color: "#32905b", roughness: 0.8 });
const metal = defineMaterial({ id: "metal", color: "#e7d6ad", roughness: 0.08, metalness: 1 });
const emitter = defineMaterial({ id: "emitter", color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 10, roughness: 1 });
export default defineGame({ id: "quality-room", materials: [white, red, green, metal, emitter], render: { mode: "raster", exposure: 1, maxBounces: 6 },
  scene: defineScene({ id: "room", camera: { position: [0, 2.2, 7], target: [0, 1.8, 0], fov: 48 }, environment: { background: "#000000", ambientIntensity: 0, lighting: "none" }, entities: [
    { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [6, 0.2, 6] }, material: white } },
    { id: "ceiling", transform: { position: [0, 4.1, 0] }, mesh: { geometry: { kind: "box", size: [6, 0.2, 6] }, material: white } },
    { id: "back", transform: { position: [0, 2, -3.1] }, mesh: { geometry: { kind: "box", size: [6, 4, 0.2] }, material: white } },
    { id: "left", transform: { position: [-3.1, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.2, 4, 6] }, material: red } },
    { id: "right", transform: { position: [3.1, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.2, 4, 6] }, material: green } },
    { id: "emitter", transform: { position: [0, 3.95, 0] }, mesh: { geometry: { kind: "box", size: [1.8, 0.05, 1.8] }, material: emitter } },
    { id: "diffuse", transform: { position: [-1.15, 0.75, 0] }, mesh: { geometry: { kind: "box", size: [1.2, 1.5, 1.2] }, material: white } },
    { id: "specular", transform: { position: [1.1, 0.8, -0.3] }, mesh: { geometry: { kind: "sphere", radius: 0.8, segments: 32 }, material: metal } },
  ] }),
});
