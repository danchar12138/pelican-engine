import RAPIER from "./rapier.ts";
import type { PhysicsJointDefinition } from "../sdk/src/index.ts";

// Internal-only: anchors, axes, and frames are local to their respective bodies.
type Vec3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];
export type InternalJoint = PhysicsJointDefinition;
export type InternalJointSnapshot = {
  format: "pelican.physics-joints-internal";
  version: 1;
  joints: InternalJoint[];
};

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return (
        typeof key === "string" &&
        "value" in descriptor &&
        descriptor.enumerable
      );
    })
  );
}
function vector(value: unknown, length: number, label: string): number[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length ||
    Reflect.ownKeys(value).length !== length + 1 ||
    !Array.from({ length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      return (
        descriptor &&
        "value" in descriptor &&
        descriptor.enumerable &&
        typeof descriptor.value === "number" &&
        Number.isFinite(descriptor.value) &&
        Math.abs(descriptor.value) <= 1e6
      );
    }).every(Boolean)
  )
    fail("TC_PHYSICS_JOINT_DEFINITION", `Invalid ${label}.`);
  return [...value];
}
function unit(value: unknown, length: number, label: string): number[] {
  const result = vector(value, length, label);
  if (Math.abs(Math.hypot(...result) - 1) > 1e-5)
    fail("TC_PHYSICS_JOINT_DEFINITION", `${label} must be normalized.`);
  return result;
}
export function validateJointDefinition(value: unknown): InternalJoint {
  if (!object(value))
    fail("TC_PHYSICS_JOINT_DEFINITION", "Expected a plain joint object.");
  const kind = value.kind;
  if (!["fixed", "revolute", "ball", "prismatic", "rope", "spring"].includes(kind as string))
    fail("TC_PHYSICS_JOINT_DEFINITION", "Unsupported joint kind.");
  const fields = [
    "id",
    "kind",
    "body1",
    "body2",
    "anchor1",
    "anchor2",
    ...(kind === "fixed"
      ? ["frame1", "frame2"]
      : kind === "revolute"
        ? ["axis1", "axis2"]
        : kind === "prismatic" ? ["axis"]
        : kind === "rope" ? ["length"]
        : kind === "spring" ? ["restLength", "stiffness", "damping"] : []),
  ];
  if (
    Object.keys(value).some(key => ![...fields, "contactsEnabled", ...(["revolute", "prismatic"].includes(kind as string) ? ["limits"] : [])].includes(key)) ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    fail("TC_PHYSICS_JOINT_DEFINITION", "Invalid joint fields.");
  for (const key of ["id", "body1", "body2"])
    if (
      typeof value[key] !== "string" ||
      !(value[key] as string).trim().length ||
      (value[key] as string).length > 256
    )
      fail("TC_PHYSICS_JOINT_DEFINITION", `Invalid ${key}.`);
  if (value.body1 === value.body2)
    fail("TC_PHYSICS_JOINT_BODY", "A joint requires distinct bodies.");
  const base = {
    id: value.id as string,
    body1: value.body1 as string,
    body2: value.body2 as string,
    anchor1: vector(value.anchor1, 3, "anchor1") as unknown as Vec3,
    anchor2: vector(value.anchor2, 3, "anchor2") as unknown as Vec3,
    ...(value.contactsEnabled === undefined ? {} : { contactsEnabled: value.contactsEnabled as boolean }),
  };
  if (value.contactsEnabled !== undefined && typeof value.contactsEnabled !== "boolean")
    fail("TC_PHYSICS_JOINT_DEFINITION", "contactsEnabled must be boolean.");
  let limits: readonly [number, number] | undefined;
  if (value.limits !== undefined) {
    const range = vector(value.limits, 2, "limits");
    if (range[0] > range[1]) fail("TC_PHYSICS_JOINT_DEFINITION", "Joint limits must be ordered.");
    limits = [range[0], range[1]];
  }
  const scalar = (key: string, positive: boolean): number => {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (positive && n === 0) || n > 1e6 || (n !== 0 && Math.fround(n) === 0))
      fail("TC_PHYSICS_JOINT_DEFINITION", `${key} must be finite, representable and ${positive ? "positive" : "nonnegative"}, at most 1e6.`);
    return n as number;
  };
  if (kind === "ball") return { ...base, kind };
  if (kind === "rope") return { ...base, kind, length: scalar("length", true) };
  if (kind === "spring") return { ...base, kind, restLength: scalar("restLength", false), stiffness: scalar("stiffness", true), damping: scalar("damping", false) };
  if (kind === "prismatic") return { ...base, kind, axis: unit(value.axis, 3, "axis") as unknown as Vec3, ...(limits ? { limits } : {}) };
  if (kind === "revolute")
    return {
      ...base,
      kind,
      axis1: unit(value.axis1, 3, "axis1") as unknown as Vec3,
      axis2: unit(value.axis2, 3, "axis2") as unknown as Vec3,
      ...(limits ? { limits } : {}),
    };
  return {
    ...base,
    kind: "fixed",
    frame1: unit(value.frame1, 4, "frame1") as unknown as Quaternion,
    frame2: unit(value.frame2, 4, "frame2") as unknown as Quaternion,
  };
}
const v = (a: Vec3) => ({ x: a[0], y: a[1], z: a[2] });
const q = (a: Quaternion) => ({ x: a[0], y: a[1], z: a[2], w: a[3] });

/** Owns only its joints; the caller owns the world and keeps its bodies alive. */
export function createInternalJoints(
  world: RAPIER.World,
  bodies: ReadonlyMap<string, RAPIER.RigidBody>,
  native: typeof RAPIER = RAPIER,
) {
  const entries = new Map<
    string,
    { definition: InternalJoint; joint: RAPIER.ImpulseJoint }
  >();
  function checked(input: unknown) {
    const definition = validateJointDefinition(input),
      a = bodies.get(definition.body1),
      b = bodies.get(definition.body2);
    if (
      !a ||
      !b ||
      world.bodies.get(a.handle) !== a ||
      world.bodies.get(b.handle) !== b ||
      !a.isValid() ||
      !b.isValid()
    )
      fail(
        "TC_PHYSICS_JOINT_BODY",
        "Joint bodies must belong to the world and be live.",
      );
    if (a === b)
      fail("TC_PHYSICS_JOINT_BODY", "A joint requires distinct bodies.");
    if (
      (!a.isFixed() && !a.isDynamic()) ||
      (!b.isFixed() && !b.isDynamic()) ||
      (a.isFixed() && b.isFixed())
    )
      fail(
        "TC_PHYSICS_JOINT_BODY",
        "Only fixed/dynamic pairs with at least one dynamic body are supported.",
      );
    return { definition, a, b };
  }
  function create(input: unknown) {
    const { definition: d, a, b } = checked(input);
    if (entries.has(d.id))
      fail("TC_PHYSICS_JOINT_DUPLICATE", `Duplicate joint ${d.id}.`);
    if (entries.size >= 10000)
      fail("TC_PHYSICS_JOINT_LIMIT", "Joint limit exceeded.");
    const data =
      d.kind === "ball"
        ? native.JointData.spherical(v(d.anchor1), v(d.anchor2))
        : d.kind === "fixed"
          ? native.JointData.fixed(
              v(d.anchor1),
              q(d.frame1),
              v(d.anchor2),
              q(d.frame2),
            )
          : d.kind === "revolute" ? native.JointData.revoluteWithAxes(
              v(d.anchor1),
              v(d.anchor2),
              v(d.axis1),
              v(d.axis2),
            )
          : d.kind === "prismatic" ? native.JointData.prismatic(v(d.anchor1), v(d.anchor2), v(d.axis))
          : d.kind === "rope" ? native.JointData.rope(d.length, v(d.anchor1), v(d.anchor2))
          : native.JointData.spring(d.restLength, d.stiffness, d.damping, v(d.anchor1), v(d.anchor2));
    const joint = world.createImpulseJoint(data, a, b, true);
    try {
      joint.setContactsEnabled(d.contactsEnabled ?? false);
      if ((d.kind === "prismatic" || d.kind === "revolute") && d.limits)
        (joint as RAPIER.UnitImpulseJoint).setLimits(d.limits[0], d.limits[1]);
    } catch (error) {
      const failures = [error];
      try { world.removeImpulseJoint(joint, true); } catch (cleanup) { failures.push(cleanup); }
      throw new AggregateError(failures, "TC_PHYSICS_JOINT_NATIVE: Native configuration failed; partialState=true. Restore a checkpoint or restart.");
    }
    entries.set(d.id, { definition: d, joint });
  }
  function entry(id: string) {
    const result = entries.get(id);
    if (!result) fail("TC_PHYSICS_JOINT_ID", `Unknown joint ${id}.`);
    checked(result.definition);
    if (!result.joint.isValid())
      fail("TC_PHYSICS_JOINT_BODY", "Joint is no longer live.");
    return result;
  }
  function joint(id: string): Readonly<InternalJoint> {
    return structuredClone(entry(id).definition);
  }
  function remove(id: string) {
    const found = entry(id);
    try { world.removeImpulseJoint(found.joint, true); }
    catch (error) { throw new AggregateError([error], "TC_PHYSICS_JOINT_NATIVE: Native removal failed; partialState=true. Restore a checkpoint or restart."); }
    entries.delete(id);
  }
  function removeForBody(id: string) {
    const ids = [...entries.values()]
      .filter(({ definition }) => definition.body1 === id || definition.body2 === id)
      .map(({ definition }) => definition.id);
    // Check the entire set while the caller still owns both live bodies.
    for (const jointId of ids) entry(jointId);
    for (const jointId of ids) remove(jointId);
  }
  function snapshot(): InternalJointSnapshot {
    for (const { definition, joint } of entries.values()) {
      checked(definition);
      if (!joint.isValid())
        fail("TC_PHYSICS_JOINT_BODY", "Joint is no longer live.");
    }
    return {
      format: "pelican.physics-joints-internal",
      version: 1,
      joints: [...entries.values()].map((entry) =>
        structuredClone(entry.definition),
      ),
    };
  }
  function restore(input: unknown) {
    if (entries.size)
      fail(
        "TC_PHYSICS_JOINT_SNAPSHOT",
        "Restore requires an empty joint registry.",
      );
    try {
      if (
        !object(input) ||
        Object.keys(input).sort().join() !== "format,joints,version" ||
        input.format !== "pelican.physics-joints-internal" ||
        input.version !== 1 ||
        !Array.isArray(input.joints) ||
        input.joints.length > 10000 ||
        Reflect.ownKeys(input.joints).length !== input.joints.length + 1
      )
        fail("TC_PHYSICS_JOINT_SNAPSHOT", "Invalid snapshot header.");
      const seen = new Set<string>();
      const definitions = Array.from(
        { length: input.joints.length },
        (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            input.joints as unknown[],
            String(index),
          );
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            fail("TC_PHYSICS_JOINT_SNAPSHOT", "Invalid joint list.");
          const { definition } = checked(descriptor.value);
          if (seen.has(definition.id))
            fail("TC_PHYSICS_JOINT_DUPLICATE", "Duplicate snapshot joint.");
          seen.add(definition.id);
          return definition;
        },
      );
      for (const definition of definitions) create(definition);
    } catch (error) {
      for (const { joint } of entries.values())
        if (joint.isValid()) world.removeImpulseJoint(joint, true);
      entries.clear();
      fail("TC_PHYSICS_JOINT_SNAPSHOT", `Snapshot rejected: ${String(error)}`);
    }
  }
  function handles() { return [...entries].map(([id, entry]) => ({ id, handle: entry.joint.handle })); }
  function adopt(definitions: readonly InternalJoint[], saved: readonly { id: string; handle: number }[]) {
    if (entries.size || definitions.length !== saved.length) fail("TC_PHYSICS_JOINT_SNAPSHOT", "Invalid checkpoint joint registry.");
    const seen = new Set<number>();
    for (const definition of definitions) {
      const { definition: d, a, b } = checked(definition);
      const handle = saved.find(item => item.id === d.id)?.handle;
      const joint = handle === undefined ? null : world.impulseJoints.get(handle);
      if (!joint || seen.has(handle!) || joint.body1().handle !== a.handle || joint.body2().handle !== b.handle)
        fail("TC_PHYSICS_JOINT_SNAPSHOT", "Checkpoint joint endpoints differ from the native world.");
      seen.add(handle!); entries.set(d.id, { definition: d, joint });
    }
    if (world.impulseJoints.len() !== entries.size) fail("TC_PHYSICS_JOINT_SNAPSHOT", "Checkpoint contains unowned joints.");
  }
  return { create, joint, remove, removeForBody, snapshot, restore, handles, adopt };
}
