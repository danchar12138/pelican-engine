import { defineAsset, defineGame, defineMaterial, defineScene } from "pelican-engine";

const imported = defineAsset({ id: "textured", type: "model", path: "assets/specular-textures.glb", license: "MIT", source: "Original procedural geometry and pixels" });
const gray = defineMaterial({ id: "gray", color: "#000000", roughness: 0.35, metalness: 0, ior: 2, specularIntensity: 1, specularColor: "#808080" });
export default defineGame({ id: "specular-textures", assets: [imported], render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0,0,8], target: [0,0,0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "textured", transform: { position: [-0.9,0,0] }, model: { asset: imported } },
    { id: "gray", transform: { position: [2.4,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: gray } },
    { id: "sun", transform: { position: [0,0,8] }, light: { kind: "directional", intensity: 4, target: [0,0,0] } },
  ] }),
});
