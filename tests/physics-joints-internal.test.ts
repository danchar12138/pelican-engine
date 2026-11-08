import assert from "node:assert/strict";
import test from "node:test";
import RAPIER from "../packages/physics/rapier.ts";
import {
  createInternalJoints,
  type InternalJoint,
} from "../packages/physics/joints-internal.ts";

await RAPIER.init();

function rig(first: "fixed" | "dynamic" = "fixed") {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const a = world.createRigidBody(
    first === "fixed"
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic(),
  );
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  for (const body of [a, b])
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(1).setSensor(true),
      body,
    );
  const bodies = new Map([
    ["a", a],
    ["b", b],
  ]);
  return { world, a, b, bodies, joints: createInternalJoints(world, bodies) };
}
const base = {
  id: "joint",
  body1: "a",
  body2: "b",
  anchor1: [0, 0, 0],
  anchor2: [0, 0, 0],
} as const;
const definitions: InternalJoint[] = [
  { ...base, kind: "fixed", frame1: [0, 0, 0, 1], frame2: [0, 0, 0, 1] },
  { ...base, kind: "revolute", axis1: [1, 0, 0], axis2: [1, 0, 0] },
  { ...base, kind: "ball" },
];
function advance(world: RAPIER.World, count = 120) {
  world.timestep = 1 / 120;
  for (let i = 0; i < count; i++) world.step();
}

for (const first of ["fixed", "dynamic"] as const)
  for (const definition of definitions) {
    test(`${first}/dynamic ${definition.kind} constrains translation and expected rotations`, () => {
      const r = rig(first);
      try {
        r.joints.create(definition);
        r.b.setLinvel({ x: 1, y: 2, z: 3 }, true);
        r.b.setAngvel({ x: 3, y: 2, z: 0 }, true);
        advance(r.world);
        const a = r.a.translation(),
          b = r.b.translation();
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.03);
        const av = r.a.angvel(),
          bv = r.b.angvel();
        const relativeX = bv.x - av.x,
          relativeY = bv.y - av.y;
        if (definition.kind === "fixed")
          assert.ok(Math.hypot(relativeX, relativeY, bv.z - av.z) < 0.05);
        if (definition.kind === "revolute") {
          const rotation = r.a.rotation();
          const axis = {
            x: 1 - 2 * (rotation.y ** 2 + rotation.z ** 2),
            y: 2 * (rotation.x * rotation.y + rotation.w * rotation.z),
            z: 2 * (rotation.x * rotation.z - rotation.w * rotation.y),
          };
          const relative = { x: relativeX, y: relativeY, z: bv.z - av.z };
          const along =
            relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
          const locked = Math.hypot(
            relative.x - along * axis.x,
            relative.y - along * axis.y,
            relative.z - along * axis.z,
          );
          assert.ok(Math.abs(along) > 0.5, `hinge rotation ${along}`);
          assert.ok(locked < 0.05, `locked rotation ${locked}`);
        }
        if (definition.kind === "ball")
          assert.ok(Math.abs(relativeX) > 0.5 && Math.abs(relativeY) > 0.5);
      } finally {
        r.world.free();
      }
    });
  }

test("definition snapshot is isolated, reconstructs joints, and deterministic worlds continue equally", () => {
  const a = rig(),
    b = rig();
  try {
    for (const [i, definition] of definitions.entries())
      a.joints.create({ ...definition, id: `j${i}` });
    const saved = JSON.parse(JSON.stringify(a.joints.snapshot()));
    b.joints.restore(saved);
    assert.deepEqual(b.joints.snapshot(), saved);
    saved.joints[0].anchor1[0] = 99;
    assert.equal(b.joints.snapshot().joints[0].anchor1[0], 0);
    for (const r of [a, b]) {
      r.b.setLinvel({ x: 1, y: 2, z: 3 }, true);
      advance(r.world, 30);
    }
    assert.deepEqual(a.b.translation(), b.b.translation());
    assert.deepEqual(a.b.rotation(), b.b.rotation());
    assert.throws(
      () => b.joints.restore(a.joints.snapshot()),
      /TC_PHYSICS_JOINT_SNAPSHOT/,
    );
  } finally {
    a.world.free();
    b.world.free();
  }
});

test("revolute anchors and independently oriented local axes remain aligned", () => {
  const r = rig();
  try {
    const half = Math.SQRT1_2;
    r.b.setTranslation({ x: 1, y: 0, z: 0 }, true);
    r.b.setRotation({ x: 0, y: 0, z: half, w: half }, true);
    r.joints.create({
      ...base,
      kind: "revolute",
      anchor1: [1, 0, 0],
      anchor2: [0, 0, 0],
      axis1: [1, 0, 0],
      axis2: [0, -1, 0],
    });
    r.b.setAngvel({ x: 2, y: 1, z: 0 }, true);
    advance(r.world);
    const position = r.b.translation(),
      velocity = r.b.angvel();
    assert.ok(Math.hypot(position.x - 1, position.y, position.z) < 0.03);
    assert.ok(Math.abs(velocity.x) > 0.5);
    assert.ok(Math.hypot(velocity.y, velocity.z) < 0.05);
  } finally {
    r.world.free();
  }
});

test("invalid definitions and body identities fail without modifying native joints", () => {
  const r = rig(),
    other = rig();
  try {
    const invalid = [
      { ...base, kind: "unknown" },
      { ...definitions[0], extra: true },
      { ...definitions[0], frame1: [0, 0, 0, 0] },
      { ...definitions[1], axis1: [0, 0, 0] },
      { ...definitions[2], anchor1: [NaN, 0, 0] },
      { ...definitions[2], anchor1: [Infinity, 0, 0] },
    ];
    for (const d of invalid)
      assert.throws(() => r.joints.create(d), /TC_PHYSICS_JOINT_DEFINITION/);
    for (const d of [
      { ...definitions[2], body2: "a" },
      { ...definitions[2], body2: "missing" },
    ])
      assert.throws(() => r.joints.create(d), /TC_PHYSICS_JOINT_BODY/);
    const foreign = createInternalJoints(
      r.world,
      new Map([
        ["a", r.a],
        ["b", other.b],
      ]),
    );
    assert.throws(
      () => foreign.create(definitions[2]),
      /TC_PHYSICS_JOINT_BODY/,
    );
    const alias = createInternalJoints(
      r.world,
      new Map([
        ["a", r.b],
        ["b", r.b],
      ]),
    );
    assert.throws(() => alias.create(definitions[2]), /TC_PHYSICS_JOINT_BODY/);
    const kinematic = r.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased(),
    );
    const unsupported = createInternalJoints(
      r.world,
      new Map([
        ["a", r.a],
        ["b", kinematic],
      ]),
    );
    assert.throws(
      () => unsupported.create(definitions[2]),
      /TC_PHYSICS_JOINT_BODY/,
    );
    assert.equal(r.world.impulseJoints.len(), 0);
    r.joints.create(definitions[0]);
    assert.throws(
      () => r.joints.create(definitions[0]),
      /TC_PHYSICS_JOINT_DUPLICATE/,
    );
    assert.equal(r.world.impulseJoints.len(), 1);
  } finally {
    r.world.free();
    other.world.free();
  }
});

test("malformed definition snapshots are rejected before any joints are created", () => {
  const r = rig();
  try {
    const header = { format: "pelican.physics-joints-internal", version: 1 };
    const bad = [
      { ...header, version: 2, joints: [] },
      { ...header, joints: [definitions[0], definitions[0]] },
      {
        ...header,
        joints: [definitions[0], { ...definitions[1], axis2: [0, 0, 0] }],
      },
      {
        ...header,
        joints: [definitions[0], { ...definitions[1], body2: "missing" }],
      },
      { ...header, joints: Array(1) },
    ];
    for (const snapshot of bad) {
      assert.throws(
        () => r.joints.restore(snapshot),
        /TC_PHYSICS_JOINT_SNAPSHOT/,
      );
      assert.equal(r.world.impulseJoints.len(), 0);
      assert.deepEqual(r.joints.snapshot().joints, []);
    }
  } finally {
    r.world.free();
  }
});

test("query and explicit removal isolate definitions and preserve unrelated joints", () => {
  const r = rig();
  try {
    r.joints.create(definitions[0]);
    r.joints.create({ ...definitions[2], id: "second" });
    const copy = r.joints.joint("joint");
    (copy.anchor1 as unknown as number[])[0] = 42;
    assert.equal(r.joints.joint("joint").anchor1[0], 0);
    assert.throws(() => r.joints.remove("missing"), /TC_PHYSICS_JOINT_ID/);
    assert.equal(r.world.impulseJoints.len(), 2);
    r.joints.remove("joint");
    assert.throws(() => r.joints.joint("joint"), /TC_PHYSICS_JOINT_ID/);
    assert.equal(r.world.impulseJoints.len(), 1);
    assert.equal(r.joints.joint("second").kind, "ball");
    r.joints.create(definitions[0]);
    assert.equal(r.world.impulseJoints.len(), 2);
  } finally {
    r.world.free();
  }
});

test("body cleanup removes only connected joints before the body is removed", () => {
  const r = rig();
  try {
    const c = r.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    const d = r.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    r.bodies.set("c", c);
    r.bodies.set("d", d);
    r.joints.create(definitions[0]);
    r.joints.create({ ...definitions[2], id: "other", body1: "c", body2: "d" });
    r.joints.removeForBody("a");
    assert.equal(r.world.impulseJoints.len(), 1);
    assert.equal(r.joints.joint("other").id, "other");
    assert.throws(() => r.joints.joint("joint"), /TC_PHYSICS_JOINT_ID/);
    r.joints.removeForBody("missing");
    assert.equal(r.world.impulseJoints.len(), 1);
  } finally {
    r.world.free();
  }
});
