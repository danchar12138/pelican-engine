import type { EntityIR, SceneIR } from "../compiler/src/types.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";
import { validateJointDefinition } from "./joints-internal.ts";
import type { PhysicsJointDefinition, Transform } from "../sdk/src/index.ts";

/** Check lifecycle identities without invoking native WASM or trusting snapshot bytes. */
export function preflightPhysicsHistory(
  definitions: readonly EntityIR[], catalog: SceneIR, history: readonly unknown[],
  header: { tick: number; bindings: readonly string[]; entities: readonly { id: string; type: string }[]; joints?: readonly PhysicsJointDefinition[] },
  checks: { definition(entity: EntityIR): void; transform(value: Transform, entity: EntityIR): void },
): void {
  const fail = (message: string): never => {
    throw new Error(`TC_PHYSICS_SNAPSHOT_HISTORY: ${message} Use an intact checkpoint for the same scene.`);
  };
  const typeOf = (entity: EntityIR) => entity.character ? "character" : entity.rigidBody?.type;
  const active = new Map(definitions.map(entity => [entity.id, typeOf(entity)]));
  const activeDefinitions = new Map(definitions.map(entity => [entity.id, entity]));
  const joints = new Map<string, PhysicsJointDefinition>();
  const kinds = new Set(["step", "move", "velocity", "impulse", "angularVelocity", "torqueImpulse", "impulseAtPoint", "gravity", "gravityScale", "jointCreate", "jointDestroy"]);
  const vector = (value: unknown) => Array.isArray(value) && value.length === 3 &&
    [0, 1, 2].every(axis => typeof value[axis] === "number" && Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 1e12);
  let steps = 0;
  let jointOperations = false;
  for (const raw of history) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Invalid history action.");
    const action = raw as { kind?: unknown; id?: unknown; created?: unknown; removed?: unknown; frame?: unknown; value?: unknown; point?: unknown; scale?: unknown; dt?: unknown; definition?: unknown };
    if (typeof action.kind !== "string" || !kinds.has(action.kind)) fail("Unknown history action.");
    if (action.kind === "jointCreate") {
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, "definition")) fail("Invalid joint create fields.");
      const joint = validateJointDefinition(action.definition), a = active.get(joint.body1), b = active.get(joint.body2);
      if (!["fixed", "dynamic"].includes(a ?? "") || !["fixed", "dynamic"].includes(b ?? "") ||
          (a !== "dynamic" && b !== "dynamic") || joints.has(joint.id) || joints.size >= 10000) fail("Invalid joint endpoints, duplicate ID or capacity.");
      joints.set(joint.id, joint);
      jointOperations = true;
      continue;
    }
    if (action.kind === "jointDestroy") {
      if (Object.keys(action).length !== 2 || typeof action.id !== "string" || !joints.has(action.id)) fail("Invalid joint destroy action.");
      joints.delete(action.id as string);
      jointOperations = true;
      continue;
    }
    if (action.kind !== "step") {
      if (action.kind !== "gravity" && (typeof action.id !== "string" || !active.has(action.id)))
        fail("History action references a missing body.");
      const fields = action.kind === "gravity" ? ["kind", "value"]
        : action.kind === "gravityScale" ? ["kind", "id", "scale"]
        : action.kind === "impulseAtPoint" ? ["kind", "id", "value", "point"] : ["kind", "id", "value"];
      if (Object.keys(action).length !== fields.length || fields.some(field => !Object.hasOwn(action, field))) fail("Invalid history action fields.");
      if (action.kind === "gravityScale") {
        if (typeof action.scale !== "number" || !Number.isFinite(action.scale) || Math.abs(action.scale) > 1000 ||
            (action.scale !== 0 && Math.fround(action.scale) === 0)) fail("Invalid gravity scale.");
      } else if (!vector(action.value) || (action.kind === "impulseAtPoint" && !vector(action.point))) fail("Invalid history vector.");
      if (action.kind !== "gravity") {
        const type = active.get(action.id as string);
        if (action.kind === "move" ? type !== "character" : action.kind === "velocity" ? type !== "character" && type !== "dynamic" : type !== "dynamic")
          fail("History action is incompatible with its body type.");
      }
      continue;
    }
    steps++;
    if (Object.keys(action).length !== 5 || ["kind", "dt", "frame", "created", "removed"].some(key => !Object.hasOwn(action, key))) fail("Invalid step fields.");
    if (typeof action.dt !== "number" || !Number.isFinite(action.dt) || action.dt < 1e-6 || action.dt > 1) fail("Invalid physics timestep.");
    if (!Array.isArray(action.removed) || !Array.isArray(action.created) || !Array.isArray(action.frame))
      fail("Lifecycle history is missing a body list.");
    const removed = new Set<string>();
    for (const id of action.removed as unknown[]) {
      if (typeof id !== "string" || removed.has(id) || !active.has(id)) fail("Invalid or duplicate removed body.");
      removed.add(id as string);
    }
    for (const id of removed) active.delete(id);
    for (const id of removed) activeDefinitions.delete(id);
    for (const [id, joint] of joints) if (removed.has(joint.body1) || removed.has(joint.body2)) joints.delete(id);
    for (const rawCreation of action.created as unknown[]) {
      if (!rawCreation || typeof rawCreation !== "object" || Array.isArray(rawCreation)) fail("Invalid created body.");
      const creation = rawCreation as { id?: unknown; prefab?: unknown; transform?: unknown };
      if (typeof creation.id !== "string" || !creation.id || active.has(creation.id) ||
          (creation.prefab !== undefined && typeof creation.prefab !== "string")) fail("Invalid or duplicate created body.");
      const entity = resolveEntityDefinition(catalog, { id: creation.id as string, ...(creation.prefab === undefined ? {} : { prefab: creation.prefab as string }) });
      const type = entity && typeOf(entity);
      if (!type) fail("Created body does not resolve to a physics definition.");
      if (Object.keys(creation).some(key => !["id", "prefab", "transform"].includes(key))) fail("Invalid creation fields.");
      const definition = { ...entity!, transform: creation.transform as Transform };
      checks.definition(definition);
      active.set(creation.id as string, type);
      activeDefinitions.set(creation.id as string, definition);
    }
    const seen = new Set<string>();
    for (const rawFrame of action.frame as unknown[]) {
      if (!rawFrame || typeof rawFrame !== "object" || Array.isArray(rawFrame)) fail("Invalid lifecycle frame.");
      const id = (rawFrame as { id?: unknown }).id;
      if (typeof id !== "string" || seen.has(id) || !active.has(id)) fail("Lifecycle frame differs from active bodies.");
      checks.transform((rawFrame as { transform: Transform }).transform, activeDefinitions.get(id as string)!);
      seen.add(id as string);
    }
    if (seen.size !== active.size) fail("Lifecycle frame omits an active body.");
  }
  if (steps !== header.tick || header.entities.length !== active.size) fail("History and snapshot body count or tick differ.");
  const seen = new Set<string>();
  for (const entry of header.entities) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id) || !active.has(entry.id) || active.get(entry.id) !== entry.type)
      fail("Snapshot bodies differ from lifecycle history.");
    seen.add(entry.id);
  }
  if (header.bindings.some(id => !active.has(id))) fail("Snapshot binding has no active physics body.");
  if (jointOperations !== (header.joints !== undefined) ||
      (jointOperations && JSON.stringify([...joints.values()]) !== JSON.stringify(header.joints)))
    fail("Snapshot joints differ from lifecycle history.");
}

