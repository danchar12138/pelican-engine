import type { EntityHandle, TilemapDefinition, TilemapService, TilemapState, TilemapVisualState, Vec2 } from "../../sdk/src/index.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type SavedMap = { id: string; entity: string; material: string; width: number; height: number; tileSize: Vec2; offset: Vec2;
  columns: number; rows: number; castShadow: boolean; receiveShadow: boolean; cells: (number | null)[] };
type Entry = SavedMap & { token: number; revisions: number[] };
type Snapshot = { format: "pelican.tilemaps"; version: 1; maps: SavedMap[] };
const CHUNK = 32, MAX_MAPS = 64, MAX_DIMENSION = 512, MAX_CELLS = 65536, MAX_TOTAL_CELLS = 262144, MAX_ATLAS_DIM = 256, MAX_FRAMES = 4096, MAX_UPDATES = 4096;
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
      const item = get(id), updates = cloneSerializable(input);
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
        return fail("CAPACITY", `Tilemap '${id}' chunk revision exhausted; recreate the map.`);
      for (const [index, value] of changes) item.cells[index] = value;
      for (const chunk of changedChunks) item.revisions[chunk]++;
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
