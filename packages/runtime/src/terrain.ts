import type { NavigationGrid, NavigationService, TerrainDefinition, TerrainGeometry, TerrainService, TerrainState } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "./plugins.ts";
import { cloneSerializable } from "./random.ts";
import { terrainGeometry, terrainHeight, terrainMesh } from "./terrain-data.ts";

const fail = (code: string, detail: string): never => { throw new Error(`TC_TERRAIN_${code}: ${detail}`); };
const owner = (id: string) => `$terrain/${id}`;
function projection(state: TerrainDefinition): NavigationGrid | undefined {
  if (!state.navigation) return;
  const blocked: { x: number; y: number }[] = [], costs: { cell: { x: number; y: number }; cost: number }[] = [];
  const mesh = terrainMesh(state), maxSlope = state.navigation.maxSlope ?? Math.PI / 4, maxStep = state.navigation.maxStep ?? 0.5;
  for (let row = 0; row < state.rows - 1; row++) for (let column = 0; column < state.columns - 1; column++) {
    const index = row * state.columns + column, a = mesh.positions[index], b = mesh.positions[index + 1], c = mesh.positions[index + state.columns], d = mesh.positions[index + state.columns + 1];
    const dx = b[0] - a[0], dz = c[2] - a[2];
    const slope = Math.atan(Math.max(Math.hypot((b[1] - a[1]) / dx, (c[1] - a[1]) / dz), Math.hypot((d[1] - c[1]) / dx, (d[1] - b[1]) / dz)));
    const range = Math.max(a[1], b[1], c[1], d[1]) - Math.min(a[1], b[1], c[1], d[1]), cell = { x: column, y: row };
    if (slope > maxSlope || range > maxStep || 1 + Math.tan(slope) > 1e6) blocked.push(cell);
    else costs.push({ cell, cost: 1 + Math.tan(slope) });
  }
  return { id: state.navigation.grid, owner: owner(state.id), width: state.columns - 1, height: state.rows - 1, blocked, costs };
}
function updateGrid(service: NavigationService, grid: NavigationGrid): void {
  const blocked = new Set(grid.blocked?.map(cell => `${cell.x}:${cell.y}`)), costs = new Map(grid.costs?.map(item => [`${item.cell.x}:${item.cell.y}`, item.cost]));
  const cells = Array.from({ length: grid.width * grid.height }, (_, i) => ({ x: i % grid.width, y: Math.floor(i / grid.width) }));
  service.setBlockedBatch(grid.id, cells.map(cell => ({ cell, blocked: blocked.has(`${cell.x}:${cell.y}`) })));
  service.setCostsBatch(grid.id, cells.map(cell => ({ cell, cost: costs.get(`${cell.x}:${cell.y}`) ?? 1 })));
}

export const createTerrainPlugin: RuntimePluginFactory = context => {
  let entries = new Map<string, TerrainState>(), disposed = false;
  const materials = new Set(context.scene.materials.map(item => item.id));
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before editing terrain."); };
  const normalize = (value: TerrainDefinition, revision = 0): TerrainState => {
    const input = cloneSerializable(value), geometry = terrainGeometry(input);
    if (!materials.has(input.material) || (input.castShadow !== undefined && typeof input.castShadow !== "boolean") || (input.receiveShadow !== undefined && typeof input.receiveShadow !== "boolean")) return fail("MATERIAL", `Terrain '${geometry.id}' needs a declared material and boolean shadow options.`);
    const nav = input.navigation;
    if (nav !== undefined && (!nav || typeof nav !== "object" || Array.isArray(nav) || Object.keys(nav).some(key => !["grid", "maxSlope", "maxStep"].includes(key)) ||
        typeof nav.grid !== "string" || !nav.grid.trim() || nav.grid.length > 128 ||
        (nav.maxSlope !== undefined && (!Number.isFinite(nav.maxSlope) || nav.maxSlope < 0 || nav.maxSlope >= Math.PI / 2)) ||
        (nav.maxStep !== undefined && (!Number.isFinite(nav.maxStep) || nav.maxStep < 0 || nav.maxStep > 1e6)))) return fail("NAVIGATION", "Use a grid ID, slope in [0,pi/2) and nonnegative maxStep.");
    if (!Number.isSafeInteger(revision) || revision < 0) return fail("REVISION", "Terrain revision must be a nonnegative safe integer.");
    return { ...geometry, material: input.material, castShadow: input.castShadow ?? true, receiveShadow: input.receiveShadow ?? true, ...(nav ? { navigation: { ...nav } } : {}), revision };
  };
  const get = (id: string) => { alive(); return entries.get(id) ?? fail("MISSING", `Terrain '${id}' does not exist.`); };
  const bridge = () => context.getTerrainPhysicsBridge?.() ?? fail("PHYSICS", "Terrain requires the production 3D physics plugin.");
  const navigation = () => context.getNavigationService?.() ?? fail("NAVIGATION", "Terrain navigation requires the navigation plugin.");
  const commit = (next: TerrainState | undefined, previous: TerrainState | undefined) => {
    const state = next ?? previous!, projected = next && projection(next), oldGrid = previous?.navigation ? navigation().getGrid(previous.navigation.grid) : undefined;
    const native = bridge();
    if (oldGrid && (oldGrid.owner !== owner(state.id) || oldGrid.width !== state.columns - 1 || oldGrid.height !== state.rows - 1)) return fail("NAVIGATION_OWNER", `Grid '${oldGrid.id}' no longer matches terrain '${state.id}'.`);
    const navigationOwner = projected || oldGrid ? context.getNavigationStateBridge?.() ?? fail("NAVIGATION_TRANSACTION", "Terrain/navigation edits require the host-owned navigation checkpoint bridge.") : undefined;
    const navigationCheckpoint = navigationOwner?.snapshot();
    let navChanged = false;
    try {
      if (projected) {
        if (oldGrid) { navChanged = true; updateGrid(navigation(), projected); }
        else { navigation().createGrid(projected); navChanged = true; }
      } else if (oldGrid) { navigation().destroyGrid(oldGrid.id); navChanged = true; }
      if (next) native.setTerrain(terrainGeometry(next)); else native.removeTerrain(state.id);
    } catch (error) {
      const failures: unknown[] = [];
      if (navChanged) try { navigationOwner!.restore(navigationCheckpoint); } catch (rollback) { failures.push(rollback); }
      if (failures.length) throw new AggregateError([error, ...failures], `TC_TERRAIN_ROLLBACK: '${state.id}' partialState=true; restore a known-good checkpoint.`);
      throw error;
    }
    if (next) entries.set(next.id, next); else entries.delete(state.id);
    try { context.emit("terrain.changed", { id: state.id, revision: next?.revision ?? null, removed: !next }); }
    catch (error) { throw new AggregateError([error], `TC_TERRAIN_EVENT: '${state.id}' edit committed=true; event delivery failed. Inspect the current revision before retrying.`); }
  };
  const parse = (value: unknown): Map<string, TerrainState> => {
    const saved = cloneSerializable(value) as { version: number; terrains: TerrainState[] };
    if (!saved || saved.version !== 1 || !Array.isArray(saved.terrains) || saved.terrains.length > 128) return fail("SNAPSHOT", "Expected version 1 with at most 128 terrains.");
    const result = new Map<string, TerrainState>(), grids = new Set<string>();
    for (const input of saved.terrains) {
      if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0) return fail("SNAPSHOT", "Each terrain needs a nonnegative saved revision.");
      const state = normalize(input, input?.revision);
      if (result.has(state.id) || (state.navigation && grids.has(state.navigation.grid))) return fail("SNAPSHOT", "Duplicate terrain or navigation grid.");
      if (state.navigation) grids.add(state.navigation.grid);
      result.set(state.id, state);
    }
    return result;
  };
  const service: TerrainService = {
    create(input) { alive(); const state = normalize(input); if (entries.has(state.id) || entries.size >= 128) return fail("CAPACITY", `Terrain '${state.id}' exists or capacity is exhausted.`); commit(state, undefined); },
    inspect(id) { return cloneSerializable(get(id)); },
    list() { alive(); return [...entries.keys()].sort(); },
    setHeights(id, edits) {
      const previous = get(id);
      if (!Array.isArray(edits) || edits.length > previous.heights.length) return fail("EDIT", `Terrain '${id}' needs at most ${previous.heights.length} distinct vertex edits.`);
      if (!edits.length) return;
      const heights = [...previous.heights], seen = new Set<number>();
      for (const edit of edits) {
        if (!edit || !Number.isSafeInteger(edit.column) || !Number.isSafeInteger(edit.row) || edit.column < 0 || edit.row < 0 || edit.column >= previous.columns || edit.row >= previous.rows || !Number.isFinite(edit.height)) return fail("EDIT", `Terrain '${id}' has an invalid vertex edit.`);
        const index = edit.row * previous.columns + edit.column;
        if (seen.has(index)) return fail("EDIT", `Terrain '${id}' contains duplicate vertex ${index}.`);
        seen.add(index); heights[index] = edit.height;
      }
      const next = normalize({ ...previous, heights }, previous.revision + 1);
      commit(next, previous);
    },
    sculpt(id, brush) {
      const state = get(id);
      if (!brush || !Array.isArray(brush.center) || brush.center.length !== 2 || !brush.center.every(Number.isFinite) || !Number.isFinite(brush.radius) || brush.radius <= 0 || brush.radius > 1e6 || !Number.isFinite(brush.delta) || Math.abs(brush.delta) > 1e5 || !["linear", "smooth", "constant"].includes(brush.falloff ?? "smooth")) return fail("BRUSH", "Provide world X/Z center, positive radius, bounded delta and a supported falloff.");
      const edits: { column: number; row: number; height: number }[] = [];
      for (const [index, point] of terrainMesh(state).positions.entries()) {
        const distance = Math.hypot(point[0] - brush.center[0], point[2] - brush.center[1]);
        if (distance > brush.radius) continue;
        const t = 1 - distance / brush.radius, weight = brush.falloff === "constant" ? 1 : brush.falloff === "linear" ? t : t * t * (3 - 2 * t);
        edits.push({ column: index % state.columns, row: Math.floor(index / state.columns), height: state.heights[index] + brush.delta * weight });
      }
      service.setHeights(id, edits);
    },
    sampleHeight(id, x, z) { return terrainHeight(get(id), x, z); },
    visuals() { alive(); return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id, "en")).map(state => ({ id: state.id, material: state.material, ...terrainMesh(state), castShadow: state.castShadow ?? true, receiveShadow: state.receiveShadow ?? true })); },
    destroy(id) { const state = get(id); const agent = context.getNavigationService?.()?.listAgents().find(item => item.terrain === id); if (agent) return fail("IN_USE", `Destroy navigation agent '${agent.id}' before terrain '${id}'.`); commit(undefined, state); },
  };
  return {
    id: "$engine.terrain", version: "1", services: { terrain: service },
    legacySnapshot: () => ({ version: 1, terrains: [] }),
    snapshot: () => { alive(); return { version: 1, terrains: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id, "en")).map(item => cloneSerializable(item)) }; },
    validateSnapshot(value) { parse(value); },
    validatePeers(value, peers) {
      const staged = parse(value), physics = peers["$engine.physics"]?.payload as { terrains?: TerrainGeometry[] } | undefined;
      const expected = [...staged.values()].map(terrainGeometry).sort((a, b) => a.id.localeCompare(b.id, "en"));
      if (JSON.stringify(expected) !== JSON.stringify(physics?.terrains ?? [])) return fail("SNAPSHOT_PHYSICS", "Terrain geometry differs from the physics peer.");
      const navPeer = peers["$engine.navigation"]?.payload as { grids?: NavigationGrid[]; agents?: { id: string; terrain?: string; grid: string; origin: readonly number[]; cellSize: number; plane: string; rowDirection: string }[] } | undefined;
      const grids = navPeer?.grids ?? [];
      for (const agent of navPeer?.agents ?? []) if (agent.terrain !== undefined) {
        const terrain = staged.get(agent.terrain);
        if (!terrain || terrain.navigation?.grid !== agent.grid || agent.cellSize !== terrain.cellSize || agent.origin[0] !== terrain.origin[0] || agent.origin[1] !== terrain.origin[2] || agent.plane !== "xz" || agent.rowDirection !== "positive") return fail("SNAPSHOT_AGENT", `Agent '${agent.id}' does not match its terrain mapping.`);
      }
      for (const state of staged.values()) {
        const projected = projection(state);
        if (!projected) continue;
        const found = grids.find(grid => grid.id === projected.id);
        const canonical = (grid: NavigationGrid | undefined) => grid && JSON.stringify([grid.id, grid.owner, grid.width, grid.height,
          [...(grid.blocked ?? [])].sort((a, b) => a.y - b.y || a.x - b.x), [...(grid.costs ?? [])].filter(item => item.cost !== 1).sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x)]);
        if (canonical(found) !== canonical(projected)) return fail("SNAPSHOT_NAVIGATION", `Grid '${projected.id}' differs from the terrain projection.`);
      }
    },
    restore(value) { alive(); entries = parse(value); },
    dispose() { disposed = true; entries.clear(); },
  };
};
