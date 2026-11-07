import * as THREE from "three/webgpu";
import type { SoftBodyVisualState } from "../../sdk/src/index.ts";

type View = { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; signature: string; positions: number[] };

/** Owns dynamic tetrahedral soft-body surface geometry; scene materials remain borrowed. */
export function createSoftBodyVisualOwner() {
  const root = new THREE.Group();
  root.name = "pelican-soft-body-visuals";
  const views = new Map<string, View>();
  let disposed = false;
  const remove = (view: View) => {
    view.mesh.removeFromParent();
    view.mesh.dispose();
    view.geometry.dispose();
  };
  const clear = () => {
    const changed = views.size > 0;
    for (const view of views.values()) remove(view);
    views.clear();
    return changed;
  };
  const signature = (state: SoftBodyVisualState) => JSON.stringify([
    state.material,
    state.castShadow,
    state.receiveShadow,
    state.positions.length,
    state.triangles,
    state.uvs,
  ]);
  const create = (state: SoftBodyVisualState, material: THREE.Material): View => {
    const geometry = new THREE.BufferGeometry();
    const count = state.triangles.length * 3;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const uvValues = new Float32Array(count * 2);
    let uvOffset = 0;
    for (const triangle of state.triangles) for (const index of triangle) {
      const uv = state.uvs[index];
      uvValues[uvOffset++] = uv[0];
      uvValues[uvOffset++] = uv[1];
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvValues, 2));
    geometry.setAttribute("uv1", new THREE.BufferAttribute(uvValues.slice(), 2));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `softbody:${state.id}`;
    mesh.castShadow = state.castShadow;
    mesh.receiveShadow = state.receiveShadow;
    return { mesh, geometry, signature: signature(state), positions: [] };
  };
  const vertices = (state: SoftBodyVisualState) => {
    const data = new Float32Array(state.triangles.length * 9);
    let offset = 0;
    for (const triangle of state.triangles) for (const index of triangle) {
      const point = state.positions[index];
      for (const value of point) data[offset++] = Math.fround(value);
    }
    return data;
  };
  const sync = (states: readonly SoftBodyVisualState[], materials: ReadonlyMap<string, THREE.Material>) => {
    if (disposed) throw new Error("TC_SOFTBODY_VISUAL_DISPOSED: Create a new presentation owner.");
    const staged = new Map<string, { view: View; created: boolean; positions: number[]; vertices: Float32Array }>();
    const created: View[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_SOFTBODY_VISUAL_ID: Duplicate soft body '${state.id}'.`);
        const material = materials.get(state.material);
        if (!material) throw new Error(`TC_SOFTBODY_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!Array.isArray(state.positions) || state.positions.length < 4 ||
            state.positions.some(point => !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) ||
            !Array.isArray(state.triangles) || state.triangles.length < 4 ||
            state.triangles.some(triangle => !Array.isArray(triangle) || triangle.length !== 3 || triangle.some(index => !Number.isSafeInteger(index) || index < 0 || index >= state.positions.length)))
          throw new Error(`TC_SOFTBODY_VISUAL_INPUT: Soft body '${state.id}' has invalid surface data.`);
        const old = views.get(state.id);
        const same = !!old && old.signature === signature(state) && old.mesh.material === material;
        const view = same ? old! : create(state, material);
        if (!same) created.push(view);
        const flat = state.positions.flatMap(point => [...point]);
        const changed = !same || flat.length !== view.positions.length || flat.some((value, index) => value !== view.positions[index]);
        staged.set(state.id, { view, created: !same, positions: flat, vertices: changed ? vertices(state) : new Float32Array() });
      }
    } catch (error) {
      for (const view of created) remove(view);
      throw error;
    }
    let changed = false;
    for (const [id, view] of views) if (!staged.has(id) || staged.get(id)!.view !== view) { remove(view); changed = true; }
    views.clear();
    for (const [id, item] of staged) {
      if (item.created) { root.add(item.view.mesh); changed = true; }
      if (item.vertices.length) {
        const position = item.view.geometry.getAttribute("position") as THREE.BufferAttribute;
        position.array.set(item.vertices);
        position.needsUpdate = true;
        item.view.geometry.computeVertexNormals();
        item.view.geometry.computeBoundingBox();
        item.view.geometry.computeBoundingSphere();
        item.view.positions = item.positions;
        changed = true;
      }
      views.set(id, item.view);
    }
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; clear(); root.removeFromParent(); disposed = true; } };
}
