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

/**
 * Reject the narrowly identified two-body zero-step replay hazard before
 * allocating a native candidate. This is not a general safety proof.
 */
export function rejectKnownUnsafeInitialRemoval(definitions: readonly EntityIR[], history: readonly unknown[]): void {
  if (definitions.length !== 2) return;
  const [first, second] = definitions;
  if (!first.rigidBody || !second.rigidBody || first.character || second.character ||
      first.rigidBody.type !== "dynamic" || second.rigidBody.type !== "dynamic" ||
      first.rigidBody.collider.shape !== "box" || second.rigidBody.collider.shape !== "box" ||
      first.rigidBody.trigger || second.rigidBody.trigger) return;

  const firstStep = history.find(action => !!action && typeof action === "object" && (action as { kind?: unknown }).kind === "step") as
    { removed?: unknown; created?: unknown } | undefined;
  if (!firstStep || !Array.isArray(firstStep.removed) || firstStep.removed.length !== 1 || firstStep.removed[0] !== first.id ||
      !Array.isArray(firstStep.created) || firstStep.created.length !== 0) return;

  // A bounding sphere enclosing the whole rotated and offset box establishes
  // definite separation without creating a Rapier world or predicting contact.
  const sphere = (entity: EntityIR): { position: readonly number[]; radius: number } | undefined => {
    const transform = entity.transform, collider = entity.rigidBody!.collider;
    const position = transform?.position, scale = transform?.scale, size = collider.size, offset = collider.offset ?? [0, 0, 0];
    if (![position, scale, size, offset].every(value => Array.isArray(value) && value.length === 3 &&
        [0, 1, 2].every(axis => typeof value[axis] === "number" && Number.isFinite(value[axis])))) return undefined;
    const radius = Math.hypot(size![0] * scale[0] / 2, size![1] * scale[1] / 2, size![2] * scale[2] / 2) +
      Math.hypot(offset[0] * scale[0], offset[1] * scale[1], offset[2] * scale[2]);
    return Number.isFinite(radius) ? { position, radius } : undefined;
  };
  const a = sphere(first), b = sphere(second);
  if (!a || !b) return;
  const distance = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
  const magnitude = Math.max(1, distance, a.radius, b.radius, ...a.position.map(Math.abs), ...b.position.map(Math.abs));
  if (distance > a.radius + b.radius + Math.max(0.001, magnitude * 1e-5))
    throw new Error(`TC_PHYSICS_SNAPSHOT_UNSAFE_HISTORY: Initial removal of '${first.id}' before the first physics step can corrupt native replay. Restore a different known-good checkpoint or restart the scene.`);
}
