import * as THREE from "three/webgpu";
import type { SpriteState } from "../../sdk/src/index.ts";

type View = { mesh: THREE.Mesh; geometry: THREE.PlaneGeometry; signature: string; baseUV: Float32Array; frame: number; matrix: number[]; visible: boolean };
type Prepared = { view: View; created: boolean; state: SpriteState; matrix: THREE.Matrix4; visible: boolean };

/** Owns sprite planes and UVs while borrowing declared scene materials. */
export function createSpriteVisualOwner() {
  const root = new THREE.Group(); root.name = "pelican-sprite-visuals";
  const views = new Map<string, View>(); let disposed = false;
  const remove = (view: View) => {
    const errors: unknown[] = [];
    try { view.mesh.removeFromParent(); } catch (error) { errors.push(error); }
    try { view.geometry.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "TC_SPRITE_VISUAL_DISPOSE: Sprite geometry cleanup failed; inspect the causes and restart the scene.");
  };
  const clear = () => {
    const old = [...views.values()], errors: unknown[] = []; views.clear();
    for (const view of old) try { remove(view); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "TC_SPRITE_VISUAL_DISPOSE: Some sprite geometry could not be released; inspect the causes.");
    return old.length > 0;
  };
  const signature = (state: SpriteState) => JSON.stringify([state.material, state.size, state.columns, state.rows, state.castShadow, state.receiveShadow]);
  const create = (state: SpriteState, material: THREE.Material): View => {
    const geometry = new THREE.PlaneGeometry(state.size[0], state.size[1]);
    try {
      const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
      geometry.setAttribute("uv1", uv.clone());
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `sprite:${state.id}`; mesh.matrixAutoUpdate = false;
      mesh.castShadow = state.castShadow; mesh.receiveShadow = state.receiveShadow;
      return { mesh, geometry, signature: signature(state), baseUV: Float32Array.from(uv.array), frame: -1, matrix: [], visible: true };
    } catch (error) { geometry.dispose(); throw error; }
  };
  const updateUV = (view: View, state: SpriteState) => {
    const column = state.frame % state.columns, row = Math.floor(state.frame / state.columns);
    const u0 = column / state.columns, v0 = 1 - (row + 1) / state.rows;
    for (const name of ["uv", "uv1"]) {
      const uv = view.geometry.getAttribute(name) as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, u0 + view.baseUV[i * 2] / state.columns, v0 + view.baseUV[i * 2 + 1] / state.rows);
      uv.needsUpdate = true;
    }
    view.frame = state.frame;
  };
  const sync = (states: readonly SpriteState[], materials: ReadonlyMap<string, THREE.Material>, objects: ReadonlyMap<string, THREE.Object3D>): boolean => {
    if (disposed) throw new Error("TC_SPRITE_VISUAL_DISPOSED: Create a new sprite presentation owner.");
    const staged = new Map<string, Prepared>(), created: View[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_SPRITE_VISUAL_ID: Duplicate sprite '${state.id}'.`);
        const material = materials.get(state.material), object = objects.get(state.entity);
        if (!material) throw new Error(`TC_SPRITE_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!object) throw new Error(`TC_SPRITE_VISUAL_ENTITY: Entity '${state.entity}' is not available for sprite '${state.id}'.`);
        object.updateWorldMatrix(true, false);
        const matrix = object.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(state.offset[0], state.offset[1], 0));
        if (matrix.elements.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))
          throw new Error(`TC_SPRITE_VISUAL_TRANSFORM: Sprite '${state.id}' needs a finite float32-representable world transform.`);
        let visible = true;
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) { visible = false; break; }
        const old = views.get(state.id), same = old && old.signature === signature(state) && old.mesh.material === material;
        const view = same ? old : create(state, material);
        if (!same) created.push(view);
        staged.set(state.id, { view, created: !same, state, matrix, visible });
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const view of created) try { remove(view); } catch (cleanup) { failures.push(cleanup); }
      if (failures.length) throw new AggregateError([error, ...failures], "TC_SPRITE_VISUAL_CREATE: Sprite preparation and cleanup failed; inspect the causes.");
      throw error;
    }
    let changed = false;
    const cleanupFailures: unknown[] = [];
    for (const [id, view] of views) if (!staged.has(id) || staged.get(id)!.view !== view) {
      try { remove(view); } catch (error) { cleanupFailures.push(error); }
      changed = true;
    }
    views.clear();
    for (const [id, item] of staged) {
      if (item.created) { root.add(item.view.mesh); changed = true; }
      if (item.view.frame !== item.state.frame) { updateUV(item.view, item.state); changed = true; }
      if (item.view.matrix.length !== item.matrix.elements.length || item.matrix.elements.some((v, i) => v !== item.view.matrix[i])) {
        item.view.mesh.matrix.copy(item.matrix); item.view.mesh.matrixWorldNeedsUpdate = true;
        item.view.matrix = [...item.matrix.elements]; changed = true;
      }
      if (item.view.visible !== item.visible) { item.view.mesh.visible = item.visible; item.view.visible = item.visible; changed = true; }
      views.set(id, item.view);
    }
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "TC_SPRITE_VISUAL_DISPOSE: Some replaced sprites could not be released; inspect the causes.");
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; disposed = true; try { clear(); } finally { root.removeFromParent(); } } };
}
