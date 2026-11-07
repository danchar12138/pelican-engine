import type {
  ComponentData,
  ComponentSchema,
  EntityHandle,
  SpawnInput,
  Transform,
  Vec3,
  WorldChunkDefinition,
  WorldStreamingOptions,
  WorldStreamingService,
} from "../../sdk/src/index.ts";
import type { EntityRecord, WorldSnapshot } from "./contracts.ts";
import type { RuntimePluginFactory } from "./plugins.ts";
import { cloneSerializable } from "./random.ts";
import { values } from "./storage.ts";

type Options = Required<WorldStreamingOptions>;
type Chunk = { x: number; z: number; active: boolean; entities: EntityRecord[] };
type StreamingSnapshot = { version: 1; options: Options; focus: Vec3 | null; chunks: Chunk[] };
const initial: Options = { chunkSize: 32, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 };
const transformSchema: ComponentSchema = {
  position: { type: "vec3", default: [0, 0, 0] },
  rotation: { type: "vec3", default: [0, 0, 0] },
  scale: { type: "vec3", default: [1, 1, 1] },
};
const fail = (code: string, detail: string): never => { throw new Error(`TC_STREAMING_${code}: ${detail}`); };
const key = (x: number, z: number) => `${x},${z}`;
function coordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= 1e12;
}
function options(input: WorldStreamingOptions, previous: Options = initial): Options {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !["chunkSize", "loadRadius", "unloadRadius", "maxChangesPerTick"].includes(k)))
    return fail("OPTIONS", "Expected chunkSize, loadRadius, unloadRadius and maxChangesPerTick options.");
  const result = { ...previous, ...input };
  if (!Number.isFinite(result.chunkSize) || result.chunkSize < 0.001 || result.chunkSize > 1e6 ||
      !Number.isSafeInteger(result.loadRadius) || result.loadRadius < 0 || result.loadRadius > 64 ||
      !Number.isSafeInteger(result.unloadRadius) || result.unloadRadius < result.loadRadius || result.unloadRadius > 64 ||
      !Number.isSafeInteger(result.maxChangesPerTick) || result.maxChangesPerTick < 1 || result.maxChangesPerTick > 64)
    return fail("OPTIONS", "Use chunkSize in [0.001, 1000000], radii 0..64 with unloadRadius >= loadRadius, and maxChangesPerTick in 1..64.");
  return result;
}
function focus(value: Vec3 | null): Vec3 | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e9))
    return fail("FOCUS", "Focus must be null or three finite world coordinates in [-1e9, 1e9].");
  return [value[0], value[1], value[2]];
}

/** Static prefab residency. Structural changes are committed by the existing World phase boundary. */
export const createWorldStreamingPlugin: RuntimePluginFactory = context => {
  let config = { ...initial }, observer: Vec3 | null = null, disposed = false;
  let chunks = new Map<string, Chunk>();
  const handles = new Map<string, EntityHandle>();
  const waiting = new Set<string>();
  const schemas = new Map(context.scene.components.map(component => [component.id, component.schema]));
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using world streaming."); };
  function entity(input: SpawnInput, fromSnapshot = false): EntityRecord {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["id", "prefab", "parent", "transform", "components"].includes(k)) ||
        typeof input.id !== "string" || !input.id.trim() || typeof input.prefab !== "string" || !input.prefab.trim())
      return fail("ENTITY", "Each chunk entity needs a nonempty id and declared prefab.");
    if (input.parent !== undefined) return fail("ENTITY", `Chunk entity '${input.id}' must be a root entity.`);
    const prefab = context.scene.prefabs.find(item => item.id === input.prefab);
    if (!prefab) return fail("PREFAB", `Unknown prefab '${input.prefab}' for '${input.id}'.`);
    if (prefab.character || (prefab.rigidBody && prefab.rigidBody.type !== "fixed"))
      return fail("PHYSICS", `Chunk entity '${input.id}' must not use a dynamic, kinematic or character body; its native state cannot yet be streamed.`);
    if (fromSnapshot && (input.transform === undefined || input.components === undefined))
      return fail("SNAPSHOT", `Saved entity '${input.id}' needs its transform and components.`);
    const transform = values(transformSchema, (fromSnapshot ? input.transform : { ...prefab.transform, ...(input.transform ?? {}) }) as unknown as ComponentData, true, fromSnapshot) as unknown as Transform;
    const source = input.components ?? {};
    if (!source || typeof source !== "object" || Array.isArray(source)) return fail("ENTITY", `Components of '${input.id}' must be a record.`);
    const entries: [string, ComponentData][] = [];
    const names = fromSnapshot ? Object.keys(source) : [...new Set([...Object.keys(prefab.components), ...Object.keys(source)])];
    for (const name of names) {
      const schema = schemas.get(name);
      if (!schema) return fail("COMPONENT", `Unknown component '${name}' on '${input.id}'.`);
      const fields = fromSnapshot ? source[name] : { ...(prefab.components[name] as ComponentData), ...source[name] };
      entries.push([name, values(schema, fields, true, fromSnapshot)]);
    }
    return { id: input.id, prefab: input.prefab, transform, components: Object.fromEntries(entries) };
  }
  function parse(value: unknown): StreamingSnapshot {
    const data = cloneSerializable(value) as StreamingSnapshot;
    if (!data || typeof data !== "object" || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.chunks) || data.chunks.length > 4096)
      return fail("SNAPSHOT", "Expected version 1 streaming snapshot with at most 4096 chunks.");
    const parsedOptions = options(data.options), parsedFocus = focus(data.focus);
    const coordinates = new Set<string>(), ids = new Set<string>();
    let total = 0;
    const parsedChunks = data.chunks.map(item => {
      if (!item || !coordinate(item.x) || !coordinate(item.z) || typeof item.active !== "boolean" || !Array.isArray(item.entities) || item.entities.length > 512)
        return fail("SNAPSHOT", "Invalid chunk coordinates, active flag or entities.");
      const id = key(item.x, item.z);
      if (coordinates.has(id)) return fail("SNAPSHOT", `Duplicate chunk '${id}'.`);
      coordinates.add(id);
      const entities = item.entities.map(item => entity(item, true));
      for (const record of entities) {
        if (ids.has(record.id)) return fail("SNAPSHOT", `Duplicate chunk entity '${record.id}'.`);
        ids.add(record.id);
      }
      total += entities.length;
      if (total > 65536) return fail("CAPACITY", "At most 65536 chunk entities may be registered.");
      return { x: item.x, z: item.z, active: item.active, entities };
    });
    return { version: 1, options: parsedOptions, focus: parsedFocus, chunks: parsedChunks };
  }
  function currentRecords(): Map<string, EntityRecord> {
    return new Map(context.world.records().map(record => [record.id, record]));
  }
  function sync(records: Map<string, EntityRecord>): void {
    for (const chunk of chunks.values()) {
      if (!chunk.active) continue;
      const remaining: EntityRecord[] = [];
      for (const old of chunk.entities) {
        const record = records.get(old.id), handle = handles.get(old.id);
        if (!record) { handles.delete(old.id); waiting.delete(old.id); continue; }
        if (handle && !context.world.isAlive(handle))
          return fail("OWNERSHIP", `Entity '${old.id}' was replaced while owned by a chunk; restore a checkpoint or use a distinct ID.`);
        if (!handle && waiting.has(old.id)) {
          handles.set(old.id, context.world.resolve(old.id));
          waiting.delete(old.id);
        } else if (!handle) return fail("OWNERSHIP", `Missing ownership for '${old.id}'.`);
        if (record.prefab !== old.prefab || record.parent !== undefined)
          return fail("OWNERSHIP", `Entity '${old.id}' no longer matches its root prefab binding.`);
        remaining.push(record);
      }
      chunk.entities = remaining;
    }
  }
  function snapshot(): StreamingSnapshot {
    alive();
    sync(currentRecords());
    return cloneSerializable({ version: 1 as const, options: config, focus: observer,
      chunks: [...chunks.values()].sort((a, b) => a.x - b.x || a.z - b.z) });
  }
  function checkWorld(data: StreamingSnapshot, world: WorldSnapshot): void {
    const records = new Map(world.entities.map(record => [record.id, record]));
    for (const chunk of data.chunks) if (chunk.active) for (const item of chunk.entities) {
      const live = records.get(item.id);
      if (!live || live.parent !== undefined || live.prefab !== item.prefab)
        fail("SNAPSHOT", `Active chunk entity '${item.id}' does not match the world snapshot.`);
    }
  }
  const service: WorldStreamingService = {
    configure(input) { alive(); config = options(cloneSerializable(input), config); },
    defineChunk(input: WorldChunkDefinition) {
      alive();
      const data = cloneSerializable(input);
      if (!data || typeof data !== "object" || !coordinate(data.x) || !coordinate(data.z) || !Array.isArray(data.entities) || data.entities.length > 512)
        return fail("CHUNK", "Chunk requires integer x/z and at most 512 root prefab entities.");
      const id = key(data.x, data.z);
      if (chunks.has(id)) return fail("DUPLICATE", `Chunk '${id}' is already defined.`);
      const reserved = new Set([...chunks.values()].flatMap(chunk => chunk.entities.map(item => item.id)));
      const entities = data.entities.map(item => entity(item));
      for (const item of entities) {
        if (reserved.has(item.id)) return fail("DUPLICATE", `Chunk entity '${item.id}' is already reserved.`);
        reserved.add(item.id);
      }
      if (chunks.size >= 4096 || reserved.size > 65536) return fail("CAPACITY", "At most 4096 chunks and 65536 chunk entities may be defined.");
      chunks.set(id, { x: data.x, z: data.z, active: false, entities });
    },
    setFocus(position) { alive(); observer = focus(position); },
    removeChunk(x, z) {
      alive();
      if (!coordinate(x) || !coordinate(z)) return fail("CHUNK", "Chunk coordinates must be safe integers in [-1e12, 1e12].");
      const chunk = chunks.get(key(x, z));
      if (!chunk) return fail("MISSING", `Chunk '${key(x, z)}' is not defined.`);
      if (chunk.active) return fail("ACTIVE", `Move focus away and wait for chunk '${key(x, z)}' to unload before removal.`);
      chunks.delete(key(x, z));
    },
    inspect() {
      alive();
      return cloneSerializable({ focus: observer, options: config, chunks: [...chunks.values()]
        .sort((a, b) => a.x - b.x || a.z - b.z)
        .map(({ x, z, active, entities }) => ({ x, z, active, entities: entities.length })) });
    },
  };
  return {
    id: "$engine.world-streaming", version: "1", services: { streaming: service },
    systems: [
      {
        id: "$engine.world-streaming.update", phase: "update", structural: true,
        run() {
          const records = currentRecords();
          sync(records);
          if (!observer) return;
          const x = Math.floor(observer[0] / config.chunkSize), z = Math.floor(observer[2] / config.chunkSize);
          const distance = (chunk: Chunk) => Math.max(Math.abs(chunk.x - x), Math.abs(chunk.z - z));
          const unload = [...chunks.values()].filter(chunk => chunk.active && distance(chunk) > config.unloadRadius)
            .sort((a, b) => distance(b) - distance(a) || a.x - b.x || a.z - b.z);
          const load = [...chunks.values()].filter(chunk => !chunk.active && distance(chunk) <= config.loadRadius)
            .sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
          const selected = [...unload, ...load].slice(0, config.maxChangesPerTick);
          // Preflight every selected chunk before enqueuing any structural changes.
          for (const chunk of selected) {
            const ids = new Set(chunk.entities.map(item => item.id));
            if (chunk.active) {
              for (const record of records.values())
                if (record.parent !== undefined && ids.has(record.parent))
                  return fail("CHILD", `Entity '${record.id}' is attached to a chunk root; remove it before unloading.`);
            } else for (const item of chunk.entities) {
              if (records.has(item.id)) return fail("OWNERSHIP", `Entity '${item.id}' already exists; choose a distinct chunk entity ID.`);
            }
          }
          for (const chunk of selected) {
            if (chunk.active) {
              for (const item of chunk.entities) {
                context.world.queue({ type: "destroy", entity: handles.get(item.id)! });
                handles.delete(item.id);
              }
              chunk.active = false;
            } else {
              for (const item of chunk.entities) {
                context.world.queue({ type: "spawn", entity: item });
                waiting.add(item.id);
              }
              chunk.active = true;
            }
          }
        },
      },
      { id: "$engine.world-streaming.bind", phase: "presentation", run() { sync(currentRecords()); } },
    ],
    snapshot,
    legacySnapshot: () => ({ version: 1, options: initial, focus: null, chunks: [] }),
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { checkWorld(parse(value), world); },
    restore(value) {
      alive();
      const data = parse(value);
      checkWorld(data, context.world.snapshot());
      config = data.options; observer = data.focus;
      chunks = new Map(data.chunks.map(chunk => [key(chunk.x, chunk.z), chunk]));
      handles.clear(); waiting.clear();
      for (const chunk of chunks.values()) if (chunk.active)
        for (const item of chunk.entities) handles.set(item.id, context.world.resolve(item.id));
    },
    dispose() { disposed = true; chunks.clear(); handles.clear(); waiting.clear(); },
  };
};
