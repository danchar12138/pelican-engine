import type { EntityHandle, RopeBodyCollider, RopeDefinition, RopeService } from "../../sdk/src/index.ts";
import type { RuntimePluginContext, RuntimePluginFactory, RopePhysicsBridge } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createRope, type RopeOptions, type RopeSnapshot, type RopeSolver, type RopeCollider, type Vec3 } from "./rope.ts";
import { createRopeBodyCoupling, VirtualRopeSphere } from "./rope-body-coupling.ts";
import { nearestIndexedParticle } from "./nearest-particle.ts";

type Entry = { definition: RopeDefinition; solver: RopeSolver; bodyRefs: Map<string, EntityHandle>; staleBodies: Set<string> };
type Saved = { definition: RopeDefinition; state: RopeSnapshot; staleBodyColliders?: string[] };
const fail = (code: string, detail: string): never => { throw new Error(`TC_ROPE_${code}: ${detail}`); };
const validId = (id: unknown): id is string => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 128;

function createEntry(input: RopeDefinition, fixedDt: number, materials: ReadonlySet<string>, restoredSegmentMode?: boolean, restoredSelfMode?: boolean): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty id of at most 128 characters.");
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be a boolean.");
  if (definition.segmentCollisions !== undefined && typeof definition.segmentCollisions !== "boolean") return fail("SEGMENT_COLLISION", "segmentCollisions must be a boolean.");
  if (definition.selfCollisions !== undefined && typeof definition.selfCollisions !== "boolean") return fail("SELF_COLLISION", "selfCollisions must be a boolean.");
  if (restoredSelfMode !== undefined && definition.selfCollisions !== undefined && definition.selfCollisions !== restoredSelfMode)
    return fail("SNAPSHOT", "Self collision configuration does not match the saved solver.");
  if (restoredSegmentMode !== undefined && definition.segmentCollisions !== undefined && definition.segmentCollisions !== restoredSegmentMode)
    return fail("SNAPSHOT", "Segment collision configuration does not match the saved solver.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Rope fixedDt must exactly match the host fixedDt.");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) return fail("FIXED_DT", "Host fixedDt must be within [1/1000, 1/30] seconds for ropes.");
  if (definition.visual !== undefined) {
    const visual = definition.visual;
    if (!visual || typeof visual !== "object" || Array.isArray(visual) || !validId(visual.material) || !materials.has(visual.material))
      return fail("VISUAL_MATERIAL", "visual.material must name a declared engine material.");
    const radius = visual.radius ?? definition.radius ?? 0.025;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0 || radius > 1e6 || Math.fround(radius) === 0)
      return fail("VISUAL_RADIUS", "visual radius must be positive, finite, representable and at most 1e6.");
    const sides = visual.radialSegments ?? 8;
    if (!Number.isSafeInteger(sides) || sides < 3 || sides > 32)
      return fail("VISUAL_SEGMENTS", "radialSegments must be an integer in [3,32].");
    if ((visual.castShadow !== undefined && typeof visual.castShadow !== "boolean") || (visual.receiveShadow !== undefined && typeof visual.receiveShadow !== "boolean"))
      return fail("VISUAL_SHADOW", "Visual shadow options must be boolean.");
  }
  if (definition.bodyColliders !== undefined) {
    if (!Array.isArray(definition.bodyColliders) || definition.bodyColliders.length > 64)
      return fail("BODY_COLLIDER", "bodyColliders must contain at most 64 bindings.");
    if (definition.bodyColliders.length && !definition.autoStep)
      return fail("BODY_COLLIDER", "Body bindings require autoStep: true.");
    const ids = new Set<string>(), entities = new Set<string>();
    for (const binding of definition.bodyColliders) {
      if (!binding || typeof binding !== "object" || !validId(binding.id) || !validId(binding.entity) || ids.has(binding.id) || entities.has(binding.entity))
        return fail("BODY_COLLIDER", "Each binding requires a unique nonempty collider id and body entity.");
      ids.add(binding.id); entities.add(binding.entity);
    }
  }
  const solver = createRope({ ...definition, fixedDt, ...(restoredSegmentMode === undefined ? {} : { segmentCollisions: restoredSegmentMode }),
    ...(restoredSelfMode === undefined ? {} : { selfCollisions: restoredSelfMode }) } as unknown as RopeOptions);
  return { definition, solver, bodyRefs: new Map(), staleBodies: new Set() };
}
function disposeEntries(entries: Map<string, Entry>): void {
  for (const { solver } of entries.values()) solver.dispose();
  entries.clear();
}
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { ropes?: unknown }).ropes) || (value as { ropes: unknown[] }).ropes.length > 256)
    return fail("SNAPSHOT", "Expected a version 1 rope snapshot with at most 256 ropes.");
  const entries = new Map<string, Entry>();
  try {
    for (const item of (value as { ropes: Saved[] }).ropes) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid rope entry.");
      const savedSegmentMode = item.state?.config?.segmentCollisions;
      if (savedSegmentMode !== undefined && typeof savedSegmentMode !== "boolean") fail("SNAPSHOT", "Invalid segment collision configuration.");
      const savedSelfMode = item.state?.config?.selfCollisions;
      if (savedSelfMode !== undefined && typeof savedSelfMode !== "boolean") fail("SNAPSHOT", "Invalid self collision configuration.");
      // Missing flags in historical snapshots preserve their original disabled modes.
      const entry = createEntry(item.definition, fixedDt, materials, savedSegmentMode ?? false, savedSelfMode ?? false);
      if (entries.has(entry.definition.id)) { entry.solver.dispose(); fail("SNAPSHOT", "Duplicate rope id."); }
      entries.set(entry.definition.id, entry);
      const stale = item.staleBodyColliders === undefined ? [] : item.staleBodyColliders;
      const bound = new Set((entry.definition.bodyColliders ?? []).map(binding => binding.id));
      if (!Array.isArray(stale) || stale.some(id => typeof id !== "string" || !bound.has(id)) || new Set(stale).size !== stale.length)
        fail("SNAPSHOT", "Invalid stale body collider list.");
      entry.staleBodies = new Set(stale);
      entry.solver.restore(item.state);
    }
    return entries;
  } catch (error) { disposeEntries(entries); throw error; }
}
function bridgeFor(context: RuntimePluginContext): RopePhysicsBridge {
  return context.getRopePhysicsBridge?.() ?? fail("BODY_COLLIDER", "Body colliders require the physics plugin and a live dynamic sphere.");
}
function resolveRefs(entry: Entry, context: RuntimePluginContext, checkPhysics: boolean): Map<string, EntityHandle> {
  const refs = new Map<string, EntityHandle>();
  const specs = entry.definition.bodyColliders ?? [];
  const bridge = checkPhysics && specs.length ? bridgeFor(context) : undefined;
  for (const spec of specs) {
    if (entry.staleBodies.has(spec.id)) continue;
    if (!context.world.isAlive(spec.entity)) fail("BODY_COLLIDER", `Body '${spec.entity}' is not a live entity.`);
    if (bridge) bridge.sampleSphere(spec.entity);
    refs.set(spec.id, context.world.resolve(spec.entity));
  }
  return refs;
}
function validateWorldBindings(entries: Map<string, Entry>, context: RuntimePluginContext, world: WorldSnapshot): void {
  const records = new Map(world.entities.map(record => [record.id, record]));
  for (const entry of entries.values()) for (const binding of entry.definition.bodyColliders ?? []) {
    if (entry.staleBodies.has(binding.id)) continue;
    const record = records.get(binding.entity);
    const definition = record && resolveEntityDefinition(context.scene, record);
    const body = definition?.rigidBody;
    if (!record || !body || body.type !== "dynamic" || body.collider.shape !== "sphere" || body.trigger)
      fail("SNAPSHOT", `Bound body '${binding.entity}' must exist as a dynamic, non-trigger sphere in the restored world.`);
  }
}

/** Split-step sphere contact uses virtual mass/velocity state; native commit is deferred. */
export const createRopePlugin: RuntimePluginFactory = (context) => {
  const { fixedDt } = context;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const hostDt = fixedDt;
  const materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>();
  let disposed = false, pendingRefs = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Rope service is disposed."); };
  // Host replay restores plugin data before it replaces the World. Resolve handles
  // lazily at the first use, after that World replacement has completed.
  const ensureRefs = () => {
    if (!pendingRefs) return;
    const staged = [...entries.values()].map(entry => ({ entry, refs: resolveRefs(entry, context, false) }));
    for (const { entry, refs } of staged) entry.bodyRefs = refs;
    pendingRefs = false;
  };
  const get = (id: string): Entry => {
    alive(); ensureRefs();
    if (!validId(id)) return fail("ID", "Expected a nonempty rope id.");
    return entries.get(id) ?? fail("MISSING", `Rope '${id}' does not exist.`);
  };
  const service: RopeService = {
    create(definition) {
      alive(); ensureRefs();
      if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty rope id.");
      if (entries.has(definition.id)) return fail("DUPLICATE", `Rope '${definition.id}' already exists.`);
      if (entries.size >= 256) return fail("CAPACITY", "At most 256 ropes per host.");
      const entry = createEntry(definition, hostDt, materials);
      try { entry.bodyRefs = resolveRefs(entry, context, true); entries.set(entry.definition.id, entry); }
      catch (error) { entry.solver.dispose(); throw error; }
    },
    step(id, ticks) {
      const entry = get(id);
      if (entry.definition.autoStep) return fail("AUTO_STEP", `Rope '${id}' is automatically stepped; omit autoStep for manual stepping.`);
      return entry.solver.step(ticks);
    },
    inspect(id) { return get(id).solver.inspect(); },
    nearestParticle(id, position, maxDistance) { return nearestIndexedParticle(get(id).solver.particlePositions(), position, maxDistance, "TC_ROPE_INPUT"); },
    visuals() {
      alive(); ensureRefs();
      return [...entries.values()].filter(entry => entry.definition.visual !== undefined)
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => {
          const visual = entry.definition.visual!;
          return { id: entry.definition.id, material: visual.material, radius: visual.radius ?? entry.definition.radius ?? 0.025,
            radialSegments: visual.radialSegments ?? 8, castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true,
            positions: entry.solver.particlePositions() };
        });
    },
    setColliders(id, colliders) {
      const entry = get(id);
      if (Array.isArray(colliders)) {
        const bound = new Set((entry.definition.bodyColliders ?? []).map(item => item.id));
        if (colliders.length + bound.size > 4096)
          return fail("BODY_COLLIDER", "Manual and bound colliders together may not exceed 4096.");
        if (colliders.some(collider => collider && bound.has(collider.id)))
          return fail("BODY_COLLIDER", "Manual collider ids must not conflict with body bindings.");
      }
      entry.solver.setColliders(cloneSerializable(colliders) as RopeCollider[]);
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
  return {
    id: "$engine.ropes", version: "1", services: { ropes: service },
    afterPhysics() {
      alive(); ensureRefs();
      const committed: { entry: Entry; snapshot: RopeSnapshot; definition: RopeDefinition; refs: Map<string, EntityHandle>; stale: Set<string> }[] = [];
      const bodies = new Map<string, VirtualRopeSphere>();
      try {
        const automatic = [...entries.values()].filter(entry => entry.definition.autoStep)
          .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0);
        for (const entry of automatic) {
          const snapshot = entry.solver.snapshot();
          committed.push({ entry, snapshot, definition: entry.definition, refs: entry.bodyRefs, stale: entry.staleBodies });
          const previous = entry.definition.bodyColliders ?? [];
          const live: RopeBodyCollider[] = [];
          for (const binding of previous) {
            const ref = entry.bodyRefs.get(binding.id);
            if (!ref && !entry.staleBodies.has(binding.id)) fail("BODY_COLLIDER", `Missing live handle for '${binding.id}'; restore a known-good checkpoint.`);
            if (ref && context.world.isAlive(ref)) live.push(binding);
          }
          if (live.length !== previous.length) {
            entry.definition = { ...entry.definition, bodyColliders: live };
            entry.bodyRefs = new Map(live.map(binding => [binding.id, entry.bodyRefs.get(binding.id)!]));
            entry.staleBodies = new Set();
          }
          const coupled = new Map<string, VirtualRopeSphere>();
          if (previous.length) {
            const boundIds = new Set(previous.map(item => item.id));
            const manual = snapshot.colliders.filter(collider => !boundIds.has(collider.id));
            const bridge = live.length ? bridgeFor(context) : undefined;
            const sampled: RopeCollider[] = live.map(binding => {
              let body = bodies.get(binding.entity);
              if (!body) {
                body = new VirtualRopeSphere(bridge!.sampleSphere(binding.entity));
                bodies.set(binding.entity, body);
              }
              coupled.set(binding.id, body);
              return { kind: "sphere", id: binding.id, center: [...body.center] as Vec3, radius: body.radius };
            });
            entry.solver.setColliders([...manual, ...sampled]);
          }
          entry.solver.step(1, coupled.size ? createRopeBodyCoupling(coupled) : undefined);
        }
        const batch = [...bodies].map(([entity, body]) => ({ entity, ...body.reaction() }))
          .filter(item => item.impulse.some(value => value !== 0) || item.moment.some(value => value !== 0))
          .sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0);
        if (batch.length) bridgeFor(context).applySphereReactions(batch);
      } catch (error) {
        const failures: string[] = [];
        for (const item of committed.reverse()) {
          item.entry.definition = item.definition; item.entry.bodyRefs = item.refs; item.entry.staleBodies = item.stale;
          try { item.entry.solver.restore(item.snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        }
        if (failures.length) throw new Error(`TC_ROPE_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, ropes: [] }),
    snapshot: () => { alive(); ensureRefs(); return { version: 1, ropes: [...entries.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0).map(entry => {
      const stale = (entry.definition.bodyColliders ?? []).filter(binding => {
        const ref = entry.bodyRefs.get(binding.id);
        if (!ref && !entry.staleBodies.has(binding.id)) return fail("SNAPSHOT", `Missing handle for '${binding.id}'.`);
        return !ref || !context.world.isAlive(ref);
      }).map(binding => binding.id);
      return { definition: cloneSerializable(entry.definition), state: entry.solver.snapshot(), ...(stale.length ? { staleBodyColliders: stale } : {}) };
    }) }; },
    validateSnapshot(value) { const staged = parseSnapshot(value, hostDt, materials); disposeEntries(staged); },
    validateWorld(value, world) {
      const staged = parseSnapshot(value, hostDt, materials);
      try { validateWorldBindings(staged, context, world); } finally { disposeEntries(staged); }
    },
    validatePeers(value, peers) {
      const staged = parseSnapshot(value, hostDt, materials);
      try {
        const bindings = [...staged.values()].flatMap(entry => (entry.definition.bodyColliders ?? []).filter(binding => !entry.staleBodies.has(binding.id)));
        if (!bindings.length) return;
        const physics = peers["$engine.physics"]?.payload as { bindings?: unknown; entities?: unknown } | undefined;
        if (!physics || !Array.isArray(physics.bindings) || !Array.isArray(physics.entities))
          return fail("SNAPSHOT", "Body-bound ropes require a matching physics snapshot.");
        const bodyStates: unknown[] = physics.entities, bodyIds: unknown[] = physics.bindings;
        for (const binding of bindings) {
          const found = bodyStates.find(item => item && typeof item === "object" && (item as { id?: unknown }).id === binding.entity && (item as { type?: unknown }).type === "dynamic");
          if (!found || !bodyIds.includes(binding.entity)) fail("SNAPSHOT", `Bound body '${binding.entity}' is missing from physics state.`);
        }
      } finally { disposeEntries(staged); }
    },
    restore(value) {
      alive(); const staged = parseSnapshot(value, hostDt, materials);
      disposeEntries(entries); entries = staged; pendingRefs = true;
    },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
