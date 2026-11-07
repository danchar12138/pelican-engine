import RAPIER from "@dimforge/rapier2d-compat";
import type { EntityHandle, Physics2DBodyDefinition, Physics2DBodyState, Physics2DService, Transform, Vec2 } from "../sdk/src/index.ts";
import type { WorldSnapshot } from "../runtime/src/contracts.ts";
import type { RuntimePluginContext, RuntimePluginFactory } from "../runtime/src/plugins.ts";
import { cloneSerializable } from "../runtime/src/random.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";

type Definition = Physics2DBodyDefinition & { friction: number; restitution: number; sensor: boolean; continuous: boolean };
type BodySnapshot = { definition: Definition; prefab: string | null; lastTransform: Transform; position: Vec2; angle: number; velocity: Vec2; angularVelocity: number; sleeping: boolean };
type Snapshot = { format: "pelican.physics2d"; version: 1; gravity: Vec2; tick: number; bodies: BodySnapshot[] };
type Body = { definition: Definition; prefab: string | null; handle: EntityHandle; lastTransform: Transform; body: RAPIER.RigidBody; collider: RAPIER.Collider };
type Native = { world: RAPIER.World; queue: RAPIER.EventQueue; bodies: Map<string, Body>; colliders: Map<number, Body> };
const MAX_BODIES = 512, LIMIT = 1e6;
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
  if (!fields(raw, raw.shape === "box" ? ["shape", "halfExtents", "offset"] : ["shape", "radius", "offset"]) || !["box", "circle"].includes(raw.shape as string))
    return fail("COLLIDER", "Collider must be a box or circle with an optional XY offset.");
  const offset = raw.offset === undefined ? undefined : pair(raw.offset, "collider offset");
  const collider: Physics2DBodyDefinition["collider"] = raw.shape === "box"
    ? { shape: "box", halfExtents: pair(raw.halfExtents, "halfExtents", true), ...(offset ? { offset } : {}) }
    : { shape: "circle", radius: positive(raw.radius, "radius"), ...(offset ? { offset } : {}) };
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
function makeNative(gravity: Vec2): Native {
  const world = new RAPIER.World(vector(gravity));
  try { return { world, queue: new RAPIER.EventQueue(true), bodies: new Map(), colliders: new Map() }; }
  catch (error) {
    try { world.free(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_INIT_CLEANUP: 2D world initialization and cleanup failed; inspect the causes."); }
    throw error;
  }
}
function freeNative(native: Native): void {
  const errors: unknown[] = [];
  try { native.world.free(); } catch (error) { errors.push(error); }
  try { native.queue.free(); } catch (error) { errors.push(error); }
  native.bodies.clear(); native.colliders.clear();
  if (errors.length) throw new AggregateError(errors, "TC_PHYSICS2D_DISPOSE: Some 2D physics resources could not be released; inspect causes and restart the scene.");
}
function addNative(native: Native, definition: Definition, handle: EntityHandle, transform: Transform, prefab: string | null, saved?: BodySnapshot): Body {
  const position = saved?.position ?? [transform.position[0], transform.position[1]], angle = saved?.angle ?? transform.rotation[2];
  const descriptor = definition.type === "dynamic" ? RAPIER.RigidBodyDesc.dynamic() :
    definition.type === "fixed" ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased();
  descriptor.setTranslation(position[0], position[1]).setRotation(angle);
  if (definition.continuous) descriptor.setCcdEnabled(true);
  const body = native.world.createRigidBody(descriptor);
  try {
    const shape = definition.collider;
    const colliderDescriptor = shape.shape === "box" ? RAPIER.ColliderDesc.cuboid(shape.halfExtents[0], shape.halfExtents[1]) : RAPIER.ColliderDesc.ball(shape.radius);
    const offset = shape.offset ?? [0, 0];
    colliderDescriptor.setTranslation(offset[0], offset[1]).setFriction(definition.friction).setRestitution(definition.restitution)
      .setSensor(definition.sensor).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    if (definition.mass !== undefined) colliderDescriptor.setMass(definition.mass);
    const collider = native.world.createCollider(colliderDescriptor, body);
    if (saved && definition.type === "dynamic") {
      body.setLinvel(vector(saved.velocity), true); body.setAngvel(saved.angularVelocity, true);
      if (saved.sleeping) body.sleep();
    }
    const entry: Body = { definition, handle, prefab, lastTransform: saved?.lastTransform ?? transform, body, collider };
    native.bodies.set(definition.id, entry); native.colliders.set(collider.handle, entry);
    return entry;
  } catch (error) {
    try { native.world.removeRigidBody(body); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_CREATE_CLEANUP: Body creation and cleanup failed; partialState=true. Restore a known-good checkpoint."); }
    throw error;
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
  if (!fields(data, ["format", "version", "gravity", "tick", "bodies"]) || data.format !== "pelican.physics2d" || data.version !== 1 ||
      !Number.isSafeInteger(data.tick) || data.tick < 0 || !Array.isArray(data.bodies) || data.bodies.length > MAX_BODIES)
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
  return { format: "pelican.physics2d", version: 1, gravity: pair(data.gravity, "gravity"), tick: data.tick, bodies };
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
  let gravity = pair(context.scene.scene.physics2d.gravity, "gravity"), tick = 0, native = makeNative(gravity), disposed = false, dirty = true;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using 2D physics."); };
  const get = (id: string): Body => {
    alive();
    if (!validName(id)) return fail("ID", "Expected a nonempty body id.");
    const entry = native.bodies.get(id);
    if (!entry || !context.world.isAlive(entry.handle)) return fail("MISSING", `Body '${id}' or its entity no longer exists.`);
    return entry;
  };
  const checkEntity = (handle: EntityHandle): { transform: Transform; prefab: string | null } => {
    const identity = context.world.identity(handle);
    if (identity.parent !== undefined) return fail("TRANSFORM", `Entity '${identity.id}' must be a root for 2D physics.`);
    const definition = resolveEntityDefinition(context.scene, identity);
    if (definition?.rigidBody || definition?.character) return fail("BODY_CONFLICT", `Entity '${identity.id}' cannot bind both 2D and 3D physics.`);
    return { transform: planar(context.world.getTransform(handle), identity.id), prefab: identity.prefab ?? null };
  };
  const remove = (entry: Body) => {
    const colliderHandle = entry.collider.handle;
    native.world.removeRigidBody(entry.body);
    native.colliders.delete(colliderHandle); native.bodies.delete(entry.definition.id); dirty = true;
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
      addNative(native, definition, handle, checked.transform, checked.prefab); dirty = true;
    },
    destroy(id) { remove(get(id)); },
    setVelocity(id, value) { const entry = get(id), velocity = pair(value, "velocity"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Velocity requires a dynamic body."); entry.body.setLinvel(vector(velocity), true); },
    setAngularVelocity(id, value) { const entry = get(id), velocity = scalar(value, "angular velocity"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Angular velocity requires a dynamic body."); entry.body.setAngvel(velocity, true); },
    applyImpulse(id, value) { const entry = get(id), impulse = pair(value, "impulse"); if (entry.definition.type !== "dynamic") return fail("BODY_TYPE", "Impulse requires a dynamic body."); entry.body.applyImpulse(vector(impulse), true); },
    setGravity(value) { alive(); const next = pair(value, "gravity"); native.world.gravity = vector(next); gravity = next; },
    gravity() { alive(); return [...gravity] as Vec2; },
    inspect(id) { return bodyState(get(id)); },
    raycast(origin, direction, maxDistance, options = {}) {
      alive();
      if (dirty || tick === 0) return fail("QUERY_PENDING", "Queries require a completed physics step after body creation, removal or restore.");
      const start = pair(origin, "ray origin"), dir = pair(direction, "ray direction"), distance = positive(maxDistance, "maxDistance");
      if (!fields(options, ["exclude", "includeSensors"]) || (options.exclude !== undefined && (!Array.isArray(options.exclude) || options.exclude.some(id => !validName(id)))) ||
          (options.includeSensors !== undefined && typeof options.includeSensors !== "boolean")) return fail("QUERY", "Ray options require body-id exclusions and an optional includeSensors boolean.");
      const length = Math.hypot(dir[0], dir[1]);
      if (!Number.isFinite(length) || length === 0) return fail("QUERY", "Ray direction must be nonzero.");
      const normalized: Vec2 = [dir[0] / length, dir[1] / length], excluded = new Set(options.exclude ?? []);
      const hit = native.world.castRayAndGetNormal(new RAPIER.Ray(vector(start), vector(normalized)), distance, true, undefined, undefined, undefined, undefined,
        collider => { const entry = native.colliders.get(collider.handle); return !!entry && context.world.isAlive(entry.handle) && !excluded.has(entry.definition.id) && (options.includeSensors === true || !entry.definition.sensor); });
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
      for (const entry of removed) remove(entry);
      for (const { entry, transform } of live) {
        const before = entry.lastTransform;
        if (transform.position[0] !== before.position[0] || transform.position[1] !== before.position[1] || transform.rotation[2] !== before.rotation[2]) {
          if (entry.definition.type === "kinematic") {
            entry.body.setNextKinematicTranslation({ x: transform.position[0], y: transform.position[1] });
            entry.body.setNextKinematicRotation(transform.rotation[2]);
          } else {
            entry.body.setTranslation({ x: transform.position[0], y: transform.position[1] }, true);
            entry.body.setRotation(transform.rotation[2], true);
          }
        }
      }
      native.world.timestep = dt;
      native.world.step(native.queue); tick++; dirty = false;
      native.queue.drainCollisionEvents((first, second, started) => {
        const a = native.colliders.get(first), b = native.colliders.get(second);
        if (!a || !b || !context.world.isAlive(a.handle) || !context.world.isAlive(b.handle)) return;
        const [left, right] = a.definition.id < b.definition.id ? [a, b] : [b, a];
        context.emit(`physics2d.${a.definition.sensor || b.definition.sensor ? "trigger" : "collision"}.${started ? "started" : "ended"}`,
          { a: left.definition.id, b: right.definition.id, entityA: left.definition.entity, entityB: right.definition.entity });
      });
      for (const { entry, transform } of live) {
        const state = bodyState(entry);
        const next: Transform = { position: [state.position[0], state.position[1], transform.position[2]], rotation: [0, 0, state.angle], scale: transform.scale };
        context.world.setTransform(entry.handle, next); entry.lastTransform = next;
      }
    } }],
    snapshot() {
      alive();
      const bodies = [...native.bodies.values()].filter(entry => context.world.isAlive(entry.handle)).sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => { const state = bodyState(entry); return { definition: entry.definition, prefab: entry.prefab, lastTransform: entry.lastTransform,
          position: state.position, angle: state.angle, velocity: state.velocity, angularVelocity: state.angularVelocity, sleeping: state.sleeping }; });
      return cloneSerializable({ format: "pelican.physics2d", version: 1, gravity, tick, bodies });
    },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { validateWorld(parse(value), world, context); },
    restore(value) {
      alive();
      const data = parse(value); validateWorld(data, context.world.snapshot(), context);
      const staged = makeNative(data.gravity);
      try { for (const item of data.bodies) addNative(staged, item.definition, context.world.resolve(item.definition.entity), item.lastTransform, item.prefab, item); }
      catch (error) {
        try { freeNative(staged); } catch (cleanup) { throw new AggregateError([error, cleanup], "TC_PHYSICS2D_RESTORE_CLEANUP: Candidate restore and cleanup failed; inspect causes."); }
        throw error;
      }
      const previous = native; native = staged; gravity = data.gravity; tick = data.tick; dirty = true;
      try { freeNative(previous); }
      catch (error) { throw new AggregateError([error], "TC_PHYSICS2D_RESTORE_CLEANUP: Previous physics resources could not be released; partialState=true. Restore a known-good checkpoint."); }
    },
    dispose() { if (disposed) return; disposed = true; freeNative(native); },
  };
};
