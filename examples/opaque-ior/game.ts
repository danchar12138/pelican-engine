import { defineGame, defineMaterial, defineScene } from "pelican-engine";

const low = defineMaterial({ id: "low", color: "#000000", roughness: 0.35, metalness: 0, ior: 1.1 });
const medium = defineMaterial({ id: "medium", color: "#000000", roughness: 0.35, metalness: 0, ior: 1.5 });
const high = defineMaterial({ id: "high", color: "#000000", roughness: 0.35, metalness: 0, ior: 2.0 });
export default defineGame({ id: "opaque-ior", render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: true, indirectLighting: false },
  scene: defineScene({ id: "scene", camera: { position: [0,0,8], target: [0,0,0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
    { id: "low", transform: { position: [-2,0,0] }, mesh: { geometry: { kind: "plane", size: [1.3,1.8] }, material: low } },
    { id: "medium", transform: { position: [0,0,0] }, mesh: { geometry: { kind: "plane", size: [1.3,1.8] }, material: medium } },
    { id: "high", transform: { position: [2,0,0] }, mesh: { geometry: { kind: "plane", size: [1.3,1.8] }, material: high } },
    { id: "sun", transform: { position: [0,0,8] }, light: { kind: "directional", intensity: 4, target: [0,0,0] } },
  ] }),
});
