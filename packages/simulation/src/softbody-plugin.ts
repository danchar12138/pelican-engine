import type { SoftBodyBodyCollider, SoftBodyDefinition, SoftBodyService, SoftBodyState, SoftBodyVisualState, Vec2, Vec3 } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import type { EntityHandle } from "../../sdk/src/index.ts";
import { requireSampledBody, resolveSampledBody, validateSampledBodyPeers, validateSampledBodyWorld } from "./sampled-body-binding.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createSimulation, type Simulation, type SimulationSnapshot } from "../../../experiments/simulation/index.ts";

type Entry = { definition: SoftBodyDefinition; simulation: Simulation; uvs: Vec2[]; bodyRef?: EntityHandle };
type Saved = { definition: SoftBodyDefinition; state: SimulationSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_SOFTBODY_${code}: ${detail}`); };
const validId = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;
const planarUvs = (positions: readonly Vec3[]): Vec2[] => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of positions) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
  const axes = [0, 1, 2].sort((a, b) => max[b] - min[b] - max[a] + min[a]), a = axes[0], b = axes[1];
  const width = Math.max(max[a] - min[a], 1e-6), height = Math.max(max[b] - min[b], 1e-6);
  return positions.map(point => [(point[a] - min[a]) / width, (point[b] - min[b]) / height]);
};
function createEntry(input: SoftBodyDefinition, fixedDt: number, materials: ReadonlySet<string>): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty soft-body id.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Soft-body fixedDt must match the host fixedDt.");
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be boolean.");
  if (definition.bodyReactions !== undefined && typeof definition.bodyReactions !== "boolean") return fail("BODY_REACTION", "bodyReactions must be boolean.");
  if (definition.bodyReactions && !definition.bodyColliders?.length) return fail("BODY_REACTION", "bodyReactions require bodyColliders.");
  if (definition.bodyColliders !== undefined) {
    if (!Array.isArray(definition.bodyColliders) || definition.bodyColliders.length > 1) return fail("BODY_COLLIDER", "Soft bodies support at most one body collider.");
    if (definition.bodyColliders.length && !definition.autoStep) return fail("BODY_COLLIDER", "bodyColliders require autoStep: true.");
    const binding = definition.bodyColliders[0];
    if (binding && (!validId(binding.id) || !validId(binding.entity))) return fail("BODY_COLLIDER", "Body binding requires nonempty ids.");
  }
  if (definition.visual && (!validId(definition.visual.material) || !materials.has(definition.visual.material))) return fail("VISUAL_MATERIAL", "visual.material must name a declared material.");
  const { id: _id, autoStep: _autoStep, visual: _visual, bodyColliders: _bodyColliders, bodyReactions: _bodyReactions, ...options } = definition;
  const simulationOptions = {
    ...options,
    fixedDt,
    ...(definition.bodyColliders?.length ? { twoWayCoupling: definition.bodyReactions ?? false } : {}),
    gravity: definition.gravity ? [...definition.gravity] as [number, number, number] : undefined,
    bodyPosition: definition.bodyPosition ? [...definition.bodyPosition] as [number, number, number] : undefined,
    bodyVelocity: definition.bodyVelocity ? [...definition.bodyVelocity] as [number, number, number] : undefined,
  };
  const simulation = createSimulation("softbody", simulationOptions);
  try {
    const uvs = planarUvs(simulation.getRenderState().particles.map(particle => particle.position));
    return { definition, simulation, uvs };
  } catch (error) { simulation.dispose(); throw error; }
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.simulation.dispose(); entries.clear(); }
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { softBodies?: unknown }).softBodies) || (value as { softBodies: unknown[] }).softBodies.length > 128) return fail("SNAPSHOT", "Expected a version 1 snapshot containing at most 128 soft bodies.");
  const result = new Map<string, Entry>();
  try {
    for (const item of (value as { softBodies: Saved[] }).softBodies) {
      if (!item || typeof item !== "object") return fail("SNAPSHOT", "Invalid soft-body entry.");
      const entry = createEntry(item.definition, fixedDt, materials);
      if (result.has(entry.definition.id)) { entry.simulation.dispose(); return fail("SNAPSHOT", `Duplicate soft-body id '${entry.definition.id}'.`); }
      result.set(entry.definition.id, entry);
      entry.simulation.restore(item.state);
    }
    return result;
  }
  catch (error) { disposeEntries(result); throw error; }
}
function inspect(entry: Entry): SoftBodyState {
  const state = entry.simulation.inspect(), render = entry.simulation.getRenderState();
  return { tick: state.tick, simulatedSeconds: state.simulatedSeconds, disposed: state.disposed, positions: render.particles.map(item => item.position), triangles: render.triangles, contacts: state.contacts, maxDistanceError: state.maxDistanceRelativeError, maxVolumeRelativeError: state.maxVolumeRelativeError, minSignedVolumeRatio: state.minSignedVolumeRatio, resources: state.resources };
}
export const createSoftBodyPlugin: RuntimePluginFactory = context => {
  const fixedDt = context.fixedDt;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>(), disposed = false, pendingRefs = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Soft-body service is disposed."); };
  const ensureRefs = () => { if (!pendingRefs) return; const refs = [...entries.values()].map(entry => ({ entry, binding: entry.definition.bodyColliders?.[0] })).map(({ entry, binding }) => ({ entry, ref: binding ? resolveSampledBody(context, binding, "TC_SOFTBODY_SNAPSHOT") : undefined })); for (const item of refs) item.entry.bodyRef = item.ref; pendingRefs = false; };
  const get = (id: string) => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty soft-body id."); return entries.get(id) ?? fail("MISSING", `Soft body '${id}' does not exist.`); };
  const syncBinding = (entry: Entry) => {
    const binding = entry.definition.bodyColliders?.[0];
    if (!binding) return;
    const sample = requireSampledBody(context, binding, entry.bodyRef, "TC_SOFTBODY_BODY_COLLIDER");
    entry.simulation.setBodyState("body:0", [...sample.center] as [number, number, number], [...sample.linearVelocity] as [number, number, number], sample.radius);
    entry.simulation.setTwoWayCoupling(entry.definition.bodyReactions ?? false);
  };
  const service: SoftBodyService = {
    create(definition) { alive(); ensureRefs(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty soft-body id."); if (entries.has(definition.id)) return fail("DUPLICATE", `Soft body '${definition.id}' already exists.`); if (entries.size >= 128) return fail("CAPACITY", "At most 128 soft bodies per host."); const entry = createEntry(definition, fixedDt, materials); try { const binding = entry.definition.bodyColliders?.[0]; if (binding) entry.bodyRef = resolveSampledBody(context, binding, "TC_SOFTBODY_BODY_COLLIDER"); syncBinding(entry); entries.set(entry.definition.id, entry); } catch (error) { entry.simulation.dispose(); throw error; } },
    step(id, ticks) { const entry = get(id); if (entry.definition.autoStep) return fail("AUTO_STEP", `Soft body '${id}' is automatically stepped.`); const before = entry.simulation.snapshot(); try { entry.simulation.step(ticks); return inspect(entry); } catch (error) { try { entry.simulation.restore(before); } catch (rollbackError) { throw new Error(`TC_SOFTBODY_ROLLBACK: ${String(error)}; partialState=true; rollback failure: ${String(rollbackError)}`); } throw error; } },
    inspect(id) { return inspect(get(id)); },
    visuals() { alive(); return [...entries.values()].filter(entry => entry.definition.visual).sort((a, b) => a.definition.id.localeCompare(b.definition.id)).map(entry => { const state = inspect(entry), visual = entry.definition.visual!; return { id: entry.definition.id, material: visual.material, positions: state.positions, triangles: state.triangles, uvs: entry.uvs.map(uv => [uv[0], uv[1]] as Vec2), castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true } satisfies SoftBodyVisualState; }); },
    applyImpulse(id, particle, impulse) { get(id).simulation.applyImpulse(particle, [...cloneSerializable(impulse)] as [number, number, number]); },
    destroy(id) { const entry = get(id); entry.simulation.dispose(); entries.delete(id); },
  };
  return {
    id: "$engine.softBodies", version: "1", services: { softBodies: service },
    afterPhysics() {
      alive();
      ensureRefs();
      const committed: { entry: Entry; snapshot: SimulationSnapshot }[] = [];
      const reactions = new Map<string, [number, number, number]>();
      try {
        for (const entry of [...entries.values()].filter(item => item.definition.autoStep).sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
          const snapshot = entry.simulation.snapshot();
          committed.push({ entry, snapshot });
          syncBinding(entry);
          const state = entry.simulation.step(1);
          const binding = entry.definition.bodyColliders?.[0];
          if (entry.definition.bodyReactions && binding) {
            const impulse = reactions.get(binding.entity) ?? [0, 0, 0];
            for (let i = 0; i < 3; i++) impulse[i] += state.contacts.reactionImpulse[i] - snapshot.counters.reactionImpulse[i];
            reactions.set(binding.entity, impulse);
          }
        }
        if (reactions.size) {
          const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_REACTION", "bodyReactions require the physics plugin.");
          bridge.applySphereReactions([...reactions].sort(([a], [b]) => a.localeCompare(b)).map(([entity, impulse]) => {
            const c = bridge.sampleSphere(entity).centerOfMass;
            return { entity, impulse, moment: [c[1] * impulse[2] - c[2] * impulse[1], c[2] * impulse[0] - c[0] * impulse[2], c[0] * impulse[1] - c[1] * impulse[0]] as Vec3 };
          }));
        }
      } catch (error) {
        const failures: string[] = [];
        for (const item of committed.reverse()) try { item.entry.simulation.restore(item.snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        if (failures.length) throw new Error(`TC_SOFTBODY_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, softBodies: [] }),
    snapshot: () => { alive(); ensureRefs(); return { version: 1, softBodies: [...entries.values()].sort((a, b) => a.definition.id.localeCompare(b.definition.id)).map(entry => { const binding = entry.definition.bodyColliders?.[0]; if (binding && (!entry.bodyRef || !context.world.isAlive(entry.bodyRef))) fail("BODY_COLLIDER", `Body '${binding.entity}' is stale; remove the simulation before saving.`); return { definition: cloneSerializable(entry.definition), state: entry.simulation.snapshot() }; }) }; },
    validateSnapshot(value) { const staged = parseSnapshot(value, fixedDt, materials); disposeEntries(staged); },
    validateWorld(value, world) { const staged = parseSnapshot(value, fixedDt, materials); try { validateSampledBodyWorld(context, world, [...staged.values()].flatMap(entry => entry.definition.bodyColliders ?? []), "TC_SOFTBODY_SNAPSHOT"); } finally { disposeEntries(staged); } },
    validatePeers(value, peers) { const staged = parseSnapshot(value, fixedDt, materials); try { validateSampledBodyPeers(peers, [...staged.values()].flatMap(entry => entry.definition.bodyColliders ?? []), "TC_SOFTBODY_SNAPSHOT"); } finally { disposeEntries(staged); } },
    restore(value) { alive(); const staged = parseSnapshot(value, fixedDt, materials); disposeEntries(entries); entries = staged; pendingRefs = true; },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
