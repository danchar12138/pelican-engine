import type { ClothBodyCollider, ClothDefinition, ClothService, EntityHandle, Vec2 } from "../../sdk/src/index.ts";
import type { RuntimePluginContext, RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createCloth, type ClothCollider, type ClothOptions, type ClothSnapshot, type ClothSolver, type Vec3 } from "./cloth.ts";
import { nearestIndexedParticle } from "./nearest-particle.ts";
import { stageClothDomain } from "./coupling-adapters.ts";
import { createCoupledSchedule } from "./coupled-schedule.ts";
import { validateSampledBodyPeers } from "./sampled-body-binding.ts";
import { createRopeBodyCoupling, virtualCollider, type VirtualRopeCollider } from "./rope-body-coupling.ts";

type Entry = { definition: ClothDefinition; solver: ClothSolver; uvs: Vec2[]; bodyRefs: Map<string, EntityHandle> };
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
    return { definition, solver, uvs, bodyRefs: new Map() };
  } catch (error) { solver.dispose(); throw error; }
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.solver.dispose(); entries.clear(); }
function validateBodyBindings(entries: Iterable<Entry>, context: RuntimePluginContext, world?: WorldSnapshot): void {
  const staged = [...entries];
  const records = world ? new Map(world.entities.map(record => [record.id, record])) : undefined;
  const bridge = staged.some(entry => (entry.definition.bodyColliders?.length ?? 0) > 0)
    ? context.getRopePhysicsBridge?.() : undefined;
  for (const entry of staged) for (const binding of entry.definition.bodyColliders ?? []) {
    const record = records?.get(binding.entity);
    if (records) {
      const body = record && resolveEntityDefinition(context.scene, record)?.rigidBody;
      if (!body || body.type !== "dynamic" || body.trigger || !["sphere", "box"].includes(body.collider.shape))
        fail("SNAPSHOT", `Bound body '${binding.entity}' must be a dynamic non-trigger sphere or box in the restored world.`);
    } else {
      if (!context.world.isAlive(binding.entity)) fail("BODY_COLLIDER", `Body '${binding.entity}' is not a live entity.`);
      if (!bridge) fail("BODY_COLLIDER", "Body bindings require the physics plugin.");
      bridge!.sampleClothBody(binding.entity);
      entry.bodyRefs.set(binding.id, context.world.resolve(binding.entity));
    }
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
  let entries = new Map<string, Entry>(), disposed = false, pendingRefs = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Cloth service is disposed."); };
  const ensureRefs = () => {
    if (!pendingRefs) return;
    validateBodyBindings(entries.values(), context);
    pendingRefs = false;
  };
  const get = (id: string): Entry => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty cloth id."); return entries.get(id) ?? fail("MISSING", `Cloth '${id}' does not exist.`); };
  const service: ClothService = {
    create(definition) {
      alive(); ensureRefs(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty cloth id.");
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
    nearestParticle(id, position, maxDistance) { return nearestIndexedParticle(get(id).solver.particlePositions(), position, maxDistance, "TC_CLOTH_INPUT"); },
    visuals() {
      alive(); return [...entries.values()].filter(entry => entry.definition.visual !== undefined)
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => { const state = entry.solver.inspect(), visual = entry.definition.visual!; return { id: entry.definition.id, material: visual.material,
          positions: state.positions, triangles: state.triangles, uvs: entry.uvs.map(uv => [uv[0], uv[1]] as Vec2),
          castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true }; });
    },
    setColliders(id, colliders) {
      const entry = get(id), values = cloneSerializable(colliders) as ClothCollider[];
      if (Array.isArray(values)) {
        const bound = new Set((entry.definition.bodyColliders ?? []).map(item => item.id));
        if (values.length + bound.size > 4096) return fail("BODY_COLLIDER", "Manual and bound colliders together may not exceed 4096.");
        if (values.some(collider => collider && bound.has(collider.id))) return fail("BODY_COLLIDER", "Manual collider ids must not conflict with body bindings.");
      }
      entry.solver.setColliders(values);
    },
    setAnchor(id, index, position) { get(id).solver.setAnchor(index, cloneSerializable(position) as Vec3); },
    setAnchors(id, anchors) { get(id).solver.setAnchors(anchors as readonly { index: number; position: Vec3 }[]); },
    releaseAnchor(id, index) { get(id).solver.releaseAnchor(index); },
    setGravity(id, gravity) { const entry = get(id); entry.definition.gravity = entry.solver.setGravity(gravity as Vec3); },
    applyForce(id, index, force) { get(id).solver.applyForce(index, cloneSerializable(force) as Vec3); },
    applyImpulse(id, index, impulse) { get(id).solver.applyImpulse(index, cloneSerializable(impulse) as Vec3); },
    applyImpulses(id, impulses) { get(id).solver.applyImpulses(impulses as readonly { index: number; impulse: Vec3 }[]); },
    destroy(id) { const entry = get(id); entry.solver.dispose(); entries.delete(id); },
  };
  const schedule = createCoupledSchedule(() => entries.values(), 4,
    entry => ({ solver: entry.solver.snapshot(), definition: entry.definition, refs: entry.bodyRefs }),
    (entry, state) => { entry.definition = state.definition; entry.bodyRefs = state.refs; entry.solver.restore(state.solver); },
    (entry, count, sample) => entry.solver.coupledTick(count, sample));
  return {
    id: "$engine.cloth", version: "1", services: { cloth: service }, simulation: schedule,
    requiresRecovery: () => schedule.faulted,
    afterPhysics() {
      alive(); ensureRefs(); const committed: { entry: Entry; solver: ClothSolver; snapshot: ClothSnapshot; definition: ClothDefinition; refs: Map<string, EntityHandle> }[] = [];
      // Stage all cloth reactions until every automatic solver has completed. A later
      // cloth error must not leave earlier native impulses committed during rollback.
      const frame = context.couplingFrame?.active ? context.couplingFrame : undefined;
      const bodies = frame?.bodies ?? new Map<string, VirtualRopeCollider>();
      try {
        const automatic = [...entries.values()].filter(entry => entry.definition.autoStep)
          .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0);
        for (const entry of automatic) {
          const snapshot = entry.solver.snapshot(); committed.push({ entry, solver: entry.solver, snapshot, definition: cloneSerializable(entry.definition), refs: entry.bodyRefs });
          const bindings = entry.definition.bodyColliders ?? [];
          const coupled = new Map<string, VirtualRopeCollider>();
          if (bindings.length) {
            const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_COLLIDER", "Body bindings require the physics plugin.");
            const manual = snapshot.colliders.filter(collider => !bindings.some(binding => binding.id === collider.id));
            const sampled: ClothCollider[] = [];
            const live: ClothBodyCollider[] = [];
            for (const binding of bindings) {
              const ref = entry.bodyRefs.get(binding.id);
              if (!ref) return fail("BODY_COLLIDER", `Missing handle for '${binding.id}'; restore a known-good checkpoint.`);
              if (!context.world.isAlive(ref)) continue;
              const sample = bridge.sampleClothBody(binding.entity);
              const reactive = entry.definition.bodyReactions ?? false;
              let body = reactive ? bodies.get(binding.entity) : undefined;
              if (!body) { body = virtualCollider(sample, reactive); if (reactive) bodies.set(binding.entity, body); }
              coupled.set(binding.id, body);
              const active = body;
              if (active.kind === "sphere") sampled.push({ kind: "sphere", id: binding.id, center: [...active.center] as Vec3, radius: active.radius });
              else sampled.push({ kind: "box", id: binding.id, center: [...active.center] as Vec3,
                halfExtents: [...active.halfExtents] as Vec3, rotation: [...active.rotation] as Vec3 });
              live.push(binding);
            }
            entry.definition = { ...entry.definition, bodyColliders: live, ...(live.length === 0 ? { bodyReactions: false } : {}) };
            entry.bodyRefs = new Map(live.map(binding => [binding.id, entry.bodyRefs.get(binding.id)!]));
            entry.solver.setColliders([...manual, ...sampled]);
          }
          const coupling = coupled.size ? createRopeBodyCoupling(coupled, new Map(), entry.definition.bodyReactions ?? false) : undefined;
          const view = schedule.next(entry.definition.id, coupling);
          if (!view) entry.solver.step(1, coupling);
          stageClothDomain(frame, entry.definition.id, entry.solver, snapshot, coupling, view);
        }
        const batch = [...bodies].map(([entity, body]) => ({ entity, ...body.reaction() }))
          .filter(item => item.impulse.some(value => value !== 0) || item.moment.some(value => value !== 0))
          .sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0);
        if (batch.length && !frame) {
          const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_REACTION", "bodyReactions require the physics plugin.");
          bridge.applyClothReactions(batch);
        }
        frame?.rollbackWith(() => {
          const failures: unknown[] = [];
          for (const item of [...committed].reverse()) {
            item.entry.definition = item.definition; item.entry.bodyRefs = item.refs;
            try { item.solver.restore(item.snapshot); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, "TC_CLOTH_COUPLING_ROLLBACK: Restore a known-good checkpoint.");
        });
      } catch (error) {
        const failures: string[] = [];
        for (const item of committed.reverse()) {
          item.entry.definition = item.definition;
          item.entry.bodyRefs = item.refs;
          try { item.solver.restore(item.snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        }
        if (failures.length) throw new Error(`TC_CLOTH_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, cloths: [] }),
    snapshot: () => { alive(); ensureRefs(); for (const entry of entries.values()) for (const binding of entry.definition.bodyColliders ?? []) {
      const ref = entry.bodyRefs.get(binding.id);
      if (!ref || !context.world.isAlive(ref)) fail("BODY_COLLIDER", `Bound body '${binding.entity}' is stale; advance the scene or remove the cloth before saving.`);
    } return { version: 1, cloths: [...entries.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
      .map(({ definition, solver }) => ({ definition: cloneSerializable(definition), state: solver.snapshot() })) }; },
    validateSnapshot(value) { const staged = parseSnapshot(value, hostDt, materials); disposeEntries(staged); },
    validateWorld(value, world) {
      const staged = parseSnapshot(value, hostDt, materials);
      try { validateBodyBindings(staged.values(), context, world); } finally { disposeEntries(staged); }
    },
    validatePeers(value, peers) {
      const staged = parseSnapshot(value, hostDt, materials);
      try { validateSampledBodyPeers(peers, [...staged.values()].flatMap(entry => entry.definition.bodyColliders ?? []), "TC_CLOTH_SNAPSHOT"); }
      finally { disposeEntries(staged); }
    },
    restore(value) {
      alive(); const staged = parseSnapshot(value, hostDt, materials);
      schedule.reset();
      disposeEntries(entries); entries = staged; pendingRefs = true;
    },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
