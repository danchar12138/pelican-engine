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
import type { RuntimePluginFactory, WorldResidencyBundle } from "./plugins.ts";
import { cloneSerializable } from "./random.ts";
import { values } from "./storage.ts";

type Options = Required<WorldStreamingOptions>;
type Edit = { kind: "add"; entity: EntityRecord } | { kind: "remove"; id: string };
type Chunk = { x: number; z: number; active: boolean; entities: EntityRecord[]; edits?: Edit[]; parked?: WorldResidencyBundle };
type StreamingSnapshot = { version: 1; options: Options; focus: Vec3 | null; chunks: Chunk[];
  focusEntity?: string | null; focusStatus?: "manual" | "following" | "missing" | "invalid" };
const initial: Options = { chunkSize: 32, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 };
const MAX_PENDING_EDITS = 4096;
const MAX_EDITS_PER_TICK = 64;
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

/** Root prefab residency. Owners park state at the structural phase boundary. */
export const createWorldStreamingPlugin: RuntimePluginFactory = context => {
  let config = { ...initial }, observer: Vec3 | null = null, disposed = false;
  let focusEntity: string | null = null, focusStatus: "manual" | "following" | "missing" | "invalid" = "manual";
  let focusHandle: EntityHandle | undefined;
  let chunks = new Map<string, Chunk>();
  const handles = new Map<string, EntityHandle>();
  const waiting = new Set<string>();
  const suspending: WorldResidencyBundle[] = [], resuming: Chunk[] = [];
  const residency = () => context.getWorldResidencyBridge?.() ?? fail("OWNER", "Dynamic residency requires a RuntimeHost owner bridge.");
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
    const savedEntity = data.focusEntity === undefined ? null : data.focusEntity;
    const savedStatus = data.focusStatus === undefined ? "manual" : data.focusStatus;
    if (!(savedEntity === null || (typeof savedEntity === "string" && savedEntity.trim().length > 0 && savedEntity.length <= 64 && !/[\x00-\x1f\x7f]/.test(savedEntity))) ||
        !["manual", "following", "missing", "invalid"].includes(savedStatus) ||
        (savedStatus === "manual" ? savedEntity !== null : savedEntity === null) ||
        ((savedStatus === "missing" || savedStatus === "invalid") && parsedFocus !== null))
      return fail("SNAPSHOT", "Invalid focus entity or status.");
    const coordinates = new Set<string>(), ids = new Set<string>();
    let total = 0, pendingCount = 0;
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
      if (item.edits !== undefined && (!Array.isArray(item.edits) || (!item.active && item.edits.length > 0)))
        return fail("SNAPSHOT", "Only active chunks may have an edit queue.");
      const removed = new Set<string>(), additions = new Set<string>();
      const edits: Edit[] = (item.edits ?? []).map(edit => {
        if (!edit || typeof edit !== "object") return fail("SNAPSHOT", "Invalid chunk edit.");
        if (edit.kind === "remove") {
          if (typeof edit.id !== "string" || !entities.some(record => record.id === edit.id) || removed.has(edit.id))
            return fail("SNAPSHOT", "A queued removal must name a distinct current chunk entity.");
          removed.add(edit.id);
          return { kind: "remove", id: edit.id };
        }
        if (edit.kind === "add") {
          const record = entity(edit.entity, true);
          if (ids.has(record.id) || additions.has(record.id)) return fail("SNAPSHOT", `Duplicate queued entity '${record.id}'.`);
          additions.add(record.id);
          ids.add(record.id);
          return { kind: "add", entity: record };
        }
        return fail("SNAPSHOT", "Unknown chunk edit.");
      });
      if (entities.length + additions.size > 512) return fail("CAPACITY", "A chunk may reserve at most 512 entities.");
      pendingCount += edits.length;
      if (pendingCount > MAX_PENDING_EDITS) return fail("CAPACITY", "At most 4096 edits may be queued.");
      total += entities.length + additions.size;
      if (total > 65536) return fail("CAPACITY", "At most 65536 chunk entities may be registered.");
      if (item.parked !== undefined) {
        if (item.active) return fail("SNAPSHOT", "Active chunks cannot retain parked resources.");
        residency().validate(item.parked, entities);
      }
      return { x: item.x, z: item.z, active: item.active, entities, ...(edits.length ? { edits } : {}), ...(item.parked === undefined ? {} : { parked: item.parked }) };
    });
    return { version: 1, options: parsedOptions, focus: parsedFocus, focusEntity: savedEntity, focusStatus: savedStatus, chunks: parsedChunks };
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
        if (!record) {
          handles.delete(old.id); waiting.delete(old.id);
          if (chunk.edits) {
            chunk.edits = chunk.edits.filter(edit => edit.kind !== "remove" || edit.id !== old.id);
            if (!chunk.edits.length) delete chunk.edits;
          }
          continue;
        }
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
    if (focusEntity && focusStatus !== "missing" && (!focusHandle || !context.world.isAlive(focusHandle))) {
      focusStatus = "missing"; focusHandle = undefined; observer = null;
    }
    return cloneSerializable({ version: 1 as const, options: config, focus: observer, focusEntity, focusStatus,
      chunks: [...chunks.values()].sort((a, b) => a.x - b.x || a.z - b.z) });
  }
  function checkWorld(data: StreamingSnapshot, world: WorldSnapshot): void {
    const records = new Map(world.entities.map(record => [record.id, record]));
    if (data.focusEntity && data.focusStatus !== "missing" && !records.has(data.focusEntity))
      fail("SNAPSHOT", `Followed entity '${data.focusEntity}' is missing from the world snapshot.`);
    for (const chunk of data.chunks) if (chunk.active) for (const item of chunk.entities) {
      const live = records.get(item.id);
      if (!live || live.parent !== undefined || live.prefab !== item.prefab)
        fail("SNAPSHOT", `Active chunk entity '${item.id}' does not match the world snapshot.`);
    }
  }
  function chunkAt(x: number, z: number): Chunk {
    if (!coordinate(x) || !coordinate(z)) return fail("CHUNK", "Chunk coordinates must be safe integers in [-1e12, 1e12].");
    return chunks.get(key(x, z)) ?? fail("MISSING", `Chunk '${key(x, z)}' is not defined.`);
  }
  function reservedIds(): Set<string> {
    const result = new Set<string>();
    for (const chunk of chunks.values()) {
      for (const item of chunk.entities) result.add(item.id);
      for (const edit of chunk.edits ?? []) if (edit.kind === "add") result.add(edit.entity.id);
    }
    return result;
  }
  function enqueue(chunk: Chunk, edit: Edit): void {
    let total = 0;
    for (const current of chunks.values()) total += current.edits?.length ?? 0;
    if (total >= MAX_PENDING_EDITS) return fail("CAPACITY", "At most 4096 edits may be queued.");
    (chunk.edits ??= []).push(edit);
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
      const reserved = reservedIds();
      const entities = data.entities.map(item => entity(item));
      for (const item of entities) {
        if (reserved.has(item.id)) return fail("DUPLICATE", `Chunk entity '${item.id}' is already reserved.`);
        reserved.add(item.id);
      }
      if (chunks.size >= 4096 || reserved.size > 65536) return fail("CAPACITY", "At most 4096 chunks and 65536 chunk entities may be defined.");
      chunks.set(id, { x: data.x, z: data.z, active: false, entities });
    },
    addEntity(x, z, input) {
      alive();
      const chunk = chunkAt(x, z), item = entity(cloneSerializable(input));
      const reserved = reservedIds();
      if (reserved.has(item.id)) return fail("DUPLICATE", `Chunk entity '${item.id}' is already reserved.`);
      const additions = (chunk.edits ?? []).filter(edit => edit.kind === "add").length;
      if (chunk.entities.length + additions >= 512 || reserved.size >= 65536)
        return fail("CAPACITY", "A chunk may reserve at most 512 entities; all chunks may reserve at most 65536.");
      if (chunk.active) enqueue(chunk, { kind: "add", entity: item });
      else chunk.entities.push(item);
    },
    removeEntity(x, z, entityId) {
      alive();
      const chunk = chunkAt(x, z);
      if (typeof entityId !== "string" || !entityId.trim()) return fail("ENTITY", "Expected a nonempty entity id.");
      const pendingAdd = chunk.edits?.findIndex(edit => edit.kind === "add" && edit.entity.id === entityId) ?? -1;
      if (pendingAdd >= 0) {
        chunk.edits!.splice(pendingAdd, 1);
        if (!chunk.edits!.length) delete chunk.edits;
        return;
      }
      const index = chunk.entities.findIndex(item => item.id === entityId);
      if (index < 0) return fail("MISSING", `Entity '${entityId}' is not owned by chunk '${key(x, z)}'.`);
      if (!chunk.active) {
        if (chunk.parked && Object.keys(chunk.parked).length) return fail("PARKED", "Reactivate the chunk before removing an individual entity with parked resources, or remove the entire inactive chunk.");
        chunk.entities.splice(index, 1); return;
      }
      if (chunk.edits?.some(edit => edit.kind === "remove" && edit.id === entityId))
        return fail("PENDING", `Removal of '${entityId}' is already queued.`);
      enqueue(chunk, { kind: "remove", id: entityId });
    },
    getChunk(x, z) {
      alive();
      const chunk = chunkAt(x, z);
      return cloneSerializable({ x: chunk.x, z: chunk.z, active: chunk.active, entities: chunk.entities,
        pending: (chunk.edits ?? []).map(edit => ({ kind: edit.kind, id: edit.kind === "add" ? edit.entity.id : edit.id })) });
    },
    setFocus(position) { alive(); observer = focus(position); focusEntity = null; focusHandle = undefined; focusStatus = "manual"; },
    followFocus(id) {
      alive();
      if (id === null) { observer = null; focusEntity = null; focusHandle = undefined; focusStatus = "manual"; return; }
      if (typeof id !== "string" || !id.trim() || id.length > 64 || /[\x00-\x1f\x7f]/.test(id) || !context.world.isAlive(id))
        return fail("FOCUS_ENTITY", "Focus requires a live entity with a printable id.");
      const handle = context.world.resolve(id);
      if (context.world.identity(handle).parent !== undefined) return fail("FOCUS_ENTITY", "Focus entity must be a root entity.");
      const position = focus(context.world.getTransform(handle).position);
      focusEntity = id; focusHandle = handle; focusStatus = "following"; observer = position;
    },
    removeChunk(x, z) {
      alive();
      const chunk = chunkAt(x, z);
      if (chunk.active) return fail("ACTIVE", `Move focus away and wait for chunk '${key(x, z)}' to unload before removal.`);
      chunks.delete(key(x, z));
    },
    inspect() {
      alive();
      return cloneSerializable({ focus: observer, focusEntity, focusStatus, options: config, chunks: [...chunks.values()]
        .sort((a, b) => a.x - b.x || a.z - b.z)
        .map(({ x, z, active, entities }) => ({ x, z, active, entities: entities.length })) });
    },
  };
  return {
    id: "$engine.world-streaming", version: "1", services: { streaming: service },
    beforeFlush(phase) {
      if (phase !== "update") return;
      context.world.runSystem("$engine.world-streaming.commit", { structural: true }, () => {
          const records = currentRecords();
          sync(records);
          if (focusEntity && focusStatus !== "missing") {
            if (!focusHandle || !context.world.isAlive(focusHandle)) {
              focusHandle = undefined; focusStatus = "missing"; observer = null;
            } else {
              const record = records.get(focusEntity), position = record?.transform.position;
              if (!record || record.parent !== undefined || !position || position.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) {
                focusStatus = "invalid"; observer = null;
              } else { focusStatus = "following"; observer = focus(position); }
            }
          }
          const editPlan: { chunk: Chunk; edit: Edit }[] = [];
          const touched = new Set<Chunk>();
          const ordered = [...chunks.values()].sort((a, b) => a.x - b.x || a.z - b.z);
          for (const chunk of ordered) {
            for (const edit of chunk.edits ?? []) {
              if (editPlan.length >= MAX_EDITS_PER_TICK) break;
              editPlan.push({ chunk, edit });
              touched.add(chunk);
            }
            if (editPlan.length >= MAX_EDITS_PER_TICK) break;
          }
          let selected: Chunk[] = [];
          if (observer) {
            const x = Math.floor(observer[0] / config.chunkSize), z = Math.floor(observer[2] / config.chunkSize);
            const distance = (chunk: Chunk) => Math.max(Math.abs(chunk.x - x), Math.abs(chunk.z - z));
            const eligible = (chunk: Chunk) => !touched.has(chunk) && !(chunk.edits?.length);
            const unload = ordered.filter(chunk => eligible(chunk) && chunk.active && distance(chunk) > config.unloadRadius)
              .sort((a, b) => distance(b) - distance(a) || a.x - b.x || a.z - b.z);
            const load = ordered.filter(chunk => eligible(chunk) && !chunk.active && distance(chunk) <= config.loadRadius)
              .sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
            selected = [...unload, ...load].slice(0, config.maxChangesPerTick);
          }
          // Preflight all planned operations before enqueuing structural changes.
          for (const { edit } of editPlan) {
            if (edit.kind === "add") {
              if (records.has(edit.entity.id)) return fail("OWNERSHIP", `Entity '${edit.entity.id}' already exists; choose a distinct chunk entity ID.`);
            } else {
              for (const record of records.values())
                if (record.parent === edit.id)
                  return fail("CHILD", `Entity '${record.id}' is attached to '${edit.id}'; remove the child before demolition.`);
            }
          }
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
          // Capture after all update systems, before any of the queued destroys commit.
          const parked = new Map<Chunk, WorldResidencyBundle>();
          for (const chunk of selected) {
            if (chunk.active) {
              const bundle = residency().capture(chunk.entities.map(item => item.id));
              residency().validate(bundle, chunk.entities);
              parked.set(chunk, bundle);
            }
            else if (chunk.parked) residency().validate(chunk.parked, chunk.entities);
          }
          for (const { edit } of editPlan) if (edit.kind === "remove") suspending.push(residency().capture([edit.id]));
          const consumed = new Map<Chunk, number>();
          for (const { chunk, edit } of editPlan) {
            if (edit.kind === "add") {
              context.world.queue({ type: "spawn", entity: edit.entity });
              chunk.entities.push(edit.entity);
              waiting.add(edit.entity.id);
            } else {
              const handle = handles.get(edit.id);
              if (handle) context.world.queue({ type: "destroy", entity: handle });
              handles.delete(edit.id);
              chunk.entities = chunk.entities.filter(item => item.id !== edit.id);
            }
            consumed.set(chunk, (consumed.get(chunk) ?? 0) + 1);
          }
          for (const [chunk, count] of consumed) {
            chunk.edits!.splice(0, count);
            if (!chunk.edits!.length) delete chunk.edits;
          }
          for (const chunk of selected) {
            if (chunk.active) {
              chunk.parked = parked.get(chunk)!;
              suspending.push(chunk.parked);
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
              resuming.push(chunk);
            }
          }
      });
    },
    afterFlush(phase) {
      if (phase !== "update") return;
      for (const bundle of suspending) residency().suspend(bundle);
      suspending.length = 0;
      sync(currentRecords());
      for (const chunk of resuming) {
        if (chunk.parked) residency().resume(chunk.parked);
        delete chunk.parked;
      }
      resuming.length = 0;
    },
    systems: [
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
      focusEntity = data.focusEntity ?? null; focusStatus = data.focusStatus ?? "manual";
      focusHandle = focusEntity && focusStatus !== "missing" ? context.world.resolve(focusEntity) : undefined;
      chunks = new Map(data.chunks.map(chunk => [key(chunk.x, chunk.z), chunk]));
      handles.clear(); waiting.clear(); suspending.length = 0; resuming.length = 0;
      for (const chunk of chunks.values()) if (chunk.active)
        for (const item of chunk.entities) handles.set(item.id, context.world.resolve(item.id));
    },
    dispose() { disposed = true; focusHandle = undefined; chunks.clear(); handles.clear(); waiting.clear(); },
  };
};
