import type { EntityHandle, LightOverride, LightPatch } from "../../sdk/src/index.ts";
import type { EntityRecord, WorldSnapshot } from "../../runtime/src/contracts.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type SavedLight = { entity: string; prefab: string | null; patch: LightPatch };
type Snapshot = { format: "pelican.lights"; version: 1; lights: SavedLight[] };
const fail = (message: string): never => { throw new Error(`TC_LIGHT_RUNTIME: ${message}`); };
const fields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
function vector(value: unknown, color: boolean): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(v => typeof v === "number" && Number.isFinite(v) && Number.isFinite(Math.fround(v)) && (!color || (v >= 0 && v <= 1)));
}
function patchValue(value: unknown): asserts value is LightPatch {
  if (!fields(value, ["intensity", "color", "target", "visible"]) || !Object.keys(value).length ||
      (Object.hasOwn(value, "intensity") && (typeof value.intensity !== "number" || !Number.isFinite(value.intensity) || value.intensity < 0 || !Number.isFinite(Math.fround(value.intensity)))) ||
      (Object.hasOwn(value, "color") && !vector(value.color, true)) ||
      (Object.hasOwn(value, "target") && !vector(value.target, false)) ||
      (Object.hasOwn(value, "visible") && typeof value.visible !== "boolean"))
    fail("Patch requires finite nonnegative intensity, linear RGB in [0,1], finite target and/or boolean visibility.");
}

export const createLightPlugin: RuntimePluginFactory = context => {
  let entries = new Map<string, SavedLight>(), handles = new Map<string, EntityHandle>(), disposed = false;
  const alive = () => { if (disposed) fail("Service is disposed; create a new runtime."); };
  const prune = () => { for (const [id, handle] of handles) if (!context.world.isAlive(handle)) { entries.delete(id); handles.delete(id); } };
  const definition = (record: Pick<EntityRecord, "id" | "prefab">) => {
    const light = resolveEntityDefinition(context.scene, record)?.light;
    if (!light) return fail(`Entity '${record.id}' has no declared light; use a live light entity or prefab.`);
    return light;
  };
  const current = (id: string) => {
    if (!validId(id) || !context.world.isAlive(id)) return fail(`Entity '${String(id)}' is not live.`);
    const identity = context.world.identity(id), light = definition(identity);
    return { identity, light };
  };
  const validateRecord = (entry: SavedLight, record: Pick<EntityRecord, "id" | "prefab">) => {
    if (entry.prefab !== (record.prefab ?? null)) fail(`Entity '${entry.entity}' prefab differs from its saved light.`);
    const light = definition(record);
    if (entry.patch.target !== undefined && light.kind === "point") fail(`Point light '${entry.entity}' has no target.`);
  };
  const parse = (value: unknown): SavedLight[] => {
    const data = cloneSerializable(value) as Snapshot;
    if (!fields(data, ["format", "version", "lights"]) || data.format !== "pelican.lights" || data.version !== 1 || !Array.isArray(data.lights) || data.lights.length > 1024)
      return fail("Invalid light snapshot.");
    const ids = new Set<string>();
    for (const entry of data.lights) {
      if (!fields(entry, ["entity", "prefab", "patch"]) || !validId(entry.entity) || !(entry.prefab === null || validId(entry.prefab)) || ids.has(entry.entity))
        return fail("Invalid or duplicate light override.");
      patchValue(entry.patch);
      ids.add(entry.entity);
    }
    return data.lights;
  };
  const validateWorld = (items: readonly SavedLight[], world: WorldSnapshot) => {
    const records = new Map(world.entities.map(record => [record.id, record]));
    for (const item of items) {
      const record = records.get(item.entity);
      if (!record) return fail(`Saved light entity '${item.entity}' is missing.`);
      validateRecord(item, record);
    }
  };
  return {
    id: "$engine.lights", version: "1",
    services: { lights: {
      set(entity, input) {
        alive(); prune();
        const { identity, light } = current(entity), patch = cloneSerializable(input);
        patchValue(patch);
        if (patch.target !== undefined && light.kind === "point") return fail(`Point light '${entity}' has no target.`);
        if (!entries.has(entity) && entries.size >= 1024) return fail("At most 1024 light overrides are supported.");
        const previous = entries.get(entity);
        entries.set(entity, { entity, prefab: identity.prefab ?? null, patch: { ...previous?.patch, ...patch } });
        handles.set(entity, context.world.resolve(entity));
      },
      reset(entity) { alive(); prune(); current(entity); entries.delete(entity); handles.delete(entity); },
      visuals(): readonly LightOverride[] {
        alive(); prune();
        return cloneSerializable([...entries.values()].sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0)
          .map(entry => ({ entity: entry.entity, ...entry.patch })));
      },
    } },
    snapshot() { alive(); prune(); return cloneSerializable({ format: "pelican.lights", version: 1, lights: [...entries.values()].sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0) }); },
    legacySnapshot: () => ({ format: "pelican.lights", version: 1, lights: [] }),
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { validateWorld(parse(value), world); },
    restore(value) {
      alive();
      const items = parse(value), nextHandles = new Map<string, EntityHandle>();
      for (const item of items) { const { identity } = current(item.entity); validateRecord(item, identity); nextHandles.set(item.entity, context.world.resolve(item.entity)); }
      entries = new Map(items.map(item => [item.entity, item])); handles = nextHandles;
    },
    dispose() { disposed = true; entries.clear(); handles.clear(); },
  };
};
