import type { FluidBodyCollider, FluidDefinition, FluidService, FluidState, FluidVisualState, Vec3 } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createSimulation, type Simulation, type SimulationOptions, type SimulationSnapshot } from "../../../experiments/simulation/index.ts";

type Entry = { definition: FluidDefinition; simulation: Simulation };
type Saved = { definition: FluidDefinition; state: SimulationSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_FLUID_${code}: ${detail}`); };
const validId = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;
const vector = (value: unknown, label: string): Vec3 => Array.isArray(value) && value.length === 3 && value.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100) ? [value[0], value[1], value[2]] : fail("INPUT", `${label} must be a finite vector with components in [-100,100].`);
function createEntry(input: FluidDefinition, fixedDt: number, materials: ReadonlySet<string>): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty fluid id.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Fluid fixedDt must match the host fixedDt.");
  if (definition.bodyReactions !== undefined && typeof definition.bodyReactions !== "boolean") return fail("BODY_REACTION", "bodyReactions must be boolean.");
  if (definition.bodyColliders !== undefined) {
    if (!Array.isArray(definition.bodyColliders) || definition.bodyColliders.length > 1) return fail("BODY_COLLIDER", "Fluid supports at most one body collider.");
    if (definition.bodyColliders.length && !definition.autoStep) return fail("BODY_COLLIDER", "bodyColliders require autoStep: true.");
    const binding = definition.bodyColliders[0];
    if (binding && (!validId(binding.id) || !validId(binding.entity))) return fail("BODY_COLLIDER", "Body binding requires nonempty ids.");
  }
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be boolean.");
  if (definition.visual !== undefined) {
    const visual = definition.visual;
    if (!visual || typeof visual !== "object" || !validId(visual.material) || !materials.has(visual.material)) return fail("VISUAL_MATERIAL", "visual.material must name a declared material.");
    if (visual.radius !== undefined && (typeof visual.radius !== "number" || !Number.isFinite(visual.radius) || visual.radius <= 0 || visual.radius > 1e6 || Math.fround(visual.radius) === 0)) return fail("VISUAL_RADIUS", "visual.radius must be positive, finite and representable as f32.");
    if ((visual.castShadow !== undefined && typeof visual.castShadow !== "boolean") || (visual.receiveShadow !== undefined && typeof visual.receiveShadow !== "boolean")) return fail("VISUAL_SHADOW", "Shadow options must be boolean.");
  }
  const { id: _id, autoStep: _autoStep, visual: _visual, bodyColliders: _bodyColliders, bodyReactions: _bodyReactions, ...options } = definition;
  const simulation = createSimulation("fluid", { ...options, fixedDt, twoWayCoupling: definition.bodyReactions ?? false } as SimulationOptions);
  return { definition, simulation };
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.simulation.dispose(); entries.clear(); }
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { fluids?: unknown }).fluids) || (value as { fluids: unknown[] }).fluids.length > 128)
    return fail("SNAPSHOT", "Expected a version 1 snapshot containing at most 128 fluids.");
  const result = new Map<string, Entry>();
  try {
    for (const item of (value as { fluids: Saved[] }).fluids) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid fluid entry.");
      const entry = createEntry(item.definition, fixedDt, materials);
      if (result.has(entry.definition.id)) { entry.simulation.dispose(); fail("SNAPSHOT", "Duplicate fluid id."); }
      result.set(entry.definition.id, entry); entry.simulation.restore(item.state);
    }
    return result;
  } catch (error) { disposeEntries(result); throw error; }
}
function inspect(entry: Entry): FluidState {
  const state = entry.simulation.inspect(), render = entry.simulation.getRenderState();
  return { tick: state.tick, simulatedSeconds: state.simulatedSeconds, disposed: state.disposed,
    particles: render.particles, bodies: render.bodies, contacts: state.contacts, fluid: state.fluid,
    resources: { particles: state.resources.particles, bodies: state.resources.bodies } };
}
export const createFluidPlugin: RuntimePluginFactory = context => {
  const fixedDt = context.fixedDt;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Fluid service is disposed."); };
  const get = (id: string) => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty fluid id."); return entries.get(id) ?? fail("MISSING", `Fluid '${id}' does not exist.`); };
  const syncBinding = (entry: Entry) => {
    const binding = entry.definition.bodyColliders?.[0];
    if (!binding) return;
    const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_COLLIDER", "bodyColliders require the physics plugin.");
    if (!context.world.isAlive(binding.entity)) fail("BODY_COLLIDER", `Body '${binding.entity}' is no longer live.`);
    const sample = bridge.sampleSphere(binding.entity);
    entry.simulation.setBodyState("body:0", [...sample.center] as [number, number, number], [...sample.linearVelocity] as [number, number, number], sample.radius);
    entry.simulation.setTwoWayCoupling(entry.definition.bodyReactions ?? false);
  };
  const service: FluidService = {
    create(definition) { alive(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty fluid id."); if (entries.has(definition.id)) return fail("DUPLICATE", `Fluid '${definition.id}' already exists.`); if (entries.size >= 128) return fail("CAPACITY", "At most 128 fluids per host."); const entry = createEntry(definition, fixedDt, materials); try { syncBinding(entry); entries.set(entry.definition.id, entry); } catch (error) { entry.simulation.dispose(); throw error; } },
    step(id, ticks) { const entry = get(id); if (entry.definition.autoStep) return fail("AUTO_STEP", `Fluid '${id}' is automatically stepped.`); const before = entry.simulation.snapshot(); try { entry.simulation.step(ticks); return inspect(entry); } catch (error) { try { entry.simulation.restore(before); } catch (rollbackError) { throw new Error(`TC_FLUID_ROLLBACK: ${String(error)}; partialState=true; rollback failure: ${String(rollbackError)}`); } throw error; } },
    inspect(id) { return inspect(get(id)); },
    visuals() { alive(); return [...entries.values()].filter(entry => entry.definition.visual !== undefined).sort((a,b) => a.definition.id.localeCompare(b.definition.id)).map(entry => { const visual = entry.definition.visual!, state = inspect(entry); return { id: entry.definition.id, material: visual.material, particles: state.particles.map(particle => ({ ...particle, radius: visual.radius ?? particle.radius })), castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true }; }); },
    applyImpulse(id, particle, impulse) { get(id).simulation.applyImpulse(particle, [...cloneSerializable(impulse)] as [number, number, number]); },
    destroy(id) { const entry = get(id); entry.simulation.dispose(); entries.delete(id); },
  };
  return {
    id: "$engine.fluid", version: "1", services: { fluid: service },
    afterPhysics() {
      alive();
      const committed: { entry: Entry; snapshot: SimulationSnapshot }[] = [];
      const reactions = new Map<string, [number, number, number]>();
      try {
        for (const entry of [...entries.values()].filter(e => e.definition.autoStep).sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
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
        if (failures.length) throw new Error(`TC_FLUID_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, fluids: [] }),
    snapshot: () => ({ version: 1, fluids: [...entries.values()].sort((a,b) => a.definition.id.localeCompare(b.definition.id)).map(entry => ({ definition: cloneSerializable(entry.definition), state: entry.simulation.snapshot() })) }),
    validateSnapshot(value) { const staged = parseSnapshot(value, fixedDt, materials); disposeEntries(staged); },
    restore(value) { alive(); const staged = parseSnapshot(value, fixedDt, materials); disposeEntries(entries); entries = staged; },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
