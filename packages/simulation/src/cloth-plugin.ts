import type { ClothBodyCollider, ClothDefinition, ClothService, Vec2 } from "../../sdk/src/index.ts";
import type { RuntimePluginContext, RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createCloth, type ClothCollider, type ClothOptions, type ClothSnapshot, type ClothSolver, type Vec3 } from "./cloth.ts";

type Entry = { definition: ClothDefinition; solver: ClothSolver; uvs: Vec2[] };
type Saved = { definition: ClothDefinition; state: ClothSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_CLOTH_${code}: ${detail}`); };
const validId = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;

function planarUvs(points: readonly (readonly [number, number, number])[]): Vec2[] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
  const axes = [0, 1, 2].sort((a, b) => (max[b] - min[b]) - (max[a] - min[a]) || a - b), first = axes[0], second = axes[1];
  const width = max[first] - min[first], height = max[second] - min[second];
  if (!(width > 0) || !(height > 0)) return fail("VISUAL_UV", "Initial points need two nonzero projection axes or explicit UVs.");
  return points.map(point => [(point[first] - min[first]) / width, (point[second] - min[second]) / height]);
}
function createEntry(input: ClothDefinition, fixedDt: number, materials: ReadonlySet<string>, restoredSelfMode?: boolean, restoredSurfaceMode?: boolean): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty id of at most 128 characters.");
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be boolean.");
  if (definition.bodyReactions !== undefined && typeof definition.bodyReactions !== "boolean") return fail("BODY_REACTION", "bodyReactions must be boolean.");
  if (definition.bodyReactions && !definition.bodyColliders?.length) return fail("BODY_REACTION", "bodyReactions require bodyColliders.");
  if (definition.bodyColliders !== undefined) {
    if (!Array.isArray(definition.bodyColliders) || definition.bodyColliders.length > 64) return fail("BODY_COLLIDER", "bodyColliders must contain at most 64 bindings.");
    if (definition.bodyColliders.length && !definition.autoStep) return fail("BODY_COLLIDER", "bodyColliders require autoStep: true.");
    const ids = new Set<string>(), entities = new Set<string>();
    for (const binding of definition.bodyColliders) {
      if (!binding || !validId(binding.id) || !validId(binding.entity) || ids.has(binding.id) || entities.has(binding.entity)) return fail("BODY_COLLIDER", "Body bindings require unique nonempty ids and entities.");
      ids.add(binding.id); entities.add(binding.entity);
    }
  }
  if (definition.selfCollisions !== undefined && typeof definition.selfCollisions !== "boolean") return fail("SELF_COLLISION", "selfCollisions must be boolean.");
  if (definition.surfaceCollisions !== undefined && typeof definition.surfaceCollisions !== "boolean") return fail("SURFACE_COLLISION", "surfaceCollisions must be boolean.");
  if (restoredSurfaceMode !== undefined && definition.surfaceCollisions !== undefined && definition.surfaceCollisions !== restoredSurfaceMode)
    return fail("SNAPSHOT", "Surface collision configuration does not match the saved solver.");
  if (restoredSelfMode !== undefined && definition.selfCollisions !== undefined && definition.selfCollisions !== restoredSelfMode)
    return fail("SNAPSHOT", "Self collision configuration does not match the saved solver.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Cloth fixedDt must match the host fixedDt.");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) return fail("FIXED_DT", "Host fixedDt must be in [1/1000,1/30].");
  if (definition.visual !== undefined) {
    const visual = definition.visual;
    if (!visual || typeof visual !== "object" || Array.isArray(visual) || !validId(visual.material) || !materials.has(visual.material))
      return fail("VISUAL_MATERIAL", "visual.material must name a declared engine material.");
    if ((visual.castShadow !== undefined && typeof visual.castShadow !== "boolean") || (visual.receiveShadow !== undefined && typeof visual.receiveShadow !== "boolean"))
      return fail("VISUAL_SHADOW", "Shadow options must be boolean.");
    if (visual.uvs !== undefined && (!Array.isArray(visual.uvs) || !Array.isArray(definition.points) || visual.uvs.length !== definition.points.length ||
      visual.uvs.some(uv => !Array.isArray(uv) || uv.length !== 2 || !uv.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6))))
      return fail("VISUAL_UV", "UVs must contain one finite 2D coordinate per particle.");
  }
  const solver = createCloth({ ...definition, fixedDt, ...(restoredSelfMode === undefined ? {} : { selfCollisions: restoredSelfMode }), ...(restoredSurfaceMode === undefined ? {} : { surfaceCollisions: restoredSurfaceMode }) } as unknown as ClothOptions);
  try {
    const uvs: Vec2[] = definition.visual ? (definition.visual.uvs ? definition.visual.uvs.map(uv => [uv[0], uv[1]]) : planarUvs(definition.points)) : [];
    return { definition, solver, uvs };
  } catch (error) { solver.dispose(); throw error; }
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.solver.dispose(); entries.clear(); }
function validateBodyBindings(entries: Iterable<Entry>, context: RuntimePluginContext, world?: WorldSnapshot): void {
  const records = world ? new Map(world.entities.map(record => [record.id, record])) : undefined;
  const bridge = [...entries].some(entry => (entry.definition.bodyColliders?.length ?? 0) > 0)
    ? context.getRopePhysicsBridge?.() : undefined;
  for (const entry of entries) for (const binding of entry.definition.bodyColliders ?? []) {
    const record = records?.get(binding.entity);
    if (records && (!record || !resolveEntityDefinition(context.scene, record)?.rigidBody))
      fail("SNAPSHOT", `Bound body '${binding.entity}' is missing from the restored world.`);
    if (!context.world.isAlive(binding.entity)) fail("BODY_COLLIDER", `Body '${binding.entity}' is not a live entity.`);
    if (!bridge) fail("BODY_COLLIDER", "Body bindings require the physics plugin.");
    bridge!.sampleSphere(binding.entity);
  }
}
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { cloths?: unknown }).cloths) || (value as { cloths: unknown[] }).cloths.length > 256)
    return fail("SNAPSHOT", "Expected a version 1 snapshot containing at most 256 cloths.");
  const entries = new Map<string, Entry>();
  try {
    for (const item of (value as { cloths: Saved[] }).cloths) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid cloth entry.");
      const savedSelfMode = item.state?.config?.selfCollisions;
      if (savedSelfMode !== undefined && typeof savedSelfMode !== "boolean") fail("SNAPSHOT", "Invalid self collision configuration.");
      const savedSurfaceMode = item.state?.config?.surfaceCollisions;
      if (savedSurfaceMode !== undefined && typeof savedSurfaceMode !== "boolean") fail("SNAPSHOT", "Invalid surface collision configuration.");
      const entry = createEntry(item.definition, fixedDt, materials, savedSelfMode ?? false, savedSurfaceMode ?? false);
      if (entries.has(entry.definition.id)) { entry.solver.dispose(); fail("SNAPSHOT", "Duplicate cloth id."); }
      entries.set(entry.definition.id, entry); entry.solver.restore(item.state);
    }
    return entries;
  } catch (error) { disposeEntries(entries); throw error; }
}
export const createClothPlugin: RuntimePluginFactory = context => {
  const { fixedDt } = context;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const hostDt = fixedDt, materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Cloth service is disposed."); };
  const get = (id: string): Entry => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty cloth id."); return entries.get(id) ?? fail("MISSING", `Cloth '${id}' does not exist.`); };
  const service: ClothService = {
    create(definition) {
      alive(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty cloth id.");
      if (entries.has(definition.id)) return fail("DUPLICATE", `Cloth '${definition.id}' already exists.`);
      if (entries.size >= 256) return fail("CAPACITY", "At most 256 cloths per host.");
      const entry = createEntry(definition, hostDt, materials);
      try {
        validateBodyBindings([entry], context);
        entries.set(entry.definition.id, entry);
      } catch (error) { entry.solver.dispose(); throw error; }
    },
    step(id, ticks) { const entry = get(id); if (entry.definition.autoStep) return fail("AUTO_STEP", `Cloth '${id}' is automatically stepped.`); return entry.solver.step(ticks); },
    inspect(id) { return get(id).solver.inspect(); },
    visuals() {
      alive(); return [...entries.values()].filter(entry => entry.definition.visual !== undefined)
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => { const state = entry.solver.inspect(), visual = entry.definition.visual!; return { id: entry.definition.id, material: visual.material,
          positions: state.positions, triangles: state.triangles, uvs: entry.uvs.map(uv => [uv[0], uv[1]] as Vec2),
          castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true }; });
    },
    setColliders(id, colliders) { get(id).solver.setColliders(cloneSerializable(colliders) as ClothCollider[]); },
    setAnchor(id, index, position) { get(id).solver.setAnchor(index, cloneSerializable(position) as Vec3); },
    releaseAnchor(id, index) { get(id).solver.releaseAnchor(index); },
    applyForce(id, index, force) { get(id).solver.applyForce(index, cloneSerializable(force) as Vec3); },
    applyImpulse(id, index, impulse) { get(id).solver.applyImpulse(index, cloneSerializable(impulse) as Vec3); },
    destroy(id) { const entry = get(id); entry.solver.dispose(); entries.delete(id); },
  };
  return {
    id: "$engine.cloth", version: "1", services: { cloth: service },
    afterPhysics() {
      alive(); const committed: { entry: Entry; solver: ClothSolver; snapshot: ClothSnapshot; definition: ClothDefinition }[] = [];
      try {
        const automatic = [...entries.values()].filter(entry => entry.definition.autoStep)
          .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0);
        for (const entry of automatic) {
          const snapshot = entry.solver.snapshot(); committed.push({ entry, solver: entry.solver, snapshot, definition: cloneSerializable(entry.definition) });
          const bindings = entry.definition.bodyColliders ?? [];
          if (bindings.length) {
            const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_COLLIDER", "Body bindings require the physics plugin.");
            const manual = snapshot.colliders.filter(collider => !bindings.some(binding => binding.id === collider.id));
            const sampled: ClothCollider[] = [];
            const live: ClothBodyCollider[] = [];
            for (const binding of bindings) {
              if (!context.world.isAlive(binding.entity)) continue;
              const sphere = bridge.sampleSphere(binding.entity);
              sampled.push({ kind: "sphere", id: binding.id, center: [...sphere.center] as Vec3, radius: sphere.radius }); live.push(binding);
            }
            entry.definition = { ...entry.definition, bodyColliders: live };
            entry.solver.setColliders([...manual, ...sampled]);
          }
          const state = entry.solver.step();
          if (entry.definition.bodyReactions && entry.definition.bodyColliders?.length) {
            const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_REACTION", "bodyReactions require the physics plugin.");
            const byCollider = new Map((entry.definition.bodyColliders ?? []).map(binding => [binding.id, binding.entity]));
            const reactions = new Map<string, { impulse: Vec3; moment: Vec3 }>();
            for (const contact of [...state.contacts, ...state.surfaceContacts]) {
              const entity = byCollider.get(contact.colliderId);
              if (!entity || !contact.reactionImpulse || !contact.reactionAngularImpulse) continue;
              const current = reactions.get(entity) ?? { impulse: [0, 0, 0] as Vec3, moment: [0, 0, 0] as Vec3 };
              for (let k = 0; k < 3; k++) { current.impulse[k] += contact.reactionImpulse[k]; current.moment[k] += contact.reactionAngularImpulse[k]; }
              reactions.set(entity, current);
            }
            if (reactions.size) bridge.applySphereReactions([...reactions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([entity, value]) => ({ entity, ...value })));
          }
        }
      } catch (error) {
        const failures: string[] = [];
        for (const item of committed.reverse()) {
          item.entry.definition = item.definition;
          try { item.solver.restore(item.snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        }
        if (failures.length) throw new Error(`TC_CLOTH_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, cloths: [] }),
    snapshot: () => ({ version: 1, cloths: [...entries.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
      .map(({ definition, solver }) => ({ definition: cloneSerializable(definition), state: solver.snapshot() })) }),
    validateSnapshot(value) { const staged = parseSnapshot(value, hostDt, materials); disposeEntries(staged); },
    validateWorld(value, world) {
      const staged = parseSnapshot(value, hostDt, materials);
      try { validateBodyBindings(staged.values(), context, world); } finally { disposeEntries(staged); }
    },
    restore(value) {
      alive(); const staged = parseSnapshot(value, hostDt, materials);
      try { validateBodyBindings(staged.values(), context); } catch (error) { disposeEntries(staged); throw error; }
      disposeEntries(entries); entries = staged;
    },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
