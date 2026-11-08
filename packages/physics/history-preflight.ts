import type { EntityIR, SceneIR } from "../compiler/src/types.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";

/** Check lifecycle identities without invoking native WASM or trusting snapshot bytes. */
export function preflightPhysicsHistory(
  definitions: readonly EntityIR[], catalog: SceneIR, history: readonly unknown[],
  header: { tick: number; bindings: readonly string[]; entities: readonly { id: string; type: string }[] },
): void {
  const fail = (message: string): never => {
    throw new Error(`TC_PHYSICS_SNAPSHOT_HISTORY: ${message} Use an intact checkpoint for the same scene.`);
  };
  const typeOf = (entity: EntityIR) => entity.character ? "character" : entity.rigidBody?.type;
  const active = new Map(definitions.map(entity => [entity.id, typeOf(entity)]));
  const kinds = new Set(["step", "move", "velocity", "impulse", "angularVelocity", "torqueImpulse", "impulseAtPoint", "gravity", "gravityScale"]);
  let steps = 0;
  for (const raw of history) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Invalid history action.");
    const action = raw as { kind?: unknown; id?: unknown; created?: unknown; removed?: unknown; frame?: unknown };
    if (typeof action.kind !== "string" || !kinds.has(action.kind)) fail("Unknown history action.");
    if (action.kind !== "step") {
      if (action.kind !== "gravity" && (typeof action.id !== "string" || !active.has(action.id)))
        fail("History action references a missing body.");
      continue;
    }
    steps++;
    if (!Array.isArray(action.removed) || !Array.isArray(action.created) || !Array.isArray(action.frame))
      fail("Lifecycle history is missing a body list.");
    const removed = new Set<string>();
    for (const id of action.removed as unknown[]) {
      if (typeof id !== "string" || removed.has(id) || !active.has(id)) fail("Invalid or duplicate removed body.");
      removed.add(id as string);
    }
    for (const id of removed) active.delete(id);
    for (const rawCreation of action.created as unknown[]) {
      if (!rawCreation || typeof rawCreation !== "object" || Array.isArray(rawCreation)) fail("Invalid created body.");
      const creation = rawCreation as { id?: unknown; prefab?: unknown };
      if (typeof creation.id !== "string" || !creation.id || active.has(creation.id) ||
          (creation.prefab !== undefined && typeof creation.prefab !== "string")) fail("Invalid or duplicate created body.");
      const entity = resolveEntityDefinition(catalog, { id: creation.id as string, ...(creation.prefab === undefined ? {} : { prefab: creation.prefab as string }) });
      const type = entity && typeOf(entity);
      if (!type) fail("Created body does not resolve to a physics definition.");
      active.set(creation.id as string, type);
    }
    const seen = new Set<string>();
    for (const rawFrame of action.frame as unknown[]) {
      if (!rawFrame || typeof rawFrame !== "object" || Array.isArray(rawFrame)) fail("Invalid lifecycle frame.");
      const id = (rawFrame as { id?: unknown }).id;
      if (typeof id !== "string" || seen.has(id) || !active.has(id)) fail("Lifecycle frame differs from active bodies.");
      seen.add(id as string);
    }
    if (seen.size !== active.size) fail("Lifecycle frame omits an active body.");
  }
  if (steps !== header.tick || header.entities.length !== active.size) fail("History and snapshot body count or tick differ.");
  const seen = new Set<string>();
  for (const entry of header.entities) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id) || active.get(entry.id) !== entry.type)
      fail("Snapshot bodies differ from lifecycle history.");
    seen.add(entry.id);
  }
  if (header.bindings.some(id => !active.has(id))) fail("Snapshot binding has no active physics body.");
}

