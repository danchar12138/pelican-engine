import RAPIER from "@dimforge/rapier2d-compat";
import type { EntityHandle, Physics2DBodyDefinition, Physics2DBodyState, Physics2DCharacterOptions, Physics2DCharacterState, Physics2DJointDefinition, Physics2DService, Transform, Vec2 } from "../sdk/src/index.ts";
import type { WorldSnapshot } from "../runtime/src/contracts.ts";
import type { RuntimePluginContext, RuntimePluginFactory } from "../runtime/src/plugins.ts";
import { cloneSerializable } from "../runtime/src/random.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";

type Definition = Physics2DBodyDefinition & { friction: number; restitution: number; sensor: boolean; continuous: boolean };
type BodySnapshot = { definition: Definition; prefab: string | null; lastTransform: Transform; position: Vec2; angle: number; velocity: Vec2; angularVelocity: number; sleeping: boolean };
type JointDefinition = Physics2DJointDefinition & { anchorA: Vec2; anchorB: Vec2; contactsEnabled: boolean };
type CharacterOptions = { offset: number; snapToGround: number; maxSlope: number };
type CharacterSnapshot = { body: string; options: CharacterOptions; requested: Vec2; movement: Vec2; grounded: boolean; deferred: boolean };
type Snapshot = { format: "pelican.physics2d"; version: 1; gravity: Vec2; tick: number; bodies: BodySnapshot[]; joints?: JointDefinition[]; characters?: CharacterSnapshot[] };
type Body = { definition: Definition; prefab: string | null; handle: EntityHandle; lastTransform: Transform; body: RAPIER.RigidBody; collider?: RAPIER.Collider };
type Joint = { definition: JointDefinition; joint: RAPIER.ImpulseJoint };
type Character = CharacterSnapshot & { controller: RAPIER.KinematicCharacterController };
type Native = { world: RAPIER.World; queue: RAPIER.EventQueue; bodies: Map<string, Body>; colliders: Map<number, Body>; joints: Map<string, Joint>; characters: Map<string, Character> };
const MAX_BODIES = 512, MAX_JOINTS = 512, MAX_CHARACTERS = 128, MAX_COMPOUND_PARTS = 2048, LIMIT = 1e6;
const fail = (code: string, message: string): never => { throw new Error(`TC_PHYSICS2D_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function scalar(value: unknown, label: string, min = -LIMIT, max = LIMIT): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || !Number.isFinite(Math.fround(value)) ||
      (value !== 0 && Math.fround(value) === 0))
    return fail("VALUE", `${label} must be finite and float32-representable in [${min}, ${max}].`);
  return value;
}
function positive(value: unknown, label: string, max = LIMIT): number {
  const result = scalar(value, label, 0, max);
  if (result <= 0 || Math.fround(result) === 0) return fail("VALUE", `${label} must be positive and float32-representable.`);
  return result;
}
function pair(value: unknown, label: string, requirePositive = false): Vec2 {
  if (!Array.isArray(value) || value.length !== 2) return fail("VECTOR", `${label} must contain two numbers.`);
  return requirePositive ? [positive(value[0], `${label}.x`), positive(value[1], `${label}.y`)] :
    [scalar(value[0], `${label}.x`), scalar(value[1], `${label}.y`)];
}
const vector = (value: Vec2) => ({ x: value[0], y: value[1] });
function planar(transform: Transform, entity: string): Transform {
  if (!transform || !Array.isArray(transform.position) || transform.position.length !== 3 ||
      !Array.isArray(transform.rotation) || transform.rotation.length !== 3 || !Array.isArray(transform.scale) || transform.scale.length !== 3 ||
      transform.position.some(value => typeof value !== "number" || !Number.isFinite(value)) ||
      transform.rotation.some(value => typeof value !== "number" || !Number.isFinite(value)) ||
      transform.scale.some(value => value !== 1) || transform.rotation[0] !== 0 || transform.rotation[1] !== 0)
    return fail("TRANSFORM", `Entity '${entity}' must be a root with unit scale and rotation only around Z; use XY for 2D physics.`);
  scalar(transform.position[0], `${entity}.x`); scalar(transform.position[1], `${entity}.y`); scalar(transform.rotation[2], `${entity}.angle`);
  return cloneSerializable(transform);
}
function normalize(input: Physics2DBodyDefinition): Definition {
  if (!fields(input, ["id", "entity", "type", "collider", "mass", "friction", "restitution", "sensor", "continuous"]) ||
      !validName(input.id) || !validName(input.entity) || !["fixed", "dynamic", "kinematic"].includes(input.type) || !input.collider)
    return fail("DEFINITION", "Body needs nonempty id/entity, fixed/dynamic/kinematic type and a collider.");
  const raw = input.collider;
  let collider: Physics2DBodyDefinition["collider"];
  if (raw.shape === "box" && fields(raw, ["shape", "halfExtents", "offset"])) {
    const offset = raw.offset === undefined ? undefined : pair(raw.offset, "collider offset");
    collider = { shape: "box", halfExtents: pair(raw.halfExtents, "halfExtents", true), ...(offset ? { offset } : {}) };
  } else if (raw.shape === "circle" && fields(raw, ["shape", "radius", "offset"])) {
    const offset = raw.offset === undefined ? undefined : pair(raw.offset, "collider offset");
    collider = { shape: "circle", radius: positive(raw.radius, "radius"), ...(offset ? { offset } : {}) };
  } else if (raw.shape === "capsule" && fields(raw, ["shape", "halfHeight", "radius", "offset"])) {
    const offset = raw.offset === undefined ? undefined : pair(raw.offset, "collider offset");
    collider = { shape: "capsule", halfHeight: scalar(raw.halfHeight, "halfHeight", 0), radius: positive(raw.radius, "radius"), ...(offset ? { offset } : {}) };
  } else if (raw.shape === "compound" && fields(raw, ["shape", "parts"]) && Array.isArray(raw.parts) && raw.parts.length <= MAX_COMPOUND_PARTS) {
    if (input.type !== "fixed") return fail("COLLIDER", "Compound colliders currently require a fixed body.");
    collider = { shape: "compound", parts: raw.parts.map(part => {
      if (!fields(part, ["halfExtents", "offset"])) return fail("COLLIDER", "Each compound part needs halfExtents and offset.");
      return { halfExtents: pair(part.halfExtents, "halfExtents", true), offset: pair(part.offset, "collider offset") };
    }) };
  } else return fail("COLLIDER", `Collider must be a box, circle, capsule or fixed-body compound with at most ${MAX_COMPOUND_PARTS} boxes.`);
  if ((input.sensor !== undefined && typeof input.sensor !== "boolean") || (input.continuous !== undefined && typeof input.continuous !== "boolean"))
    return fail("DEFINITION", "sensor and continuous must be boolean.");
  if (input.type !== "dynamic" && (input.mass !== undefined || input.continuous === true))
    return fail("DEFINITION", "mass and continuous collision detection apply only to dynamic bodies.");
  return { id: input.id, entity: input.entity, type: input.type, collider,
    ...(input.mass === undefined ? {} : { mass: positive(input.mass, "mass") }),
    friction: input.friction === undefined ? 0.5 : scalar(input.friction, "friction", 0),
    restitution: input.restitution === undefined ? 0 : scalar(input.restitution, "restitution", 0, 1),
    sensor: input.sensor === true, continuous: input.continuous === true };
}
function jointDefinition(input: Physics2DJointDefinition): JointDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input) || !validName(input.id) || !validName(input.bodyA) || !validName(input.bodyB) || input.bodyA === input.bodyB)
    return fail("JOINT_DEFINITION", "Joint needs a nonempty id and two distinct body ids.");
  const baseKeys = ["id", "kind", "bodyA", "bodyB", "anchorA", "anchorB", "contactsEnabled"];
  const extra = input.kind === "fixed" ? ["frameA", "frameB"] : input.kind === "rope" ? ["length"] : input.kind === "spring" ? ["restLength", "stiffness", "damping"] : [];
  if (!fields(input, [...baseKeys, ...extra]) || !["fixed", "revolute", "rope", "spring"].includes(input.kind) ||
      (input.contactsEnabled !== undefined && typeof input.contactsEnabled !== "boolean"))
    return fail("JOINT_DEFINITION", "Use fixed, revolute, rope or spring joint fields and a boolean contactsEnabled.");
  const base = { id: input.id, bodyA: input.bodyA, bodyB: input.bodyB,
    anchorA: input.anchorA === undefined ? [0, 0] as Vec2 : pair(input.anchorA, "anchorA"),
    anchorB: input.anchorB === undefined ? [0, 0] as Vec2 : pair(input.anchorB, "anchorB"),
    contactsEnabled: input.contactsEnabled === true };
  if (input.kind === "fixed") return { ...base, kind: "fixed", frameA: input.frameA === undefined ? 0 : scalar(input.frameA, "frameA"), frameB: input.frameB === undefined ? 0 : scalar(input.frameB, "frameB") };
  if (input.kind === "revolute") return { ...base, kind: "revolute" };
  if (input.kind === "rope") return { ...base, kind: "rope", length: positive(input.length, "rope length") };
  return { ...base, kind: "spring", restLength: scalar(input.restLength, "spring restLength", 0),
    stiffness: scalar(input.stiffness, "spring stiffness", 0), damping: scalar(input.damping, "spring damping", 0) };
}
function characterOptions(input: Physics2DCharacterOptions): CharacterOptions {
  if (!fields(input, ["offset", "snapToGround", "maxSlope"])) return fail("CHARACTER_OPTIONS", "Character options accept offset, snapToGround and maxSlope.");
  return { offset: input.offset === undefined ? 0.01 : positive(input.offset, "character offset"),
    snapToGround: input.snapToGround === undefined ? 0 : scalar(input.snapToGround, "snapToGround", 0),
    maxSlope: input.maxSlope === undefined ? Math.PI / 4 : scalar(input.maxSlope, "maxSlope", 0, Math.PI / 2) };
}
function makeNative(gravity: Vec2): Native {
  const world = new RAPIER.World(vector(gravity));
  try { return { world, queue: new RAPIER.EventQueue(true), bodies: new Map(), colliders: new Map(), joints: new Map(), characters: new Map() }; }
  catch (error) {
    try { world.free(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_INIT_CLEANUP: 2D world initialization and cleanup failed; inspect the causes."); }
    throw error;
  }
}
function freeNative(native: Native): void {
  const errors: unknown[] = [];
  for (const character of native.characters.values())
    try { native.world.removeCharacterController(character.controller); } catch (error) { errors.push(error); }
  native.characters.clear();
  try { native.world.free(); } catch (error) { errors.push(error); }
  try { native.queue.free(); } catch (error) { errors.push(error); }
  native.bodies.clear(); native.colliders.clear(); native.joints.clear();
  if (errors.length) throw new AggregateError(errors, "TC_PHYSICS2D_DISPOSE: Some 2D physics resources could not be released; inspect causes and restart the scene.");
}
function colliderDescriptor(definition: Definition): RAPIER.ColliderDesc | null {
  const shape = definition.collider;
  let descriptor: RAPIER.ColliderDesc;
  if (shape.shape === "box") descriptor = RAPIER.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1]);
  else if (shape.shape === "circle") descriptor = RAPIER.ColliderDesc.ball(shape.radius);
  else if (shape.shape === "capsule") descriptor = RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
  else {
    if (!shape.parts.length) return null;
    descriptor = RAPIER.ColliderDesc.compound(shape.parts.map(part => new RAPIER.Cuboid(part.halfExtents[0], part.halfExtents[1])),
      shape.parts.map(part => vector(part.offset)), shape.parts.map(() => 0));
  }
  const offset = shape.shape === "compound" ? [0, 0] : shape.offset ?? [0, 0];
  descriptor.setTranslation(offset[0], offset[1]).setFriction(definition.friction).setRestitution(definition.restitution)
    .setSensor(definition.sensor).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
  if (definition.mass !== undefined) descriptor.setMass(definition.mass);
  return descriptor;
}
function addNative(native: Native, definition: Definition, handle: EntityHandle, transform: Transform, prefab: string | null, saved?: BodySnapshot): Body {
  const position = saved?.position ?? [transform.position[0], transform.position[1]], angle = saved?.angle ?? transform.rotation[2];
  const descriptor = definition.type === "dynamic" ? RAPIER.RigidBodyDesc.dynamic() :
    definition.type === "fixed" ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased();
  descriptor.setTranslation(position[0], position[1]).setRotation(angle);
  if (definition.continuous) descriptor.setCcdEnabled(true);
  const body = native.world.createRigidBody(descriptor);
  try {
    const descriptor = colliderDescriptor(definition);
    const collider = descriptor ? native.world.createCollider(descriptor, body) : undefined;
    if (saved && definition.type === "dynamic") {
      body.setLinvel(vector(saved.velocity), true); body.setAngvel(saved.angularVelocity, true);
      if (saved.sleeping) body.sleep();
    }
    const entry: Body = { definition, handle, prefab, lastTransform: saved?.lastTransform ?? transform, body, ...(collider ? { collider } : {}) };
    native.bodies.set(definition.id, entry); if (collider) native.colliders.set(collider.handle, entry);
    return entry;
  } catch (error) {
    try { native.world.removeRigidBody(body); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_CREATE_CLEANUP: Body creation and cleanup failed; partialState=true. Restore a known-good checkpoint."); }
    throw error;
  }
}
function addNativeJoint(native: Native, definition: JointDefinition): Joint {
  const a = native.bodies.get(definition.bodyA), b = native.bodies.get(definition.bodyB);
  if (!a || !b) return fail("JOINT_BODY", `Joint '${definition.id}' requires both existing 2D bodies.`);
  const anchorA = vector(definition.anchorA), anchorB = vector(definition.anchorB);
  const descriptor = definition.kind === "fixed" ? RAPIER.JointData.fixed(anchorA, definition.frameA ?? 0, anchorB, definition.frameB ?? 0) :
    definition.kind === "revolute" ? RAPIER.JointData.revolute(anchorA, anchorB) :
    definition.kind === "rope" ? RAPIER.JointData.rope(definition.length, anchorA, anchorB) :
    RAPIER.JointData.spring(definition.restLength, definition.stiffness, definition.damping, anchorA, anchorB);
  let joint: RAPIER.ImpulseJoint | undefined;
  try {
    joint = native.world.createImpulseJoint(descriptor, a.body, b.body, true);
    joint.setContactsEnabled(definition.contactsEnabled);
    const entry = { definition, joint }; native.joints.set(definition.id, entry); return entry;
  } catch (error) {
    const failures: unknown[] = [error];
    if (joint) try { native.world.removeImpulseJoint(joint, true); } catch (cleanup) { failures.push(cleanup); }
    throw new AggregateError(failures, `TC_PHYSICS2D_JOINT_CREATE: Joint '${definition.id}' could not be created safely; partialState=true. Restore a known-good checkpoint.`);
  }
}
function addNativeCharacter(native: Native, saved: CharacterSnapshot): Character {
  const body = native.bodies.get(saved.body);
  if (!body || body.definition.type !== "kinematic" || body.definition.sensor || !body.collider)
    return fail("CHARACTER_BODY", `Character '${saved.body}' requires a non-sensor kinematic body with a collider.`);
  let controller: RAPIER.KinematicCharacterController | undefined;
  try {
    controller = native.world.createCharacterController(saved.options.offset);
    controller.setUp({ x: 0, y: 1 });
    controller.setSlideEnabled(true);
    controller.setApplyImpulsesToDynamicBodies(false);
    controller.setMaxSlopeClimbAngle(saved.options.maxSlope);
    if (saved.options.snapToGround > 0) controller.enableSnapToGround(saved.options.snapToGround);
    const entry = { ...saved, controller }; native.characters.set(saved.body, entry); return entry;
  } catch (error) {
    const failures: unknown[] = [error];
    if (controller) try { native.world.removeCharacterController(controller); } catch (cleanup) { failures.push(cleanup); }
    throw new AggregateError(failures, `TC_PHYSICS2D_CHARACTER_CREATE: Controller '${saved.body}' could not be created safely; partialState=true. Restore a known-good checkpoint.`);
  }
}
function bodyState(entry: Body): Physics2DBodyState {
  const position = entry.body.translation(), velocity = entry.body.linvel();
  return { id: entry.definition.id, entity: entry.definition.entity, type: entry.definition.type,
    position: pair([position.x, position.y], "body position"), angle: scalar(entry.body.rotation(), "body angle"),
    velocity: pair([velocity.x, velocity.y], "body velocity"), angularVelocity: scalar(entry.body.angvel(), "angular velocity"),
    sleeping: entry.definition.type === "dynamic" && entry.body.isSleeping() };
}
function parse(value: unknown): Snapshot {
  const data = cloneSerializable(value) as Snapshot;
  if (!fields(data, ["format", "version", "gravity", "tick", "bodies", "joints", "characters"]) || data.format !== "pelican.physics2d" || data.version !== 1 ||
      !Number.isSafeInteger(data.tick) || data.tick < 0 || !Array.isArray(data.bodies) || data.bodies.length > MAX_BODIES ||
      (data.joints !== undefined && (!Array.isArray(data.joints) || data.joints.length > MAX_JOINTS)) ||
      (data.characters !== undefined && (!Array.isArray(data.characters) || data.characters.length > MAX_CHARACTERS)))
    return fail("SNAPSHOT", "Expected a bounded version 1 2D physics snapshot.");
  const ids = new Set<string>(), entities = new Set<string>();
  const bodies = data.bodies.map(item => {
    if (!fields(item, ["definition", "prefab", "lastTransform", "position", "angle", "velocity", "angularVelocity", "sleeping"]) ||
        !(item.prefab === null || validName(item.prefab)) || typeof item.sleeping !== "boolean") return fail("SNAPSHOT", "Invalid 2D body state.");
    const definition = normalize(item.definition);
    if (ids.has(definition.id) || entities.has(definition.entity)) return fail("SNAPSHOT", "Body ids and entity bindings must be unique.");
    ids.add(definition.id); entities.add(definition.entity);
    if (definition.type !== "dynamic" && item.sleeping) return fail("SNAPSHOT", "Only dynamic bodies may be sleeping.");
    const velocity = pair(item.velocity, "body velocity"), angularVelocity = scalar(item.angularVelocity, "angular velocity");
    if (definition.type === "fixed" && (velocity[0] !== 0 || velocity[1] !== 0 || angularVelocity !== 0))
      return fail("SNAPSHOT", "Fixed bodies cannot have velocity.");
    return { definition, prefab: item.prefab, lastTransform: planar(item.lastTransform, definition.entity),
      position: pair(item.position, "body position"), angle: scalar(item.angle, "body angle"), velocity, angularVelocity, sleeping: item.sleeping };
  });
  const jointIds = new Set<string>();
  const joints = (data.joints ?? []).map(value => {
    const joint = jointDefinition(value);
    if (jointIds.has(joint.id) || !ids.has(joint.bodyA) || !ids.has(joint.bodyB))
      return fail("SNAPSHOT", `Joint '${joint.id}' must be unique and reference two saved bodies.`);
    jointIds.add(joint.id); return joint;
  });
  const characterIds = new Set<string>(), definitions = new Map(bodies.map(item => [item.definition.id, item.definition]));
  const characters = (data.characters ?? []).map(value => {
    if (!fields(value, ["body", "options", "requested", "movement", "grounded", "deferred"]) || !validName(value.body) || characterIds.has(value.body) ||
        typeof value.grounded !== "boolean" || typeof value.deferred !== "boolean") return fail("SNAPSHOT", "Invalid or duplicate character state.");
    const body = definitions.get(value.body);
    if (!body || body.type !== "kinematic" || body.sensor || body.collider.shape === "compound")
      return fail("SNAPSHOT", `Character '${value.body}' requires a saved non-sensor kinematic body.`);
    characterIds.add(value.body);
    return { body: value.body, options: characterOptions(value.options), requested: pair(value.requested, "character request"),
      movement: pair(value.movement, "character movement"), grounded: value.grounded, deferred: value.deferred };
  });
  return { format: "pelican.physics2d", version: 1, gravity: pair(data.gravity, "gravity"), tick: data.tick, bodies, joints, characters };
}
function validateWorld(snapshot: Snapshot, world: WorldSnapshot, context: RuntimePluginContext): void {
  const records = new Map(world.entities.map(record => [record.id, record]));
  for (const item of snapshot.bodies) {
    const entity = item.definition.entity, record = records.get(entity);
    if (!record || record.parent !== undefined || (record.prefab ?? null) !== item.prefab)
      return fail("SNAPSHOT", `Body '${item.definition.id}' needs its original live root entity '${entity}'.`);
    planar(record.transform, entity);
    const definition = resolveEntityDefinition(context.scene, record);
    if (definition?.rigidBody || definition?.character)
      return fail("SNAPSHOT", `Entity '${entity}' cannot bind both 2D and 3D physics.`);
  }
}
let initialization: Promise<RuntimePluginFactory> | undefined;
export function createPhysics2DFactory(): Promise<RuntimePluginFactory> {
  if (!initialization) initialization = RAPIER.init().then(() => createPhysics2DPlugin).catch(error => {
    initialization = undefined;
    throw new Error("TC_PHYSICS2D_INIT: Unable to initialize the 2D physics backend; check package installation and reload.", { cause: error });
  });
  return initialization;
}
const createPhysics2DPlugin: RuntimePluginFactory = context => {
  if (!context.scene.scene.physics2d) return fail("DISABLED", "Enable scene.physics2d before creating the 2D physics plugin.");
  let gravity = pair(context.scene.scene.physics2d.gravity, "gravity"), tick = 0, native = makeNative(gravity), disposed = false, dirty = true, nativeFault = false;
  const ensureOpen = () => { if (disposed) fail("DISPOSED", "Create a new host before using 2D physics."); };
  const alive = () => { ensureOpen(); if (nativeFault) fail("FAULTED", "2D physics may be partially changed; restore a known-good host checkpoint or restart the scene."); };
  const mutate = (label: string, action: () => void) => {
    try { action(); }
    catch (error) { nativeFault = true; throw new AggregateError([error], `TC_PHYSICS2D_NATIVE: ${label} failed; partialState=true. Restore a known-good host checkpoint.`); }
  };
  const readBody = (entry: Body): Physics2DBodyState => {
    try { return bodyState(entry); }
    catch (error) { nativeFault = true; throw new AggregateError([error], `TC_PHYSICS2D_NATIVE: Reading body '${entry.definition.id}' failed; partialState=true. Restore a known-good host checkpoint.`); }
  };
  const get = (id: string): Body => {
    alive();
    if (!validName(id)) return fail("ID", "Expected a nonempty body id.");
    const entry = native.bodies.get(id);
    if (!entry || !context.world.isAlive(entry.handle)) return fail("MISSING", `Body '${id}' or its entity no longer exists.`);
    return entry;
  };
  const overlap = (center: Vec2, angle: number, shape: RAPIER.Shape, options: { exclude?: readonly string[]; includeSensors?: boolean }): string[] => {
    alive();
    if (dirty || tick === 0) return fail("QUERY_PENDING", "Queries require a completed physics step after body creation, removal or restore.");
    if (!fields(options, ["exclude", "includeSensors"]) || (options.exclude !== undefined && (!Array.isArray(options.exclude) || options.exclude.some(id => !validName(id)))) ||
        (options.includeSensors !== undefined && typeof options.includeSensors !== "boolean")) return fail("QUERY", "Overlap options require body-id exclusions and an optional includeSensors boolean.");
    const excluded = new Set(options.exclude ?? []), found = new Set<string>();
    try {
      native.world.intersectionsWithShape(vector(center), angle, shape, collider => {
        const entry = native.colliders.get(collider.handle);
        if (entry && context.world.isAlive(entry.handle) && !excluded.has(entry.definition.id) && (options.includeSensors === true || !entry.definition.sensor)) found.add(entry.definition.id);
        return true;
      });
    } catch (error) {
      nativeFault = true;
      throw new AggregateError([error], "TC_PHYSICS2D_QUERY_NATIVE: Overlap query failed; partialState=true. Restore a known-good host checkpoint.");
    }
    return [...found].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  };
  const checkEntity = (handle: EntityHandle): { transform: Transform; prefab: string | null } => {
    const identity = context.world.identity(handle);
    if (identity.parent !== undefined) return fail("TRANSFORM", `Entity '${identity.id}' must be a root for 2D physics.`);
    const definition = resolveEntityDefinition(context.scene, identity);
    if (definition?.rigidBody || definition?.character) return fail("BODY_CONFLICT", `Entity '${identity.id}' cannot bind both 2D and 3D physics.`);
    return { transform: planar(context.world.getTransform(handle), identity.id), prefab: identity.prefab ?? null };
  };
  const remove = (entry: Body) => {
    const colliderHandle = entry.collider?.handle, character = native.characters.get(entry.definition.id);
    if (character) {
      mutate(`Removing character '${entry.definition.id}'`, () => native.world.removeCharacterController(character.controller));
      native.characters.delete(entry.definition.id);
    }
    mutate(`Removing body '${entry.definition.id}'`, () => native.world.removeRigidBody(entry.body));
    if (colliderHandle !== undefined) native.colliders.delete(colliderHandle);
    for (const [id, joint] of native.joints)
      if (joint.definition.bodyA === entry.definition.id || joint.definition.bodyB === entry.definition.id) native.joints.delete(id);
    native.bodies.delete(entry.definition.id); dirty = true;
  };
  const service: Physics2DService = {
    create(input) {
      alive();
      const definition = normalize(cloneSerializable(input));
      if (native.bodies.has(definition.id)) return fail("DUPLICATE", `Body '${definition.id}' already exists.`);
      if ([...native.bodies.values()].some(item => item.definition.entity === definition.entity))
        return fail("BODY_CONFLICT", `Entity '${definition.entity}' already has a 2D body; destroy it first.`);
      if (native.bodies.size >= MAX_BODIES) return fail("CAPACITY", `At most ${MAX_BODIES} 2D bodies may exist.`);
      if (!context.world.isAlive(definition.entity)) return fail("ENTITY", `Entity '${definition.entity}' is not alive.`);
      const handle = context.world.resolve(definition.entity), checked = checkEntity(handle);
      mutate(`Creating body '${definition.id}'`, () => { addNative(native, definition, handle, checked.transform, checked.prefab); }); dirty = true;
    },
    destroy(id) { remove(get(id)); },
    setCollider(id, input) {
      const entry = get(id);
      if (entry.definition.type !== "fixed") return fail("BODY_TYPE", "Collider replacement currently requires a fixed body.");
      const next = normalize({ ...entry.definition, collider: cloneSerializable(input) });
      const descriptor = colliderDescriptor(next), previous = entry.collider, previousHandle = previous?.handle;
      let replacement: RAPIER.Collider | undefined;
      try { if (descriptor) replacement = native.world.createCollider(descriptor, entry.body); }
      catch (error) { dirty = true; nativeFault = true; throw new AggregateError([error], `TC_PHYSICS2D_COLLIDER_REPLACE: Could not create collider for '${id}'; partialState=true. Restore a known-good checkpoint.`); }
      try { if (previous) native.world.removeCollider(previous, true); }
      catch (error) {
        const failures: unknown[] = [error];
        if (replacement) try { native.world.removeCollider(replacement, true); } catch (cleanup) { failures.push(cleanup); }
        dirty = true; nativeFault = true;
        throw new AggregateError(failures, `TC_PHYSICS2D_COLLIDER_REPLACE: Could not remove the previous collider for '${id}'; partialState=true. Restore a known-good checkpoint.`);
      }
      if (previousHandle !== undefined) native.colliders.delete(previousHandle);
      entry.collider = replacement;
      if (replacement) native.colliders.set(replacement.handle, entry);
      entry.definition = next; dirty = true;
    },
    collider(id) { return cloneSerializable(get(id).definition.collider); },
    createJoint(input) {
      alive();
      const definition = jointDefinition(cloneSerializable(input));
      if (native.joints.has(definition.id)) return fail("JOINT_DUPLICATE", `Joint '${definition.id}' already exists.`);
      if (native.joints.size >= MAX_JOINTS) return fail("CAPACITY", `At most ${MAX_JOINTS} 2D joints may exist.`);
      get(definition.bodyA); get(definition.bodyB);
      try { addNativeJoint(native, definition); } catch (error) { nativeFault = true; throw error; }
    },
    destroyJoint(id) {
      alive();
      if (!validName(id)) return fail("JOINT_DEFINITION", "Expected a nonempty joint id.");
      const entry = native.joints.get(id);
      if (!entry) return fail("JOINT_MISSING", `Joint '${id}' does not exist.`);
      try { native.world.removeImpulseJoint(entry.joint, true); }
      catch (error) { nativeFault = true; throw new AggregateError([error], `TC_PHYSICS2D_JOINT_REMOVE: Joint '${id}' could not be removed; partialState=true. Restore a known-good checkpoint.`); }
      native.joints.delete(id);
    },
    inspectJoint(id) {
      alive();
      const entry = native.joints.get(id);
      if (!entry || !context.world.isAlive(native.bodies.get(entry.definition.bodyA)!.handle) || !context.world.isAlive(native.bodies.get(entry.definition.bodyB)!.handle))
        return fail("JOINT_MISSING", `Joint '${id}' or one of its bodies no longer exists.`);
      return cloneSerializable(entry.definition);
    },
    listJoints() {
      alive();
      return [...native.joints.values()].filter(entry => context.world.isAlive(native.bodies.get(entry.definition.bodyA)!.handle) && context.world.isAlive(native.bodies.get(entry.definition.bodyB)!.handle))
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0).map(entry => cloneSerializable(entry.definition));
    },
    attachCharacter(id, input = {}) {
      const entry = get(id), options = characterOptions(cloneSerializable(input));
      if (native.characters.has(id)) return fail("CHARACTER_DUPLICATE", `Character '${id}' is already attached.`);
      if (native.characters.size >= MAX_CHARACTERS) return fail("CAPACITY", `At most ${MAX_CHARACTERS} characters may exist.`);
      if (entry.definition.type !== "kinematic" || entry.definition.sensor || !entry.collider)
        return fail("CHARACTER_BODY", `Character '${id}' requires a non-sensor kinematic body with a collider.`);
      const saved: CharacterSnapshot = { body: id, options, requested: [0, 0], movement: [0, 0], grounded: false, deferred: dirty };
      try { addNativeCharacter(native, saved); } catch (error) { nativeFault = true; throw error; }
    },
    detachCharacter(id) {
      get(id);
      const character = native.characters.get(id);
      if (!character) return fail("CHARACTER_MISSING", `Character '${id}' is not attached.`);
      mutate(`Removing character '${id}'`, () => native.world.removeCharacterController(character.controller));
      native.characters.delete(id);
    },
    moveCharacter(id, value) {
      get(id);
      const character = native.characters.get(id);
      if (!character) return fail("CHARACTER_MISSING", `Character '${id}' is not attached.`);
      const delta = pair(value, "character displacement");
      character.requested = [scalar(character.requested[0] + delta[0], "accumulated displacement.x"),
        scalar(character.requested[1] + delta[1], "accumulated displacement.y")];
    },
    characterState(id): Physics2DCharacterState {
      get(id);
      const character = native.characters.get(id);
      if (!character) return fail("CHARACTER_MISSING", `Character '${id}' is not attached.`);
      return cloneSerializable({ body: id, requested: character.requested, movement: character.movement, grounded: character.grounded, deferred: character.deferred });
    },
    setVelocity(id, value) { const entry = get(id), velocity = pair(value, "velocity"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Velocity requires a dynamic body."); mutate(`Setting velocity for '${id}'`, () => entry.body.setLinvel(vector(velocity), true)); },
    setAngularVelocity(id, value) { const entry = get(id), velocity = scalar(value, "angular velocity"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Angular velocity requires a dynamic body."); mutate(`Setting angular velocity for '${id}'`, () => entry.body.setAngvel(velocity, true)); },
    applyImpulse(id, value) { const entry = get(id), impulse = pair(value, "impulse"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Impulse requires a dynamic body."); mutate(`Applying impulse to '${id}'`, () => entry.body.applyImpulse(vector(impulse), true)); },
    setGravity(value) { alive(); const next = pair(value, "gravity"); mutate("Setting gravity", () => { native.world.gravity = vector(next); }); gravity = next; },
    gravity() { alive(); return [...gravity] as Vec2; },
    inspect(id) { return readBody(get(id)); },
    overlapCircle(center, radius, options = {}) {
      return overlap(pair(center, "circle center"), 0, new RAPIER.Ball(positive(radius, "circle radius")), options);
    },
    overlapBox(center, halfExtents, angle = 0, options = {}) {
      const size = pair(halfExtents, "box halfExtents", true);
      return overlap(pair(center, "box center"), scalar(angle, "box angle"), new RAPIER.Cuboid(size[0], size[1]), options);
    },
    raycast(origin, direction, maxDistance, options = {}) {
      alive();
      if (dirty || tick === 0) return fail("QUERY_PENDING", "Queries require a completed physics step after body creation, removal or restore.");
      const start = pair(origin, "ray origin"), dir = pair(direction, "ray direction"), distance = positive(maxDistance, "maxDistance");
      if (!fields(options, ["exclude", "includeSensors"]) || (options.exclude !== undefined && (!Array.isArray(options.exclude) || options.exclude.some(id => !validName(id)))) ||
          (options.includeSensors !== undefined && typeof options.includeSensors !== "boolean")) return fail("QUERY", "Ray options require body-id exclusions and an optional includeSensors boolean.");
      const length = Math.hypot(dir[0], dir[1]);
      if (!Number.isFinite(length) || length === 0) return fail("QUERY", "Ray direction must be nonzero.");
      const normalized: Vec2 = [dir[0] / length, dir[1] / length], excluded = new Set(options.exclude ?? []);
      let hit: ReturnType<RAPIER.World["castRayAndGetNormal"]>;
      try {
        hit = native.world.castRayAndGetNormal(new RAPIER.Ray(vector(start), vector(normalized)), distance, true, undefined, undefined, undefined, undefined,
          collider => { const entry = native.colliders.get(collider.handle); return !!entry && context.world.isAlive(entry.handle) && !excluded.has(entry.definition.id) && (options.includeSensors === true || !entry.definition.sensor); });
      } catch (error) {
        nativeFault = true;
        throw new AggregateError([error], "TC_PHYSICS2D_QUERY_NATIVE: Ray query failed; partialState=true. Restore a known-good host checkpoint.");
      }
      if (!hit) return null;
      const entry = native.colliders.get(hit.collider.handle);
      if (!entry) return fail("QUERY", "Query returned an unknown collider; reload the scene.");
      const t = scalar(hit.timeOfImpact, "ray distance", 0, distance);
      return { body: entry.definition.id, entity: entry.definition.entity, distance: t,
        point: [start[0] + normalized[0] * t, start[1] + normalized[1] * t], normal: pair([hit.normal.x, hit.normal.y], "ray normal") };
    },
  };
  const empty = (): Snapshot => ({ format: "pelican.physics2d", version: 1, gravity: pair(context.scene.scene.physics2d!.gravity, "gravity"), tick: 0, bodies: [] });
  return {
    id: "$engine.physics2d", version: "1", services: { physics2d: service },
    requiresRecovery: () => nativeFault,
    inspect: () => ({ faulted: nativeFault, bodies: native.bodies.size, joints: native.joints.size }),
    physics2DBridge: { hasEntity(entity) { alive(); return [...native.bodies.values()].some(entry => entry.definition.entity === entity && context.world.isAlive(entry.handle)); } },
    systems: [{ id: "$engine.physics2d.step", phase: "physics", writes: ["Transform"], run(dt) {
      alive(); positive(dt, "fixedDt");
      if (tick >= Number.MAX_SAFE_INTEGER) return fail("TICK", "Physics tick counter exhausted; start a new scene.");
      const live: { entry: Body; transform: Transform }[] = [], removed: Body[] = [];
      for (const entry of native.bodies.values()) {
        if (!context.world.isAlive(entry.handle)) removed.push(entry);
        else {
          const checked = checkEntity(entry.handle);
          if (checked.prefab !== entry.prefab) return fail("BODY_CONFLICT", `Entity '${entry.definition.entity}' changed identity; recreate the 2D body.`);
          live.push({ entry, transform: checked.transform });
        }
      }
      try {
      for (const entry of removed) remove(entry);
      for (const { entry, transform } of live) {
        const before = entry.lastTransform;
        if (transform.position[0] !== before.position[0] || transform.position[1] !== before.position[1] || transform.rotation[2] !== before.rotation[2]) {
          if (entry.definition.type === "kinematic" && !native.characters.has(entry.definition.id)) {
            entry.body.setNextKinematicTranslation({ x: transform.position[0], y: transform.position[1] });
            entry.body.setNextKinematicRotation(transform.rotation[2]);
          } else {
            // A controlled-body transform edit is an explicit teleport. Defer movement
            // until a normal step refreshes query structures; never advance fake time.
            entry.body.setTranslation({ x: transform.position[0], y: transform.position[1] }, true);
            entry.body.setRotation(transform.rotation[2], true);
            if (entry.definition.type === "kinematic") {
              entry.body.setNextKinematicTranslation({ x: transform.position[0], y: transform.position[1] });
              entry.body.setNextKinematicRotation(transform.rotation[2]);
            }
            dirty = true;
          }
        }
      }
      native.world.timestep = dt;
      const moves: { character: Character; entry: Body; movement: Vec2; target: Vec2; grounded: boolean }[] = [];
      if (!dirty) {
        for (const character of [...native.characters.values()].sort((a, b) => a.body < b.body ? -1 : a.body > b.body ? 1 : 0)) {
          const entry = native.bodies.get(character.body);
          if (!entry || !entry.collider || !context.world.isAlive(entry.handle)) return fail("CHARACTER_BODY", `Character '${character.body}' has no live collider.`);
          character.controller.computeColliderMovement(entry.collider, vector(character.requested), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined,
            collider => { const other = native.colliders.get(collider.handle); return !!other && other !== entry && context.world.isAlive(other.handle); });
          const result = character.controller.computedMovement(), movement = pair([result.x, result.y], "character movement"), position = entry.body.translation();
          moves.push({ character, entry, movement, target: pair([position.x + movement[0], position.y + movement[1]], "character target"), grounded: character.controller.computedGrounded() });
        }
        for (const move of moves) move.entry.body.setNextKinematicTranslation(vector(move.target));
      } else {
        for (const character of native.characters.values()) { character.deferred = true; character.grounded = false; }
      }
      native.world.step(native.queue); tick++; dirty = false;
      native.queue.drainCollisionEvents((first, second, started) => {
        const a = native.colliders.get(first), b = native.colliders.get(second);
        if (!a || !b || !context.world.isAlive(a.handle) || !context.world.isAlive(b.handle)) return;
        const [left, right] = a.definition.id < b.definition.id ? [a, b] : [b, a];
        context.emit(`physics2d.${a.definition.sensor || b.definition.sensor ? "trigger" : "collision"}.${started ? "started" : "ended"}`,
          { a: left.definition.id, b: right.definition.id, entityA: left.definition.entity, entityB: right.definition.entity });
      });
      for (const { entry, transform } of live) {
        const state = readBody(entry);
        const next: Transform = { position: [state.position[0], state.position[1], transform.position[2]], rotation: [0, 0, state.angle], scale: transform.scale };
        context.world.setTransform(entry.handle, next); entry.lastTransform = next;
      }
      for (const move of moves) {
        move.character.requested = [0, 0]; move.character.movement = move.movement;
        move.character.grounded = move.grounded; move.character.deferred = false;
      }
      } catch (error) {
        nativeFault = true;
        throw new AggregateError([error], "TC_PHYSICS2D_STEP: Physics step failed; partialState=true. Restore a known-good host checkpoint.");
      }
    } }],
    snapshot() {
      alive();
      const bodies = [...native.bodies.values()].filter(entry => context.world.isAlive(entry.handle)).sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => { const state = readBody(entry); return { definition: entry.definition, prefab: entry.prefab, lastTransform: entry.lastTransform,
          position: state.position, angle: state.angle, velocity: state.velocity, angularVelocity: state.angularVelocity, sleeping: state.sleeping }; });
      const liveIds = new Set(bodies.map(item => item.definition.id));
      const joints = [...native.joints.values()].filter(item => liveIds.has(item.definition.bodyA) && liveIds.has(item.definition.bodyB))
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0).map(item => item.definition);
      const characters = [...native.characters.values()].filter(item => liveIds.has(item.body))
        .sort((a, b) => a.body < b.body ? -1 : a.body > b.body ? 1 : 0)
        .map(({ controller: _controller, ...item }) => item);
      return cloneSerializable({ format: "pelican.physics2d", version: 1, gravity, tick, bodies, joints, characters });
    },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { validateWorld(parse(value), world, context); },
    restore(value) {
      ensureOpen();
      const data = parse(value); validateWorld(data, context.world.snapshot(), context);
      const staged = makeNative(data.gravity);
      try {
        for (const item of data.bodies) addNative(staged, item.definition, context.world.resolve(item.definition.entity), item.lastTransform, item.prefab, item);
        for (const joint of data.joints ?? []) addNativeJoint(staged, joint);
        for (const character of data.characters ?? []) addNativeCharacter(staged, character);
        // Joint creation wakes connected bodies; restore saved sleep intent afterward.
        for (const item of data.bodies) if (item.definition.type === "dynamic" && item.sleeping)
          staged.bodies.get(item.definition.id)!.body.sleep();
      }
      catch (error) {
        try { freeNative(staged); } catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_RESTORE_CLEANUP: Candidate restore and cleanup failed; inspect causes."); }
        throw error;
      }
      const previous = native; native = staged; gravity = data.gravity; tick = data.tick; dirty = true;
      try { freeNative(previous); }
      catch (error) { nativeFault = true; throw new AggregateError([error], "TC_PHYSICS2D_RESTORE_CLEANUP: Previous physics resources could not be released; partialState=true. Restore a known-good checkpoint."); }
      nativeFault = false;
    },
    dispose() { if (disposed) return; disposed = true; freeNative(native); },
  };
};
