import type { EntityHandle, NavigationObstacleUpdate, NavigationService, Physics2DCollider, Physics2DService, TilemapDefinition, TilemapNavigationOptions, TilemapPhysics2DOptions, TilemapService, TilemapState, TilemapUpdate, TilemapVisualState, Vec2 } from "../../sdk/src/index.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type SavedMap = { id: string; entity: string; material: string; width: number; height: number; tileSize: Vec2; offset: Vec2;
  columns: number; rows: number; castShadow: boolean; receiveShadow: boolean; cells: (number | null)[] };
type Entry = SavedMap & { token: number; revisions: number[] };
type Snapshot = { format: "pelican.tilemaps"; version: 1; maps: SavedMap[] };
const CHUNK = 32, MAX_MAPS = 64, MAX_DIMENSION = 512, MAX_CELLS = 65536, MAX_TOTAL_CELLS = 262144, MAX_ATLAS_DIM = 256, MAX_FRAMES = 4096, MAX_UPDATES = 4096, MAX_COLLIDER_PARTS = 2048;
const fail = (code: string, message: string): never => { throw new Error(`TC_TILEMAP_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function pair(value: unknown, label: string, positive: boolean): Vec2 {
  if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6 ||
      !Number.isFinite(Math.fround(v)) || (positive && (v <= 0 || Math.fround(v) === 0))))
    return fail("VALUE", `${label} must contain two ${positive ? "positive " : ""}finite float32-representable values with magnitude at most 1e6.`);
  return [value[0], value[1]];
}
function frame(value: unknown, total: number): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= total)
    return fail("FRAME", `Tile frame must be null or an integer in [0, ${total - 1}].`);
  return value as number;
}
function cellIndex(item: SavedMap, x: number, y: number): number {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= item.width || y >= item.height)
    return fail("CELL", `Tile coordinates must be within map '${item.id}'.`);
  return y * item.width + x;
}
function chunkColumns(item: SavedMap): number { return Math.ceil(item.width / CHUNK); }
function chunkRows(item: SavedMap): number { return Math.ceil(item.height / CHUNK); }
function saved(item: Entry): SavedMap {
  return { id: item.id, entity: item.entity, material: item.material, width: item.width, height: item.height,
    tileSize: item.tileSize, offset: item.offset, columns: item.columns, rows: item.rows,
    castShadow: item.castShadow, receiveShadow: item.receiveShadow, cells: item.cells };
}
export const createTilemapPlugin: RuntimePluginFactory = context => {
  let entries = new Map<string, Entry>(), handles = new Map<string, EntityHandle>(), nextToken = 1, disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using tilemaps."); };
  const prune = () => { for (const [id, handle] of handles) if (!context.world.isAlive(handle)) { handles.delete(id); entries.delete(id); } };
  const get = (id: string) => {
    alive(); prune();
    if (!validName(id)) return fail("ID", "Expected a nonempty tilemap id.");
    return entries.get(id) ?? fail("MISSING", `Tilemap '${id}' does not exist or its entity was destroyed.`);
  };
  const materialExists = (id: string) => context.scene.materials.some(material => material.id === id && !!material.texture);
  function normalize(input: TilemapDefinition, strict = false): SavedMap {
    if (!fields(input, ["id", "entity", "material", "width", "height", "tileSize", "offset", "columns", "rows", "cells", "castShadow", "receiveShadow"]) ||
        !validName(input.id) || !validName(input.entity) || !validName(input.material) || !materialExists(input.material) ||
        typeof input.width !== "number" || !Number.isSafeInteger(input.width) || input.width < 1 || input.width > MAX_DIMENSION ||
        typeof input.height !== "number" || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > MAX_DIMENSION || input.width * input.height > MAX_CELLS ||
        typeof input.columns !== "number" || !Number.isSafeInteger(input.columns) || input.columns < 1 || input.columns > MAX_ATLAS_DIM ||
        typeof input.rows !== "number" || !Number.isSafeInteger(input.rows) || input.rows < 1 || input.rows > MAX_ATLAS_DIM || input.columns * input.rows > MAX_FRAMES ||
        (input.castShadow !== undefined && typeof input.castShadow !== "boolean") || (input.receiveShadow !== undefined && typeof input.receiveShadow !== "boolean"))
      return fail("DEFINITION", "Tilemap requires a live entity, textured material, valid dimensions, atlas dimensions and boolean shadow options.");
    if (strict && (input.offset === undefined || input.cells === undefined || input.castShadow === undefined || input.receiveShadow === undefined))
      return fail("SNAPSHOT", `Tilemap '${input.id}' is missing stored fields.`);
    const count = input.width * input.height;
    if (input.cells !== undefined && (!Array.isArray(input.cells) || input.cells.length !== count))
      return fail("CELLS", `Tilemap '${input.id}' needs exactly ${count} row-major cells.`);
    const cells = input.cells === undefined ? Array.from({ length: count }, () => null) : input.cells.map(value => frame(value, input.columns * input.rows));
    return { id: input.id, entity: input.entity, material: input.material, width: input.width, height: input.height,
      tileSize: pair(input.tileSize, "tileSize", true), offset: input.offset === undefined ? [0, 0] : pair(input.offset, "offset", false),
      columns: input.columns, rows: input.rows, castShadow: input.castShadow === true, receiveShadow: input.receiveShadow === true, cells };
  }
  function parse(value: unknown): SavedMap[] {
    const data = cloneSerializable(value) as Snapshot;
    if (!fields(data, ["format", "version", "maps"]) || data.format !== "pelican.tilemaps" || data.version !== 1 ||
        !Array.isArray(data.maps) || data.maps.length > MAX_MAPS) return fail("SNAPSHOT", "Expected a bounded version 1 tilemap snapshot.");
    const ids = new Set<string>(); let total = 0;
    const result = data.maps.map(raw => {
      const item = normalize(raw, true);
      if (ids.has(item.id)) return fail("SNAPSHOT", `Duplicate tilemap '${item.id}'.`);
      ids.add(item.id); total += item.cells.length;
      if (total > MAX_TOTAL_CELLS) return fail("CAPACITY", `At most ${MAX_TOTAL_CELLS} total cells may be restored.`);
      return item;
    });
    return result;
  }
  function validateWorld(items: readonly SavedMap[], world: WorldSnapshot): void {
    const ids = new Set(world.entities.map(item => item.id));
    for (const item of items) if (!ids.has(item.entity)) return fail("SNAPSHOT", `Tilemap '${item.id}' needs live entity '${item.entity}' in the world snapshot.`);
  }
  function reserveTokens(count: number): number {
    if (!Number.isSafeInteger(nextToken) || count > Number.MAX_SAFE_INTEGER - nextToken) return fail("CAPACITY", "Tilemap presentation token range exhausted; create a new host.");
    const start = nextToken; nextToken += count; return start;
  }
  function planTiles(item: Entry, input: readonly TilemapUpdate[]) {
    const updates = cloneSerializable(input);
    if (!Array.isArray(updates) || updates.length > MAX_UPDATES) return fail("UPDATES", `Expected at most ${MAX_UPDATES} updates.`);
    const changes = new Map<number, number | null>(), changedChunks = new Set<number>(), across = chunkColumns(item);
    for (const update of updates) {
      if (!fields(update, ["x", "y", "frame"]) || typeof update.x !== "number" || typeof update.y !== "number")
        return fail("UPDATES", "Each update needs x, y and frame.");
      const index = cellIndex(item, update.x, update.y), value = frame(update.frame, item.columns * item.rows);
      if (changes.has(index)) return fail("UPDATES", `Cell ${update.x},${update.y} is repeated in the batch.`);
      changes.set(index, value);
      if (item.cells[index] !== value) changedChunks.add(Math.floor(update.y / CHUNK) * across + Math.floor(update.x / CHUNK));
    }
    for (const chunk of changedChunks) if (item.revisions[chunk] >= Number.MAX_SAFE_INTEGER)
      return fail("CAPACITY", `Tilemap '${item.id}' chunk revision exhausted; recreate the map.`);
    return { changes, changedChunks };
  }
  function planNavigation(item: Entry, gridId: string, input: TilemapNavigationOptions, changes?: ReadonlyMap<number, number | null>) {
    const nav: NavigationService = context.getNavigationService?.() ?? fail("NAVIGATION_UNAVAILABLE", "Navigation is unavailable; install the engine navigation plugin before synchronizing tiles.");
    const options = cloneSerializable(input);
    if (!fields(options, ["origin", "blockedFrames", "emptyBlocked"]) || !Array.isArray(options.blockedFrames) || options.blockedFrames.length > MAX_FRAMES ||
        (options.emptyBlocked !== undefined && typeof options.emptyBlocked !== "boolean"))
      return fail("NAVIGATION_OPTIONS", "Provide blockedFrames and optional origin/emptyBlocked.");
    const blocked = new Set<number>();
    for (const candidate of options.blockedFrames) {
      const selected = frame(candidate, item.columns * item.rows);
      if (selected === null || blocked.has(selected)) return fail("NAVIGATION_OPTIONS", "blockedFrames must contain distinct atlas frame indices.");
      blocked.add(selected);
    }
    const origin = options.origin === undefined ? { x: 0, y: 0 } : options.origin;
    if (!fields(origin, ["x", "y"]) || typeof origin.x !== "number" || typeof origin.y !== "number" ||
        !Number.isSafeInteger(origin.x) || !Number.isSafeInteger(origin.y) || origin.x < 0 || origin.y < 0)
      return fail("NAVIGATION_OPTIONS", "Navigation origin must contain nonnegative safe integer x/y coordinates.");
    const grid = nav.getGrid(gridId);
    if (origin.x + item.width > grid.width || origin.y + item.height > grid.height)
      return fail("NAVIGATION_BOUNDS", `Tilemap '${item.id}' does not fit in navigation grid '${gridId}' at that origin.`);
    const updates: NavigationObstacleUpdate[] = [];
    const append = (index: number, value: number | null) => updates.push({ cell: { x: origin.x as number + index % item.width,
      y: origin.y as number + Math.floor(index / item.width) }, blocked: value === null ? options.emptyBlocked === true : blocked.has(value) });
    if (changes) for (const [index, value] of changes) append(index, value);
    else for (let index = 0; index < item.cells.length; index++) append(index, item.cells[index]);
    return { nav, updates };
  }
  function planPhysics(item: Entry, bodyId: string, input: TilemapPhysics2DOptions, cells: readonly (number | null)[] = item.cells) {
    const physics: Physics2DService = context.getPhysics2DService?.() ?? fail("PHYSICS2D_UNAVAILABLE", "Enable scene.physics2d before synchronizing tile collisions.");
    const body = physics.inspect(bodyId);
    if (body.type !== "fixed" || body.entity !== item.entity)
      return fail("PHYSICS2D_BODY", `Body '${bodyId}' must be fixed and bound to tilemap entity '${item.entity}'.`);
    const options = cloneSerializable(input);
    if (!fields(options, ["solidFrames", "emptySolid"]) || !Array.isArray(options.solidFrames) || options.solidFrames.length > MAX_FRAMES ||
        (options.emptySolid !== undefined && typeof options.emptySolid !== "boolean"))
      return fail("PHYSICS2D_OPTIONS", "Provide solidFrames and optional emptySolid.");
    const solidFrames = new Set<number>();
    for (const candidate of options.solidFrames) {
      const selected = frame(candidate, item.columns * item.rows);
      if (selected === null || solidFrames.has(selected)) return fail("PHYSICS2D_OPTIONS", "solidFrames must contain distinct atlas frame indices.");
      solidFrames.add(selected);
    }
    const solid = (index: number) => cells[index] === null ? options.emptySolid === true : solidFrames.has(cells[index] as number);
    const visited = new Uint8Array(cells.length), parts: { halfExtents: Vec2; offset: Vec2 }[] = [];
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) {
      const index = y * item.width + x;
      if (visited[index] || !solid(index)) continue;
      let width = 0;
      while (x + width < item.width && !visited[index + width] && solid(index + width)) width++;
      let height = 1;
      while (y + height < item.height) {
        let complete = true;
        for (let dx = 0; dx < width; dx++) {
          const candidate = (y + height) * item.width + x + dx;
          if (visited[candidate] || !solid(candidate)) { complete = false; break; }
        }
        if (!complete) break;
        height++;
      }
      if (parts.length >= MAX_COLLIDER_PARTS) return fail("PHYSICS2D_CAPACITY", `Tilemap '${item.id}' needs more than ${MAX_COLLIDER_PARTS} collision rectangles; simplify or split it.`);
      for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) visited[(y + dy) * item.width + x + dx] = 1;
      const halfX = width * item.tileSize[0] / 2, halfY = height * item.tileSize[1] / 2;
      const centerX = item.offset[0] + (x + width / 2) * item.tileSize[0], centerY = item.offset[1] - (y + height / 2) * item.tileSize[1];
      parts.push({ halfExtents: [halfX, halfY], offset: [centerX, centerY] });
    }
    const collider: Physics2DCollider = { shape: "compound", parts };
    return { physics, collider };
  }
  const service: TilemapService = {
    create(input) {
      alive(); prune();
      const item = normalize(cloneSerializable(input));
      if (entries.has(item.id)) return fail("DUPLICATE", `Tilemap '${item.id}' already exists.`);
      if (!context.world.isAlive(item.entity)) return fail("ENTITY", `Entity '${item.entity}' is not alive; create it before the tilemap.`);
      const total = [...entries.values()].reduce((sum, value) => sum + value.cells.length, 0);
      if (entries.size >= MAX_MAPS || total + item.cells.length > MAX_TOTAL_CELLS)
        return fail("CAPACITY", `At most ${MAX_MAPS} maps and ${MAX_TOTAL_CELLS} total cells may exist.`);
      const handle = context.world.resolve(item.entity), token = reserveTokens(1);
      entries.set(item.id, { ...item, token, revisions: Array.from({ length: chunkColumns(item) * chunkRows(item) }, () => 0) });
      handles.set(item.id, handle);
    },
    getTile(id, x, y) { const item = get(id); return item.cells[cellIndex(item, x, y)]; },
    setTile(id, x, y, value) { service.setTiles(id, [{ x, y, frame: value }]); },
    setTiles(id, input) {
      const item = get(id), { changes, changedChunks } = planTiles(item, input);
      for (const [index, value] of changes) item.cells[index] = value;
      for (const chunk of changedChunks) item.revisions[chunk]++;
    },
    syncNavigation(id, grid, options) {
      const item = get(id), planned = planNavigation(item, grid, options);
      const previous = planned.updates.map(update => ({ cell: update.cell, blocked: planned.nav.isBlocked(grid, update.cell) }));
      try { planned.nav.setBlockedBatch(grid, planned.updates); }
      catch (error) {
        try { planned.nav.setBlockedBatch(grid, previous); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "TC_TILEMAP_NAVIGATION_ROLLBACK: Navigation synchronization and rollback failed; partialState=true. Restore a known-good host checkpoint.");
        }
        throw error;
      }
    },
    setTilesAndSyncNavigation(id, input, grid, options) {
      const item = get(id), plan = planTiles(item, input), navigation = planNavigation(item, grid, options, plan.changes);
      const oldCells = item.cells, oldRevisions = item.revisions, cells = [...oldCells], revisions = [...oldRevisions];
      for (const [index, value] of plan.changes) cells[index] = value;
      for (const chunk of plan.changedChunks) revisions[chunk]++;
      const previous = navigation.updates.map(update => ({ cell: update.cell, blocked: navigation.nav.isBlocked(grid, update.cell) }));
      try {
        navigation.nav.setBlockedBatch(grid, navigation.updates);
        item.cells = cells; item.revisions = revisions;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try { item.cells = oldCells; item.revisions = oldRevisions; } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        try { navigation.nav.setBlockedBatch(grid, previous); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (rollbackErrors.length)
          throw new AggregateError([error, ...rollbackErrors], "TC_TILEMAP_NAVIGATION_ROLLBACK: Tile/navigation update failed and rollback failed; partialState=true. Restore a known-good host checkpoint.");
        throw error;
      }
    },
    syncPhysics2D(id, body, options) {
      const item = get(id), planned = planPhysics(item, body, options);
      planned.physics.setCollider(body, planned.collider);
    },
    setTilesAndSyncPhysics2D(id, input, body, options) {
      const item = get(id), plan = planTiles(item, input), oldCells = item.cells, oldRevisions = item.revisions;
      const cells = [...oldCells], revisions = [...oldRevisions];
      for (const [index, value] of plan.changes) cells[index] = value;
      for (const chunk of plan.changedChunks) revisions[chunk]++;
      const planned = planPhysics(item, body, options, cells), previous = planned.physics.collider(body);
      // A failed native replacement already reports partialState; do not retry it blindly.
      planned.physics.setCollider(body, planned.collider);
      try { item.cells = cells; item.revisions = revisions; }
      catch (error) {
        const failures: unknown[] = [error];
        try { item.cells = oldCells; item.revisions = oldRevisions; } catch (rollback) { failures.push(rollback); }
        try { planned.physics.setCollider(body, previous); } catch (rollback) { failures.push(rollback); }
        if (failures.length > 1) throw new AggregateError(failures, "TC_TILEMAP_PHYSICS2D_ROLLBACK: Tile/collider update failed and rollback failed; partialState=true. Restore a known-good checkpoint.");
        throw error;
      }
    },
    inspect(id): TilemapState { return cloneSerializable(saved(get(id))); },
    visuals(): readonly TilemapVisualState[] {
      alive(); prune();
      return [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(item => {
        const { cells: _cells, ...definition } = saved(item), chunks: { x: number; y: number; revision: number }[] = [];
        const across = chunkColumns(item);
        for (let y = 0; y < chunkRows(item); y++) for (let x = 0; x < across; x++) chunks.push({ x, y, revision: item.revisions[y * across + x] });
        return cloneSerializable({ ...definition, token: item.token, chunks });
      });
    },
    readChunk(id, x, y) {
      const item = get(id), across = chunkColumns(item), down = chunkRows(item);
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= across || y >= down)
        return fail("CHUNK", `Chunk coordinates must be within tilemap '${id}'.`);
      const width = Math.min(CHUNK, item.width - x * CHUNK), height = Math.min(CHUNK, item.height - y * CHUNK), cells: (number | null)[] = [];
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) cells.push(item.cells[(y * CHUNK + row) * item.width + x * CHUNK + col]);
      return { x, y, width, height, revision: item.revisions[y * across + x], cells };
    },
    destroy(id) { get(id); entries.delete(id); handles.delete(id); },
  };
  const empty = (): Snapshot => ({ format: "pelican.tilemaps", version: 1, maps: [] });
  return {
    id: "$engine.tilemaps", version: "1", services: { tilemaps: service },
    snapshot() { alive(); prune(); return cloneSerializable({ format: "pelican.tilemaps", version: 1,
      maps: [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(saved) }); },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { validateWorld(parse(value), world); },
    restore(value) {
      alive();
      const parsed = parse(value), nextHandles = new Map<string, EntityHandle>();
      for (const item of parsed) nextHandles.set(item.id, context.world.resolve(item.entity));
      const start = reserveTokens(parsed.length);
      entries = new Map(parsed.map((item, i) => [item.id, { ...item, token: start + i,
        revisions: Array.from({ length: chunkColumns(item) * chunkRows(item) }, () => 0) }]));
      handles = nextHandles;
    },
    dispose() { disposed = true; entries.clear(); handles.clear(); },
  };
};
