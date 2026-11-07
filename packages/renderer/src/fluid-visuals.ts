import * as THREE from "three/webgpu";
import type { FluidVisualState } from "../../sdk/src/index.ts";

type View = { mesh: THREE.InstancedMesh; geometry: THREE.SphereGeometry; signature: string };
export function createFluidVisualOwner() {
  const root = new THREE.Group(); root.name = "pelican-fluid-visuals";
  const views = new Map<string, View>(); let disposed = false;
  const remove = (view: View) => { view.mesh.removeFromParent(); view.mesh.dispose(); view.geometry.dispose(); };
  const clear = () => { const changed = views.size > 0; for (const view of views.values()) remove(view); views.clear(); return changed; };
  const sync = (states: readonly FluidVisualState[], materials: ReadonlyMap<string, THREE.Material>) => {
    if (disposed) throw new Error("TC_FLUID_VISUAL_DISPOSED: Create a new presentation owner.");
    const next = new Map<string, View>(); let changed = false;
    for (const state of states) {
      const material = materials.get(state.material);
      if (!material) throw new Error("TC_FLUID_VISUAL_MATERIAL: Material is not declared.");
      const signature = JSON.stringify([state.material, state.particles.length, state.particles[0]?.radius, state.castShadow, state.receiveShadow]);
      let view = views.get(state.id);
      if (!view || view.signature !== signature || view.mesh.material !== material) {
        if (view) remove(view);
        const geometry = new THREE.SphereGeometry(state.particles[0]?.radius ?? 0.025, 8, 6);
        const mesh = new THREE.InstancedMesh(geometry, material, state.particles.length);
        mesh.name = "fluid:" + state.id; mesh.castShadow = state.castShadow; mesh.receiveShadow = state.receiveShadow; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(mesh);
        view = { mesh, geometry, signature }; changed = true;
      }
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
      for (let index = 0; index < state.particles.length; index++) { position.fromArray(state.particles[index].position); matrix.makeTranslation(position.x, position.y, position.z); view.mesh.setMatrixAt(index, matrix); }
      view.mesh.count = state.particles.length; view.mesh.instanceMatrix.needsUpdate = true; view.mesh.computeBoundingSphere(); next.set(state.id, view); changed = true;
    }
    for (const [id, view] of views) if (!next.has(id)) { remove(view); changed = true; }
    views.clear(); for (const [id, view] of next) views.set(id, view); return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; clear(); root.removeFromParent(); disposed = true; } };
}
