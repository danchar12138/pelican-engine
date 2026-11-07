import * as THREE from "three/webgpu";
import type { TilemapChunkState, TilemapVisualState } from "../../sdk/src/index.ts";

type Chunk = { revision: number; mesh: THREE.Mesh | null; geometry: THREE.BufferGeometry | null };
type View = { group: THREE.Group; signature: string; token: number; material: THREE.Material; chunks: Map<string, Chunk>; matrix: number[]; visible: boolean };
type Prepared = { view: View; created: boolean; matrix: THREE.Matrix4; visible: boolean; chunks: Map<string, Chunk> };
const CHUNK = 32;

/** Owns per-chunk plane geometry; scene materials and entity objects are borrowed. */
export function createTilemapVisualOwner() {
  const root = new THREE.Group(); root.name = "pelican-tilemap-visuals";
  const views = new Map<string, View>(); let disposed = false;
  const removeChunk = (chunk: Chunk) => {
    const failures: unknown[] = [];
    try { chunk.mesh?.removeFromParent(); } catch (error) { failures.push(error); }
    try { chunk.geometry?.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "TC_TILEMAP_VISUAL_DISPOSE: Chunk cleanup failed; inspect the causes.");
  };
  const removeView = (view: View) => {
    const failures: unknown[] = [];
    try { view.group.removeFromParent(); } catch (error) { failures.push(error); }
    for (const chunk of view.chunks.values()) try { removeChunk(chunk); } catch (error) { failures.push(error); }
    view.chunks.clear();
    if (failures.length) throw new AggregateError(failures, "TC_TILEMAP_VISUAL_DISPOSE: Map cleanup failed; inspect the causes.");
  };
  const clear = () => {
    const old = [...views.values()], failures: unknown[] = []; views.clear();
    for (const view of old) try { removeView(view); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "TC_TILEMAP_VISUAL_DISPOSE: Some maps could not be released; inspect the causes.");
    return old.length > 0;
  };
  const signature = (s: TilemapVisualState) => JSON.stringify([s.material, s.width, s.height, s.tileSize, s.offset, s.columns, s.rows, s.castShadow, s.receiveShadow]);
  const create = (state: TilemapVisualState, material: THREE.Material): View => {
    const group = new THREE.Group(); group.name = `tilemap:${state.id}`; group.matrixAutoUpdate = false;
    return { group, signature: signature(state), token: state.token, material, chunks: new Map(), matrix: [], visible: true };
  };
  const build = (state: TilemapVisualState, data: TilemapChunkState, material: THREE.Material): Chunk => {
    if (data.width < 1 || data.height < 1 || data.width > CHUNK || data.height > CHUNK || data.cells.length !== data.width * data.height)
      throw new Error(`TC_TILEMAP_VISUAL_INPUT: Invalid chunk data for '${state.id}'.`);
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let y = 0; y < data.height; y++) for (let x = 0; x < data.width; x++) {
      const frame = data.cells[y * data.width + x];
      if (frame === null) continue;
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= state.columns * state.rows)
        throw new Error(`TC_TILEMAP_VISUAL_INPUT: Invalid atlas frame in '${state.id}'.`);
      const left = state.offset[0] + (data.x * CHUNK + x) * state.tileSize[0], right = left + state.tileSize[0];
      const top = state.offset[1] - (data.y * CHUNK + y) * state.tileSize[1], bottom = top - state.tileSize[1];
      const col = frame % state.columns, row = Math.floor(frame / state.columns);
      const u0 = col / state.columns, u1 = (col + 1) / state.columns, v1 = 1 - row / state.rows, v0 = 1 - (row + 1) / state.rows;
      const base = positions.length / 3;
      positions.push(left, top, 0, left, bottom, 0, right, top, 0, right, bottom, 0);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
      uvs.push(u0, v1, u0, v0, u1, v1, u1, v0);
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    if (!indices.length) return { revision: data.revision, mesh: null, geometry: null };
    const geometry = new THREE.BufferGeometry();
    try {
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute("uv1", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `tilemap:${state.id}:${data.x}:${data.y}`;
      mesh.castShadow = state.castShadow; mesh.receiveShadow = state.receiveShadow;
      return { revision: data.revision, mesh, geometry };
    } catch (error) { geometry.dispose(); throw error; }
  };
  const sync = (
    states: readonly TilemapVisualState[], materials: ReadonlyMap<string, THREE.Material>, objects: ReadonlyMap<string, THREE.Object3D>,
    readChunk: (id: string, x: number, y: number) => TilemapChunkState,
  ): boolean => {
    if (disposed) throw new Error("TC_TILEMAP_VISUAL_DISPOSED: Create a new tilemap presentation owner.");
    const staged = new Map<string, Prepared>(), created: Chunk[] = [];
    try {
      for (const state of states) {
        if (staged.has(state.id)) throw new Error(`TC_TILEMAP_VISUAL_ID: Duplicate map '${state.id}'.`);
        const material = materials.get(state.material), object = objects.get(state.entity);
        if (!material) throw new Error(`TC_TILEMAP_VISUAL_MATERIAL: Material '${state.material}' is not declared.`);
        if (!object) throw new Error(`TC_TILEMAP_VISUAL_ENTITY: Entity '${state.entity}' is not available for '${state.id}'.`);
        object.updateWorldMatrix(true, false);
        const matrix = object.matrixWorld.clone();
        if (matrix.elements.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))
          throw new Error(`TC_TILEMAP_VISUAL_TRANSFORM: Map '${state.id}' needs a finite float32-representable world transform.`);
        let visible = true;
        for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) { visible = false; break; }
        const old = views.get(state.id), same = old && old.token === state.token && old.signature === signature(state) && old.material === material;
        const view = same ? old : create(state, material), chunks = new Map<string, Chunk>();
        for (const info of state.chunks) {
          const key = `${info.x},${info.y}`;
          if (chunks.has(key)) throw new Error(`TC_TILEMAP_VISUAL_INPUT: Duplicate chunk '${key}' in '${state.id}'.`);
          const cached = same ? view.chunks.get(key) : undefined;
          if (cached && cached.revision === info.revision) chunks.set(key, cached);
          else {
            const data = readChunk(state.id, info.x, info.y);
            if (data.x !== info.x || data.y !== info.y || data.revision !== info.revision)
              throw new Error(`TC_TILEMAP_VISUAL_STALE: Chunk '${key}' changed during presentation; retry on the next frame.`);
            const next = build(state, data, material); created.push(next); chunks.set(key, next);
          }
        }
        staged.set(state.id, { view, created: !same, matrix, visible, chunks });
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const chunk of created) try { removeChunk(chunk); } catch (cleanup) { failures.push(cleanup); }
      if (failures.length) throw new AggregateError([error, ...failures], "TC_TILEMAP_VISUAL_CREATE: Map preparation and cleanup failed; inspect the causes.");
      throw error;
    }
    let changed = false; const failures: unknown[] = [];
    for (const [id, old] of views) {
      const next = staged.get(id);
      if (!next || next.view !== old) {
        try { removeView(old); } catch (error) { failures.push(error); }
        changed = true;
      } else for (const [key, chunk] of old.chunks) if (next.chunks.get(key) !== chunk) {
        try { removeChunk(chunk); } catch (error) { failures.push(error); }
        changed = true;
      }
    }
    views.clear();
    for (const [id, next] of staged) {
      if (next.created) { root.add(next.view.group); changed = true; }
      for (const [key, chunk] of next.chunks) if (next.view.chunks.get(key) !== chunk && chunk.mesh) {
        next.view.group.add(chunk.mesh); changed = true;
      }
      next.view.chunks = next.chunks;
      if (next.view.matrix.length !== next.matrix.elements.length || next.matrix.elements.some((v, i) => v !== next.view.matrix[i])) {
        next.view.group.matrix.copy(next.matrix); next.view.group.matrixWorldNeedsUpdate = true;
        next.view.matrix = [...next.matrix.elements]; changed = true;
      }
      if (next.view.visible !== next.visible) { next.view.group.visible = next.visible; next.view.visible = next.visible; changed = true; }
      views.set(id, next.view);
    }
    if (failures.length) throw new AggregateError(failures, "TC_TILEMAP_VISUAL_DISPOSE: Some replaced tile chunks could not be released; inspect the causes.");
    return changed;
  };
  return { root, sync, clear, dispose() { if (disposed) return; disposed = true; try { clear(); } finally { root.removeFromParent(); } } };
}
