import test from "node:test";
import assert from "node:assert/strict";
import { createPhysicsFactory, type PhysicsServiceWithQueries } from "../packages/physics/index.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { SDK_VERSION, type Vec3 } from "../packages/sdk/src/index.ts";
import type { EntityIR, SceneIR } from "../packages/compiler/src/types.ts";
import type { RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

const factory = await createPhysicsFactory();
const transform = (position: Vec3 = [0, 0, 0]) => ({ position, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const box = (id: string, type: "dynamic" | "fixed" | "kinematic", position: Vec3): EntityIR => ({
  id, transform: transform(position), components: {},
  rigidBody: { type, collider: { shape: "box", size: [2, 2, 2] }, mass: 2, friction: 0, restitution: 0, trigger: false },
});
const entities: EntityIR[] = [
  box("body", "dynamic", [3, 0, 0]), box("center", "dynamic", [10, 0, 0]),
  box("fixed", "fixed", [20, 0, 0]), box("kinematic", "kinematic", [30, 0, 0]),
  { id: "character", transform: transform([40, 0, 0]), components: {}, character: { radius: 0.3, height: 1.8, speed: 5, jumpSpeed: 5, gravity: 9.81 } },
];
function rig() {
  const scene = { format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "angular-test",
    scene: { id: "scene", camera: { position: [0, 5, 10], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 }, environment: { background: "#000000", ambientIntensity: 1 }, gravity: [0, 0, 0], entities },
    components: [], systems: [], prefabs: [], materials: [], computes: [], assets: [] } as SceneIR;
  const world = createWorld({ entities: entities.map((e) => ({ id: e.id, transform: e.transform, components: {} })) });
  const context = { scene, world, events: () => [], emit: () => ({}) } as unknown as RuntimePluginContext;
  const plugin = factory(context), physics = plugin.services!.physics! as PhysicsServiceWithQueries, system = plugin.systems![0];
  return { world, plugin, physics, step() { world.runSystem(system.id, system, () => system.run(1 / 60)); }, dispose() { plugin.dispose(); world.dispose(); } };
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`);
const snapshot = (r: ReturnType<typeof rig>) => r.plugin.snapshot() as { history: any[]; entities: { id: string }[] };

test("world-space impulses yield expected linear and angular momentum immediately", () => {
  const r = rig();
  try {
    const p = r.physics;
    p.impulseAtPoint("body", [0, 2, 0], [4, 0, 0]);
    p.impulseAtPoint("center", [0, 2, 0], [10, 0, 0]);
    near(p.velocity("body")[1], 1);
    near(p.velocity("center")[1], 1);
    // A 2 x 2 x 2 cube of mass 2 has Izz = 4/3. r cross J = 2.
    near(p.angularVelocity("body")[2], 1.5);
    near(p.angularVelocity("center")[2], 0);
    p.torqueImpulse("center", [0, 0, 2]);
    near(p.angularVelocity("center")[2], 1.5);
    p.setAngularVelocity("center", [1, -2, 3]);
    assert.deepEqual(p.angularVelocity("center"), [1, -2, 3]);
    const result = p.angularVelocity("center") as [number, number, number]; result[0] = 99;
    assert.deepEqual(p.angularVelocity("center"), [1, -2, 3]);
  } finally { r.dispose(); }
});

test("validation is atomic and lifecycle guards cover every operation", () => {
  const r = rig();
  try {
    r.step();
    const p = r.physics, before = snapshot(r);
    for (const id of ["fixed", "kinematic", "character"]) {
      assert.equal(p.angularVelocity(id).length, 3);
      assert.throws(() => p.setAngularVelocity(id, [1, 2, 3]), /TC_PHYSICS_BODY_TYPE: setAngularVelocity requires a dynamic body/);
      assert.throws(() => p.torqueImpulse(id, [1, 2, 3]), /TC_PHYSICS_BODY_TYPE: torqueImpulse requires a dynamic body/);
      assert.throws(() => p.impulseAtPoint(id, [1, 2, 3], [0, 0, 0]), /TC_PHYSICS_BODY_TYPE: impulseAtPoint requires a dynamic body/);
    }
    assert.throws(() => p.setAngularVelocity("body", [NaN, 0, 0]), /TC_PHYSICS_VECTOR/);
    assert.throws(() => p.torqueImpulse("body", [Infinity, 0, 0]), /TC_PHYSICS_VECTOR/);
    assert.throws(() => p.impulseAtPoint("body", [0, 1, 0], [NaN, 0, 0]), /TC_PHYSICS_VECTOR/);
    assert.deepEqual(snapshot(r), before);
    r.world.destroy("body");
    for (const call of [() => p.angularVelocity("body"), () => p.setAngularVelocity("body", [0, 0, 0]), () => p.torqueImpulse("body", [0, 0, 0]), () => p.impulseAtPoint("body", [0, 0, 0], [0, 0, 0])]) assert.throws(call, /TC_PHYSICS_ENTITY/);
    r.step();
    assert.ok(!snapshot(r).entities.some((e) => e.id === "body"));
  } finally { r.dispose(); }
  assert.throws(() => r.physics.angularVelocity("center"), /TC_PHYSICS_DISPOSED/);
});

test("angular history is detached, restored and verified against native state", () => {
  const r = rig(), fresh = rig();
  try {
    const impulse: [number, number, number] = [0, 2, 0], point: [number, number, number] = [4, 0, 0];
    r.physics.setAngularVelocity("body", [0.1, 0.2, 0.3]);
    r.physics.torqueImpulse("body", [0, 0, 2]);
    r.physics.impulseAtPoint("body", impulse, point);
    impulse[1] = 50; point[0] = 99;
    const saved = snapshot(r);
    assert.deepEqual(saved.history.at(-1).value, [0, 2, 0]);
    assert.deepEqual(saved.history.at(-1).point, [4, 0, 0]);
    for (const edit of [
      (h: any) => { h.point[0]++; },
      (h: any) => { delete h.point; },
      (h: any) => { h.extra = true; },
      (h: any) => { h.point = [0, 0]; },
    ]) {
      const bad = structuredClone(saved); edit(bad.history.at(-1));
      assert.throws(() => r.plugin.restore(bad), /TC_PHYSICS_SNAPSHOT/);
      assert.deepEqual(snapshot(r), saved);
    }
    r.step(); const expected = snapshot(r);
    r.plugin.restore(JSON.parse(JSON.stringify(saved))); r.step();
    fresh.plugin.restore(JSON.parse(JSON.stringify(saved))); fresh.step();
    assert.deepEqual(snapshot(r), expected);
    assert.deepEqual(snapshot(fresh), expected);
  } finally { r.dispose(); fresh.dispose(); }
});
