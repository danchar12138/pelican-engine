import type { EntityHandle } from "../../sdk/src/index.ts";
import type { RuntimePluginContext } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import type { ClothPhysicsBody } from "../../runtime/src/plugins.ts";
import type { Simulation, SimulationSnapshot } from "../../../experiments/simulation/types.ts";

export type SampledBodyBinding = { readonly entity: string };
export interface ParticleBodyEntry {
  definition: { bodyColliders?: readonly { id: string; entity: string }[]; bodyReactions?: boolean };
  simulation: Simulation;
  bodyRefs: Map<string, EntityHandle>;
  externalBodies: boolean;
}
export function bindParticleBodies(context: RuntimePluginContext, entry: ParticleBodyEntry, code: string): void {
  entry.bodyRefs = new Map((entry.definition.bodyColliders ?? []).map(binding => [binding.id, resolveSampledBody(context, binding, code)]));
}
export function particleBodyId(entry: ParticleBodyEntry, id: string): string { return entry.externalBodies ? `body:${id}` : "body:0"; }
export function particleColliderIds(entry: ParticleBodyEntry): { id: string }[] {
  const bindings = entry.definition.bodyColliders ?? [];
  return entry.externalBodies ? [...bindings, ...bindings.map(binding => ({ id: particleBodyId(entry, binding.id) }))] : [...bindings];
}
export function checkParticleBodies(entry: ParticleBodyEntry, snapshot: SimulationSnapshot, code: string): void {
  const bindings = entry.definition.bodyColliders ?? [], ids = new Set(bindings.map(binding => particleBodyId(entry, binding.id)));
  const sampled = [...(snapshot.sampledBodies ?? []), ...(snapshot.sampledBoxes ?? [])];
  if (sampled.length !== bindings.length || sampled.some(body => !ids.has(body.id)) || (entry.externalBodies && (snapshot.bodies.length !== bindings.length || snapshot.bodies.some(body => !ids.has(body.id)))))
    throw new Error(`${code}: Sampled native bodies differ from the declared binding registry.`);
}
export function syncParticleBodies(context: RuntimePluginContext, entry: ParticleBodyEntry, code: string): { id: string; entity: string; sample: ClothPhysicsBody }[] {
  const bindings = entry.definition.bodyColliders ?? [];
  const live = bindings.filter(binding => {
    const ref = entry.bodyRefs.get(binding.id);
    if (!ref) throw new Error(`${code}: Missing generation handle for '${binding.id}'.`);
    if (context.world.isAlive(ref)) return true;
    if (!entry.externalBodies) throw new Error(`${code}: Legacy body '${binding.entity}' is stale; recreate the simulation.`);
    return false;
  });
  const samples = live.map(binding => ({ id: particleBodyId(entry, binding.id), entity: binding.entity, sample: requireSampledBody(context, binding, entry.bodyRefs.get(binding.id), code) }));
  if (entry.externalBodies) {
    entry.simulation.setSampledBodies(samples.map(({ id, sample }) => sample.kind === "sphere"
      ? { kind: "sphere", id, position: [...sample.center], velocity: [...sample.linearVelocity], radius: sample.radius }
      : { kind: "box", id, position: [...sample.center], velocity: [...sample.linearVelocity], halfExtents: [...sample.halfExtents], rotation: [...sample.rotation] }));
    if (live.length !== bindings.length) {
      entry.definition.bodyColliders = live; entry.bodyRefs = new Map(live.map(binding => [binding.id, entry.bodyRefs.get(binding.id)!]));
      if (!live.length) entry.definition.bodyReactions = false;
    }
  } else if (samples[0]) {
    const sample = samples[0].sample;
    if (sample.kind === "sphere") entry.simulation.setBodyState("body:0", [...sample.center], [...sample.linearVelocity], sample.radius);
    else entry.simulation.setBodyBoxState("body:0", [...sample.center], [...sample.linearVelocity], [...sample.halfExtents], [...sample.rotation]);
  }
  if (entry.externalBodies || bindings.length) entry.simulation.setTwoWayCoupling(entry.definition.bodyReactions ?? false);
  return samples;
}

export function resolveSampledBody(context: RuntimePluginContext, binding: SampledBodyBinding, code: string): EntityHandle {
  if (!context.world.isAlive(binding.entity))
    throw new Error(`${code}: Body '${binding.entity}' is not live. Create the binding again for a new entity.`);
  return context.world.resolve(binding.entity);
}

export function requireSampledBody(context: RuntimePluginContext, binding: SampledBodyBinding, ref: EntityHandle | undefined, code: string) {
  if (!ref || !context.world.isAlive(ref))
    throw new Error(`${code}: Body '${binding.entity}' is stale. Destroy and recreate the simulation binding.`);
  const bridge = context.getRopePhysicsBridge?.();
  if (!bridge) throw new Error(`${code}: A physics plugin with a live dynamic sphere or box is required.`);
  return bridge.sampleParticleBody(binding.entity);
}

export function validateSampledBodyWorld(context: RuntimePluginContext, world: WorldSnapshot, bindings: Iterable<SampledBodyBinding>, code: string): void {
  const records = new Map(world.entities.map(record => [record.id, record]));
  for (const binding of bindings) {
    const record = records.get(binding.entity);
    const body = record && resolveEntityDefinition(context.scene, record)?.rigidBody;
    if (!body || body.type !== "dynamic" || body.trigger || !["sphere", "box"].includes(body.collider.shape))
      throw new Error(`${code}: Restored body '${binding.entity}' must be a live dynamic, non-trigger sphere or box.`);
  }
}

export function validateSampledBodyPeers(peers: Readonly<Record<string, { version?: string; payload: unknown }>>, bindings: readonly SampledBodyBinding[], code: string): void {
  if (!bindings.length) return;
  const physics = peers["$engine.physics"]?.payload as { bindings?: unknown; entities?: unknown } | undefined;
  if (!physics || !Array.isArray(physics.bindings) || !Array.isArray(physics.entities))
    throw new Error(`${code}: Bound simulations require a matching physics snapshot.`);
  for (const binding of bindings) {
    const body = physics.entities.find((item: unknown) => item && typeof item === "object" && (item as { id?: unknown }).id === binding.entity && (item as { type?: unknown }).type === "dynamic");
    if (!body || !physics.bindings.includes(binding.entity))
      throw new Error(`${code}: Bound body '${binding.entity}' is missing from physics state.`);
  }
}
