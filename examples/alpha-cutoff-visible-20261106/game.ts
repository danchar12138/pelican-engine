import { defineGame, defineMaterial, defineScene } from "pelican-engine";
// The first foreground checks the exact alpha cutoff boundary.
const back = defineMaterial({ id: "back", color: "#000000", emissive: "#00ff00", emissiveIntensity: 1 });
const below = defineMaterial({ id: "below", color: "#000000", emissive: "#ff0000", emissiveIntensity: 1, opacity: 0.5, alphaTest: 0.5 });
const above = defineMaterial({ id: "above", color: "#000000", emissive: "#ff0000", emissiveIntensity: 1, opacity: 0.4, alphaTest: 0.3 });
const noCutoff = defineMaterial({ id: "no-cutoff", color: "#000000", emissive: "#ff0000", emissiveIntensity: 1, opacity: 0.4, alphaTest: 0 });
export default defineGame({ id: "alpha-cutoff-visible-20261106", render: { samplesPerFrame: 1, maxBounces: 2, denoise: false, directLighting: false, indirectLighting: false }, scene: defineScene({ id: "scene", camera: { position: [0,0,8], target: [0,0,0], fov: 45 }, environment: { background: "#000000", ambientIntensity: 0 }, entities: [
  { id: "back0", transform: { position: [-2.4,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: back } },
  { id: "back1", transform: { position: [-0.8,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: back } },
  { id: "back2", transform: { position: [0.8,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: back } },
  { id: "back3", transform: { position: [2.4,0,0] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: back } },
  { id: "front0", transform: { position: [-2.4,0,0.2] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: below } },
  { id: "front1", transform: { position: [-0.8,0,0.2] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: above } },
  { id: "front2", transform: { position: [0.8,0,0.2] }, mesh: { geometry: { kind: "plane", size: [1,1.8] }, material: noCutoff } },
] }) });
