import type { EntityIR, SceneIR } from "../../compiler/src/types.ts";
import type { PhysicsService, Vec3 } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";

/** Service intent comes from declarations, never from inspecting function source. */
export function planGameplayServices(ir: SceneIR) {
  const scenes = [ir.scene, ...(ir.scenes ?? [])];
  const definitions = [...ir.prefabs, ...scenes.flatMap(scene => scene.entities)];
  const authoredPhysics = definitions.some(entity => entity.rigidBody || entity.character);
  // User code can synchronously create terrain/cloth/ropes, enable grounding or
  // occlusion, and query physics before its first spawn. Prepare it conservatively.
  const runtime = ir.runtime !== undefined;
  const intent = ir.services?.physics3d ?? "auto";
  if (!["auto", "required", "disabled"].includes(intent))
    fail("SERVICE_PLAN", `Invalid services.physics3d in scene '${ir.scene.id}'; use auto, required or disabled.`);
  if (intent === "disabled" && authoredPhysics)
    fail("SERVICE_CONFLICT", `Scene '${ir.scene.id}' or a prefab declares physics while services.physics3d is disabled; use auto or required.`);
  return {
    physics3d: intent === "required" || intent === "auto" && (authoredPhysics || ir.systems.length > 0 || runtime) ? "native" : "empty",
    // Scene transitions call prepare again; the 2D owner requires the active configuration.
    physics2d: ir.scene.physics2d !== undefined,
  } as const;
}

/** The only production imports of the native backends are asynchronous edges. */
export async function preparePhysicsServices(ir: SceneIR): Promise<RuntimePluginFactory[]> {
  const plan = planGameplayServices(ir);
  const factories: RuntimePluginFactory[] = [];
  if (plan.physics2d) {
    const { createPhysics2DFactory } = await import("../../physics/physics2d.ts");
    factories.push(await createPhysics2DFactory());
  }
  if (plan.physics3d === "native") {
    const { createPhysicsFactory } = await import("../../physics/index.ts");
    factories.push(await createPhysicsFactory());
  } else factories.push(createEmptyPhysicsPlugin);
  return factories;
}

const fail = (code: string, message: string): never => {
  throw new Error(`TC_PHYSICS_${code}: ${message}`);
};
const vector = (value: Vec3, label: string): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3 ||
      ![0, 1, 2].every(i => typeof value[i] === "number" && Number.isFinite(value[i]) && Math.abs(value[i]!) <= 1e12))
    fail("VECTOR", `${label} must contain three finite numbers with magnitude <= 1e12.`);
  return [...value] as unknown as Vec3;
};
const dimension = (value: number, zero = false) => typeof value === "number" &&
  Number.isFinite(value) && value <= 1e6 && (zero && value === 0 || value > 0 && Math.fround(value) > 0);
type QueryOptions = { exclude?: readonly string[]; includeTriggers?: boolean };
function queryOptions(options: QueryOptions | undefined, code: string) {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "exclude" && key !== "includeTriggers") ||
      options.exclude !== undefined && (!Array.isArray(options.exclude) || !options.exclude.every(id => typeof id === "string")) ||
      options.includeTriggers !== undefined && typeof options.includeTriggers !== "boolean"))
    fail(code, "Query options require exclude string IDs and includeTriggers boolean.");
}

interface EmptySnapshot {
  format: "pelican.physics-empty";
  version: 1;
  scene: string;
  tick: number;
  gravity: Vec3;
}

/** No body creation API exists on PhysicsService. All spawnable definitions were
 * checked during prepare, so an empty world can answer synchronous queries without
 * importing WASM. User systems/runtime factories always receive the native owner. */
const createEmptyPhysicsPlugin: RuntimePluginFactory = context => {
  const catalog = structuredClone(context.scene);
  const initialGravity = vector(catalog.scene.gravity ?? [0, -9.81, 0], "gravity");
  const scene = JSON.stringify({ entities: catalog.scene.entities, prefabs: catalog.prefabs, gravity: initialGravity });
  let gravity = initialGravity, tick = 0, disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before accessing physics."); };
  const missing = (entity: string): never => {
    alive();
    return fail("ENTITY", `No physics body '${entity}' in scene '${catalog.scene.id}'. Declare a rigidBody or character on the entity or its prefab.`);
  };
  const assertEmpty = (entities: readonly Pick<EntityIR, "id" | "prefab">[]) => {
    for (const entity of entities) {
      const definition = resolveEntityDefinition(catalog, entity);
      if (definition?.rigidBody || definition?.character)
        fail("SERVICE_PLAN", `Unexpected physical entity '${entity.id}' in scene '${catalog.scene.id}'; prepare gameplay again after changing physics declarations.`);
    }
  };
  const snapshot = (): EmptySnapshot => {
    alive();
    return { format: "pelican.physics-empty", version: 1, scene, tick, gravity: [...gravity] as unknown as Vec3 };
  };
  const validate = (input: unknown): EmptySnapshot => {
    alive();
    const saved = structuredClone(input) as EmptySnapshot;
    if (!saved || saved.scene !== scene || !Number.isSafeInteger(saved.tick) || saved.tick < 0)
      return fail("SNAPSHOT", `Invalid empty-world state for scene '${catalog.scene.id}'; restore an intact checkpoint.`);
    if (saved.format === "pelican.physics-empty" && saved.version === 1) {
      if (Object.keys(saved).some(key => !["format", "version", "scene", "tick", "gravity"].includes(key)))
        return fail("SNAPSHOT", "Unknown empty-world snapshot field; restore an intact checkpoint.");
      return { ...saved, gravity: vector(saved.gravity, "snapshot gravity") };
    }
    // Older renderers registered Rapier even for worlds with no authored code or
    // bodies. Migrate the logical empty state; never retain opaque native bytes.
    const legacy = saved as unknown as Record<string, unknown>;
    const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
    if (legacy.format !== "pelican.physics-rapier3d" || legacy.version !== 3 ||
        legacy.checkpoint !== undefined || !Array.isArray(legacy.world) || !legacy.world.length ||
        legacy.world.length > 64 * 1024 * 1024 ||
        !legacy.world.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
        ![legacy.entities, legacy.characters, legacy.pairs, legacy.bindings].every(empty) ||
        legacy.joints !== undefined && !empty(legacy.joints) || legacy.terrains !== undefined && !empty(legacy.terrains) ||
        !Array.isArray(legacy.history) || legacy.history.length > 100000)
      return fail("SNAPSHOT", "Snapshot needs the native physics owner; set services.physics3d to required and prepare the original game before restoring it.");
    let migratedGravity = initialGravity, steps = 0;
    for (const action of legacy.history as Record<string, unknown>[]) {
      if (!action || typeof action !== "object") return fail("SNAPSHOT", "Invalid legacy empty-world history.");
      if (action.kind === "gravity") migratedGravity = vector(action.value as Vec3, "legacy gravity");
      else if (action.kind === "step" && typeof action.dt === "number" && Number.isFinite(action.dt) && action.dt > 0 &&
          empty(action.frame) && empty(action.created) && empty(action.removed) && action.substep === undefined) steps++;
      else if (action.kind === "lifecycle" && empty(action.frame) && empty(action.created) && empty(action.removed)) { /* no bodies */ }
      else return fail("SNAPSHOT", "Legacy snapshot contains native operations; set services.physics3d to required and prepare the original game before restoring it.");
    }
    if (steps !== saved.tick) return fail("SNAPSHOT", "Legacy empty-world tick differs from its history; restore an intact checkpoint.");
    return { format: "pelican.physics-empty", version: 1, scene, tick: saved.tick, gravity: migratedGravity };
  };
  const backendRequired = (): never => {
    alive();
    return fail("SERVICE_DISABLED", `Scene '${catalog.scene.id}' has no prepared 3D backend. Set services.physics3d to "required" before using terrain or rigid-body simulation bridges.`);
  };
  const reactions = (values: readonly unknown[]) => { alive(); if (values.length) backendRequired(); };
  const physics: PhysicsService = {
    moveCharacterTo: missing, teleport: missing, createJoint: definition => missing(definition.body1),
    destroyJoint(id) { alive(); fail("JOINT_MISSING", `Joint '${id}' does not exist; inspect listJoints before removing it.`); },
    inspectJoint(id) { alive(); return fail("JOINT_MISSING", `Joint '${id}' does not exist; inspect listJoints first.`); },
    listJoints() { alive(); return []; },
    setGravity(value) { alive(); gravity = vector(value, "gravity"); },
    gravity() { alive(); return [...gravity] as unknown as Vec3; },
    setGravityScale: missing, gravityScale: missing, moveCharacter: missing, grounded: missing,
    velocity: missing, centerOfMass: missing, setVelocity: missing, impulse: missing,
    angularVelocity: missing, setAngularVelocity: missing, torqueImpulse: missing, impulseAtPoint: missing,
    raycast(origin, direction, maxDistance, options) {
      alive(); vector(origin, "origin"); const d = vector(direction, "direction");
      if (!Number.isFinite(maxDistance) || maxDistance < 0 || maxDistance > 1e12) fail("DEFINITION", "maxDistance must be in [0,1e12].");
      if (!Math.hypot(...d)) fail("RAY", "Ray direction is zero; supply a nonzero direction.");
      queryOptions(options, "RAY"); return null;
    },
    castShape(shape, center, displacement, rotation = [0, 0, 0], options) {
      alive();
      if (!shape || typeof shape !== "object" || Array.isArray(shape)) fail("SWEEP", "Supply a sphere, box or capsule sweep shape.");
      if (shape.shape === "sphere" && Object.keys(shape).every(key => ["shape", "radius"].includes(key)) && dimension(shape.radius)) { /* valid */ }
      else if (shape.shape === "box" && Object.keys(shape).every(key => ["shape", "halfExtents"].includes(key)) && vector(shape.halfExtents, "halfExtents").every(n => dimension(n))) { /* valid */ }
      else if (shape.shape === "capsule" && Object.keys(shape).every(key => ["shape", "radius", "halfHeight"].includes(key)) && dimension(shape.radius) && dimension(shape.halfHeight, true)) { /* valid */ }
      else fail("SWEEP", "Use positive, float32-representable dimensions up to 1e6.");
      vector(center, "center"); vector(rotation, "rotation"); const travel = vector(displacement, "displacement");
      if (!Math.hypot(...travel.map(Math.fround))) fail("SWEEP", "Displacement must be nonzero and representable as float32; use overlap queries for a stationary shape.");
      queryOptions(options, "SWEEP"); return null;
    },
    overlapSphere(center, radius, options) {
      alive(); vector(center, "sphere center");
      if (!dimension(radius)) fail("OVERLAP", "Radius must be positive, float32-representable and at most 1e6.");
      queryOptions(options, "OVERLAP"); return [];
    },
    overlapBox(center, halfExtents, rotation = [0, 0, 0], options) {
      alive(); vector(center, "box center"); vector(rotation, "rotation");
      if (!vector(halfExtents, "halfExtents").every(n => dimension(n))) fail("OVERLAP", "Half-extents must be positive, float32-representable and at most 1e6.");
      queryOptions(options, "OVERLAP"); return [];
    },
    overlapCapsule(center, halfHeight, radius, rotation = [0, 0, 0], options) {
      alive(); vector(center, "capsule center"); vector(rotation, "rotation");
      if (!dimension(halfHeight, true) || !dimension(radius)) fail("OVERLAP", "Use nonnegative half-height and positive radius, float32-representable and at most 1e6.");
      queryOptions(options, "OVERLAP"); return [];
    },
  };
  return {
    id: "$engine.physics", version: "3", services: { physics },
    terrainPhysicsBridge: { setTerrain: backendRequired, removeTerrain: backendRequired },
    ropePhysicsBridge: {
      sampleSphere: backendRequired, sampleClothBody: backendRequired, sampleRopeBody: backendRequired, sampleParticleBody: backendRequired,
      applySphereReactions: reactions, applyClothReactions: reactions, applyRopeReactions: reactions, applyParticleReactions: reactions,
    },
    legacySnapshot: () => ({ format: "pelican.physics-empty", version: 1, scene, tick: 0, gravity: [...initialGravity] }),
    systems: [
      { id: "$engine.physics.bind", phase: "physics", before: ["$engine.physics"], beforeIfPresent: ["$engine.cinematics", "$engine.models"], run() { alive(); assertEmpty(context.world.records()); } },
      { id: "$engine.physics", phase: "physics", writes: ["Transform"], run(dt) {
        alive();
        if (context.advanceCoupledPhysics) context.advanceCoupledPhysics(dt, () => { tick++; }, () => {});
        else tick++;
      } },
    ],
    snapshot,
    validateSnapshot(value) { validate(value); },
    validateWorld(value, world: WorldSnapshot) { validate(value); assertEmpty(world.entities); },
    restore(value) { const saved = validate(value); gravity = saved.gravity; tick = saved.tick; },
    inspect() { alive(); return { tick, replay: { checkpointTick: tick, operations: 0, decodedOperations: 0 }, bodies: [] }; },
    dispose() { disposed = true; },
  };
};
