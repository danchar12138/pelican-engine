import RAPIER from "@dimforge/rapier3d-compat";
import type {
  CharacterDefinition,
  EntityHandle,
  PhysicsService,
  PhysicsSweepShape,
  RigidBodyDefinition,
  Transform,
  Vec3,
} from "../sdk/src/index.ts";
import type { WorldSnapshot } from "../runtime/src/contracts.ts";
import { cloneSerializable } from "../runtime/src/random.ts";
import type { EntityIR, SceneIR } from "../compiler/src/types.ts";
import { resolveEntityDefinition } from "../runtime/src/prefabs.ts";
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFactory,
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
  | { kind: "impulseAtPoint"; id: string; value: Vec3; point: Vec3 };
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
function shape(e: EntityIR, t: Transform): RAPIER.Shape {
  const d = e.rigidBody!.collider,
    s = t.scale;
  if (d.shape === "box")
    return new RAPIER.Cuboid(
      (d.size![0] * s[0]) / 2,
      (d.size![1] * s[1]) / 2,
      (d.size![2] * s[2]) / 2,
    );
  if (d.shape === "sphere") return new RAPIER.Ball(d.radius! * s[0]);
  return new RAPIER.Capsule(d.halfHeight! * s[1], d.radius! * s[0]);
}
let initialization: Promise<RuntimePluginFactory> | undefined;
let initialized = false;
const factory: RuntimePluginFactory = (context) => createPlugin(context);
/** Initialize WASM once, including concurrent callers. */
export async function createPhysicsFactory(): Promise<RuntimePluginFactory> {
  return (initialization ??= RAPIER.init().then(() => {
    initialized = true;
    return factory;
  }));
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
  const world = new RAPIER.World(vec(gravity, "gravity"));
  let queue: RAPIER.EventQueue | undefined;
  const bodies = new Map<string, BodyEntry>(),
    byCollider = new Map<number, string>(),
    pairs = new Map<string, { a: number; b: number; trigger: boolean }>();
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
        cd = new RAPIER.ColliderDesc(shape(e, e.transform));
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
    for (const [key, p] of pairs)
      if (p.a === b.collider.handle || p.b === b.collider.handle) {
        emitPair(p, false, emit);
        pairs.delete(key);
      }
    if (b.controller) world.removeCharacterController(b.controller);
    byCollider.delete(b.collider.handle);
    world.removeRigidBody(b.body);
    bodies.delete(id);
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
        b.collider.setShape(shape(b.definition, t));
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
      !["step", "move", "velocity", "impulse", "angularVelocity", "torqueImpulse", "impulseAtPoint", "gravity"].includes(action.kind)
    )
      fail("TC_PHYSICS_SNAPSHOT", "Invalid history action.");
    if (action.kind === "gravity") {
      if (Object.keys(action).length !== 2 || !Object.hasOwn(action, "value"))
        fail("TC_PHYSICS_SNAPSHOT", "Invalid gravity history action fields.");
      world.gravity = vec(action.value, "gravity");
      for (const body of bodies.values()) if (body.type === "dynamic") body.body.wakeUp();
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
  function alive() {
    if (disposed)
      fail(
        "TC_PHYSICS_DISPOSED",
        "Physics plugin disposed; create a new host.",
      );
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
      if (id && ref && context.world.isAlive(ref) && !excluded.has(id) && (options?.includeTriggers === true || !collider.isSensor())) found.add(id);
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
    state.apply(action, emit);
    history.push(structuredClone(action));
  }
  function get(id: string) {
    alive();
    ensureRefs();
    const ref = refs.get(id);
    if (!ref || !context.world.isAlive(ref))
      fail("TC_PHYSICS_ENTITY", id + " has no live physics body.");
    return state.get(id);
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
    alive();
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
        !Array.isArray(s.pairs)
      )
        fail(
          "TC_PHYSICS_SNAPSHOT",
          "Malformed/incompatible snapshot header; use an intact version 3 snapshot of this scene.",
        );
      // No caller-controlled bytes ever reach World.restoreSnapshot. Reconstruct
      // safe native state from checked operations, then verify ALL native/header data.
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
        })
      )
        fail(
          "TC_PHYSICS_SNAPSHOT",
          "Native state, entity/handle mapping, character state or contact pairs differ from verified history.",
        );
      return { candidate, history: s.history, bindings: s.bindings };
    } catch (error) {
      candidate?.dispose();
      fail(
        "TC_PHYSICS_SNAPSHOT",
        "Snapshot rejected atomically: " + String(error),
      );
    }
  }
  const physics: PhysicsServiceWithQueries = {
    setGravity(value) {
      alive();
      record({ kind: "gravity", value: tuple(vec(value, "gravity")) });
    },
    gravity() {
      alive();
      return tuple(state.world.gravity);
    },
    moveCharacter(id, value) {
      get(id);
      record({ kind: "move", id, value });
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
      get(id);
      record({ kind: "velocity", id, value });
    },
    impulse(id, value) {
      get(id);
      record({ kind: "impulse", id, value });
    },
    angularVelocity(id) {
      return tuple(get(id).body.angvel());
    },
    setAngularVelocity(id, value) {
      get(id);
      record({ kind: "angularVelocity", id, value: tuple(vec(value, "angular velocity")) });
    },
    torqueImpulse(id, value) {
      get(id);
      record({ kind: "torqueImpulse", id, value: tuple(vec(value, "torque impulse")) });
    },
    impulseAtPoint(id, value, point) {
      get(id);
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
        ray = new RAPIER.Ray(o, { x: d.x / l, y: d.y / l, z: d.z / l });
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
            !!ref &&
            context.world.isAlive(ref) &&
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
        shape = new RAPIER.Ball(input.radius);
      } else if (input.shape === "box" && Object.keys(input).every(key => ["shape", "halfExtents"].includes(key))) {
        const size = vec(input.halfExtents, "sweep box halfExtents");
        if ([size.x, size.y, size.z].some(value => value <= 0 || value > 1e6 || Math.fround(value) === 0))
          fail("TC_PHYSICS_SWEEP", "Box half-extents must be positive, float32-representable and at most 1e6.");
        shape = new RAPIER.Cuboid(size.x, size.y, size.z);
      } else if (input.shape === "capsule" && Object.keys(input).every(key => ["shape", "radius", "halfHeight"].includes(key)) && validRadius(input.radius) &&
          typeof input.halfHeight === "number" && Number.isFinite(input.halfHeight) && input.halfHeight >= 0 && input.halfHeight <= 1e6 &&
          (input.halfHeight === 0 || Math.fround(input.halfHeight) > 0)) {
        shape = new RAPIER.Capsule(input.halfHeight, input.radius);
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
          return !!id && !!ref && context.world.isAlive(ref) && !excluded.has(id) &&
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
      return overlapShape(position, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(radius), options);
    },
    overlapBox(center, halfExtents, angles = [0, 0, 0], options) {
      alive();
      ensureRefs();
      const position = vec(center, "box center"), size = vec(halfExtents, "box halfExtents");
      if ([size.x, size.y, size.z].some(value => value <= 0 || value > 1e6 || Math.fround(value) === 0))
        fail("TC_PHYSICS_OVERLAP", "Each half-extent must be positive, float32-representable, and at most 1e6.");
      vec(angles, "box rotation");
      return overlapShape(position, rotation(angles), new RAPIER.Cuboid(size.x, size.y, size.z), options);
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
      return overlapShape(position, rotation(angles), new RAPIER.Capsule(halfHeight, radius), options);
    },
  };
  const sampleRopeSphere = (id: string) => {
    const b = get(id);
    if (b.type !== "dynamic" || b.definition.rigidBody?.collider.shape !== "sphere" || b.collider.isSensor())
      fail("TC_PHYSICS_ROPE_BODY", `Rope body '${id}' must be a live dynamic, non-trigger sphere.`);
    const inertia = b.body.effectiveWorldInvInertia();
    return {
      center: tuple(b.collider.translation()), radius: b.collider.radius(),
      centerOfMass: tuple(b.body.worldCom()), linearVelocity: tuple(b.body.linvel()),
      angularVelocity: tuple(b.body.angvel()), inverseMass: tuple(b.body.effectiveInvMass()),
      inverseInertia: [inertia.m11, inertia.m12, inertia.m13, inertia.m22, inertia.m23, inertia.m33] as const,
    };
  };
  return {
    id: pluginId,
    version: "3",
    services: { physics },
    ropePhysicsBridge: {
      sampleSphere: sampleRopeSphere,
      applySphereReactions(reactions) {
        alive();
        const seen = new Set<string>();
        const actions: Action[] = [];
        for (const { entity, impulse, moment } of reactions) {
          if (seen.has(entity)) fail("TC_PHYSICS_ROPE_BODY", `Duplicate rope reaction body '${entity}'.`);
          seen.add(entity);
          const sample = sampleRopeSphere(entity), j = tuple(vec(impulse, "rope reaction"));
          const m = tuple(vec(moment, "rope reaction moment")), c = sample.centerOfMass;
          const torque: Vec3 = [m[0] - (c[1] * j[2] - c[2] * j[1]), m[1] - (c[2] * j[0] - c[0] * j[2]), m[2] - (c[0] * j[1] - c[1] * j[0])];
          vec(torque, "rope reaction torque");
          if (j.some(value => value !== 0)) actions.push({ kind: "impulse", id: entity, value: j });
          if (torque.some(value => value !== 0)) actions.push({ kind: "torqueImpulse", id: entity, value: torque });
        }
        if (history.length + actions.length > limit)
          fail("TC_PHYSICS_HISTORY_LIMIT", "Rope reactions exceed physics history capacity; start a new scene.");
        // Record the whole batch as one recoverable transaction. Native actions are
        // still applied sequentially, so a failed action must rebuild the physics
        // state and history from the pre-batch snapshot before the host faults.
        const before = snapshot(), previousHistory = history.slice(), previousState = state;
        try {
          for (const action of actions) record(action);
        } catch (error) {
          try {
            const checked = validate(before);
            state = checked.candidate;
            history = previousHistory;
            bindRefs(checked.bindings);
            previousState.dispose();
            for (const body of state.bodies.values()) {
              const ref = refs.get(body.id);
              if (ref) context.world.setTransform(ref, body.transform);
            }
          } catch (rollbackError) {
            throw new Error(`TC_PHYSICS_REACTION_ROLLBACK: ${String(error)}; partialState=true; rollback failure: ${String(rollbackError)}`);
          }
          throw new Error(`TC_PHYSICS_REACTION: ${String(error)}; reaction batch rolled back.`);
        }
      },
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
          // Conservatively reject the known unsafe initial deletion path before
          // invoking native physics. This does not protect historical replay.
          if (state.tick === 0) {
            const blocked = action.removed.filter(id => state.bodies.get(id)?.type !== "fixed");
            if (blocked.length > 0)
              fail(
                "TC_PHYSICS_FIRST_STEP_REMOVAL",
                `Cannot remove moving physics bodies before the first physics step: ${blocked.join(", ")}. Keep them alive until a physics step completes.`,
              );
          }
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
      previous.dispose();
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
