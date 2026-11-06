import RAPIER from "@dimforge/rapier3d-compat";

// Internal-only: anchors, axes, and frames are local to their respective bodies.
type Vec3 = readonly [number, number, number];
type Quaternion = readonly [number, number, number, number];
type Base = {
  id: string;
  body1: string;
  body2: string;
  anchor1: Vec3;
  anchor2: Vec3;
};
export type InternalJoint =
  | (Base & { kind: "ball" })
  | (Base & { kind: "revolute"; axis1: Vec3; axis2: Vec3 })
  | (Base & { kind: "fixed"; frame1: Quaternion; frame2: Quaternion });
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
function validate(value: unknown): InternalJoint {
  if (!object(value))
    fail("TC_PHYSICS_JOINT_DEFINITION", "Expected a plain joint object.");
  const kind = value.kind;
  if (kind !== "fixed" && kind !== "revolute" && kind !== "ball")
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
        : []),
  ];
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    fail("TC_PHYSICS_JOINT_DEFINITION", "Invalid joint fields.");
  for (const key of ["id", "body1", "body2"])
    if (
      typeof value[key] !== "string" ||
      !(value[key] as string).length ||
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
  };
  if (kind === "ball") return { ...base, kind };
  if (kind === "revolute")
    return {
      ...base,
      kind,
      axis1: unit(value.axis1, 3, "axis1") as unknown as Vec3,
      axis2: unit(value.axis2, 3, "axis2") as unknown as Vec3,
    };
  return {
    ...base,
    kind,
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
) {
  const entries = new Map<
    string,
    { definition: InternalJoint; joint: RAPIER.ImpulseJoint }
  >();
  function checked(input: unknown) {
    const definition = validate(input),
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
        ? RAPIER.JointData.spherical(v(d.anchor1), v(d.anchor2))
        : d.kind === "fixed"
          ? RAPIER.JointData.fixed(
              v(d.anchor1),
              q(d.frame1),
              v(d.anchor2),
              q(d.frame2),
            )
          : RAPIER.JointData.revoluteWithAxes(
              v(d.anchor1),
              v(d.anchor2),
              v(d.axis1),
              v(d.axis2),
            );
    const joint = world.createImpulseJoint(data, a, b, true);
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
    world.removeImpulseJoint(found.joint, true);
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
  return { create, joint, remove, removeForBody, snapshot, restore };
}
