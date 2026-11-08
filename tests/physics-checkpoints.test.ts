import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { createPhysicsFactory } from "../packages/physics/index.ts";
import { createRapierInstance } from "../packages/physics/rapier.ts";
import { defineGame, defineScene, instantiateGame, SDK_VERSION, type Vec3 } from "../packages/sdk/src/index.ts";
import type { SceneIR, EntityIR } from "../packages/compiler/src/types.ts";

const transform = (position: Vec3) => ({ position, rotation: [0, 0, 0] as Vec3, scale: [1, 1, 1] as Vec3 });
const physical = { mass: 1, friction: 0.5, restitution: 0, trigger: false };
const entities: EntityIR[] = [
  { id: "ground", transform: transform([0, -0.5, 0]), components: {}, rigidBody: { ...physical, type: "fixed", collider: { shape: "box", size: [40, 1, 40] } } },
  { id: "body", transform: transform([0, 2, 0]), components: {}, rigidBody: { ...physical, type: "dynamic", collider: { shape: "box", size: [1, 1, 1] } } },
  { id: "anchor", transform: transform([4, 3, 0]), components: {}, rigidBody: { ...physical, type: "fixed", collider: { shape: "sphere", radius: 0.2 } } },
  { id: "hanging", transform: transform([4, 1, 0]), components: {}, rigidBody: { ...physical, type: "dynamic", collider: { shape: "sphere", radius: 0.3 } } },
  { id: "character", transform: transform([-3, 2, 0]), components: {}, character: { radius: 0.3, height: 1.8, speed: 4, jumpSpeed: 5, gravity: 9.81 } },
];
const ir: SceneIR = { format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "checkpoint",
  scene: { id: "main", camera: { position: [0, 5, 10], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 }, environment: { background: "#000000", ambientIntensity: 1 }, gravity: [0, -9.81, 0], entities },
  components: [], systems: [], prefabs: [], materials: [], computes: [], assets: [] };
const factory = await createPhysicsFactory();
function host() {
  const host = new RuntimeHost(ir, { plugins: [factory] });
  host.attach(instantiateGame(defineGame({ id: "checkpoint", scene: defineScene({ id: "main", entities: [] }) }), host.facade));
  return host;
}
test("v4 checkpoint preserves native contacts, joints, characters and deterministic continuation across owners", () => {
  const a = host(), b = host();
  try {
    a.facade.physics.createJoint({ id: "rope", kind: "rope", body1: "anchor", body2: "hanging", anchor1: [0, 0, 0], anchor2: [0, 0, 0], length: 2 });
    a.step(2300);
    const saved = a.snapshot();
    const physics = saved.plugins!["$engine.physics"].payload as { version: number; history: unknown[]; checkpoint: { abi: string } };
    assert.equal(physics.version, 4); assert.ok(physics.history.length < 2048);
    b.restore(saved); assert.deepEqual(b.snapshot(), saved);
    a.facade.physics.impulse("body", [1, 2, 0]); b.facade.physics.impulse("body", [1, 2, 0]);
    a.step(60); b.step(60); assert.deepEqual(b.snapshot(), a.snapshot());
    const bad = structuredClone(saved); ((bad.plugins!["$engine.physics"].payload as typeof physics).checkpoint.abi) = "different-build";
    const previous = b.snapshot(); assert.throws(() => b.restore(bad), /TC_PHYSICS_SNAPSHOT/); assert.deepEqual(b.snapshot(), previous);
    // A well-formed native checkpoint may still disagree with immutable content.
    // Mutating an isolated copy must not turn an authored solid into a sensor.
    const forged = structuredClone(saved), payload = forged.plugins!["$engine.physics"].payload as any;
    const native = createRapierInstance(), world = native.World.restoreSnapshot(Uint8Array.from(payload.checkpoint.header.world));
    try {
      world.colliders.get(payload.checkpoint.header.entities.find((e: { id: string }) => e.id === "body").colliderHandle)!.setSensor(true);
      payload.checkpoint.header.world = Array.from(world.takeSnapshot());
      Object.assign(payload, structuredClone(payload.checkpoint.header), { history: [] });
    } finally { world.free(); }
    assert.throws(() => b.restore(forged), /TC_PHYSICS_SNAPSHOT.*collider definition/);
    assert.deepEqual(b.snapshot(), previous);
  } finally { a.dispose(); b.dispose(); }
});
test("terrain native owner mappings survive checkpoint compaction and reconstruction", () => {
  let plugin: ReturnType<typeof factory>;
  const host = new RuntimeHost(ir, { plugins: [context => (plugin = factory(context))] });
  host.attach(instantiateGame(defineGame({ id: "checkpoint", scene: defineScene({ id: "main", entities: [] }) }), host.facade));
  try {
    plugin!.terrainPhysicsBridge!.setTerrain({ id: "terrain", columns: 2, rows: 2, cellSize: 2, origin: [10, 0, 10], heights: [0, 0.1, 0, 0.1], friction: 0.6, restitution: 0 });
    host.step(2100); const saved = host.snapshot(); host.restore(saved); assert.deepEqual(host.snapshot(), saved);
    plugin!.terrainPhysicsBridge!.removeTerrain("terrain"); host.step();
    const removed = host.snapshot(); host.restore(removed); assert.deepEqual(host.snapshot(), removed);
  } finally { host.dispose(); }
});
test("empty games exceed the old session cutoff with bounded saved replay", () => {
  const empty: SceneIR = { ...ir, scene: { ...ir.scene, entities: [] } };
  const host = new RuntimeHost(empty, { plugins: [factory] });
  host.attach(instantiateGame(defineGame({ id: "checkpoint", scene: defineScene({ id: "main", entities: [] }) }), host.facade));
  try {
    for (let i = 0; i < 11; i++) host.step(10000);
    const saved = host.snapshot(), physics = saved.plugins!["$engine.physics"].payload as { version: number; history: unknown[] };
    assert.equal(physics.version, 4); assert.ok(physics.history.length < 2048); assert.equal(saved.scheduler.tick, 110000);
    host.restore(saved); host.step(); assert.equal(host.snapshot().scheduler.tick, 110001);
  } finally { host.dispose(); }
});
