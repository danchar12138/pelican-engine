import test from "node:test";
import assert from "node:assert/strict";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  createPhysicsFactory,
  createFactory,
  type PhysicsServiceWithQueries,
} from "../packages/physics/index.ts";
import { createScheduler } from "../packages/runtime/src/scheduler.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import type { RuntimePluginContext } from "../packages/runtime/src/plugins.ts";
import type { EntityIR, SceneIR } from "../packages/compiler/src/types.ts";
import {
  SDK_VERSION,
  defineGame,
  defineScene,
  defineSystem,
  instantiateGame,
  type SystemInput,
  type Transform,
  type Vec3,
} from "../packages/sdk/src/index.ts";

assert.throws(() => createFactory(), /TC_PHYSICS_INIT/);
const factories = await Promise.all([
  createPhysicsFactory(),
  createPhysicsFactory(),
  createPhysicsFactory(),
]);
const factory = factories[0];
const transform = (position: Vec3 = [0, 0, 0]): Transform => ({
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});
function box(
  id: string,
  position: Vec3,
  size: Vec3 = [1, 1, 1],
  type: "fixed" | "dynamic" | "kinematic" = "fixed",
): EntityIR {
  return {
    id,
    transform: transform(position),
    components: {},
    rigidBody: {
      type,
      collider: { shape: "box", size },
      mass: 1,
      friction: 0.5,
      restitution: 0,
      trigger: false,
    },
  };
}
function character(id = "player", position: Vec3 = [0, 3, 0]): EntityIR {
  return {
    id,
    transform: transform(position),
    components: {},
    character: {
      radius: 0.3,
      height: 1.8,
      speed: 5,
      jumpSpeed: 5,
      gravity: 9.81,
    },
  };
}
const floor = () => box("floor", [0, -0.5, 0], [30, 1, 30]);
function sceneIR(
  entities: EntityIR[],
  systems: ReturnType<typeof defineSystem>[] = [],
): SceneIR {
  return {
    format: "pelican.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "physics-test",
    scene: {
      id: "scene",
      camera: {
        position: [0, 5, 10],
        target: [0, 0, 0],
        fov: 50,
        near: 0.1,
        far: 100,
      },
      environment: { background: "#000000", ambientIntensity: 1 },
      gravity: [0, -9.81, 0],
      entities,
    },
    components: [],
    systems: systems.map((s) => ({
      id: s.id,
      phase: s.phase ?? "update",
      reads: s.reads ? [...s.reads] : undefined,
      writes: s.writes ? [...s.writes] : undefined,
      structural: s.structural,
      source: { file: "physics.test.ts", line: 1, column: 1, length: 1 },
    })),
    prefabs: [],
    materials: [],
    computes: [],
    assets: [],
  };
}
function rig(
  entities: EntityIR[] = [floor(), character()],
  prefabs: EntityIR[] = [],
) {
  const scene = { ...sceneIR(entities), prefabs },
    world = createWorld({
      entities: entities.map((e) => ({
        id: e.id,
        parent: e.parent,
        transform: e.transform,
        components: {},
      })),
    });
  const events: { type: string; payload: unknown }[] = [];
  const context: RuntimePluginContext = {
    scene,
    world,
    events: () => [],
    emit(type, payload) {
      events.push({ type, payload });
      return {
        type,
        payload,
        sequence: events.length,
        tick: 0,
        source: "system",
      } as never;
    },
  };
  let plugin: ReturnType<typeof factory>;
  try {
    plugin = factory(context);
  } catch (error) {
    world.dispose();
    throw error;
  }
  const physics = plugin.services!.physics! as PhysicsServiceWithQueries,
    system = plugin.systems![0];
  return {
    world,
    plugin,
    physics,
    events,
    step(count = 1, dt = 1 / 60) {
      for (let i = 0; i < count; i++)
        world.runSystem(system.id, system, () => system.run(dt));
    },
    dispose() {
      plugin.dispose();
      world.dispose();
    },
  };
}
function hostRig(
  entities: EntityIR[],
  inputs: SystemInput[] = [],
  fixedDt = 1 / 60,
  prefabs: EntityIR[] = [],
  components: SceneIR["components"] = [],
) {
  const systems = inputs.map(defineSystem),
    ir = { ...sceneIR(entities, systems), prefabs, components },
    host = new RuntimeHost(ir, { plugins: [factory], fixedDt });
  const game = instantiateGame(
    defineGame({
      id: ir.gameId,
      scene: defineScene({ id: "scene", entities: [] }),
      systems,
    }),
    host.facade,
  );
  host.attach(game);
  return host;
}
const near = (a: number, b: number, tolerance = 0.03) =>
  assert.ok(Math.abs(a - b) <= tolerance, a + " should be near " + b);
const snap = (r: ReturnType<typeof rig>) =>
  r.plugin.snapshot() as {
    version: number;
    bindings: string[];
    world: number[];
    entities: {
      id: string;
      bodyHandle: number;
      colliderHandle: number;
      type: string;
      transform: Transform;
    }[];
    characters: {
      entity: string;
      bodyHandle: number;
      colliderHandle: number;
      radius: number;
      height: number;
      gravity: number;
      grounded: boolean;
      verticalVelocity: number;
      velocity: Vec3;
      requested: Vec3;
    }[];
    pairs: [number, number][];
    tick: number;
    history: unknown[];
    scene: string;
  };

test("physics initializes once and shares the factory across concurrent and subsequent calls", async () => {
  assert.equal(factories[0], factories[1]);
  assert.equal(factories[1], factories[2]);
  assert.equal(await createPhysicsFactory(), factory);
  assert.equal(createFactory(), factory);
});

test("character falls onto floor, stays grounded without alternating, jumps and lands", () => {
  const r = rig();
  try {
    r.step(100);
    near(r.world.getTransform("player").position[1], 0.91);
    for (let i = 0; i < 45; i++) {
      assert.equal(r.physics.grounded("player"), true);
      near(r.physics.velocity("player")[1], 0, 1e-8);
      r.step();
    }
    r.physics.setVelocity("player", [0, 5, 0]);
    r.step(20);
    assert.ok(r.world.getTransform("player").position[1] > 1.6);
    assert.equal(r.physics.grounded("player"), false);
    r.step(100);
    assert.equal(r.physics.grounded("player"), true);
    near(r.world.getTransform("player").position[1], 0.91);
  } finally {
    r.dispose();
  }
});

test("character respects first-tick wall/floor, high displacement, ceiling, sensors, and XYZ velocity", () => {
  const r = rig([
    floor(),
    character("player", [0, 0.92, 0]),
    box("wall", [2, 2, 0], [0.5, 4, 8]),
    box("ceiling", [0, 3, 0], [3, 0.2, 3]),
    {
      ...box("trigger", [0.6, 1, 0], [0.2, 2, 2]),
      rigidBody: { ...box("s", [0, 0, 0]).rigidBody!, trigger: true },
    },
  ]);
  try {
    r.physics.moveCharacter("player", [20, -20, 0]);
    r.step();
    assert.ok(r.world.getTransform("player").position[0] < 1.46);
    assert.ok(r.world.getTransform("player").position[1] > 0.89);
    r.world.setTransform("player", { position: [0, 0.92, 0] });
    r.step(2);
    r.physics.moveCharacter("player", [1, 0.5, 0]);
    r.step();
    const p = r.world.getTransform("player").position;
    assert.ok(p[0] > 0.9, "sensor must not block movement");
    assert.ok(p[1] > 1.3, "Y displacement participates in movement");
    r.world.setTransform("player", { position: [0, 0.92, 0] });
    r.step();
    r.physics.setVelocity("player", [1, 100, 0.5]);
    r.step();
    assert.ok(
      r.world.getTransform("player").position[1] < 2.02,
      "ceiling blocks jump",
    );
    near(r.physics.velocity("player")[1], 0, 1e-5);
    r.step(10);
    assert.ok(r.world.getTransform("player").position[0] > 0.1);
    assert.ok(r.world.getTransform("player").position[2] > 0.05);
  } finally {
    r.dispose();
  }
});

test("Host prePhysics yaw and movement survive physics, postPhysics queries and fixed accumulation", () => {
  let observedYaw = 0,
    grounded = false;
  const host = hostRig(
    [floor(), character("player", [0, 0.92, 0])],
    [
      {
        id: "control",
        phase: "prePhysics",
        reads: ["Transform"],
        writes: ["Transform"],
        run(ctx, dt) {
          ctx.setTransform("player", { rotation: [0, 1.2, 0] });
          ctx.physics.moveCharacter("player", [dt, 0, 0]);
        },
      },
      {
        id: "observe",
        phase: "postPhysics",
        reads: ["Transform"],
        run(ctx) {
          observedYaw = ctx.getTransform("player").rotation[1];
          grounded = ctx.physics.grounded("player");
        },
      },
    ],
  );
  try {
    host.step(60);
    near(observedYaw, 1.2, 1e-5);
    near(host.world.getTransform("player").position[0], 1, 0.05);
    assert.equal(grounded, true);
    assert.equal(host.snapshot().scheduler.tick, 60);
  } finally {
    host.dispose();
  }
  const a = rig([floor(), box("ball", [0, 4, 0], [1, 1, 1], "dynamic")]),
    b = rig([floor(), box("ball", [0, 4, 0], [1, 1, 1], "dynamic")]);
  const sa = createScheduler({ world: a.world, systems: a.plugin.systems }),
    sb = createScheduler({ world: b.world, systems: b.plugin.systems });
  try {
    sa.step(60);
    for (let i = 0; i < 120; i++) sb.advance(1 / 120);
    assert.deepEqual(a.plugin.snapshot(), b.plugin.snapshot());
    assert.deepEqual(a.world.snapshot(), b.world.snapshot());
  } finally {
    sa.dispose();
    sb.dispose();
    a.dispose();
    b.dispose();
  }
});

test("rigid bodies receive mass-correct impulse, collide and emit started/ended; triggers allow crossing", () => {
  const ball = box("ball", [0, 3, 0], [1, 1, 1], "dynamic");
  ball.rigidBody!.mass = 2;
  const r = rig([
    floor(),
    ball,
    {
      ...box("sensor", [0, 1.5, 0], [4, 0.2, 4]),
      rigidBody: { ...box("s", [0, 0, 0]).rigidBody!, trigger: true },
    },
  ]);
  try {
    r.physics.impulse("ball", [2, 0, 0]);
    near(r.physics.velocity("ball")[0], 1, 1e-5);
    r.step(120);
    near(r.world.getTransform("ball").position[1], 0.5, 0.05);
    for (const type of [
      "physics.trigger.started",
      "physics.trigger.ended",
      "physics.collision.started",
    ])
      assert.ok(
        r.events.some((e) => e.type === type),
        type,
      );
    r.world.setTransform("ball", { position: [0, 5, 0] });
    r.step(3);
    assert.ok(r.events.some((e) => e.type === "physics.collision.ended"));
  } finally {
    r.dispose();
  }
});

test("raycast is normalized, bounded, usable before first tick, and validates all parameters", () => {
  const r = rig([box("wall", [3, 0, 0], [1, 4, 4])]);
  try {
    assert.equal(r.physics.raycast([0, 0, 0], [2, 0, 0], 2), null);
    const h = r.physics.raycast([0, 0, 0], [7, 0, 0], 10)!;
    assert.equal(h.entity, "wall");
    near(h.distance, 2.5, 1e-6);
    assert.deepEqual(h.normal, [-1, 0, 0]);
    near(h.point[0], 2.5, 1e-6);
    assert.throws(
      () => r.physics.raycast([0, 0, 0], [0, 0, 0], 1),
      /TC_PHYSICS_RAY/,
    );
    assert.throws(
      () => r.physics.raycast([NaN, 0, 0], [1, 0, 0], 1),
      /TC_PHYSICS_VECTOR/,
    );
    assert.throws(
      () => r.physics.raycast([0, 0, 0], [1, 0, 0], Infinity),
      /TC_PHYSICS_DEFINITION/,
    );
  } finally {
    r.dispose();
  }
});

test("box rotation/scale/offset and fixed/kinematic/dynamic external transforms synchronize", () => {
  const wall = box("wall", [0, 0, 0], [4, 1, 1]);
  wall.transform.rotation = [0, 0, Math.PI / 2];
  wall.transform.scale = [2, 1, 1];
  wall.rigidBody!.collider.offset = [0.5, 0, 0];
  const r = rig([
    wall,
    box("moving", [10, 0, 0], [1, 1, 1], "kinematic"),
    box("dynamic", [20, 2, 0], [1, 1, 1], "dynamic"),
  ]);
  try {
    near(r.physics.raycast([0, 10, 0], [0, -1, 0], 20)!.distance, 5, 1e-4);
    r.world.setTransform("wall", {
      position: [2, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 2, 1],
    });
    r.world.setTransform("moving", {
      position: [12, 0, 0],
      rotation: [0, 0.7, 0],
    });
    r.world.setTransform("dynamic", {
      position: [25, 5, 0],
      rotation: [0.2, 0.3, 0.4],
    });
    r.step();
    const hit = r.physics.raycast([10, 0, 0], [-1, 0, 0], 20)!;
    assert.equal(hit.entity, "wall");
    near(hit.distance, 5.5);
    near(r.world.getTransform("moving").position[0], 12);
    near(r.world.getTransform("moving").rotation[1], 0.7, 1e-5);
    near(r.world.getTransform("dynamic").position[0], 25);
    near(r.world.getTransform("dynamic").rotation[0], 0.2, 1e-5);
    near(r.world.getTransform("dynamic").rotation[1], 0.3, 1e-5);
    near(r.world.getTransform("dynamic").rotation[2], 0.4, 1e-5);
  } finally {
    r.dispose();
  }
});

test("unsupported character transforms, parented physics and nonuniform round shapes diagnose explicitly", () => {
  const bad = character();
  bad.parent = "root";
  assert.throws(
    () => rig([{ id: "root", transform: transform(), components: {} }, bad]),
    /TC_PHYSICS_PARENT_TRANSFORM/,
  );
  for (const patch of [
    { scale: [2, 2, 2] as Vec3 },
    { rotation: [0.1, 0, 0] as Vec3 },
    { rotation: [0, 0, 0.1] as Vec3 },
  ]) {
    const e = character();
    Object.assign(e.transform, patch);
    assert.throws(() => rig([e]), /TC_PHYSICS_TRANSFORM/);
  }
  const sphere = box("sphere", [0, 0, 0]);
  sphere.rigidBody!.collider = { shape: "sphere", radius: 1 };
  sphere.transform.scale = [1, 2, 1];
  assert.throws(() => rig([sphere]), /TC_PHYSICS_TRANSFORM/);
  const r = rig();
  try {
    const before = snap(r);
    assert.throws(
      () => r.physics.setVelocity("floor", [1, 0, 0]),
      /TC_PHYSICS_BODY_TYPE/,
    );
    assert.throws(
      () => r.physics.impulse("player", [1, 0, 0]),
      /TC_PHYSICS_BODY_TYPE/,
    );
    assert.throws(
      () => r.physics.moveCharacter("floor", [0, 1, 0]),
      /TC_PHYSICS_CHARACTER/,
    );
    assert.throws(
      () => r.physics.moveCharacter("player", [0, NaN, 0]),
      /TC_PHYSICS_VECTOR/,
    );
    assert.deepEqual(snap(r), before);
    r.world.setTransform("player", { scale: [2, 2, 2] });
    assert.throws(() => r.step(), /TC_PHYSICS_TRANSFORM/);
    assert.deepEqual(snap(r), before);
  } finally {
    r.dispose();
  }
});

test("snapshot restores native dynamics, pending character commands, contact pairs and future steps exactly", () => {
  const r = rig([
    floor(),
    character(),
    box("ball", [3, 5, 0], [1, 1, 1], "dynamic"),
  ]);
  const fresh = rig([
    floor(),
    character(),
    box("ball", [3, 5, 0], [1, 1, 1], "dynamic"),
  ]);
  try {
    r.step(90);
    r.physics.moveCharacter("player", [0.4, 0.2, 0]);
    r.physics.setVelocity("player", [1, 4, 0.5]);
    r.physics.impulse("ball", [1, 2, 0]);
    const saved = snap(r);
    r.step(40);
    const expected = snap(r);
    r.plugin.restore(JSON.parse(JSON.stringify(saved)));
    r.step(40);
    assert.deepEqual(snap(r), expected);
    fresh.plugin.restore(JSON.parse(JSON.stringify(saved)));
    fresh.step(40);
    assert.deepEqual(snap(fresh), expected);
    assert.deepEqual(fresh.world.snapshot(), r.world.snapshot());
  } finally {
    r.dispose();
    fresh.dispose();
  }
});

test("Host snapshots and recorded replay preserve physics with actual system service access", () => {
  const inputs: SystemInput[] = [
    {
      id: "control",
      phase: "prePhysics",
      reads: ["Transform"],
      writes: ["Transform"],
      run(ctx, dt) {
        ctx.physics.moveCharacter("player", [2 * dt, 0, 0]);
        ctx.setTransform("player", { rotation: [0, 0.7, 0] });
        if (ctx.time.tick === 12) ctx.physics.setVelocity("player", [0, 5, 0]);
      },
    },
  ];
  const host = hostRig([floor(), character("player", [0, 0.92, 0])], inputs);
  try {
    host.step(20);
    const saved = host.snapshot();
    host.step(10);
    host.restore(saved);
    assert.deepEqual(host.snapshot(), saved);
    host.startRecording();
    host.step(30);
    const trace = host.stopRecording();
    const result = host.replay(trace);
    assert.equal(
      result.status,
      "passed",
      JSON.stringify(host.inspect().diagnostics),
    );
  } finally {
    host.dispose();
  }
});

test("malformed snapshots reject atomically BEFORE any native byte deserialization", () => {
  const r = rig();
  const nativeRestore = RAPIER.World.restoreSnapshot;
  let unsafeCalls = 0;
  RAPIER.World.restoreSnapshot = () => {
    unsafeCalls++;
    throw new Error("Untrusted native restore must not run");
  };
  try {
    r.step(80);
    const saved = snap(r);
    const changes: ((s: ReturnType<typeof snap>) => void)[] = [
      (s) => {
        s.entities[1] = { ...s.entities[0] };
      },
      (s) => {
        s.entities[0].bodyHandle = s.entities[1].bodyHandle;
      },
      (s) => {
        s.entities[0].colliderHandle = s.entities[1].colliderHandle;
      },
      (s) => {
        s.entities[0].colliderHandle = 123;
      },
      (s) => {
        s.entities[0].type = "dynamic";
      },
      (s) => {
        s.characters = [];
      },
      (s) => {
        s.characters.push(structuredClone(s.characters[0]));
      },
      (s) => {
        s.characters[0].entity = "floor";
      },
      (s) => {
        s.characters[0].bodyHandle = s.entities[0].bodyHandle;
      },
      (s) => {
        s.characters[0].colliderHandle = 1;
      },
      (s) => {
        s.characters[0].radius = 0.5;
      },
      (s) => {
        s.characters[0].height = 2;
      },
      (s) => {
        s.characters[0].gravity = 0;
      },
      (s) => {
        s.characters[0].verticalVelocity = Infinity;
      },
      (s) => {
        s.characters[0].requested = [NaN, 0, 0];
      },
      (s) => {
        s.characters[0].velocity = [0, NaN, 0];
      },
      (s) => {
        s.characters[0].grounded = "yes" as never;
      },
      (s) => {
        s.pairs.push([123, 456]);
      },
      (s) => {
        s.pairs.push([
          s.entities[0].colliderHandle,
          s.entities[0].colliderHandle,
        ]);
      },
      (s) => {
        s.tick = -1;
      },
      (s) => {
        s.scene += "changed";
      },
      (s) => {
        s.world = [];
      },
      (s) => {
        s.world = [0, 1, 2];
      },
      (s) => {
        s.world[0] = 999;
      },
      (s) => {
        s.world[0] ^= 255;
      },
      (s) => {
        s.world[Math.floor(s.world.length / 2)] ^= 128;
      },
      (s) => {
        s.world.pop();
      },
      (s) => {
        s.history.push({ kind: "step", dt: NaN, frame: [] });
      },
      (s) => {
        s.history.push({
          kind: "step",
          dt: 1 / 60,
          frame: [
            { id: "floor", transform: transform() },
            { id: "floor", transform: transform() },
          ],
        });
      },
    ];
    for (const change of changes) {
      const malformed = structuredClone(saved);
      change(malformed);
      assert.throws(
        () => r.plugin.validateSnapshot(malformed),
        /TC_PHYSICS_SNAPSHOT/,
      );
      assert.throws(() => r.plugin.restore(malformed), /TC_PHYSICS_SNAPSHOT/);
      assert.deepEqual(snap(r), saved);
    }
    for (const bad of [null, [], {}, new Uint8Array([1, 2, 3])])
      assert.throws(() => r.plugin.restore(bad), /TC_PHYSICS_SNAPSHOT/);
    assert.equal(unsafeCalls, 0);
    r.plugin.restore(saved);
    r.step();
    assert.equal(unsafeCalls, 0);
  } finally {
    RAPIER.World.restoreSnapshot = nativeRestore;
    r.dispose();
  }
});

test("destroy removes walls and pairs; authored same-id respawn creates a fresh body", () => {
  const r = rig([
    floor(),
    character("player", [0, 0.92, 0]),
    box("wall", [2, 2, 0], [0.5, 4, 6]),
    box("ball", [8, 0.5, 0], [1, 1, 1], "dynamic"),
  ]);
  try {
    r.step(20);
    assert.ok(snap(r).pairs.length > 0);
    r.world.destroy("ball");
    r.world.destroy("wall");
    assert.equal(r.physics.raycast([1, 2, 0], [1, 0, 0], 5), null);
    r.physics.moveCharacter("player", [4, 0, 0]);
    r.step();
    assert.ok(r.world.getTransform("player").position[0] > 3.8);
    assert.ok(!snap(r).entities.some((e) => e.id === "wall"));
    r.physics.setVelocity("player", [5, 4, 0]);
    r.physics.moveCharacter("player", [3, 0, 0]);
    r.world.destroy("player");
    assert.throws(() => r.physics.grounded("player"), /TC_PHYSICS_ENTITY/);
    r.world.spawn({ id: "player", transform: transform([10, 1, 0]) });
    r.step();
    assert.ok(snap(r).entities.some((e) => e.id === "player"));
    near(r.world.getTransform("player").position[0], 10, 1e-6);
    near(r.physics.velocity("player")[0], 0, 1e-6);
    assert.ok(r.physics.velocity("player")[1] <= 0);
    const replacement = snap(r).characters.find((c) => c.entity === "player")!;
    assert.deepEqual(replacement.requested, [0, 0, 0]);
    assert.ok(r.events.some((e) => e.type === "physics.collision.ended"));
  } finally {
    r.dispose();
  }
});

test("native resources are released exactly once after restore, validation failure, destroy and repeated dispose", () => {
  const freedWorlds = new Set<RAPIER.World>(),
    freedQueues = new Set<RAPIER.EventQueue>(),
    freedControllers = new Set<RAPIER.KinematicCharacterController>();
  const wf = RAPIER.World.prototype.free,
    qf = RAPIER.EventQueue.prototype.free,
    cf = RAPIER.KinematicCharacterController.prototype.free;
  RAPIER.World.prototype.free = function () {
    assert.ok(!freedWorlds.has(this), "world double free");
    freedWorlds.add(this);
    return wf.call(this);
  };
  RAPIER.EventQueue.prototype.free = function () {
    assert.ok(!freedQueues.has(this), "queue double free");
    freedQueues.add(this);
    return qf.call(this);
  };
  RAPIER.KinematicCharacterController.prototype.free = function () {
    assert.ok(!freedControllers.has(this), "controller double free");
    freedControllers.add(this);
    return cf.call(this);
  };
  const r = rig();
  try {
    r.step(2);
    const saved = snap(r);
    r.plugin.validateSnapshot(saved);
    const bad = structuredClone(saved);
    bad.characters[0].radius = 10;
    assert.throws(() => r.plugin.restore(bad));
    r.plugin.restore(saved);
    r.world.destroy("player");
    r.step();
    r.plugin.dispose();
    r.plugin.dispose();
    assert.equal(freedWorlds.size, 4);
    assert.equal(freedQueues.size, 4);
    assert.equal(freedControllers.size, 4);
    for (const f of [
      () => r.plugin.snapshot(),
      () => r.plugin.inspect!(),
      () => r.physics.raycast([0, 0, 0], [1, 0, 0], 2),
      () => r.physics.velocity("player"),
      () => r.plugin.restore(saved),
      () => r.plugin.validateSnapshot(saved),
    ])
      assert.throws(f, /TC_PHYSICS_DISPOSED/);
  } finally {
    r.dispose();
    RAPIER.World.prototype.free = wf;
    RAPIER.EventQueue.prototype.free = qf;
    RAPIER.KinematicCharacterController.prototype.free = cf;
  }
});

test("camera ray options exclude entities and sensors while retaining the nearest valid hit", () => {
  const sensor = box("sensor", [2, 0, 0]);
  sensor.rigidBody!.trigger = true;
  const r = rig([
    box("player", [1, 0, 0]),
    sensor,
    box("wall", [3, 0, 0]),
    box("far", [5, 0, 0]),
  ]);
  try {
    const cast = (
      options?: Parameters<PhysicsServiceWithQueries["raycast"]>[3],
    ) => r.physics.raycast([0, 0, 0], [10, 0, 0], 10, options);
    assert.equal(cast()!.entity, "player");
    assert.equal(cast({ exclude: ["player"] })!.entity, "wall");
    near(cast({ exclude: ["player"] })!.distance, 2.5, 1e-6);
    assert.equal(
      cast({ exclude: ["player"], includeTriggers: true })!.entity,
      "sensor",
    );
    assert.equal(
      cast({ exclude: ["player", "sensor", "wall"] })!.entity,
      "far",
    );
    assert.equal(cast({ exclude: ["player", "wall", "far"] }), null);
    assert.equal(
      cast({
        exclude: ["player", "sensor", "wall", "far"],
        includeTriggers: true,
      }),
      null,
    );
    r.world.destroy("player");
    assert.equal(cast()!.entity, "wall");
    r.world.destroy("wall");
    assert.equal(cast()!.entity, "far");
    for (const value of [
      null,
      [],
      { exclude: [42] },
      { includeTriggers: "yes" },
      { exclude: "player" },
      { unknown: true },
    ])
      assert.throws(() => cast(value as never), /TC_PHYSICS_RAY/);
  } finally {
    r.dispose();
  }
});

test("a wall edited before physics blocks character movement at its current scene transform", () => {
  const r = rig([
    floor(),
    character("player", [0, 0.92, 0]),
    box("wall", [20, 2, 0], [0.5, 4, 8]),
  ]);
  try {
    r.world.setTransform("wall", { position: [2, 2, 0] });
    r.physics.moveCharacter("player", [10, 0, 0]);
    r.step();
    assert.ok(r.world.getTransform("player").position[0] < 1.46);
    const saved = snap(r);
    r.plugin.restore(saved);
    assert.deepEqual(snap(r), saved);
  } finally {
    r.dispose();
  }
});

test("character crosses a sensor without blocking and emits both trigger events", () => {
  const sensor = box("sensor", [1.5, 1, 0], [1, 2, 2]);
  sensor.rigidBody!.trigger = true;
  const r = rig([floor(), character("player", [0, 0.92, 0]), sensor]);
  try {
    for (let i = 0; i < 80; i++) {
      r.physics.moveCharacter("player", [0.05, 0, 0]);
      r.step();
    }
    assert.ok(r.world.getTransform("player").position[0] > 3.8);
    for (const type of ["physics.trigger.started", "physics.trigger.ended"])
      assert.ok(
        r.events.some((e) => e.type === type),
        type,
      );
  } finally {
    r.dispose();
  }
});

test("character can reverse away after contacting a kinematic gate without a permanent zero-time floor contact loop", () => {
  const player = character("player", [0, 0.75, 4]);
  player.character = {
    ...player.character!,
    radius: 0.3,
    height: 1.4,
    speed: 3.6,
  };
  const host = rig([
    player,
    box("floor", [0, -0.3, 0], [18, 0.6, 21]),
    box("gate", [0, 1.4, 7], [3.5, 2.8, 0.4], "kinematic"),
  ]);
  try {
    host.step(30);
    for (let tick = 0; tick < 100; tick++) {
      host.physics.moveCharacter("player", [0, 0, 0.06]);
      host.step();
    }
    const contact = host.world.getTransform("player").position;
    assert.ok(contact[2] > 6.45 && contact[2] < 6.55);
    host.step(1);
    for (let tick = 0; tick < 100; tick++) {
      host.physics.moveCharacter("player", [0, 0, -0.06]);
      host.step();
    }
    const away = host.world.getTransform("player").position;
    assert.ok(
      away[2] < 2,
      JSON.stringify({
        contact,
        away,
        physics: host.plugin.inspect?.(),
      }),
    );
  } finally {
    host.dispose();
  }
});

test("grounded zero-vertical motion loses support at ledges and after removing a supporting collider", () => {
  for (const scenario of ["walk-off", "remove-support"] as const) {
    const player = character("player", [0, 1, 0]);
    player.character = { ...player.character!, height: 1.4 };
    const r = rig([
      box("platform", [0, -0.25, 0], [2, 0.5, 2], "kinematic"),
      player,
    ]);
    try {
      r.step(45);
      assert.equal(r.physics.grounded("player"), true);
      const supported = r.world.getTransform("player").position[1];
      assert.ok(supported > 0.69 && supported < 0.73);
      if (scenario === "walk-off") {
        for (let tick = 0; tick < 45; tick++) {
          r.physics.moveCharacter("player", [0.06, 0, 0]);
          r.step();
        }
      } else {
        r.world.destroy("platform");
        r.step(45);
      }
      assert.equal(
        r.physics.grounded("player"),
        false,
        JSON.stringify({
          scenario,
          position: r.world.getTransform("player").position,
          physics: r.plugin.inspect?.(),
        }),
      );
      assert.ok(
        r.world.getTransform("player").position[1] < supported - 0.25,
        scenario,
      );
      assert.ok(r.physics.velocity("player")[1] < -1);
      const saved = snap(r);
      r.step(5);
      r.plugin.restore(saved);
      assert.deepEqual(snap(r), saved);
      r.step(5);
      assert.ok(r.world.getTransform("player").position[1] < supported - 0.5);
    } finally {
      r.dispose();
    }
  }
});

test("opening a kinematic gate after sustained contact releases the character and remains replayable", () => {
  const player = character("player", [0, 0.75, 4]);
  player.character = { ...player.character!, height: 1.4 };
  const r = rig([
    floor(),
    player,
    box("gate", [0, 1.4, 7], [3.5, 2.8, 0.4], "kinematic"),
  ]);
  try {
    r.step(30);
    for (let tick = 0; tick < 100; tick++) {
      r.physics.moveCharacter("player", [0, 0, 0.06]);
      r.step();
    }
    const contact = r.world.getTransform("player").position[2];
    assert.ok(contact < 6.51);
    r.world.setTransform("gate", { position: [0, 5, 7] });
    const checkpoint = snap(r);
    for (let tick = 0; tick < 35; tick++) {
      r.physics.moveCharacter("player", [0, 0, 0.06]);
      r.step();
    }
    const advanced = snap(r);
    assert.ok(r.world.getTransform("player").position[2] > 8);
    r.plugin.restore(checkpoint);
    r.world.setTransform("gate", { position: [0, 5, 7] });
    for (let tick = 0; tick < 35; tick++) {
      r.physics.moveCharacter("player", [0, 0, 0.06]);
      r.step();
    }
    assert.deepEqual(snap(r), advanced);
  } finally {
    r.dispose();
  }
});

test("stall recovery keeps opposing thin solids and corners blocking while allowing retreat", () => {
  for (const side of [-1, 1]) {
    const player = character("player", [0, 0.75, 4]);
    player.character = { ...player.character!, height: 1.4 };
    const r = rig([
      player,
      box("floor", [0, -0.3, 0], [18, 0.6, 21]),
      box("gate", [0, 1.4, 7], [3.5, 2.8, 0.4], "kinematic"),
      box("back", [0, 1.4, 3], [5, 2.8, 0.08], "kinematic"),
      box("side", [side * 0.9, 1.4, 5], [0.08, 2.8, 4], "kinematic"),
    ]);
    try {
      r.step(30);
      for (let tick = 0; tick < 100; tick++) {
        r.physics.moveCharacter("player", [side * 0.02, 0, 0.06]);
        r.step();
      }
      const contact = r.world.getTransform("player").position;
      assert.ok(contact[2] <= 6.52);
      assert.ok(Math.abs(contact[0]) <= 0.58);
      for (let tick = 0; tick < 100; tick++) {
        r.physics.moveCharacter("player", [0, 0, -0.06]);
        r.step();
      }
      const retreat = r.world.getTransform("player").position;
      assert.ok(retreat[2] > 3.32 && retreat[2] < 4);
      assert.ok(Math.abs(retreat[0]) <= 0.58);
      assert.ok(retreat[1] > 0.65);
    } finally {
      r.dispose();
    }
  }
});

test("Host rejects malformed plugin state before changing scheduler, World or physics", () => {
  const host = hostRig([floor(), character()]);
  try {
    host.step(20);
    const before = host.snapshot(),
      bad = structuredClone(before);
    const payload = bad.plugins!["$engine.physics"].payload as ReturnType<
      typeof snap
    >;
    payload.entities[1].bodyHandle = payload.entities[0].bodyHandle;
    assert.throws(() => host.restore(bad), /TC_PHYSICS_SNAPSHOT/);
    assert.deepEqual(host.snapshot(), before);
    host.step(3);
  } finally {
    host.dispose();
  }
});

test("constructor and candidate replay failures free acquired native objects", () => {
  const wf = RAPIER.World.prototype.free,
    qf = RAPIER.EventQueue.prototype.free,
    cc = RAPIER.World.prototype.createCollider;
  let worlds = 0,
    queues = 0,
    colliders = 0;
  RAPIER.World.prototype.free = function () {
    worlds++;
    return wf.call(this);
  };
  RAPIER.EventQueue.prototype.free = function () {
    queues++;
    return qf.call(this);
  };
  RAPIER.World.prototype.createCollider = function (
    ...args: Parameters<typeof cc>
  ) {
    if (++colliders === 2) throw new Error("injected collider failure");
    return cc.apply(this, args);
  };
  try {
    assert.throws(
      () => rig([character(), box("ball", [3, 2, 0], [1, 1, 1], "dynamic")]),
      /injected collider failure/,
    );
    assert.equal(worlds, 1);
    assert.equal(queues, 1);
    RAPIER.World.prototype.createCollider = cc;
    const r = rig();
    try {
      const bad = snap(r);
      bad.history.push({ kind: "move", id: "missing", value: [1, 0, 0] });
      assert.throws(() => r.plugin.restore(bad), /TC_PHYSICS_SNAPSHOT/);
      assert.equal(worlds, 2);
      assert.equal(queues, 2);
    } finally {
      r.dispose();
    }
    assert.equal(worlds, 3);
    assert.equal(queues, 3);
  } finally {
    RAPIER.World.prototype.free = wf;
    RAPIER.EventQueue.prototype.free = qf;
    RAPIER.World.prototype.createCollider = cc;
  }
});

const hostPhysics = (host: RuntimeHost) =>
  host.snapshot().plugins!["$engine.physics"].payload as ReturnType<
    typeof snap
  >;

test("Host prefab spawn reaches next physics, collides, moves and restores/replays pending and live snapshots", () => {
  const crate = box("crate-prefab", [0, 3, 3], [1, 1, 1], "dynamic"),
    actor = character("actor-prefab", [0, 0.92, 0]),
    sensor = box("sensor-prefab", [2, 1, 0], [1, 2, 2]);
  crate.rigidBody!.mass = 2;
  crate.components = { Tag: { value: 7 } };
  sensor.rigidBody!.trigger = true;
  const seenEvents = new Set<string>();
  const inputs: SystemInput[] = [
    {
      id: "spawn-prefabs",
      phase: "update",
      structural: true,
      run(ctx) {
        if (ctx.time.tick === 1) {
          ctx.entities.spawn({ id: "crate", prefab: crate.id });
          ctx.entities.spawn({ id: "actor", prefab: actor.id });
          ctx.entities.spawn({ id: "sensor", prefab: sensor.id });
          ctx.entities.spawn({ id: "plain" });
        }
      },
    },
    {
      id: "drive-prefabs",
      phase: "prePhysics",
      reads: ["Transform"],
      writes: [],
      run(ctx) {
        if (ctx.time.tick === 3) ctx.physics.impulse("crate", [4, 2, 0]);
        if (ctx.time.tick >= 3 && ctx.time.tick < 110)
          ctx.physics.moveCharacter("actor", [0.05, 0, 0]);
      },
    },
    {
      id: "check-prefabs",
      phase: "postPhysics",
      reads: ["Transform"],
      writes: [],
      run(ctx) {
        for (const event of ctx.events()) seenEvents.add(event.type);
        if (ctx.time.tick === 2) {
          assert.ok(ctx.physics.velocity("crate")[1] < 0);
          assert.equal(ctx.physics.grounded("actor"), true);
        }
        if (ctx.time.tick === 3)
          near(ctx.physics.velocity("crate")[0], 2, 1e-5);
        assert.throws(() => ctx.physics.velocity("plain"), /TC_PHYSICS_ENTITY/);
      },
    },
  ];
  const make = () =>
    hostRig(
      [floor(), box("wall", [4, 2, 0], [0.5, 4, 12])],
      inputs,
      1 / 60,
      [crate, actor, sensor],
      [
        {
          id: "Tag",
          schema: { value: { type: "number", default: 0 } },
          source: { file: "physics.test.ts", line: 1, column: 1, length: 1 },
        },
      ],
    );
  const host = make(),
    cold = make();
  try {
    const before = host.snapshot();
    host.step();
    const pending = host.snapshot();
    assert.ok(host.world.isAlive("crate"));
    assert.equal(host.world.getComponent("crate", "Tag").value, 7);
    assert.ok(!hostPhysics(host).entities.some((e) => e.id === "crate"));
    host.step();
    const live = host.snapshot();
    assert.deepEqual(
      hostPhysics(host).entities.map((e) => e.id),
      ["floor", "wall", "crate", "actor", "sensor"],
    );
    host.startRecording();
    host.step(118);
    const trace = host.stopRecording(),
      expected = host.snapshot();
    assert.ok(host.world.getTransform("crate").position[0] > 1);
    near(host.world.getTransform("crate").position[1], 0.5);
    const actorX = host.world.getTransform("actor").position[0];
    assert.ok(actorX > 3 && actorX < 3.5);
    assert.ok(hostPhysics(host).pairs.length > 0);
    for (const type of [
      "physics.collision.started",
      "physics.trigger.started",
      "physics.trigger.ended",
    ])
      assert.ok(seenEvents.has(type), type);
    assert.equal(
      host.replay(trace).status,
      "passed",
      JSON.stringify(host.inspect().diagnostics),
    );
    assert.deepEqual(host.snapshot(), expected);
    for (const saved of [before, pending, live]) {
      cold.restore(JSON.parse(JSON.stringify(saved)));
      assert.deepEqual(cold.snapshot(), saved);
      cold.step(120 - saved.scheduler.tick);
      assert.deepEqual(cold.snapshot(), expected);
    }
  } finally {
    host.dispose();
    cold.dispose();
  }
});

test("Host same-ID prefab generations reset velocity, requests and contacts across pending restore/replay", () => {
  const crate = box("crate-prefab", [0, 0.5, 0], [1, 1, 1], "dynamic"),
    actor = character("actor-prefab", [4, 0.92, 0]);
  const inputs: SystemInput[] = [
    {
      id: "spawn-and-replace",
      phase: "update",
      structural: true,
      run(ctx) {
        if (ctx.time.tick === 1 || ctx.time.tick === 4) {
          if (ctx.time.tick === 4) {
            ctx.physics.impulse("crate", [10, 20, 0]);
            ctx.physics.setVelocity("actor", [5, 5, 0]);
            ctx.physics.moveCharacter("actor", [10, 1, 0]);
            ctx.entities.destroy("crate");
            ctx.entities.destroy("actor");
          }
          ctx.entities.spawn({
            id: "crate",
            prefab: crate.id,
            transform: {
              position: ctx.time.tick === 1 ? [0, 0.5, 0] : [10, 3, 0],
            },
          });
          ctx.entities.spawn({
            id: "actor",
            prefab: actor.id,
            transform: {
              position: ctx.time.tick === 1 ? [4, 0.92, 0] : [12, 3, 0],
            },
          });
        }
      },
    },
    {
      id: "fresh-queries",
      phase: "prePhysics",
      reads: ["Transform"],
      writes: [],
      run(ctx) {
        if (ctx.time.tick === 5) {
          for (const id of ["crate", "actor"])
            assert.throws(() => ctx.physics.velocity(id), /TC_PHYSICS_ENTITY/);
        }
      },
    },
  ];
  const make = () => hostRig([floor()], inputs, 1 / 60, [crate, actor]);
  const host = make(),
    cold = make();
  try {
    host.step(3);
    assert.ok(hostPhysics(host).pairs.length > 0);
    host.startRecording();
    host.step();
    const pending = host.snapshot();
    assert.deepEqual(hostPhysics(host).bindings, ["floor"]);
    host.step();
    const fresh = host.snapshot(),
      state = hostPhysics(host);
    near(host.world.getTransform("crate").position[0], 10, 1e-6);
    near(host.world.getTransform("actor").position[0], 12, 1e-6);
    assert.ok(
      state.pairs.every(
        ([a, b]) =>
          !state.entities.some(
            (e) =>
              ["crate", "actor"].includes(e.id) &&
              (e.colliderHandle === a || e.colliderHandle === b),
          ),
      ),
    );
    const actorState = state.characters.find((c) => c.entity === "actor")!;
    assert.deepEqual(actorState.velocity, [0, 0, 0]);
    assert.deepEqual(actorState.requested, [0, 0, 0]);
    assert.equal(actorState.grounded, false);
    host.step(10);
    const trace = host.stopRecording(),
      expected = host.snapshot();
    assert.equal(
      host.replay(trace).status,
      "passed",
      JSON.stringify(host.inspect().diagnostics),
    );
    assert.deepEqual(host.snapshot(), expected);
    for (const saved of [pending, fresh]) {
      cold.restore(JSON.parse(JSON.stringify(saved)));
      cold.step(expected.scheduler.tick - saved.scheduler.tick);
      assert.deepEqual(cold.snapshot(), expected);
    }
  } finally {
    host.dispose();
    cold.dispose();
  }
});

test("prefab discovery uses the existing native world, refreshes first-step queries and supports type replacement", () => {
  const wall = box("wall-prefab", [2, 2, 0], [0.5, 4, 8]),
    crate = box("crate-prefab", [8, 2, 0], [1, 1, 1], "dynamic"),
    actor = character("actor-prefab", [10, 3, 0]);
  const r = rig(
    [floor(), character("player", [0, 0.92, 0])],
    [wall, crate, actor],
  );
  const create = RAPIER.World.prototype.createRigidBody;
  const worlds = new Set<RAPIER.World>();
  RAPIER.World.prototype.createRigidBody = function (
    ...args: Parameters<typeof create>
  ) {
    worlds.add(this);
    return create.apply(this, args);
  };
  try {
    r.world.spawn({ id: "wall", prefab: wall.id, transform: wall.transform });
    r.world.spawn({
      id: "instance",
      prefab: crate.id,
      transform: crate.transform,
    });
    r.physics.moveCharacter("player", [10, 0, 0]);
    r.step();
    assert.ok(r.world.getTransform("player").position[0] < 1.46);
    assert.equal(r.physics.raycast([0, 2, 0], [1, 0, 0], 4)!.entity, "wall");
    r.physics.setVelocity("instance", [5, 5, 0]);
    r.world.destroy("instance");
    r.world.spawn({
      id: "instance",
      prefab: actor.id,
      transform: actor.transform,
    });
    assert.throws(() => r.physics.velocity("instance"), /TC_PHYSICS_ENTITY/);
    r.step();
    assert.equal(
      snap(r).entities.find((e) => e.id === "instance")!.type,
      "character",
    );
    near(r.world.getTransform("instance").position[0], 10, 1e-6);
    near(r.physics.velocity("instance")[0], 0, 1e-6);
    r.world.destroy("instance");
    r.world.destroy("wall");
    r.step();
    assert.ok(
      !snap(r).entities.some((e) => ["wall", "instance"].includes(e.id)),
    );
    assert.equal(worlds.size, 1);
    r.plugin.validateSnapshot(snap(r));
  } finally {
    RAPIER.World.prototype.createRigidBody = create;
    r.dispose();
  }
});

test("dynamic declarations reject unknown/nonphysics identities and untrusted definitions atomically", () => {
  const prefab = box("crate-prefab", [0, 3, 0], [1, 1, 1], "dynamic"),
    decorative: EntityIR = {
      id: "decorative",
      transform: transform(),
      components: {},
    };
  const r = rig([floor()], [prefab, decorative]);
  try {
    r.world.spawn({
      id: "crate",
      prefab: prefab.id,
      transform: prefab.transform,
    });
    r.step();
    const saved = snap(r);
    assert.equal(saved.version, 3);
    const corruptions = [
      (s: ReturnType<typeof snap>) => {
        s.version = 2;
      },
      (s: ReturnType<typeof snap>) => {
        s.bindings.push("missing");
      },
      (s: ReturnType<typeof snap>) => {
        s.bindings.push("crate");
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { created: unknown[] }).created[0] = {
          id: "crate",
          prefab: "unknown",
          transform: prefab.transform,
        };
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { created: unknown[] }).created[0] = {
          id: "crate",
          transform: prefab.transform,
        };
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { created: unknown[] }).created[0] = {
          id: "crate",
          prefab: decorative.id,
          transform: prefab.transform,
        };
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { created: unknown[] }).created[0] = {
          id: "crate",
          prefab: prefab.id,
          transform: prefab.transform,
          rigidBody: { ...prefab.rigidBody, mass: 1e9 },
        };
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { removed: string[] }).removed = ["floor", "floor"];
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { removed: string[] }).removed = ["missing"];
      },
      (s: ReturnType<typeof snap>) => {
        (s.history[0] as { created: unknown[] }).created.push({
          id: "crate",
          prefab: prefab.id,
          transform: prefab.transform,
        });
      },
    ];
    for (const corrupt of corruptions) {
      const bad = structuredClone(saved);
      corrupt(bad);
      assert.throws(
        () => r.plugin.validateSnapshot(bad),
        /TC_PHYSICS_SNAPSHOT/,
      );
      assert.throws(() => r.plugin.restore(bad), /TC_PHYSICS_SNAPSHOT/);
      assert.deepEqual(snap(r), saved);
    }
    const other = structuredClone(prefab);
    other.rigidBody!.mass = 2;
    const incompatible = rig([floor()], [other, decorative]);
    try {
      assert.throws(
        () => incompatible.plugin.restore(saved),
        /TC_PHYSICS_SNAPSHOT/,
      );
    } finally {
      incompatible.dispose();
    }
  } finally {
    r.dispose();
  }
});

test("runtime physics prefab parent and scale overrides keep authored diagnostics", () => {
  const root: EntityIR = { id: "root", transform: transform(), components: {} };
  const round = box("round", [0, 3, 0], [1, 1, 1], "dynamic");
  round.rigidBody!.collider = { shape: "sphere", radius: 0.5 };
  const actor = character("actor-prefab");
  const parented = box("parented", [0, 3, 0]);
  parented.parent = "root";
  const cases: {
    prefab: EntityIR;
    parent?: string;
    transform?: Partial<Transform>;
    code: RegExp;
  }[] = [
    { prefab: round, parent: "root", code: /TC_PHYSICS_PARENT_TRANSFORM/ },
    { prefab: parented, code: /TC_PHYSICS_PARENT_TRANSFORM/ },
    {
      prefab: round,
      transform: { scale: [1, 2, 1] },
      code: /TC_PHYSICS_TRANSFORM/,
    },
    {
      prefab: round,
      transform: { scale: [0, 0, 0] },
      code: /TC_PHYSICS_TRANSFORM/,
    },
    {
      prefab: actor,
      transform: { rotation: [0.1, 0, 0] },
      code: /TC_PHYSICS_TRANSFORM/,
    },
    {
      prefab: actor,
      transform: { scale: [2, 2, 2] },
      code: /TC_PHYSICS_TRANSFORM/,
    },
  ];
  for (const c of cases) {
    const r = rig([root], [c.prefab]);
    try {
      r.world.spawn({
        id: "instance",
        prefab: c.prefab.id,
        parent: c.parent,
        transform: { ...c.prefab.transform, ...c.transform },
      });
      const before = snap(r);
      assert.throws(() => r.step(), c.code);
      assert.deepEqual(snap(r), before);
    } finally {
      r.dispose();
    }
  }
  const r = rig([root]);
  try {
    r.world.spawn({ id: "unknown", prefab: "missing" });
    assert.throws(() => r.step(), /TC_PREFAB_MISSING/);
  } finally {
    r.dispose();
  }
});

test("optional World preflight checks bound IDs and prefab identity without replacing live native state", () => {
  const a = box("a", [0, 3, 0], [1, 1, 1], "dynamic"),
    b = box("b", [0, 3, 0]);
  const r = rig([floor()], [a, b]);
  try {
    r.world.spawn({ id: "crate", prefab: a.id, transform: a.transform });
    r.step();
    const saved = snap(r),
      world = r.world.snapshot();
    const plugin = r.plugin as typeof r.plugin & {
      validateWorld(value: unknown, savedWorld: typeof world): void;
    };
    plugin.validateWorld(saved, world);
    for (const mutate of [
      (w: typeof world) => {
        w.entities = w.entities.filter((e) => e.id !== "crate");
      },
      (w: typeof world) => {
        w.entities.find((e) => e.id === "crate")!.prefab = b.id;
      },
      (w: typeof world) => {
        delete w.entities.find((e) => e.id === "crate")!.prefab;
      },
    ]) {
      const bad = structuredClone(world);
      mutate(bad);
      assert.throws(
        () => plugin.validateWorld(saved, bad),
        /TC_PHYSICS_SNAPSHOT/,
      );
      assert.deepEqual(snap(r), saved);
    }
  } finally {
    r.dispose();
  }
});
