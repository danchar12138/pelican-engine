import RAPIER, { createRapierInstance } from "./rapier.ts";
import { preflightPhysicsHistory } from "./history-preflight.ts";
import { createInternalJoints, validateJointDefinition } from "./joints-internal.ts";
import type {
  CharacterDefinition,
  EntityHandle,
  PhysicsService,
  PhysicsJointDefinition,
  PhysicsSweepShape,
  RigidBodyDefinition,
  Transform,
  TerrainGeometry,
  Vec3,
} from "../sdk/src/index.ts";
import type { WorldSnapshot } from "../runtime/src/contracts.ts";
import { cloneSerializable } from "../runtime/src/random.ts";
import { terrainGeometry, terrainMesh } from "../runtime/src/terrain-data.ts";
import type { EntityIR, SceneIR } from "../compiler/src/types.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFactory,
  ClothPhysicsBody,
} from "../runtime/src/plugins.ts";

const pluginId = "$engine.physics";
const limit = 100_000;
type BodyType = "fixed" | "dynamic" | "kinematic" | "character";
type V = { x: number; y: number; z: number };
export interface PhysicsRaycastOptions {
  exclude?: readonly string[];
  includeTriggers?: boolean;
}
export type PhysicsServiceWithQueries = PhysicsService & {
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options?: PhysicsRaycastOptions,
  ): ReturnType<PhysicsService["raycast"]>;
};
interface CharacterState {
  entity: string;
  bodyHandle: number;
  colliderHandle: number;
  radius: number;
  height: number;
  gravity: number;
  verticalVelocity: number;
  velocity: Vec3;
  grounded: boolean;
  requested: Vec3;
}
interface BodyEntry {
  id: string;
  definition: EntityIR;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  type: BodyType;
  transform: Transform;
  character?: CharacterState;
  controller?: RAPIER.KinematicCharacterController;
}
type Frame = { id: string; transform: Transform }[];
type Creation = { id: string; prefab?: string; transform: Transform };
type Action =
  | {
      kind: "step";
      dt: number;
      frame: Frame;
      created: Creation[];
      removed: string[];
    }
  | { kind: "move" | "velocity" | "impulse" | "angularVelocity" | "torqueImpulse"; id: string; value: Vec3 }
  | { kind: "gravity"; value: Vec3 }
  | { kind: "gravityScale"; id: string; scale: number }
  | { kind: "impulseAtPoint"; id: string; value: Vec3; point: Vec3 }
  | { kind: "jointCreate"; definition: PhysicsJointDefinition }
  | { kind: "jointDestroy"; id: string }
  | { kind: "terrainSet"; terrain: TerrainGeometry }
  | { kind: "terrainRemove"; id: string };
interface PhysicsSnapshot {
  format: "pelican.physics-rapier3d";
  version: 3;
  scene: string;
  world: number[];
  tick: number;
  history: Action[];
  bindings: string[];
  entities: {
    id: string;
    bodyHandle: number;
    colliderHandle: number;
    type: BodyType;
    transform: Transform;
  }[];
  characters: CharacterState[];
  pairs: [number, number][];
  /** Absent in old v3 snapshots with no joint operations. */
  joints?: PhysicsJointDefinition[];
  terrains?: TerrainGeometry[];
}
function fail(code: string, message: string): never {
  throw new Error(code + ": " + message);
}
function vec(v: Vec3, name: string): V {
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    ![0, 1, 2].every(
      (i) =>
        typeof v[i] === "number" &&
        Number.isFinite(v[i]) &&
        Math.abs(v[i]) <= 1e12,
    )
  )
    fail(
      "TC_PHYSICS_VECTOR",
      name + " must contain three finite numbers with magnitude <= 1e12.",
    );
  return { x: v[0], y: v[1], z: v[2] };
}
function finite(n: number, name: string, min = 0, max = 1e12) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    fail(
      "TC_PHYSICS_DEFINITION",
      name + " is outside [" + min + ", " + max + "].",
    );
}
function tuple(v: V): Vec3 {
  return [v.x === 0 ? 0 : v.x, v.y === 0 ? 0 : v.y, v.z === 0 ? 0 : v.z];
}
function rotation(v: Vec3): RAPIER.Rotation {
  const [x, y, z] = v.map((n) => n / 2),
    cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}
// XYZ Euler order, matching the renderer's Object3D transforms.
function euler(q: RAPIER.Rotation): Vec3 {
  const { x, y, z, w } = q,
    m13 = 2 * (x * z + w * y),
    m23 = 2 * (y * z - w * x),
    m33 = 1 - 2 * (x * x + y * y),
    m12 = 2 * (x * y - w * z),
    m11 = 1 - 2 * (y * y + z * z);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  const angles =
    Math.abs(m13) < 0.9999999
      ? [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)]
      : [Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)), ry, 0];
  return angles.map((n) => (n === 0 ? 0 : n)) as unknown as Vec3;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function validateBody(d: RigidBodyDefinition) {
  const c = d.collider;
  if (
    !["fixed", "dynamic", "kinematic"].includes(d.type) ||
    !c ||
    !["box", "sphere", "capsule"].includes(c.shape)
  )
    fail("TC_PHYSICS_DEFINITION", "Invalid body or collider definition.");
  if (c.shape === "box") {
    const s = vec(c.size!, "size");
    if (Math.min(s.x, s.y, s.z) <= 0)
      fail("TC_PHYSICS_DEFINITION", "Box extents must be positive.");
  } else finite(c.radius!, "radius", 1e-6);
  if (c.shape === "capsule") finite(c.halfHeight!, "halfHeight");
  if (c.offset) vec(c.offset, "offset");
  if (d.mass !== undefined) finite(d.mass, "mass", 1e-6);
  if (d.friction !== undefined) finite(d.friction, "friction");
  if (d.restitution !== undefined) finite(d.restitution, "restitution", 0, 1);
  if (d.trigger !== undefined && typeof d.trigger !== "boolean")
    fail("TC_PHYSICS_DEFINITION", "trigger must be boolean.");
}
function validateCharacter(d: CharacterDefinition) {
  finite(d.radius, "radius", 1e-6);
  finite(d.height, "height", 2 * d.radius);
  finite(d.speed, "speed");
  if (d.jumpSpeed !== undefined) finite(d.jumpSpeed, "jumpSpeed");
  if (d.gravity !== undefined) finite(d.gravity, "gravity");
}
function checkTransform(t: Transform, e: EntityIR) {
  if (!t) fail("TC_PHYSICS_TRANSFORM", e.id + " requires a transform.");
  vec(t.position, e.id + ".position");
  vec(t.rotation, e.id + ".rotation");
  const s = vec(t.scale, e.id + ".scale");
  if (Math.min(s.x, s.y, s.z) < 1e-6)
    fail("TC_PHYSICS_TRANSFORM", e.id + " requires positive scale >= 1e-6.");
  if (
    e.character &&
    (!same(t.scale, [1, 1, 1]) || t.rotation[0] !== 0 || t.rotation[2] !== 0)
  )
    fail(
      "TC_PHYSICS_TRANSFORM",
      e.id +
        " character supports unit scale and yaw rotation only; remove pitch/roll and scale.",
    );
  if (
    e.rigidBody &&
    e.rigidBody.collider.shape !== "box" &&
    (s.x !== s.y || s.y !== s.z)
  )
    fail(
      "TC_PHYSICS_TRANSFORM",
      e.id +
        " sphere/capsule requires uniform scale; use a box for nonuniform scale.",
    );
}
function validateDefinition(e: EntityIR) {
  if (e.rigidBody && e.character)
    fail("TC_PHYSICS_DEFINITION", e.id + " cannot be a body and character.");
  if (e.parent)
    fail(
      "TC_PHYSICS_PARENT_TRANSFORM",
      e.id +
        " uses unsupported parented physics; place physics entities at the scene root.",
    );
  if (e.rigidBody) validateBody(e.rigidBody);
  if (e.character) validateCharacter(e.character);
  checkTransform(e.transform, e);
}
function shape(e: EntityIR, t: Transform, native: typeof RAPIER = RAPIER): RAPIER.Shape {
  const d = e.rigidBody!.collider,
    s = t.scale;
  if (d.shape === "box")
    return new native.Cuboid(
      (d.size![0] * s[0]) / 2,
      (d.size![1] * s[1]) / 2,
      (d.size![2] * s[2]) / 2,
    );
  if (d.shape === "sphere") return new native.Ball(d.radius! * s[0]);
  return new native.Capsule(d.halfHeight! * s[1], d.radius! * s[0]);
}
let initialization: Promise<RuntimePluginFactory> | undefined;
let initialized = false;
const factory: RuntimePluginFactory = (context) => createPlugin(context);
/** Initialize WASM once, including concurrent callers. */
export async function createPhysicsFactory(): Promise<RuntimePluginFactory> {
  return (initialization ??= RAPIER.init().then(() => {
    initialized = true;
    return factory;
  }).catch(error => { initialization = undefined; throw error; }));
}
export const initPhysics = createPhysicsFactory;
/** Synchronous factory for callers that already awaited createPhysicsFactory. */
export function createFactory(): RuntimePluginFactory {
  if (!initialized)
    fail(
      "TC_PHYSICS_INIT",
      "Await createPhysicsFactory() before creating a synchronous factory.",
    );
  return factory;
}

function simulation(definitions: EntityIR[], gravity: Vec3, catalog: SceneIR) {
  const RAPIER = createRapierInstance();
  const world = new RAPIER.World(vec(gravity, "gravity"));
  let queue: RAPIER.EventQueue | undefined;
  const bodies = new Map<string, BodyEntry>(),
    nativeBodies = new Map<string, RAPIER.RigidBody>(),
    byCollider = new Map<number, string>(),
    pairs = new Map<string, { a: number; b: number; trigger: boolean }>();
  const joints = createInternalJoints(world, nativeBodies, RAPIER);
  const terrains = new Map<string, { definition: TerrainGeometry; body: RAPIER.RigidBody; collider: RAPIER.Collider }>();
  let terrainHistory = false;
  let terrainSamples = 0;
  let jointHistory = false;
  let tick = 0,
    topologyDirty = false;
  const pairKey = (a: number, b: number) => (a < b ? a + ":" + b : b + ":" + a);
  function controller(d: CharacterDefinition) {
    const c = world.createCharacterController(0.01);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.enableAutostep(Math.min(0.3, d.height * 0.2), d.radius * 0.5, false);
    c.enableSnapToGround(0.15);
    return c;
  }
  function add(e: EntityIR) {
    const type: BodyType = e.character ? "character" : e.rigidBody!.type;
    const p = vec(e.transform.position, e.id),
      rd =
        type === "fixed"
          ? RAPIER.RigidBodyDesc.fixed()
          : type === "dynamic"
            ? RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true)
            : RAPIER.RigidBodyDesc.kinematicPositionBased();
    rd.setTranslation(p.x, p.y, p.z).setRotation(
      rotation(e.transform.rotation),
    );
    const body = world.createRigidBody(rd);
    let ownedController: RAPIER.KinematicCharacterController | undefined;
    try {
      let cd: RAPIER.ColliderDesc;
      if (e.character)
        cd = RAPIER.ColliderDesc.capsule(
          (e.character.height - 2 * e.character.radius) / 2,
          e.character.radius,
        );
      else {
        const d = e.rigidBody!,
          o = d.collider.offset ?? [0, 0, 0];
        cd = new RAPIER.ColliderDesc(shape(e, e.transform, RAPIER));
        cd.setTranslation(
          o[0] * e.transform.scale[0],
          o[1] * e.transform.scale[1],
          o[2] * e.transform.scale[2],
        )
          .setFriction(d.friction ?? 0.5)
          .setRestitution(d.restitution ?? 0)
          .setSensor(d.trigger ?? false);
        if (d.mass !== undefined) cd.setMass(d.mass);
      }
      cd.setActiveEvents(
        RAPIER.ActiveEvents.COLLISION_EVENTS,
      ).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      const collider = world.createCollider(cd, body);
      const b: BodyEntry = {
        id: e.id,
        definition: e,
        body,
        collider,
        type,
        transform: structuredClone(e.transform),
      };
      topologyDirty = true;
      bodies.set(e.id, b);
      nativeBodies.set(e.id, body);
      byCollider.set(collider.handle, e.id);
      if (e.character) {
        const d = e.character;
        b.controller = ownedController = controller(d);
        b.character = {
          entity: e.id,
          bodyHandle: body.handle,
          colliderHandle: collider.handle,
          radius: d.radius,
          height: d.height,
          gravity: d.gravity ?? 9.81,
          verticalVelocity: 0,
          velocity: [0, 0, 0],
          grounded: false,
          requested: [0, 0, 0],
        };
      }
    } catch (error) {
      if (ownedController) world.removeCharacterController(ownedController);
      const entry = bodies.get(e.id);
      if (entry) byCollider.delete(entry.collider.handle);
      bodies.delete(e.id);
      nativeBodies.delete(e.id);
      world.removeRigidBody(body);
      throw error;
    }
  }
  try {
    queue = new RAPIER.EventQueue(true);
    for (const e of definitions) add(e);
    // Build Rapier query structures without advancing physical time.
    world.timestep = 0;
    world.step(queue);
    world.timestep = 1 / 60;
    topologyDirty = false;
  } catch (error) {
    try {
      world.free();
    } finally {
      queue?.free();
    }
    throw error;
  }
  function get(id: string) {
    const b = bodies.get(id);
    if (!b) fail("TC_PHYSICS_ENTITY", id + " has no live physics body.");
    return b;
  }
  function emitPair(
    p: { a: number; b: number; trigger: boolean },
    started: boolean,
    emit: (type: string, payload: unknown) => void,
  ) {
    const a = byCollider.get(p.a),
      b = byCollider.get(p.b);
    if (a && b)
      emit(
        "physics." +
          (p.trigger ? "trigger" : "collision") +
          "." +
          (started ? "started" : "ended"),
        { a, b },
      );
  }
  function remove(id: string, emit: (type: string, payload: unknown) => void) {
    const b = get(id);
    joints.removeForBody(id);
    for (const [key, p] of pairs)
      if (p.a === b.collider.handle || p.b === b.collider.handle) {
        emitPair(p, false, emit);
        pairs.delete(key);
      }
    if (b.controller) world.removeCharacterController(b.controller);
    byCollider.delete(b.collider.handle);
    world.removeRigidBody(b.body);
    bodies.delete(id);
    nativeBodies.delete(id);
    topologyDirty = true;
  }
  function drain(emit: (type: string, payload: unknown) => void) {
    queue!.drainCollisionEvents((a, b, started) => {
      if (!byCollider.has(a) || !byCollider.has(b)) return;
      const key = pairKey(a, b),
        p = {
          a,
          b,
          trigger:
            world.getCollider(a).isSensor() || world.getCollider(b).isSensor(),
        };
      if (started) {
        if (pairs.has(key)) return;
        pairs.set(key, p);
      } else {
        if (!pairs.has(key)) return;
        pairs.delete(key);
      }
      emitPair(p, started, emit);
    });
  }
  function sync(frame: Frame, emit: (type: string, payload: unknown) => void) {
    if (!Array.isArray(frame) || frame.length > bodies.size)
      fail("TC_PHYSICS_SNAPSHOT", "Invalid transform frame.");
    const seen = new Set<string>();
    for (const f of frame) {
      if (!f || seen.has(f.id))
        fail("TC_PHYSICS_SNAPSHOT", "Duplicate transform entity.");
      const b = get(f.id);
      checkTransform(f.transform, b.definition);
      seen.add(f.id);
    }
    let dirty = topologyDirty;
    for (const id of bodies.keys())
      if (!seen.has(id)) {
        remove(id, emit);
        dirty = true;
      }
    for (const f of frame) {
      const b = get(f.id),
        t = f.transform,
        old = b.transform;
      if (!same(t, old)) dirty = true;
      if (!same(t.scale, old.scale)) {
        b.collider.setShape(shape(b.definition, t, RAPIER));
        const o = b.definition.rigidBody!.collider.offset ?? [0, 0, 0];
        b.collider.setTranslationWrtParent({
          x: o[0] * t.scale[0],
          y: o[1] * t.scale[1],
          z: o[2] * t.scale[2],
        });
        if (b.definition.rigidBody!.mass !== undefined)
          b.collider.setMass(b.definition.rigidBody!.mass!);
        b.body.recomputeMassPropertiesFromColliders();
      }
      // External Transform edits are explicit teleports for all body types.
      if (!same(t.position, old.position)) {
        b.body.setTranslation(vec(t.position, b.id), true);
        if (b.character) b.character.grounded = false;
      }
      if (!same(t.rotation, old.rotation))
        b.body.setRotation(rotation(t.rotation), true);
      b.transform = structuredClone(t);
    }
    world.propagateModifiedBodyPositionsToColliders();
    if (dirty) {
      const dt = world.timestep;
      world.timestep = 0;
      // Rapier 0.21 commits moved fixed-collider bounds on the following
      // pipeline pass when dt is zero. Both passes advance no physical time.
      world.step(queue);
      drain(emit);
      world.step(queue);
      drain(emit);
      world.timestep = dt;
    }
    topologyDirty = false;
  }
  /** Recover from Rapier KCC zero-TOI cycling without ignoring any blocking solid. */
  function sweepSlide(b: BodyEntry, desired: V) {
    const start = b.collider.translation(),
      position = { x: start.x, y: start.y, z: start.z },
      remaining = { ...desired },
      ignored = new Set<number>();
    for (let iteration = 0; iteration < 8; iteration++) {
      if (Math.hypot(remaining.x, remaining.y, remaining.z) < 1e-7) break;
      const hit = world.castShape(
        position,
        b.collider.rotation(),
        remaining,
        b.collider.shape,
        0.01,
        1,
        false,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        b.collider,
        b.body,
        (collider) => !ignored.has(collider.handle),
      );
      if (!hit) {
        position.x += remaining.x;
        position.y += remaining.y;
        position.z += remaining.z;
        break;
      }
      const normal = hit.normal1,
        dot =
          remaining.x * normal.x +
          remaining.y * normal.y +
          remaining.z * normal.z;
      // Touching a surface while moving tangentially or outward is not a blocker.
      // The exclusion applies only to this linear sweep; other solids remain queried.
      if (hit.time_of_impact < 1e-5 && dot >= -1e-6) {
        ignored.add(hit.collider.handle);
        continue;
      }
      const time = Math.max(0, Math.min(1, hit.time_of_impact));
      position.x += remaining.x * time;
      position.y += remaining.y * time;
      position.z += remaining.z * time;
      remaining.x *= 1 - time;
      remaining.y *= 1 - time;
      remaining.z *= 1 - time;
      const into =
        remaining.x * normal.x +
        remaining.y * normal.y +
        remaining.z * normal.z;
      if (into < 0) {
        remaining.x -= into * normal.x;
        remaining.y -= into * normal.y;
        remaining.z -= into * normal.z;
      } else ignored.add(hit.collider.handle);
    }
    const support = world.castShape(
      position,
      b.collider.rotation(),
      { x: 0, y: -1, z: 0 },
      b.collider.shape,
      0,
      0.025,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      b.collider,
      b.body,
    );
    return {
      movement: {
        x: position.x - start.x,
        y: position.y - start.y,
        z: position.z - start.z,
      },
      grounded:
        desired.y <= 0 &&
        !!support &&
        support.normal1.y >= Math.cos(b.controller!.maxSlopeClimbAngle()),
    };
  }
  function apply(
    action: Action,
    emit: (type: string, payload: unknown) => void,
  ) {
    if (
      !action ||
      !["step", "move", "velocity", "impulse", "angularVelocity", "torqueImpulse", "impulseAtPoint", "gravity", "gravityScale", "jointCreate", "jointDestroy", "terrainSet", "terrainRemove"].includes(action.kind)
    )
      fail("TC_PHYSICS_SNAPSHOT", "Invalid history action.");
    if (action.kind === "terrainSet" || action.kind === "terrainRemove") {
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, action.kind === "terrainSet" ? "terrain" : "id")) fail("TC_PHYSICS_TERRAIN", "Invalid terrain history fields.");
      if (action.kind === "terrainSet") {
        const definition = terrainGeometry(action.terrain), previous = terrains.get(definition.id), queryId = `$terrain/${definition.id}`;
        if ((!previous && terrains.size >= 128) || bodies.has(queryId)) fail("TC_PHYSICS_TERRAIN", "Terrain capacity exceeded or a reserved query ID conflicts with an entity.");
        if (terrainSamples + definition.heights.length > 8000000) fail("TC_PHYSICS_TERRAIN_HISTORY", "Terrain history exceeds 8000000 height samples; start a new scene.");
        terrainSamples += definition.heights.length;
        const mesh = terrainMesh(definition), shape = new RAPIER.TriMesh(new Float32Array(mesh.positions.flat()), new Uint32Array(mesh.triangles.flat()));
        if (previous) {
          previous.collider.setShape(shape);
          previous.collider.setFriction(definition.friction ?? 0.5);
          previous.collider.setRestitution(definition.restitution ?? 0);
          previous.definition = definition;
        } else {
          const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
          try {
            const collider = world.createCollider(new RAPIER.ColliderDesc(shape).setFriction(definition.friction ?? 0.5).setRestitution(definition.restitution ?? 0)
              .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL), body);
            terrains.set(definition.id, { definition, body, collider }); byCollider.set(collider.handle, queryId);
          } catch (error) { world.removeRigidBody(body); throw error; }
        }
        for (const body of bodies.values()) if (body.type === "dynamic") body.body.wakeUp();
      } else {
        const entry = terrains.get(action.id);
        if (!entry) fail("TC_PHYSICS_TERRAIN", `Terrain '${action.id}' does not exist.`);
        for (const [key, pair] of pairs) if (pair.a === entry.collider.handle || pair.b === entry.collider.handle) { emitPair(pair, false, emit); pairs.delete(key); }
        byCollider.delete(entry.collider.handle); world.removeRigidBody(entry.body); terrains.delete(action.id);
      }
      terrainHistory = true; topologyDirty = true;
      sync([...bodies.values()].map(body => ({ id: body.id, transform: body.transform })), emit);
      return;
    }
    if (action.kind === "jointCreate" || action.kind === "jointDestroy") {
      const field = action.kind === "jointCreate" ? "definition" : "id";
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, field))
        fail("TC_PHYSICS_SNAPSHOT", "Invalid joint history fields.");
      if (action.kind === "jointCreate") joints.create(action.definition);
      else joints.remove(action.id);
      jointHistory = true;
      return;
    }
    if (action.kind === "gravity") {
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, "value"))
        fail("TC_PHYSICS_SNAPSHOT", "Invalid gravity history action fields.");
      world.gravity = vec(action.value, "gravity");
      for (const body of bodies.values()) if (body.type === "dynamic") body.body.wakeUp();
      return;
    }
    if (action.kind === "gravityScale") {
      if (Object.keys(action).length !== 3 || !Object.hasOwn(action, "id") || !Object.hasOwn(action, "scale"))
        fail("TC_PHYSICS_SNAPSHOT", "Invalid gravity scale history action fields.");
      const body = get(action.id);
      if (body.type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `Gravity scale requires a dynamic rigid body (${body.id}).`);
      if (typeof action.scale !== "number" || !Number.isFinite(action.scale) || Math.abs(action.scale) > 1000 ||
          (action.scale !== 0 && Math.fround(action.scale) === 0))
        fail("TC_PHYSICS_GRAVITY_SCALE", "Gravity scale must be float32-representable in [-1000, 1000].");
      body.body.setGravityScale(action.scale, true);
      return;
    }
    if (action.kind !== "step") {
      if (["angularVelocity", "torqueImpulse", "impulseAtPoint"].includes(action.kind)) {
        const keys = action.kind === "impulseAtPoint" ? ["kind", "id", "value", "point"] : ["kind", "id", "value"];
        if (Object.keys(action).length !== keys.length || Object.keys(action).some((key) => !keys.includes(key)))
          fail("TC_PHYSICS_SNAPSHOT", "Invalid angular history action fields.");
      }
      const b = get(action.id),
        v = vec(action.value, action.kind);
      const point = action.kind === "impulseAtPoint" ? vec(action.point, "point") : undefined;
      if (action.kind === "move") {
        if (!b.character)
          fail("TC_PHYSICS_CHARACTER", b.id + " is not a character.");
        const c = b.character,
          requested: Vec3 = [
            c.requested[0] + v.x,
            c.requested[1] + v.y,
            c.requested[2] + v.z,
          ];
        vec(requested, "accumulated displacement");
        c.requested = requested;
      } else if (action.kind === "velocity") {
        if (b.character) {
          b.character.velocity = tuple(v);
          b.character.verticalVelocity = v.y;
          if (v.y > 0) b.character.grounded = false;
        } else if (b.type === "dynamic") b.body.setLinvel(v, true);
        else
          fail(
            "TC_PHYSICS_BODY_TYPE",
            "setVelocity requires a dynamic body or character (" + b.id + ").",
          );
      } else {
        if (b.type !== "dynamic")
          fail(
            "TC_PHYSICS_BODY_TYPE",
            (action.kind === "angularVelocity" ? "setAngularVelocity" : action.kind) + " requires a dynamic body (" + b.id + ").",
          );
        if (action.kind === "angularVelocity") b.body.setAngvel(v, true);
        else if (action.kind === "torqueImpulse") b.body.applyTorqueImpulse(v, true);
        else if (action.kind === "impulseAtPoint") b.body.applyImpulseAtPoint(v, point!, true);
        else b.body.applyImpulse(v, true);
      }
      return;
    }
    finite(action.dt, "dt", 1e-6, 1);
    // Creation history contains content identity and transforms only. Never accept
    // caller-supplied collider/body definitions during isolated snapshot replay.
    if (!Array.isArray(action.created) || !Array.isArray(action.removed))
      fail("TC_PHYSICS_SNAPSHOT", "Missing lifecycle operations.");
    const removed = new Set<string>();
    for (const id of action.removed) {
      if (typeof id !== "string" || removed.has(id))
        fail("TC_PHYSICS_SNAPSHOT", "Duplicate/invalid removed entity.");
      get(id);
      removed.add(id);
    }
    const created = new Map<string, EntityIR>();
    for (const c of action.created) {
      if (
        !c ||
        typeof c.id !== "string" ||
        !c.id ||
        Object.keys(c).some(
          (k) => !["id", "prefab", "transform"].includes(k),
        ) ||
        (c.prefab !== undefined && typeof c.prefab !== "string") ||
        created.has(c.id) ||
        (bodies.has(c.id) && !removed.has(c.id))
      )
        fail("TC_PHYSICS_SNAPSHOT", "Invalid/duplicate creation identity.");
      if (
        c.prefab !== undefined &&
        !catalog.prefabs.some((p) => p.id === c.prefab)
      )
        fail("TC_PHYSICS_SNAPSHOT", "Unknown compiled prefab identity.");
      const definition = resolveEntityDefinition(catalog, c);
      if (!definition || (!definition.rigidBody && !definition.character))
        fail(
          "TC_PHYSICS_SNAPSHOT",
          "Creation must resolve to an authored physics entity or compiled physics prefab.",
        );
      const e = { ...definition, transform: c.transform };
      validateDefinition(e);
      created.set(c.id, e);
    }
    const expected = new Map(
      [...bodies]
        .filter(([id]) => !removed.has(id))
        .map(([id, b]) => [id, b.definition]),
    );
    for (const [id, e] of created) expected.set(id, e);
    if (!Array.isArray(action.frame) || action.frame.length !== expected.size)
      fail(
        "TC_PHYSICS_SNAPSHOT",
        "Lifecycle frame does not match active bodies.",
      );
    const seen = new Set<string>();
    for (const f of action.frame) {
      const e = f && expected.get(f.id);
      if (!e || seen.has(f.id))
        fail("TC_PHYSICS_SNAPSHOT", "Invalid lifecycle frame entity.");
      checkTransform(f.transform, e);
      if (created.has(f.id) && !same(f.transform, created.get(f.id)!.transform))
        fail("TC_PHYSICS_SNAPSHOT", "Creation and frame transforms differ.");
      seen.add(f.id);
    }
    drain(emit);
    for (const id of removed) remove(id, emit);
    for (const e of created.values()) add(e);
    sync(action.frame, emit);
    world.timestep = action.dt;
    for (const b of bodies.values())
      if (b.character && b.controller) {
        const c = b.character,
          dt = action.dt;
        // A downward probe on every falling/grounded tick keeps grounded stable.
        c.verticalVelocity -= c.gravity * dt;
        const desired = {
          x: c.requested[0] + c.velocity[0] * dt,
          y: c.requested[1] + c.verticalVelocity * dt,
          z: c.requested[2] + c.velocity[2] * dt,
        };
        b.controller.computeColliderMovement(
          b.collider,
          desired,
          RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        );
        let m = b.controller.computedMovement();
        const stalled =
          b.controller.numComputedCollisions() >= 20 &&
          ((Math.hypot(desired.x, desired.z) > 1e-6 &&
            Math.hypot(m.x, m.z) < Math.hypot(desired.x, desired.z) * 0.01) ||
            (Math.hypot(m.x, m.y, m.z) < 1e-7 &&
              Math.hypot(desired.x, desired.y, desired.z) > 1e-6));
        const recovered = stalled ? sweepSlide(b, desired) : undefined;
        if (recovered) m = recovered.movement;
        const p = b.body.translation();
        c.grounded = recovered?.grounded ?? b.controller.computedGrounded();
        if (
          (c.grounded && c.verticalVelocity < 0) ||
          (desired.y > 0 && m.y < desired.y - 1e-5 && c.verticalVelocity > 0)
        )
          c.verticalVelocity = 0;
        b.body.setNextKinematicTranslation({
          x: p.x + m.x,
          y: p.y + m.y,
          z: p.z + m.z,
        });
        c.requested = [0, 0, 0];
      }
    world.step(queue);
    tick++;
    drain(emit);
    for (const b of bodies.values())
      b.transform = {
        position: tuple(b.body.translation()),
        rotation: b.character ? b.transform.rotation : euler(b.body.rotation()),
        scale: b.transform.scale,
      };
  }
  function header() {
    const bytes = world.takeSnapshot();
    if (bytes.length > 64 * 1024 * 1024)
      fail(
        "TC_PHYSICS_SNAPSHOT_SIZE",
        "Snapshot exceeds 64 MiB; reduce the scene size.",
      );
    return {
      world: Array.from(bytes),
      tick,
      entities: [...bodies.values()].map((b) => ({
        id: b.id,
        bodyHandle: b.body.handle,
        colliderHandle: b.collider.handle,
        type: b.type,
        transform: structuredClone(b.transform),
      })),
      characters: [...bodies.values()].flatMap((b) =>
        b.character ? [structuredClone(b.character)] : [],
      ),
      pairs: [...pairs.values()].map((p) =>
        p.a < p.b ? [p.a, p.b] : [p.b, p.a],
      ) as [number, number][],
      ...(jointHistory ? { joints: joints.snapshot().joints } : {}),
      ...(terrainHistory ? { terrains: [...terrains.values()].map(item => structuredClone(item.definition)).sort((a, b) => a.id.localeCompare(b.id, "en")) } : {}),
    };
  }
  return {
    get tick() {
      return tick;
    },
    contactCount(handle: number) {
      return [...pairs.values()].filter((p) => p.a === handle || p.b === handle)
        .length;
    },
    world,
    native: RAPIER,
    joints,
    terrains,
    bodies,
    byCollider,
    get,
    apply,
    header,
    remove,
    sync,
    dispose() {
      try {
        queue!.free();
      } finally {
        world.free();
      }
    },
  };
}

function createPlugin(context: RuntimePluginContext): RuntimePlugin & {
  validateWorld(value: unknown, world: WorldSnapshot): void;
} {
  const catalog = structuredClone(context.scene);
  const definitions = catalog.scene.entities.filter(
    (e) => e.rigidBody || e.character,
  );
  const ids = new Set<string>();
  for (const e of definitions) {
    if (ids.has(e.id))
      fail("TC_PHYSICS_DEFINITION", "Duplicate physics entity " + e.id);
    ids.add(e.id);
    validateDefinition(e);
  }
  const gravity = catalog.scene.gravity ?? [0, -9.81, 0];
  vec(gravity, "gravity");
  const scene = JSON.stringify({
    entities: catalog.scene.entities,
    prefabs: catalog.prefabs,
    gravity,
  });
  let state = simulation(definitions, gravity, catalog),
    history: Action[] = [],
    disposed = false,
    nativeFault = false,
    pendingBind: string[] | undefined;
  const refs = new Map<string, EntityHandle>();
  function bindRefs(ids: Iterable<string> = state.bodies.keys()) {
    refs.clear();
    for (const id of ids)
      if (context.world.isAlive(id)) refs.set(id, context.world.resolve(id));
  }
  bindRefs();
  function ensureRefs() {
    if (pendingBind) {
      bindRefs(pendingBind);
      pendingBind = undefined;
    }
  }
  const emit = (type: string, payload: unknown) => {
    context.emit(type, payload);
  };
  function alive(recovering = false) {
    if (disposed)
      fail(
        "TC_PHYSICS_DISPOSED",
        "Physics plugin disposed; create a new host.",
      );
    if (nativeFault && !recovering)
      fail("TC_PHYSICS_RECOVERY_REQUIRED", "A native physics operation failed; restore a known-good checkpoint or restart the scene before further access.");
  }
  function overlapShape(position: V, orientation: RAPIER.Rotation, shape: RAPIER.Shape, options?: PhysicsRaycastOptions): string[] {
    if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some(key => key !== "exclude" && key !== "includeTriggers") ||
        (options.exclude !== undefined && (!Array.isArray(options.exclude) || !options.exclude.every(id => typeof id === "string"))) ||
        (options.includeTriggers !== undefined && typeof options.includeTriggers !== "boolean")))
      fail("TC_PHYSICS_OVERLAP", "Options require exclude string IDs and includeTriggers boolean.");
    const excluded = new Set(options?.exclude ?? []), found = new Set<string>();
    state.world.intersectionsWithShape(position, orientation, shape, collider => {
      const id = state.byCollider.get(collider.handle), ref = id ? refs.get(id) : undefined;
      if (id && queryAlive(id) && !excluded.has(id) && (options?.includeTriggers === true || !collider.isSensor())) found.add(id);
      return true;
    });
    return [...found].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  }
  function lifecycle(dt: number): Extract<Action, { kind: "step" }> {
    ensureRefs();
    const frame: Frame = [],
      created: Creation[] = [],
      removed: string[] = [];
    const active = new Map(context.world.records().map((r) => [r.id, r]));
    for (const id of state.bodies.keys()) {
      const ref = refs.get(id);
      if (!ref || !context.world.isAlive(ref) || !active.has(id))
        removed.push(id);
    }
    for (const r of active.values()) {
      const definition = resolveEntityDefinition(catalog, r);
      if (!definition || (!definition.rigidBody && !definition.character))
        continue;
      // World parent/transform overrides must obey the same constraints as authored bodies.
      const e = {
        ...definition,
        parent: r.parent ?? definition.parent,
        transform: r.transform,
      };
      validateDefinition(e);
      frame.push({ id: r.id, transform: r.transform });
      if (!state.bodies.has(r.id) || removed.includes(r.id))
        created.push({
          id: r.id,
          ...(r.prefab === undefined ? {} : { prefab: r.prefab }),
          transform: r.transform,
        });
    }
    return { kind: "step", dt, frame, created, removed };
  }
  function record(action: Action) {
    alive();
    if (history.length >= limit)
      fail(
        "TC_PHYSICS_HISTORY_LIMIT",
        "Physics history exceeds 100000 operations; start a new scene.",
      );
    // Capture plain input first: a clone failure after native mutation would
    // otherwise leave a changed world with no corresponding history entry.
    const captured = cloneSerializable(action);
    try { state.apply(captured, emit); }
    catch (error) {
      // A stable diagnostic may also be raised after native mutation or event
      // delivery. Its prefix cannot establish that the native owner is intact.
      nativeFault = true;
      throw new AggregateError([error], `TC_PHYSICS_OPERATION: '${captured.kind}' failed; partialState=unknown. Restore a known-good checkpoint or restart the scene.`);
    }
    history.push(captured);
  }
  function get(id: string) {
    alive();
    ensureRefs();
    const ref = refs.get(id);
    if (!ref || !context.world.isAlive(ref))
      fail("TC_PHYSICS_ENTITY", id + " has no live physics body.");
    return state.get(id);
  }
  function queryAlive(id: string): boolean {
    if (id.startsWith("$terrain/") && state.terrains.has(id.slice("$terrain/".length))) return true;
    const ref = refs.get(id);
    return !!ref && context.world.isAlive(ref);
  }
  function snapshot(): PhysicsSnapshot {
    alive();
    ensureRefs();
    return {
      format: "pelican.physics-rapier3d",
      version: 3,
      scene,
      history: structuredClone(history),
      bindings: [...refs]
        .filter(([, ref]) => context.world.isAlive(ref))
        .map(([id]) => id),
      ...state.header(),
    };
  }
  function validate(input: unknown) {
    alive(true);
    let candidate: ReturnType<typeof simulation> | undefined;
    try {
      const s = cloneSerializable(input) as PhysicsSnapshot;
      if (
        !s ||
        s.format !== "pelican.physics-rapier3d" ||
        s.version !== 3 ||
        s.scene !== scene ||
        !Number.isSafeInteger(s.tick) ||
        s.tick < 0 ||
        !Array.isArray(s.history) ||
        s.history.length > limit ||
        !Array.isArray(s.world) ||
        s.world.length === 0 ||
        s.world.length > 64 * 1024 * 1024 ||
        !s.world.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
        !Array.isArray(s.bindings) ||
        s.bindings.some((id) => typeof id !== "string") ||
        new Set(s.bindings).size !== s.bindings.length ||
        !Array.isArray(s.entities) ||
        !Array.isArray(s.characters) ||
        !Array.isArray(s.pairs) ||
        (s.joints !== undefined && !Array.isArray(s.joints)) ||
        (s.terrains !== undefined && !Array.isArray(s.terrains))
      )
        fail(
          "TC_PHYSICS_SNAPSHOT",
          "Malformed/incompatible snapshot header; use an intact version 3 snapshot of this scene.",
        );
      // Both checks run on detached data before allocating any native candidate.
      // Neither check establishes that arbitrary replay is safe.
      preflightPhysicsHistory(definitions, catalog, s.history, s, { definition: validateDefinition, transform: checkTransform });
      // No caller-controlled bytes ever reach World.restoreSnapshot. Reconstruct
      // native state from checked operations, then compare native/header data.
      candidate = simulation(definitions, gravity, catalog);
      for (const action of s.history) candidate.apply(action, () => {});
      if (s.bindings.some((id) => !candidate!.bodies.has(id)))
        fail("TC_PHYSICS_SNAPSHOT", "Binding has no reconstructed body.");
      const actual = candidate.header();
      if (
        !same(actual, {
          world: s.world,
          tick: s.tick,
          entities: s.entities,
          characters: s.characters,
          pairs: s.pairs,
          ...(s.joints === undefined ? {} : { joints: s.joints }),
          ...(s.terrains === undefined ? {} : { terrains: s.terrains }),
        })
      )
        fail(
          "TC_PHYSICS_SNAPSHOT",
          "Native state, entity/handle mapping, character state or contact pairs differ from verified history.",
        );
      return { candidate, history: s.history, bindings: s.bindings };
    } catch (error) {
      const failures: unknown[] = [error];
      // The candidate owns a separate WASM memory, so a trap cannot corrupt
      // the active world's native allocator or Rust borrow state.
      try { candidate?.dispose(); } catch (cleanup) { failures.push(cleanup); }
      if (failures.length > 1)
        throw new AggregateError(failures, "TC_PHYSICS_SNAPSHOT: Isolated candidate replay and cleanup failed; active physics was not replaced. Use an intact checkpoint.");
      fail(
        "TC_PHYSICS_SNAPSHOT",
        "Snapshot rejected atomically: " + String(error),
      );
    }
  }
  const physics: PhysicsServiceWithQueries = {
    createJoint(input) {
      const definition = validateJointDefinition(cloneSerializable(input));
      get(definition.body1); get(definition.body2);
      record({ kind: "jointCreate", definition });
    },
    destroyJoint(id) {
      alive(); ensureRefs();
      const definition = state.joints.joint(id);
      get(definition.body1); get(definition.body2);
      record({ kind: "jointDestroy", id });
    },
    inspectJoint(id) {
      alive(); ensureRefs();
      const definition = state.joints.joint(id);
      get(definition.body1); get(definition.body2);
      return definition;
    },
    listJoints() {
      alive(); ensureRefs();
      return state.joints.snapshot().joints.filter(definition => {
        const a = refs.get(definition.body1), b = refs.get(definition.body2);
        return !!a && !!b && context.world.isAlive(a) && context.world.isAlive(b);
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    },
    setGravity(value) {
      alive();
      record({ kind: "gravity", value: tuple(vec(value, "gravity")) });
    },
    gravity() {
      alive();
      return tuple(state.world.gravity);
    },
    setGravityScale(id, scale) {
      if (get(id).type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `Gravity scale requires a dynamic rigid body (${id}).`);
      if (!Number.isFinite(scale) || Math.abs(scale) > 1000 || (scale !== 0 && Math.fround(scale) === 0)) fail("TC_PHYSICS_GRAVITY_SCALE", "Gravity scale must be float32-representable in [-1000,1000].");
      record({ kind: "gravityScale", id, scale });
    },
    gravityScale(id) {
      const body = get(id);
      if (body.type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `Gravity scale requires a dynamic rigid body (${id}).`);
      return body.body.gravityScale();
    },
    moveCharacter(id, value) {
      if (!get(id).character) fail("TC_PHYSICS_CHARACTER", `${id} is not a character.`);
      record({ kind: "move", id, value: tuple(vec(value, "displacement")) });
    },
    grounded(id) {
      const c = get(id).character;
      if (!c) fail("TC_PHYSICS_CHARACTER", id + " is not a character.");
      return c.grounded;
    },
    velocity(id) {
      const b = get(id);
      return b.character
        ? [
            b.character.velocity[0],
            b.character.verticalVelocity,
            b.character.velocity[2],
          ]
        : tuple(b.body.linvel());
    },
    centerOfMass(id) {
      return tuple(get(id).body.worldCom());
    },
    setVelocity(id, value) {
      const body = get(id);
      if (!body.character && body.type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `setVelocity requires a dynamic body or character (${id}).`);
      record({ kind: "velocity", id, value: tuple(vec(value, "velocity")) });
    },
    impulse(id, value) {
      if (get(id).type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `impulse requires a dynamic body (${id}).`);
      record({ kind: "impulse", id, value: tuple(vec(value, "impulse")) });
    },
    angularVelocity(id) {
      return tuple(get(id).body.angvel());
    },
    setAngularVelocity(id, value) {
      if (get(id).type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `setAngularVelocity requires a dynamic body (${id}).`);
      record({ kind: "angularVelocity", id, value: tuple(vec(value, "angular velocity")) });
    },
    torqueImpulse(id, value) {
      if (get(id).type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `torqueImpulse requires a dynamic body (${id}).`);
      record({ kind: "torqueImpulse", id, value: tuple(vec(value, "torque impulse")) });
    },
    impulseAtPoint(id, value, point) {
      if (get(id).type !== "dynamic") fail("TC_PHYSICS_BODY_TYPE", `impulseAtPoint requires a dynamic body (${id}).`);
      record({ kind: "impulseAtPoint", id, value: tuple(vec(value, "impulse")), point: tuple(vec(point, "point")) });
    },
    raycast(
      origin: Vec3,
      direction: Vec3,
      maxDistance: number,
      options?: PhysicsRaycastOptions,
    ) {
      alive();
      ensureRefs();
      finite(maxDistance, "maxDistance");
      const o = vec(origin, "origin"),
        d = vec(direction, "direction"),
        l = Math.hypot(d.x, d.y, d.z);
      if (!l)
        fail(
          "TC_PHYSICS_RAY",
          "Ray direction is zero; supply a nonzero direction.",
        );
      if (
        options !== undefined &&
        (!options ||
          typeof options !== "object" ||
          Array.isArray(options) ||
          Object.keys(options).some(
            (k) => k !== "exclude" && k !== "includeTriggers",
          ) ||
          (options.exclude !== undefined &&
            (!Array.isArray(options.exclude) ||
              !options.exclude.every((id) => typeof id === "string"))) ||
          (options.includeTriggers !== undefined &&
            typeof options.includeTriggers !== "boolean"))
      )
        fail(
          "TC_PHYSICS_RAY",
          "Ray options require exclude string IDs and includeTriggers boolean.",
        );
      const excluded = new Set(options?.exclude ?? []),
        ray = new state.native.Ray(o, { x: d.x / l, y: d.y / l, z: d.z / l });
      const hit = state.world.castRayAndGetNormal(
        ray,
        maxDistance,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        (collider) => {
          const id = state.byCollider.get(collider.handle),
            ref = id ? refs.get(id) : undefined;
          return (
            !!id &&
            queryAlive(id) &&
            !excluded.has(id) &&
            (options?.includeTriggers === true || !collider.isSensor())
          );
        },
      );
      if (!hit) return null;
      return {
        entity: state.byCollider.get(hit.collider.handle)!,
        distance: hit.timeOfImpact,
        point: tuple(ray.pointAt(hit.timeOfImpact)),
        normal: tuple(hit.normal),
      };
    },
    castShape(input: PhysicsSweepShape, center, displacement, angles = [0, 0, 0], options) {
      alive();
      ensureRefs();
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail("TC_PHYSICS_SWEEP", "Supply a sphere, box or capsule sweep shape.");
      let shape: RAPIER.Shape;
      const validRadius = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e6 && Math.fround(value) > 0;
      if (input.shape === "sphere" && Object.keys(input).every(key => ["shape", "radius"].includes(key)) && validRadius(input.radius)) {
        shape = new state.native.Ball(input.radius);
      } else if (input.shape === "box" && Object.keys(input).every(key => ["shape", "halfExtents"].includes(key))) {
        const size = vec(input.halfExtents, "sweep box halfExtents");
        if ([size.x, size.y, size.z].some(value => value <= 0 || value > 1e6 || Math.fround(value) === 0))
          fail("TC_PHYSICS_SWEEP", "Box half-extents must be positive, float32-representable and at most 1e6.");
        shape = new state.native.Cuboid(size.x, size.y, size.z);
      } else if (input.shape === "capsule" && Object.keys(input).every(key => ["shape", "radius", "halfHeight"].includes(key)) && validRadius(input.radius) &&
          typeof input.halfHeight === "number" && Number.isFinite(input.halfHeight) && input.halfHeight >= 0 && input.halfHeight <= 1e6 &&
          (input.halfHeight === 0 || Math.fround(input.halfHeight) > 0)) {
        shape = new state.native.Capsule(input.halfHeight, input.radius);
      } else return fail("TC_PHYSICS_SWEEP", "Invalid sweep shape or dimensions; use positive float32-representable dimensions up to 1e6.");
      const position = vec(center, "sweep center"), travel = vec(displacement, "sweep displacement");
      vec(angles, "sweep rotation");
      const length = Math.hypot(travel.x, travel.y, travel.z);
      if (!length || !Math.hypot(Math.fround(travel.x), Math.fround(travel.y), Math.fround(travel.z)))
        fail("TC_PHYSICS_SWEEP", "Displacement must be nonzero and representable as float32; use overlap queries for a stationary shape.");
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) ||
          Object.keys(options).some(key => key !== "exclude" && key !== "includeTriggers") ||
          (options.exclude !== undefined && (!Array.isArray(options.exclude) || !options.exclude.every(id => typeof id === "string"))) ||
          (options.includeTriggers !== undefined && typeof options.includeTriggers !== "boolean")))
        fail("TC_PHYSICS_SWEEP", "Options require exclude string IDs and includeTriggers boolean.");
      const excluded = new Set(options?.exclude ?? []);
      const hit = state.world.castShape(position, rotation(angles), travel, shape, 0, 1, true,
        undefined, undefined, undefined, undefined, collider => {
          const id = state.byCollider.get(collider.handle), ref = id ? refs.get(id) : undefined;
          return !!id && queryAlive(id) && !excluded.has(id) &&
            (options?.includeTriggers === true || !collider.isSensor());
        });
      return hit ? { entity: state.byCollider.get(hit.collider.handle)!, fraction: hit.time_of_impact,
        distance: hit.time_of_impact * length, point: tuple(hit.witness1), normal: tuple(hit.normal1) } : null;
    },
    overlapSphere(center, radius, options) {
      alive();
      ensureRefs();
      const position = vec(center, "sphere center");
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0 || radius > 1e6 || Math.fround(radius) === 0)
        fail("TC_PHYSICS_OVERLAP", "Radius must be positive, float32-representable, and at most 1e6.");
      return overlapShape(position, { x: 0, y: 0, z: 0, w: 1 }, new state.native.Ball(radius), options);
    },
    overlapBox(center, halfExtents, angles = [0, 0, 0], options) {
      alive();
      ensureRefs();
      const position = vec(center, "box center"), size = vec(halfExtents, "box halfExtents");
      if ([size.x, size.y, size.z].some(value => value <= 0 || value > 1e6 || Math.fround(value) === 0))
        fail("TC_PHYSICS_OVERLAP", "Each half-extent must be positive, float32-representable, and at most 1e6.");
      vec(angles, "box rotation");
      return overlapShape(position, rotation(angles), new state.native.Cuboid(size.x, size.y, size.z), options);
    },
    overlapCapsule(center, halfHeight, radius, angles = [0, 0, 0], options) {
      alive();
      ensureRefs();
      const position = vec(center, "capsule center");
      if (typeof halfHeight !== "number" || !Number.isFinite(halfHeight) || halfHeight < 0 || halfHeight > 1e6 ||
          (halfHeight > 0 && Math.fround(halfHeight) === 0) || typeof radius !== "number" || !Number.isFinite(radius) ||
          radius <= 0 || radius > 1e6 || Math.fround(radius) === 0)
        fail("TC_PHYSICS_OVERLAP", "Half-height must be nonnegative and radius positive; both must be float32-representable and at most 1e6.");
      vec(angles, "capsule rotation");
      return overlapShape(position, rotation(angles), new state.native.Capsule(halfHeight, radius), options);
    },
  };
  const sampleRopeSphere = (id: string) => {
    const b = get(id);
    if (b.type !== "dynamic" || b.definition.rigidBody?.collider.shape !== "sphere" || b.collider.isSensor())
      fail("TC_PHYSICS_ROPE_BODY", `Rope body '${id}' must be a live dynamic, non-trigger sphere.`);
    const inertia = b.body.effectiveWorldInvInertia();
    const rotation = b.body.rotation();
    return {
      center: tuple(b.collider.translation()), radius: b.collider.radius(),
      friction: b.collider.friction(),
      bodyPosition: tuple(b.body.translation()), bodyOrientation: [rotation.x, rotation.y, rotation.z, rotation.w] as const,
      centerOfMass: tuple(b.body.worldCom()), linearVelocity: tuple(b.body.linvel()),
      angularVelocity: tuple(b.body.angvel()), inverseMass: tuple(b.body.effectiveInvMass()),
      inverseInertia: [inertia.m11, inertia.m12, inertia.m13, inertia.m22, inertia.m23, inertia.m33] as const,
    };
  };
  const sampleSimulationBody = (id: string, owner: "CLOTH" | "ROPE" | "PARTICLE"): ClothPhysicsBody => {
    const body = get(id), definition = body.definition.rigidBody;
    const code = `TC_PHYSICS_${owner}_BODY`;
    if (body.type !== "dynamic" || !definition || body.collider.isSensor())
      fail(code, `${owner} body '${id}' must be a live dynamic, non-trigger sphere or box.`);
    if (definition.collider.shape === "sphere") return { kind: "sphere", ...sampleRopeSphere(id) };
    if (definition.collider.shape !== "box")
      fail(code, `${owner} body '${id}' must use a sphere or box collider.`);
    const halfExtents = body.collider.halfExtents();
    if (!halfExtents || [halfExtents.x, halfExtents.y, halfExtents.z].some(value => !Number.isFinite(value) || value <= 0 || value > 1e6))
      fail(code, `${owner} body '${id}' has invalid box half-extents.`);
    const inertia = body.body.effectiveWorldInvInertia();
    const orientation = body.body.rotation();
    return { kind: "box", center: tuple(body.collider.translation()), halfExtents: tuple(halfExtents),
      friction: body.collider.friction(),
      bodyPosition: tuple(body.body.translation()), bodyOrientation: [orientation.x, orientation.y, orientation.z, orientation.w],
      rotation: euler(body.collider.rotation()), centerOfMass: tuple(body.body.worldCom()),
      linearVelocity: tuple(body.body.linvel()), angularVelocity: tuple(body.body.angvel()), inverseMass: tuple(body.body.effectiveInvMass()),
      inverseInertia: [inertia.m11, inertia.m12, inertia.m13, inertia.m22, inertia.m23, inertia.m33] };
  };
  const sampleClothBody = (id: string) => sampleSimulationBody(id, "CLOTH");
  const sampleRopeBody = (id: string) => sampleSimulationBody(id, "ROPE");
  const sampleParticleBody = (id: string) => sampleSimulationBody(id, "PARTICLE");
  const applyReactions = (reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[], owner: "SPHERE" | "CLOTH" | "ROPE" | "PARTICLE") => {
    alive();
    const seen = new Set<string>();
    const actions: Action[] = [];
    for (const { entity, impulse, moment } of reactions) {
      if (seen.has(entity)) fail("TC_PHYSICS_ROPE_BODY", `Duplicate reaction body '${entity}'.`);
      seen.add(entity);
      const sample = owner === "SPHERE" ? sampleRopeSphere(entity) : sampleSimulationBody(entity, owner), j = tuple(vec(impulse, "reaction"));
      const m = tuple(vec(moment, "reaction moment")), c = sample.centerOfMass;
      const torque: Vec3 = [m[0] - (c[1] * j[2] - c[2] * j[1]), m[1] - (c[2] * j[0] - c[0] * j[2]), m[2] - (c[0] * j[1] - c[1] * j[0])];
      vec(torque, "reaction torque");
      if (j.some(value => value !== 0)) actions.push({ kind: "impulse", id: entity, value: j });
      if (torque.some(value => value !== 0)) actions.push({ kind: "torqueImpulse", id: entity, value: torque });
    }
    if (history.length + actions.length > limit)
      fail("TC_PHYSICS_HISTORY_LIMIT", "Reactions exceed physics history capacity; start a new scene.");
    if (!actions.length) return;
    // A native failure can leave partial state. Do not replay history in this error path.
    try { for (const action of actions) record(action); }
    catch (error) {
      nativeFault = true;
      throw new AggregateError([error], "TC_PHYSICS_REACTION: Applying reaction failed; partialState=true. Restore a known-good checkpoint or restart the scene.");
    }
  };
  return {
    id: pluginId,
    version: "3",
    requiresRecovery: () => nativeFault,
    services: { physics },
    terrainPhysicsBridge: {
      setTerrain(terrain) { record({ kind: "terrainSet", terrain: terrainGeometry(terrain) }); },
      removeTerrain(id) { record({ kind: "terrainRemove", id }); },
    },
    ropePhysicsBridge: {
      sampleSphere: sampleRopeSphere,
      sampleClothBody,
      sampleRopeBody,
      sampleParticleBody,
      applySphereReactions(reactions) { applyReactions(reactions, "SPHERE"); },
      applyClothReactions(reactions) { applyReactions(reactions, "CLOTH"); },
      applyRopeReactions(reactions) { applyReactions(reactions, "ROPE"); },
      applyParticleReactions(reactions) { applyReactions(reactions, "PARTICLE"); },
    },
    systems: [
      {
        id: pluginId,
        phase: "physics",
        // records() checks access to every registered component. Omitted reads
        // grants this internal system metadata access without changing World APIs.
        writes: ["Transform"],
        run(dt) {
          const action = lifecycle(dt);
          record(action);
          bindRefs();
          for (const b of state.bodies.values())
            context.world.setTransform(refs.get(b.id)!, b.transform);
        },
      },
    ],
    snapshot,
    validateSnapshot(input) {
      const checked = validate(input);
      checked.candidate.dispose();
    },
    validateWorld(input, world) {
      const checked = validate(input);
      try {
        const records = new Map(world.entities.map((r) => [r.id, r]));
        for (const r of records.values()) {
          const e = resolveEntityDefinition(catalog, r);
          if (e && (e.rigidBody || e.character))
            validateDefinition({
              ...e,
              parent: r.parent ?? e.parent,
              transform: r.transform,
            });
        }
        for (const id of checked.bindings) {
          const r = records.get(id),
            expected = checked.candidate.get(id).definition,
            actual = r && resolveEntityDefinition(catalog, r);
          if (
            !actual ||
            !same(
              {
                prefab: actual.prefab,
                rigidBody: actual.rigidBody,
                character: actual.character,
              },
              {
                prefab: expected.prefab,
                rigidBody: expected.rigidBody,
                character: expected.character,
              },
            )
          )
            fail(
              "TC_PHYSICS_SNAPSHOT",
              "World binding identity differs for " + id,
            );
        }
      } finally {
        checked.candidate.dispose();
      }
    },
    restore(input) {
      const checked = validate(input),
        previous = state;
      state = checked.candidate;
      history = checked.history;
      bindRefs(checked.bindings);
      pendingBind = checked.bindings;
      try { previous.dispose(); }
      catch (error) {
        nativeFault = true;
        throw new AggregateError([error], "TC_PHYSICS_RESTORE_CLEANUP: Previous native state could not be released; partialState=true. Restart the scene.");
      }
      nativeFault = false;
      // RuntimeHost restores World before plugin state. A direct plugin context
      // may restore physics alone, so synchronize its live entity transforms too.
      for (const b of state.bodies.values()) {
        const ref = refs.get(b.id);
        if (ref) context.world.setTransform(ref, b.transform);
      }
    },
    inspect() {
      alive();
      ensureRefs();
      return {
        tick: state.tick,
        bodies: [...state.bodies.values()]
          .filter((b) => {
            const ref = refs.get(b.id);
            return !!ref && context.world.isAlive(ref);
          })
          .map((b) => ({
            id: b.id,
            type: b.type,
            position: tuple(b.body.translation()),
            velocity: physics.velocity(b.id),
            grounded: b.character?.grounded ?? null,
            contacts: state.contactCount(b.collider.handle),
          })),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.dispose();
      history = [];
      refs.clear();
    },
  };
}
