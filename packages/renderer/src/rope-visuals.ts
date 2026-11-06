import * as THREE from "three/webgpu";
import type { RopeVisualState } from "../../sdk/src/index.ts";

type MaterialMap = ReadonlyMap<string, THREE.Material>;
type View = {
  mesh: THREE.InstancedMesh;
  geometry: THREE.CylinderGeometry;
  signature: string;
  positions: number[];
};
type Prepared = { view: View; created: boolean; positions: number[]; matrices?: Float32Array; count?: number };

/** Presentation owns its instance buffers and geometries; scene materials remain borrowed. */
export function createRopeVisualOwner() {
  const root = new THREE.Group();
  root.name = "pelican-rope-visuals";
  const views = new Map<string, View>();
  let disposed = false;
  const remove = (view: View) => { view.mesh.removeFromParent(); view.mesh.dispose(); view.geometry.dispose(); };
  const clear = () => { const changed = views.size > 0; for (const view of views.values()) remove(view); views.clear(); return changed; };
  const signature = (state: RopeVisualState) => JSON.stringify([state.material, state.radius, state.radialSegments, state.castShadow, state.receiveShadow, state.positions.length]);
  const create = (state: RopeVisualState, material: THREE.Material): View => {
    let geometry: THREE.CylinderGeometry | undefined;
    let mesh: THREE.InstancedMesh | undefined;
    try {
      geometry = new THREE.CylinderGeometry(state.radius, state.radius, 1, state.radialSegments, 1, false);
      const uv = geometry.getAttribute("uv");
      if (uv) geometry.setAttribute("uv1", uv.clone());
      mesh = new THREE.InstancedMesh(geometry, material, state.positions.length - 1);
      mesh.name = `rope:${state.id}`;
      mesh.castShadow = state.castShadow;
      mesh.receiveShadow = state.receiveShadow;
      mesh.count = 0;
      mesh.visible = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return { mesh, geometry, signature: signature(state), positions: [] };
    } catch (error) {
      mesh?.dispose(); geometry?.dispose();
      throw error;
    }
  };
  const matrices = (state: RopeVisualState) => {
    const data = new Float32Array((state.positions.length - 1) * 16);
    const axis = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
    const position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
    const matrix = new THREE.Matrix4();
    let count = 0;
    for (let index = 0; index < state.positions.length - 1; index++) {
      const a = state.positions[index], b = state.positions[index + 1];
      direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const length = direction.length();
      // A collapsed segment has no surface; never submit a singular instance transform.
      if (length === 0) continue;
      if (!Number.isFinite(length) || Math.fround(length) === 0)
        throw new Error(`TC_ROPE_VISUAL_NUMERIC: Segment ${index} of '${state.id}' has an unrepresentable length.`);
      position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      rotation.setFromUnitVectors(axis, direction.multiplyScalar(1 / length));
      scale.set(1, length, 1);
      matrix.compose(position, rotation, scale);
      for (const value of matrix.elements)
        if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
          throw new Error(`TC_ROPE_VISUAL_NUMERIC: Segment ${index} of '${state.id}' has a non-finite transform.`);
      data.set(matrix.elements, count++ * 16);
    }
    return { data, count };
  };
  const sync = (states: readonly RopeVisualState[], materials: MaterialMap): boolean => {
    if (disposed) throw new Error("TC_ROPE_VISUAL_DISPOSED: Create a new presentation owner.");
    const staged = new Map<string, Prepared>();
    const created: View[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_ROPE_VISUAL_ID: Duplicate rope '${state.id}'.`);
        const material = materials.get(state.material);
        if (!material) throw new Error(`TC_ROPE_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!Array.isArray(state.positions) || state.positions.length < 2 || state.positions.length > 4096 ||
            state.positions.some(point => !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)))
          throw new Error(`TC_ROPE_VISUAL_POSITION: Rope '${state.id}' requires finite particle positions.`);
        if (!Number.isFinite(state.radius) || state.radius <= 0 || Math.fround(state.radius) === 0 ||
            !Number.isInteger(state.radialSegments) || state.radialSegments < 3 || state.radialSegments > 32)
          throw new Error(`TC_ROPE_VISUAL_SHAPE: Rope '${state.id}' has an invalid radius or radial segment count.`);
        const old = views.get(state.id), same = old && old.signature === signature(state) && old.mesh.material === material;
        const view = same ? old : create(state, material);
        if (!same) created.push(view);
        const positions = state.positions.flatMap(point => [...point]);
        const changed = !same || positions.length !== view.positions.length || positions.some((value, index) => value !== view.positions[index]);
        const update = changed ? matrices(state) : undefined;
        staged.set(state.id, { view, created: !same, positions, ...(update ? { matrices: update.data, count: update.count } : {}) });
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
      if (item.matrices) {
        item.view.mesh.instanceMatrix.array.set(item.matrices);
        item.view.mesh.count = item.count!;
        item.view.mesh.visible = item.count! > 0;
        item.view.mesh.instanceMatrix.needsUpdate = true;
        if (item.count! > 0) item.view.mesh.computeBoundingSphere();
        item.view.positions = item.positions;
        changed = true;
      }
      views.set(id, item.view);
    }
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; clear(); root.removeFromParent(); disposed = true; } };
}
