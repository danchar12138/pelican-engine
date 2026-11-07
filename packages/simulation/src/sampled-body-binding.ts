import type { EntityHandle } from "../../sdk/src/index.ts";
import type { RuntimePluginContext } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";

export type SampledBodyBinding = { readonly entity: string };

export function resolveSampledBody(context: RuntimePluginContext, binding: SampledBodyBinding, code: string): EntityHandle {
  if (!context.world.isAlive(binding.entity))
    throw new Error(`${code}: Body '${binding.entity}' is not live. Create the binding again for a new entity.`);
  return context.world.resolve(binding.entity);
}

export function requireSampledBody(context: RuntimePluginContext, binding: SampledBodyBinding, ref: EntityHandle | undefined, code: string) {
  if (!ref || !context.world.isAlive(ref))
    throw new Error(`${code}: Body '${binding.entity}' is stale. Destroy and recreate the simulation binding.`);
  const bridge = context.getRopePhysicsBridge?.();
  if (!bridge) throw new Error(`${code}: A physics plugin with a live dynamic sphere is required.`);
  return bridge.sampleSphere(binding.entity);
}

export function validateSampledBodyWorld(context: RuntimePluginContext, world: WorldSnapshot, bindings: Iterable<SampledBodyBinding>, code: string): void {
  const records = new Map(world.entities.map(record => [record.id, record]));
  for (const binding of bindings) {
    const record = records.get(binding.entity);
    const body = record && resolveEntityDefinition(context.scene, record)?.rigidBody;
    if (!body || body.type !== "dynamic" || body.trigger || body.collider.shape !== "sphere")
      throw new Error(`${code}: Restored body '${binding.entity}' must be a live dynamic, non-trigger sphere.`);
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
