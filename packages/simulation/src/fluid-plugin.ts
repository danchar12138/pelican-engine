import type { FluidBodyCollider, FluidDefinition, FluidService, FluidState, FluidVisualState, Vec3 } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import type { EntityHandle } from "../../sdk/src/index.ts";
import { bindParticleBodies, checkParticleBodies, particleColliderIds, syncParticleBodies, validateSampledBodyPeers, validateSampledBodyWorld } from "./sampled-body-binding.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createSimulation, type Simulation, type SimulationOptions, type SimulationSnapshot } from "../../../experiments/simulation/index.ts";
import { differingSimulationOption } from "./snapshot-options.ts";
import { nearestParticle } from "./nearest-particle.ts";
import { stageParticleDomain } from "./coupling-adapters.ts";
import { createCoupledSchedule } from "./coupled-schedule.ts";
import { fluidField, FLUID_REST_DENSITY } from "./sph.ts";
import { applyParticleForces } from "./particle-forces.ts";
import { checkColliderBindings, setManualColliders } from "./manual-colliders.ts";
import { createRopeBodyCoupling, virtualCollider, type VirtualRopeCollider } from "./rope-body-coupling.ts";

type Entry = { definition: FluidDefinition; simulation: Simulation; bodyRefs: Map<string, EntityHandle>; externalBodies: boolean };
type Saved = { definition: FluidDefinition; state: SimulationSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_FLUID_${code}: ${detail}`); };
const validId = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;
const vector = (value: unknown, label: string): Vec3 => Array.isArray(value) && value.length === 3 && value.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100) ? [value[0], value[1], value[2]] : fail("INPUT", `${label} must be a finite vector with components in [-100,100].`);
function createEntry(input: FluidDefinition, fixedDt: number, materials: ReadonlySet<string>, restoredExternal?: boolean): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty fluid id.");
  const externalBodies = restoredExternal ?? (definition.autoStep === true);
  if (externalBodies && !definition.autoStep) return fail("BODY_COLLIDER", "Native body mode requires automatic stepping.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Fluid fixedDt must match the host fixedDt.");
  if (definition.bodyReactions !== undefined && typeof definition.bodyReactions !== "boolean") return fail("BODY_REACTION", "bodyReactions must be boolean.");
  if (definition.bodyColliders !== undefined) {
    if (!Array.isArray(definition.bodyColliders) || definition.bodyColliders.length > (externalBodies ? 64 : 1)) return fail("BODY_COLLIDER", "Fluid supports at most 64 live native body colliders (one in legacy snapshots).");
    if (definition.bodyColliders.length && !definition.autoStep) return fail("BODY_COLLIDER", "bodyColliders require autoStep: true.");
    const ids = new Set<string>(), entities = new Set<string>();
    for (const binding of definition.bodyColliders) {
      if (!binding || !validId(binding.id) || !validId(binding.entity) || ids.has(binding.id) || entities.has(binding.entity)) return fail("BODY_COLLIDER", "Body bindings need distinct nonempty IDs and entities.");
      ids.add(binding.id); entities.add(binding.entity);
    }
  }
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be boolean.");
  if (definition.visual !== undefined) {
    const visual = definition.visual;
    if (!visual || typeof visual !== "object" || !validId(visual.material) || !materials.has(visual.material)) return fail("VISUAL_MATERIAL", "visual.material must name a declared material.");
    if (visual.radius !== undefined && (typeof visual.radius !== "number" || !Number.isFinite(visual.radius) || visual.radius <= 0 || visual.radius > 1e6 || Math.fround(visual.radius) === 0)) return fail("VISUAL_RADIUS", "visual.radius must be positive, finite and representable as f32.");
    if ((visual.castShadow !== undefined && typeof visual.castShadow !== "boolean") || (visual.receiveShadow !== undefined && typeof visual.receiveShadow !== "boolean")) return fail("VISUAL_SHADOW", "Shadow options must be boolean.");
  }
  const { id: _id, autoStep: _autoStep, visual: _visual, bodyColliders: _bodyColliders, bodyReactions: _bodyReactions, ...options } = definition;
  const simulation = createSimulation("fluid", { ...options, fixedDt, externalBodies, twoWayCoupling: definition.bodyReactions ?? false } as SimulationOptions);
  return { definition, simulation, bodyRefs: new Map(), externalBodies };
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.simulation.dispose(); entries.clear(); }
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { fluids?: unknown }).fluids) || (value as { fluids: unknown[] }).fluids.length > 128)
    return fail("SNAPSHOT", "Expected a version 1 snapshot containing at most 128 fluids.");
  const result = new Map<string, Entry>();
  try {
    for (const item of (value as { fluids: Saved[] }).fluids) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid fluid entry.");
      const entry = createEntry(item.definition, fixedDt, materials, item.state?.options?.externalBodies ?? false);
      if (result.has(entry.definition.id)) { entry.simulation.dispose(); fail("SNAPSHOT", "Duplicate fluid id."); }
      result.set(entry.definition.id, entry);
      const expected = entry.simulation.snapshot().options;
      entry.simulation.restore(item.state);
      checkColliderBindings(item.state.colliders, particleColliderIds(entry), "TC_FLUID_SNAPSHOT");
      checkParticleBodies(entry, item.state, "TC_FLUID_SNAPSHOT");
      const differing = differingSimulationOption(entry.simulation.snapshot().options, expected, "fluid", !!entry.definition.bodyColliders?.length);
      if (differing) fail("SNAPSHOT", `Fluid '${entry.definition.id}' option '${differing}' differs from its definition.`);
      if (entry.definition.bodyColliders?.length)
        entry.simulation.setTwoWayCoupling(entry.definition.bodyReactions ?? false);
    }
    return result;
  } catch (error) { disposeEntries(result); throw error; }
}
function inspect(entry: Entry): FluidState {
  const state = entry.simulation.inspect(), render = entry.simulation.getRenderState();
  return { tick: state.tick, simulatedSeconds: state.simulatedSeconds, disposed: state.disposed, gravity: [...(entry.definition.gravity ?? [0, -2, 0])] as Vec3,
    particles: render.particles, velocities: entry.simulation.getParticleVelocities(), bodies: render.bodies, contacts: state.contacts, fluid: state.fluid,
    resources: { particles: state.resources.particles, bodies: state.resources.bodies } };
}
export const createFluidPlugin: RuntimePluginFactory = context => {
  const fixedDt = context.fixedDt;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>(), disposed = false, pendingRefs = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Fluid service is disposed."); };
  const ensureRefs = () => { if (!pendingRefs) return; for (const entry of entries.values()) bindParticleBodies(context, entry, "TC_FLUID_SNAPSHOT"); pendingRefs = false; };
  const get = (id: string) => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty fluid id."); return entries.get(id) ?? fail("MISSING", `Fluid '${id}' does not exist.`); };
  const syncBinding = (entry: Entry) => syncParticleBodies(context, entry, "TC_FLUID_BODY_COLLIDER");
  const service: FluidService = {
    create(definition) { alive(); ensureRefs(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty fluid id."); if (entries.has(definition.id)) return fail("DUPLICATE", `Fluid '${definition.id}' already exists.`); if (entries.size >= 128) return fail("CAPACITY", "At most 128 fluids per host."); const entry = createEntry(definition, fixedDt, materials); try { bindParticleBodies(context, entry, "TC_FLUID_BODY_COLLIDER"); syncBinding(entry); entries.set(entry.definition.id, entry); } catch (error) { entry.simulation.dispose(); throw error; } },
    step(id, ticks) { const entry = get(id); if (entry.definition.autoStep) return fail("AUTO_STEP", `Fluid '${id}' is automatically stepped.`); const before = entry.simulation.snapshot(); try { entry.simulation.step(ticks); return inspect(entry); } catch (error) { try { entry.simulation.restore(before); } catch (rollbackError) { throw new Error(`TC_FLUID_ROLLBACK: ${String(error)}; partialState=true; rollback failure: ${String(rollbackError)}`); } throw error; } },
    inspect(id) {
      const entry = get(id), result = inspect(entry);
      if (entry.definition.autoStep) {
        const active = [...entries.values()].filter(item => item.definition.autoStep).sort((a, b) => a.definition.id.localeCompare(b.definition.id, "en"));
        const samples = active.map(item => item.simulation.snapshot().particles), index = active.indexOf(entry), offset = samples.slice(0, index).reduce((sum, particles) => sum + particles.length, 0);
        const field = fluidField(samples.flat()), density = field.density.slice(offset, offset + samples[index].length), pressure = field.pressure.slice(offset, offset + samples[index].length);
        result.fluid = { method: "WCSPH", restDensity: FLUID_REST_DENSITY, minDensity: Math.min(...density), maxDensity: Math.max(...density), maxPressure: Math.max(...pressure) };
      }
      return result;
    },
    nearestParticle(id, position, maxDistance) { return nearestParticle(get(id).simulation, position, maxDistance, "TC_FLUID_INPUT"); },
    visuals() { alive(); return [...entries.values()].filter(entry => entry.definition.visual !== undefined).sort((a,b) => a.definition.id.localeCompare(b.definition.id)).map(entry => { const visual = entry.definition.visual!, state = entry.simulation.getRenderState(); return { id: entry.definition.id, material: visual.material, particles: state.particles.map(particle => ({ ...particle, radius: visual.radius ?? particle.radius })), castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true }; }); },
    setGravity(id, gravity) { const entry = get(id), value = vector(gravity, "gravity"); entry.simulation.setGravity([...value]); entry.definition.gravity = value; },
    setColliders(id, colliders) { const entry = get(id); setManualColliders(entry.simulation, colliders, particleColliderIds(entry), "TC_FLUID_INPUT"); },
    applyImpulse(id, particle, impulse) { get(id).simulation.applyImpulse(particle, [...cloneSerializable(impulse)] as [number, number, number]); },
    applyImpulses(id, impulses) { const entry = get(id); if (!Array.isArray(impulses) || impulses.length > 512) return fail("INPUT", "Expected at most 512 particle impulses."); entry.simulation.applyImpulses(impulses.map(item => { if (!item || typeof item !== "object" || typeof item.particle !== "string" || !/^particle:(0|[1-9]\d*)$/.test(item.particle)) return fail("INPUT", "Each impulse requires a particle id from inspect()."); return { id: item.particle, impulse: [...vector(item.impulse, "impulse")] as [number, number, number] }; })); },
    applyForce(id, particle, force) { applyParticleForces(get(id).simulation, [{ particle, force }], "TC_FLUID_INPUT"); },
    applyForces(id, forces) { applyParticleForces(get(id).simulation, forces, "TC_FLUID_INPUT"); },
    destroy(id) { const entry = get(id); entry.simulation.dispose(); entries.delete(id); },
  };
  const schedule = createCoupledSchedule(() => entries.values(), 6,
    entry => ({ solver: entry.simulation.snapshot(), definition: cloneSerializable(entry.definition), refs: entry.bodyRefs }),
    (entry, state) => { entry.definition = state.definition; entry.bodyRefs = state.refs; entry.simulation.restore(state.solver); },
    (entry, count, sample) => entry.simulation.coupledTick(count, sample));
  return {
    id: "$engine.fluid", version: "1", services: { fluid: service }, simulation: schedule,
    requiresRecovery: () => schedule.faulted,
    afterRestore() { ensureRefs(); for (const entry of entries.values()) syncBinding(entry); },
    prepareSimulationSubstep() {
      for (const entry of entries.values()) if (entry.definition.autoStep) context.couplingFrame?.registerFluid(entry.definition.id, entry.simulation.snapshot().particles);
    },
    afterPhysics() {
      alive();
      ensureRefs();
      const committed: { entry: Entry; snapshot: SimulationSnapshot }[] = [];
      const frame = context.couplingFrame?.active ? context.couplingFrame : undefined;
      const bodies = frame?.bodies ?? new Map<string, VirtualRopeCollider>();
      try {
        for (const entry of [...entries.values()].filter(e => e.definition.autoStep).sort((a, b) => a.definition.id.localeCompare(b.definition.id))) {
          const snapshot = entry.simulation.snapshot();
          committed.push({ entry, snapshot });
          const samples = syncBinding(entry);
          let coupling;
          if (samples.length) {
            const reactive = entry.definition.bodyReactions ?? false;
            const coupled = new Map<string, VirtualRopeCollider>();
            for (const { id, entity, sample } of samples) {
              let body = reactive ? bodies.get(entity) : undefined;
              if (!body) { body = virtualCollider(sample, reactive); if (reactive) bodies.set(entity, body); }
              coupled.set(id, body);
            }
            coupling = createRopeBodyCoupling(coupled, new Map(), reactive);
          }
          if (frame) coupling = { ...(coupling ?? createRopeBodyCoupling(new Map())), fluidAcceleration: (index: number) => frame.fluidAcceleration(entry.definition.id, index) };
          const view = schedule.next(entry.definition.id, coupling);
          if (!view) entry.simulation.step(1, coupling);
          stageParticleDomain(frame, entry.definition.id, entry.simulation, snapshot, coupling, view);
        }
        const batch = [...bodies].map(([entity, body]) => ({ entity, ...body.reaction() }))
          .filter(item => item.impulse.some(value => value !== 0) || item.moment.some(value => value !== 0))
          .sort((a, b) => a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0);
        if (batch.length && !frame) {
          const bridge = context.getRopePhysicsBridge?.() ?? fail("BODY_REACTION", "bodyReactions require the physics plugin.");
          bridge.applyParticleReactions(batch);
        }
        frame?.rollbackWith(() => {
          const failures: unknown[] = [];
          for (const item of [...committed].reverse()) try { item.entry.simulation.restore(item.snapshot); } catch (error) { failures.push(error); }
          if (failures.length) throw new AggregateError(failures, "TC_FLUID_COUPLING_ROLLBACK: Restore a known-good checkpoint.");
        });
      } catch (error) {
        const failures: string[] = [];
        for (const item of committed.reverse()) try { item.entry.simulation.restore(item.snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        if (failures.length) throw new Error(`TC_FLUID_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, fluids: [] }),
    snapshot: () => { alive(); ensureRefs(); return { version: 1, fluids: [...entries.values()].sort((a,b) => a.definition.id.localeCompare(b.definition.id)).map(entry => { for (const binding of entry.definition.bodyColliders ?? []) { const ref = entry.bodyRefs.get(binding.id); if (!ref || !context.world.isAlive(ref)) fail("BODY_COLLIDER", `Body '${binding.entity}' is stale; advance or remove the simulation before saving.`); } return { definition: cloneSerializable(entry.definition), state: entry.simulation.snapshot() }; }) }; },
    validateSnapshot(value) { const staged = parseSnapshot(value, fixedDt, materials); disposeEntries(staged); },
    validateWorld(value, world) { const staged = parseSnapshot(value, fixedDt, materials); try { validateSampledBodyWorld(context, world, [...staged.values()].flatMap(entry => entry.definition.bodyColliders ?? []), "TC_FLUID_SNAPSHOT"); } finally { disposeEntries(staged); } },
    validatePeers(value, peers) { const staged = parseSnapshot(value, fixedDt, materials); try { validateSampledBodyPeers(peers, [...staged.values()].flatMap(entry => entry.definition.bodyColliders ?? []), "TC_FLUID_SNAPSHOT"); } finally { disposeEntries(staged); } },
    restore(value) { alive(); const staged = parseSnapshot(value, fixedDt, materials); schedule.reset(); disposeEntries(entries); entries = staged; pendingRefs = true; },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
