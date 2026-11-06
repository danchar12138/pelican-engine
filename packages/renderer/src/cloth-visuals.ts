import * as THREE from "three/webgpu";
import type { ClothVisualState } from "../../sdk/src/index.ts";

type View = { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; signature: string; positions: number[] };
type Prepared = { view: View; created: boolean; positions: number[]; vertices?: Float32Array; normals?: Float32Array };

/** Owns dynamic cloth geometry and buffers; scene materials remain borrowed. */
export function createClothVisualOwner() {
  const root = new THREE.Group(); root.name = "pelican-cloth-visuals";
  const views = new Map<string, View>(); let disposed = false;
  const remove = (view: View) => { view.mesh.removeFromParent(); view.mesh.dispose(); view.geometry.dispose(); };
  const clear = () => { const changed = views.size > 0; for (const view of views.values()) remove(view); views.clear(); return changed; };
  const signature = (state: ClothVisualState) => JSON.stringify([state.material, state.castShadow, state.receiveShadow, state.positions.length, state.triangles, state.uvs]);
  const create = (state: ClothVisualState, material: THREE.Material): View => {
    const geometry = new THREE.BufferGeometry(); let mesh: THREE.Mesh | undefined;
    try {
      const count = state.triangles.length * 3;
      const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3), normal = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      position.setUsage(THREE.DynamicDrawUsage); normal.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", position); geometry.setAttribute("normal", normal);
      const values = new Float32Array(count * 2); let offset = 0;
      for (const triangle of state.triangles) for (const index of triangle) { const uv = state.uvs[index]; values[offset++] = uv[0]; values[offset++] = uv[1]; }
      const uv = new THREE.BufferAttribute(values, 2); geometry.setAttribute("uv", uv); geometry.setAttribute("uv1", uv.clone());
      mesh = new THREE.Mesh(geometry, material); mesh.name = `cloth:${state.id}`;
      mesh.castShadow = state.castShadow; mesh.receiveShadow = state.receiveShadow;
      return { mesh, geometry, signature: signature(state), positions: [] };
    } catch (error) { mesh?.dispose(); geometry.dispose(); throw error; }
  };
  const geometryData = (state: ClothVisualState) => {
    const vertices = new Float32Array(state.triangles.length * 9), normals = new Float32Array(vertices.length);
    const accumulated = Array.from({ length: state.positions.length }, () => [0, 0, 0]);
    const faces: [number, number, number][] = [];
    let offset = 0;
    for (let face = 0; face < state.triangles.length; face++) {
      const triangle = state.triangles[face];
      const points = triangle.map(index => state.positions[index].map(Math.fround));
      const u = points[1].map((value, axis) => value - points[0][axis]), v = points[2].map((value, axis) => value - points[0][axis]);
      const n: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...n);
      if (!Number.isFinite(length) || length === 0)
        throw new Error(`TC_CLOTH_VISUAL_DEGENERATE: Triangle ${face} of '${state.id}' collapsed or is not representable; adjust cloth geometry or simulation.`);
      faces.push([n[0] / length, n[1] / length, n[2] / length]);
      for (let vertex = 0; vertex < 3; vertex++) {
        const index = triangle[vertex];
        for (let axis = 0; axis < 3; axis++) { vertices[offset++] = points[vertex][axis]; accumulated[index][axis] += n[axis]; }
      }
    }
    offset = 0;
    for (let face = 0; face < state.triangles.length; face++) for (const index of state.triangles[face]) {
      const n = accumulated[index], length = Math.hypot(...n), source = length > 1e-20 ? [n[0] / length, n[1] / length, n[2] / length] : faces[face];
      for (const value of source) { if (!Number.isFinite(value)) throw new Error(`TC_CLOTH_VISUAL_NUMERIC: Invalid normal in '${state.id}'.`); normals[offset++] = value; }
    }
    return { vertices, normals };
  };
  const sync = (states: readonly ClothVisualState[], materials: ReadonlyMap<string, THREE.Material>): boolean => {
    if (disposed) throw new Error("TC_CLOTH_VISUAL_DISPOSED: Create a new presentation owner.");
    const staged = new Map<string, Prepared>(), created: View[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_CLOTH_VISUAL_ID: Duplicate cloth '${state.id}'.`);
        const material = materials.get(state.material);
        if (!material) throw new Error(`TC_CLOTH_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!Array.isArray(state.positions) || state.positions.length < 3 || state.positions.length > 4096 ||
            state.positions.some(point => !Array.isArray(point) || point.length !== 3 || !point.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) ||
            !Array.isArray(state.triangles) || state.triangles.length < 1 || state.triangles.length > 8192 ||
            state.triangles.some(triangle => !Array.isArray(triangle) || triangle.length !== 3 || triangle.some(index => !Number.isSafeInteger(index) || index < 0 || index >= state.positions.length)) ||
            !Array.isArray(state.uvs) || state.uvs.length !== state.positions.length || state.uvs.some(uv => !Array.isArray(uv) || uv.length !== 2 || !uv.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))))
          throw new Error(`TC_CLOTH_VISUAL_INPUT: Cloth '${state.id}' has invalid positions, topology or UVs.`);
        const old = views.get(state.id), same = old && old.signature === signature(state) && old.mesh.material === material;
        const view = same ? old : create(state, material);
        if (!same) created.push(view);
        const positions = state.positions.flatMap(point => [...point]);
        const changed = !same || positions.length !== view.positions.length || positions.some((value, index) => value !== view.positions[index]);
        const update = changed ? geometryData(state) : undefined;
        staged.set(state.id, { view, created: !same, positions, ...update });
      }
    } catch (error) { for (const view of created) remove(view); throw error; }
    let changed = false;
    for (const [id, view] of views) if (!staged.has(id) || staged.get(id)!.view !== view) { remove(view); changed = true; }
    views.clear();
    for (const [id, item] of staged) {
      if (item.created) { root.add(item.view.mesh); changed = true; }
      if (item.vertices && item.normals) {
        const position = item.view.geometry.getAttribute("position") as THREE.BufferAttribute, normal = item.view.geometry.getAttribute("normal") as THREE.BufferAttribute;
        position.array.set(item.vertices); normal.array.set(item.normals); position.needsUpdate = true; normal.needsUpdate = true;
        item.view.geometry.computeBoundingBox(); item.view.geometry.computeBoundingSphere(); item.view.positions = item.positions; changed = true;
      }
      views.set(id, item.view);
    }
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; clear(); root.removeFromParent(); disposed = true; } };
}
