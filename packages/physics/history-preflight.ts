import type { EntityIR } from "../compiler/src/types.ts";

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
