import * as THREE from "three/webgpu";
import type { SceneIR } from "../../compiler/src/types.ts";

/** Internal renderer setup; input textures are borrowed from the gameplay generation.
 * Slot views own GPU textures, share decoded pixels, and release with the material.
 */
export function setupPBRMaterial(
  material: THREE.MeshStandardNodeMaterial,
  definition: SceneIR["materials"][number],
  textures: ReadonlyMap<string, THREE.Texture>,
): void {
  const owned: THREE.Texture[] = [];
  const release = () => {
    material.removeEventListener("dispose", release);
    for (const texture of owned) texture.dispose();
    owned.length = 0;
  };
  try {
    for (const slot of [
      "texture",
      "normalMap",
      "roughnessMap",
      "metalnessMap",
      "aoMap",
      "emissiveMap",
    ] as const) {
      const id = definition[slot];
      if (id === undefined) continue;
      const source = textures.get(id);
      if (!source)
        throw new Error(
          `TC_MATERIAL_TEXTURE: ${definition.id}.${slot}: Missing texture asset ${id}. Repair: Declare and load this defineAsset texture ID.`,
        );
      const view = source.clone();
      owned.push(view);
      view.name = `${definition.id}.${slot}:${id}`;
      view.colorSpace =
        slot === "texture" || slot === "emissiveMap"
          ? source.colorSpace
          : THREE.NoColorSpace;
      view.needsUpdate = true;
      material[slot === "texture" ? "map" : slot] = view;
    }
    if (definition.normalScale !== undefined) {
      if (
        !Array.isArray(definition.normalScale) ||
        definition.normalScale.length !== 2 ||
        [definition.normalScale[0], definition.normalScale[1]].some(
          (v) =>
            typeof v !== "number" ||
            !Number.isFinite(v) ||
            !Number.isFinite(Math.fround(v)) ||
            (v !== 0 && Math.fround(v) === 0),
        )
      )
        throw new Error(
          `TC_MATERIAL_NORMAL_SCALE: ${definition.id}.normalScale: Expected two finite float32 numbers. Repair: Supply [x, y] normal multipliers.`,
        );
      material.normalScale.fromArray(definition.normalScale);
    }
    material.addEventListener("dispose", release);
  } catch (error) {
    release();
    throw error;
  }
}
