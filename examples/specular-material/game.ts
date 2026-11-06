import { defineAsset, defineGame, defineMaterial, defineScene } from "pelican-engine";

const imported = defineAsset({ id: "imported", type: "model", path: "assets/specular.glb", license: "MIT", source: "Pelican procedural glTF specular test fixture" });
const red = defineMaterial({ id: "red", color: "#000000", roughness: 0.35, metalness: 0, ior: 2, specularIntensity: 1, specularColor: "#ff0000" });
const dark = defineMaterial({ id: "dark", color: "#000000", roughness: 0.35, metalness: 0, ior: 2, specularIntensity: 0, specularColor: "#ffffff" });
const green = defineMaterial({ id: "green", color: "#000000", roughness: 0.35, metalness: 0, ior: 2, specularIntensity: 1, specularColor: "#00ff00" });
export default defineGame({ id: "specular-material", assets: [imported], render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0,0,8], target: [0,0,0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "importedPlane", transform: { position: [-2.4,0,0] }, model: { asset: imported } },
    { id: "dark", transform: { position: [-0.8,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: dark } },
    { id: "green", transform: { position: [0.8,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: green } },
    { id: "red", transform: { position: [2.4,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: red } },
    { id: "sun", transform: { position: [0,0,8] }, light: { kind: "directional", intensity: 4, target: [0,0,0] } },
  ] }),
});
