import { defineGame, defineScene, defineMaterial } from "pelican-engine";
import { TorusKnotGeometry } from "three";

// A normal npm generator. No Three renderer, scene or GPU object is borrowed.
const source = new TorusKnotGeometry(1, 0.3, 128, 24);
const geometry = {
  kind: "buffer" as const,
  positions: Array.from(source.getAttribute("position").array),
  normals: Array.from(source.getAttribute("normal").array),
  uv: Array.from(source.getAttribute("uv").array),
  indices: Array.from(source.index!.array),
};
source.dispose();
const material = defineMaterial({
  id: "metal",
  color: "#5eaba0",
  metalness: 0.7,
  roughness: 0.24,
});
export default defineGame({
  id: "npm-geometry",
  services: { physics3d: "disabled" },
  scene: defineScene({
    id: "main",
    camera: { position: [4, 3, 6], target: [0, 0, 0] },
    entities: [
      { id: "generated", mesh: { geometry, material } },
      {
        id: "sun",
        transform: { position: [3, 6, 4] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
});
