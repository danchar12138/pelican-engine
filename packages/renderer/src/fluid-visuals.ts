import * as THREE from "three/webgpu";
import type { FluidVisualState } from "../../sdk/src/index.ts";

type View = { mesh: THREE.InstancedMesh; geometry: THREE.SphereGeometry; signature: string; values: number[] };
type Prepared = { view: View; created: boolean; values: number[]; matrices?: Float32Array };

/** Owns particle geometry and instance buffers; materials are borrowed from the scene. */
export function createFluidVisualOwner() {
  const root = new THREE.Group(); root.name = "pelican-fluid-visuals";
  const views = new Map<string, View>(); let disposed = false;
  const remove = (view: View) => { view.mesh.removeFromParent(); view.mesh.dispose(); view.geometry.dispose(); };
  const clear = () => { const changed = views.size > 0; for (const view of views.values()) remove(view); views.clear(); return changed; };
  const signature = (state: FluidVisualState) => JSON.stringify([state.material, state.particles.length, state.castShadow, state.receiveShadow]);
  const create = (state: FluidVisualState, material: THREE.Material): View => {
    let geometry: THREE.SphereGeometry | undefined, mesh: THREE.InstancedMesh | undefined;
    try {
      geometry = new THREE.SphereGeometry(1, 8, 6);
      const uv = geometry.getAttribute("uv"); if (uv) geometry.setAttribute("uv1", uv.clone());
      mesh = new THREE.InstancedMesh(geometry, material, state.particles.length);
      mesh.name = `fluid:${state.id}`; mesh.castShadow = state.castShadow; mesh.receiveShadow = state.receiveShadow;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return { mesh, geometry, signature: signature(state), values: [] };
    } catch (error) { mesh?.dispose(); geometry?.dispose(); throw error; }
  };
  const sync = (states: readonly FluidVisualState[], materials: ReadonlyMap<string, THREE.Material>): boolean => {
    if (disposed) throw new Error("TC_FLUID_VISUAL_DISPOSED: Create a new presentation owner.");
    const staged = new Map<string, Prepared>(), created: View[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_FLUID_VISUAL_ID: Duplicate fluid '${state.id}'.`);
        const material = materials.get(state.material);
        if (!material) throw new Error(`TC_FLUID_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!Array.isArray(state.particles) || state.particles.length > 65536 || state.particles.some(p =>
          !p || !Array.isArray(p.position) || p.position.length !== 3 ||
          !p.position.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
          !Number.isFinite(p.radius) || p.radius <= 0 || !Number.isFinite(Math.fround(p.radius)) || Math.fround(p.radius) === 0))
          throw new Error(`TC_FLUID_VISUAL_INPUT: Fluid '${state.id}' requires finite, representable particle positions and radii.`);
        const old = views.get(state.id), same = old && old.signature === signature(state) && old.mesh.material === material;
        const view = same ? old : create(state, material);
        if (!same) created.push(view);
        const values = state.particles.flatMap(p => [...p.position, p.radius]);
        const changed = !same || values.length !== view.values.length || values.some((value, index) => value !== view.values[index]);
        let matrices: Float32Array | undefined;
        if (changed) {
          matrices = new Float32Array(state.particles.length * 16);
          const matrix = new THREE.Matrix4();
          for (let index = 0; index < state.particles.length; index++) {
            const { position, radius } = state.particles[index];
            matrix.makeScale(radius, radius, radius);
            matrix.setPosition(position[0], position[1], position[2]);
            matrices.set(matrix.elements, index * 16);
          }
        }
        staged.set(state.id, { view, created: !same, values, matrices });
      }
    } catch (error) { for (const view of created) remove(view); throw error; }
    let changed = false;
    for (const [id, view] of views) if (!staged.has(id) || staged.get(id)!.view !== view) { remove(view); changed = true; }
    views.clear();
    for (const [id, item] of staged) {
      if (item.created) { root.add(item.view.mesh); changed = true; }
      if (item.matrices) {
        item.view.mesh.instanceMatrix.array.set(item.matrices);
        item.view.mesh.count = item.values.length / 4;
        item.view.mesh.visible = item.view.mesh.count > 0;
        item.view.mesh.instanceMatrix.needsUpdate = true;
        if (item.view.mesh.count > 0) item.view.mesh.computeBoundingSphere();
        item.view.values = item.values; changed = true;
      }
      views.set(id, item.view);
    }
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; clear(); root.removeFromParent(); disposed = true; } };
}
