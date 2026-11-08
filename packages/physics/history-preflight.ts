import type { EntityIR, SceneIR } from "../compiler/src/types.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";
import { validateJointDefinition } from "./joints-internal.ts";
import type { PhysicsJointDefinition, Transform } from "../sdk/src/index.ts";
import type { TerrainGeometry } from "../sdk/src/index.ts";
import { terrainGeometry } from "../runtime/src/terrain-data.ts";
import { validateParkedBody, type ParkedBodyState } from "./residency-data.ts";

/** Check lifecycle identities without invoking native WASM or trusting snapshot bytes. */
export function preflightPhysicsHistory(
  definitions: readonly EntityIR[], catalog: SceneIR, history: readonly unknown[],
  header: { tick: number; bindings: readonly string[]; entities: readonly { id: string; type: string }[]; joints?: readonly PhysicsJointDefinition[]; terrains?: readonly TerrainGeometry[] },
  checks: { definition(entity: EntityIR): void; transform(value: Transform, entity: EntityIR): void },
): void {
  const fail = (message: string): never => {
    throw new Error(`TC_PHYSICS_SNAPSHOT_HISTORY: ${message} Use an intact checkpoint for the same scene.`);
  };
  const typeOf = (entity: EntityIR) => entity.character ? "character" : entity.rigidBody?.type;
  const active = new Map(definitions.map(entity => [entity.id, typeOf(entity)]));
  const activeDefinitions = new Map(definitions.map(entity => [entity.id, entity]));
  const joints = new Map<string, PhysicsJointDefinition>();
  const terrains = new Map<string, TerrainGeometry>();
  const kinds = new Set(["step", "lifecycle", "move", "characterTarget", "velocity", "impulse", "angularVelocity", "torqueImpulse", "impulseAtPoint", "gravity", "gravityScale", "jointCreate", "jointDestroy", "terrainSet", "terrainRemove", "teleport", "reactions"]);
  kinds.add("resumeBodies");
  const vector = (value: unknown) => Array.isArray(value) && value.length === 3 &&
    [0, 1, 2].every(axis => typeof value[axis] === "number" && Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 1e12);
  let steps = 0;
  let jointOperations = false;
  let terrainOperations = false;
  let terrainSamples = 0;
  let openSubstep: { next: number; count: number; dt: number } | undefined;
  const expanded: unknown[] = [];
  for (const raw of history) {
    const group = raw as { kind?: unknown; actions?: unknown[] };
    if (group?.kind === "coupled") {
      if (Object.keys(group).length !== 2 || !Array.isArray(group.actions) || !group.actions.length || group.actions.length > 64) fail("Invalid coupled transaction.");
      const actions = group.actions ?? [];
      const native = actions.filter((child): child is { kind: string; substep?: { index: number; count: number } } => !!child && typeof child === "object" && (child as { kind?: unknown }).kind === "step");
      const count = native[0]?.substep?.count ?? 1;
      if (!native.length || native.length !== count || native.some((child, index) => (child.substep?.index ?? 0) !== index || (child.substep?.count ?? 1) !== count) ||
          actions.some(child => !child || typeof child !== "object" || !["step", "reactions"].includes((child as { kind: string }).kind))) fail("Coupled transaction omits or reorders substeps.");
      expanded.push(...actions);
    } else expanded.push(raw);
    if (expanded.length > 3200000) fail("Decoded physics history exceeds 3200000 operations.");
  }
  for (const raw of expanded) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Invalid history action.");
    const action = raw as { kind?: unknown; id?: unknown; created?: unknown; removed?: unknown; frame?: unknown; value?: unknown; point?: unknown; scale?: unknown; dt?: unknown; definition?: unknown; terrain?: unknown; transform?: unknown; resetVelocity?: unknown; substep?: { index: number; count: number }; values?: { id: string; impulse: unknown; torque: unknown }[] };
    if (typeof action.kind !== "string" || !kinds.has(action.kind)) fail("Unknown history action.");
    if (openSubstep && !["step", "impulse", "torqueImpulse", "impulseAtPoint", "reactions"].includes(action.kind as string)) fail("Only coupled reactions may occur between native substeps.");
    if (action.kind === "resumeBodies") {
      const data = raw as { bodies?: { id: string; state: ParkedBodyState }[] };
      if (Object.keys(data).length !== 2 || !Array.isArray(data.bodies) || data.bodies.length > 512) fail("Invalid parked body resume batch.");
      const seen = new Set<string>();
      for (const item of data.bodies ?? []) {
        if (!item || Object.keys(item).length !== 2 || seen.has(item.id) || !active.has(item.id)) fail("Invalid parked body identity.");
        validateParkedBody(item.state, active.get(item.id) === "character"); seen.add(item.id);
      }
      continue;
    }
    if (action.kind === "reactions") {
      if (Object.keys(action).length !== 2 || !Array.isArray(action.values) || action.values.length > 10000) fail("Invalid reaction batch.");
      const seen = new Set<string>();
      for (const value of action.values ?? []) {
        if (!value || Object.keys(value).length !== 3 || seen.has(value.id) || active.get(value.id) !== "dynamic" || activeDefinitions.get(value.id)?.rigidBody?.trigger || !vector(value.impulse) || !vector(value.torque)) fail("Invalid reaction body or vectors.");
        seen.add(value.id);
      }
      continue;
    }
    if (action.kind === "teleport") {
      if (Object.keys(action).length !== 4 || typeof action.id !== "string" || !activeDefinitions.has(action.id) || typeof action.resetVelocity !== "boolean" || !Object.hasOwn(action, "transform")) fail("Invalid teleport history fields.");
      checks.transform(action.transform as Transform, activeDefinitions.get(action.id as string)!);
      continue;
    }
    if (action.kind === "terrainSet" || action.kind === "terrainRemove") {
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, action.kind === "terrainSet" ? "terrain" : "id")) fail("Invalid terrain fields.");
      if (action.kind === "terrainSet") {
        const geometry = terrainGeometry(action.terrain as TerrainGeometry);
        terrainSamples += geometry.heights.length;
        if (terrainSamples > 8000000 || (!terrains.has(geometry.id) && terrains.size >= 128) || active.has(`$terrain/${geometry.id}`)) fail("Terrain history exceeds bounds or conflicts with an entity.");
        terrains.set(geometry.id, geometry);
      } else {
        if (typeof action.id !== "string" || !terrains.has(action.id)) fail("Invalid terrain removal.");
        terrains.delete(action.id as string);
      }
      terrainOperations = true;
      continue;
    }
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
    if (action.kind !== "step" && action.kind !== "lifecycle") {
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
        if (action.kind === "move" || action.kind === "characterTarget" ? type !== "character" : action.kind === "velocity" ? type !== "character" && type !== "dynamic" : type !== "dynamic")
          fail("History action is incompatible with its body type.");
      }
      continue;
    }
    const lifecycle = action.kind === "lifecycle";
    if (Object.keys(action).length !== (lifecycle ? 4 : action.substep === undefined ? 5 : 6) || ["kind", "frame", "created", "removed"].some(key => !Object.hasOwn(action, key))) fail("Invalid step fields.");
    if (!lifecycle && (typeof action.dt !== "number" || !Number.isFinite(action.dt) || action.dt < 1e-6 || action.dt > 1)) fail("Invalid physics timestep.");
    if (!Array.isArray(action.removed) || !Array.isArray(action.created) || !Array.isArray(action.frame))
      fail("Lifecycle history is missing a body list.");
    const part = action.substep;
    if (part !== undefined) {
      if (!part || typeof part !== "object" || Object.keys(part).length !== 2 || !Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.count) || part.count < 2 || part.count > 32 || part.index < 0 || part.index >= part.count ||
          (part.index === 0 ? openSubstep !== undefined : !openSubstep || openSubstep.next !== part.index || openSubstep.count !== part.count || openSubstep.dt !== action.dt)) fail("Invalid or unordered native substep.");
      if (part.index > 0 && ((action.created as unknown[]).length || (action.removed as unknown[]).length)) fail("Substep repeats lifecycle changes.");
      if (part.index === part.count - 1) { steps++; openSubstep = undefined; }
      else openSubstep = { next: part.index + 1, count: part.count, dt: action.dt as number };
    } else { if (openSubstep) fail("Lifecycle/whole-tick step interrupts substeps."); if (!lifecycle) steps++; }
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
  if (openSubstep || steps !== header.tick || header.entities.length !== active.size) fail("History has an incomplete tick or differs from snapshot bodies/tick.");
  const seen = new Set<string>();
  for (const entry of header.entities) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id) || !active.has(entry.id) || active.get(entry.id) !== entry.type)
      fail("Snapshot bodies differ from lifecycle history.");
    seen.add(entry.id);
  }
  if (header.bindings.some(id => !active.has(id))) fail("Snapshot binding has no active physics body.");
  if (terrainOperations !== (header.terrains !== undefined) || (terrainOperations && JSON.stringify([...terrains.values()].sort((a, b) => a.id.localeCompare(b.id, "en"))) !== JSON.stringify(header.terrains))) fail("Snapshot terrains differ from history.");
  if (jointOperations !== (header.joints !== undefined) ||
      (jointOperations && JSON.stringify([...joints.values()]) !== JSON.stringify(header.joints)))
    fail("Snapshot joints differ from lifecycle history.");
}

