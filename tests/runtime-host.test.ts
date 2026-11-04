import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeHost, type HostOptions } from "../packages/runtime/src/host.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import type {
  RuntimePlugin,
  RuntimePluginFactory,
} from "../packages/runtime/src/plugins.ts";
import {
  SDK_VERSION,
  defineComponent,
  defineGame,
  defineScene,
  defineSystem,
  instantiateGame,
  type GameInstance,
  type EngineFacade,
  type SystemDefinition,
  type SystemInput,
} from "../packages/sdk/src/index.ts";

const Counter = defineComponent({
  id: "Counter",
  schema: {
    value: { type: "number", default: 0 },
    vector: { type: "vec3", default: [0, 0, 0] },
  },
});
const Flag = defineComponent({
  id: "Flag",
  schema: { on: { type: "boolean", default: false } },
});
const source = { file: "game.ts", line: 1, column: 1, length: 1 };

test("Host plugin World validation rejects inconsistent sidecars before changing live state", () => {
  let calls = 0;
  const ir = sceneIR(),
    plugin: RuntimePluginFactory = () => ({
      id: "linked",
      snapshot: () => ({ entities: ["root"] }),
      validateSnapshot() {},
      validateWorld(value, world) {
        calls++;
        if (
          JSON.stringify((value as any).entities) !==
          JSON.stringify(world.entities.map((entity) => entity.id))
        )
          throw new Error("TC_PLUGIN_WORLD_MISMATCH");
      },
      restore() {},
      dispose() {},
    });
  const host = new RuntimeHost(ir, { plugins: [plugin] });
  host.attach(
    instantiateGame(
      defineGame({
        id: ir.gameId,
        scene: defineScene({ id: "scene", entities: [] }),
      }),
      host.facade,
    ),
  );
  try {
    const before = host.snapshot(),
      invalid = structuredClone(before);
    (invalid.plugins!.linked.payload as any).entities = [];
    assert.throws(() => host.restore(invalid), /TC_PLUGIN_WORLD_MISMATCH/);
    assert.equal(calls, 1);
    assert.deepEqual(host.snapshot(), before);
  } finally {
    host.dispose();
  }
});

test("Host prefab spawn merges compiler defaults and overrides, enforces permissions and restores content identity", () => {
  const definition = sceneIR();
  definition.prefabs = [
    {
      id: "crate",
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0.5, 0],
        scale: [2, 2, 2],
      },
      components: { Counter: { value: 7, vector: [1, 2, 3] } },
    },
  ];
  const host = new RuntimeHost(definition);
  host.attach(
    instantiateGame(
      defineGame({
        id: definition.gameId,
        scene: defineScene({ id: "scene", entities: [] }),
      }),
      host.facade,
    ),
  );
  try {
    host.facade.entities.spawn({
      id: "spawned",
      prefab: "crate",
      transform: { position: [8, 1, 0] },
      components: { Counter: { value: 9 } },
    });
    host.world.flush();
    assert.deepEqual(host.world.getTransform("spawned"), {
      position: [8, 1, 0],
      rotation: [0, 0.5, 0],
      scale: [2, 2, 2],
    });
    assert.deepEqual(host.world.getComponent("spawned", "Counter"), {
      value: 9,
      vector: [1, 2, 3],
    });
    const saved = host.snapshot();
    host.facade.entities.destroy("spawned");
    host.world.flush();
    host.restore(saved);
    assert.equal(
      host.world.records().find((r) => r.id === "spawned")?.prefab,
      "crate",
    );
    assert.throws(
      () => host.facade.entities.spawn({ id: "bad", prefab: "missing" }),
      /TC_PREFAB_MISSING/,
    );
    assert.equal(host.world.inspect().pendingCommands, 0);
    const invalid = structuredClone(saved);
    invalid.world.entities.find((r) => r.id === "spawned")!.prefab = "missing";
    invalid.scheduler.world = structuredClone(invalid.world);
    assert.throws(() => host.restore(invalid), /TC_PREFAB_MISSING/);
    assert.deepEqual(host.snapshot(), saved);
    assert.throws(
      () =>
        host.world.runSystem(
          "denied",
          { structural: true, writes: ["Transform"] },
          () => host.facade.entities.spawn({ id: "denied", prefab: "crate" }),
        ),
      /TC_WORLD_ACCESS/,
    );
    assert.equal(host.world.inspect().pendingCommands, 0);
  } finally {
    host.dispose();
  }
});
const transform = () => ({
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0] as const,
  scale: [1, 1, 1] as const,
});

/** Minimal valid IR: gameplay tests use ordinary SDK definitions, not fake World/scheduler objects. */
function sceneIR(systems: readonly SystemDefinition[] = []): SceneIR {
  return {
    format: "threecat.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "host-test",
    scene: {
      id: "scene",
      camera: {
        position: [0, 1, 5],
        target: [0, 0, 0],
        fov: 50,
        near: 0.1,
        far: 100,
      },
      environment: { background: "#000000", ambientIntensity: 1 },
      gravity: [0, -9.81, 0],
      entities: [
        {
          id: "root",
          transform: transform(),
          components: { Counter: { value: 0, vector: [0, 0, 0] } },
        },
      ],
    },
    components: [Counter, Flag].map((component) => ({
      id: component.id,
      schema: component.schema,
      source,
    })),
    systems: systems.map((system) => ({
      id: system.id,
      phase: system.phase ?? "update",
      source,
      ...(system.before === undefined ? {} : { before: [...system.before] }),
      ...(system.after === undefined ? {} : { after: [...system.after] }),
      ...(system.reads === undefined ? {} : { reads: [...system.reads] }),
      ...(system.writes === undefined ? {} : { writes: [...system.writes] }),
      ...(system.structural === undefined
        ? {}
        : { structural: system.structural }),
    })),
    prefabs: [],
    materials: [],
    computes: [],
    assets: [],
  };
}

function rig(inputs: readonly SystemInput[] = [], options: HostOptions = {}) {
  const systems = inputs.map(defineSystem);
  const ir = sceneIR(systems);
  const host = new RuntimeHost(ir, options);
  const game = instantiateGame(
    defineGame({
      id: "host-test",
      scene: defineScene({ id: "scene", entities: [] }),
      systems,
    }),
    host.facade,
  );
  host.attach(game);
  return { host, game, systems, ir };
}
const value = (host: RuntimeHost) =>
  host.world.getComponent("root", "Counter").value;
const increment: SystemInput = {
  id: "increment",
  writes: ["Counter"],
  run(ctx) {
    ctx.setComponent("root", Counter, {
      value: ctx.getComponent("root", Counter).value + 1,
    });
  },
};

test("host: real compiled game initializes scheduler and runs authoritative World, input, random and events", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "threecat host \u4e2d\u6587 "),
  );
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(
      path.dirname(absolute).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(absolute).startsWith("threecat host "));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(root, "threecat.project.json"),
    JSON.stringify({ entry: "game.ts", engineVersion: SDK_VERSION }),
  );
  await fs.writeFile(
    path.join(root, "game.ts"),
    `
import { defineComponent, defineGame, defineScene, defineSystem } from "@threecat/sdk";
const Stats = defineComponent({ id: "Stats", schema: {
  count: { type: "number", default: 0 }, tick: { type: "number", default: 0 },
  elapsed: { type: "number", default: 0 }, random: { type: "number", default: 0 },
  input: { type: "number", default: 0 }, ack: { type: "number", default: 0 }
} });
const controls = defineSystem({ id: "controls", phase: "input", reads: ["Stats"], writes: ["Stats", "Transform"], structural: false,
  run(ctx) {
    for (const event of ctx.events("input.key")) {
      const payload = event.payload as { key: string; pressed: boolean };
      if (payload.key === "ArrowRight" && payload.pressed) {
        ctx.setTransform("player", { position: [ctx.getTransform("player").position[0] + 2, 0, 0] });
        ctx.setComponent("player", Stats, { input: ctx.getComponent("player", Stats).input + 1 });
      }
    }
  }
});
const simulate = defineSystem({ id: "simulate", phase: "update", before: ["finish"], reads: ["Stats"], writes: ["Stats"], structural: false,
  run(ctx, dt) {
    const data = ctx.getComponent("player", Stats);
    ctx.setComponent("player", Stats, { count: data.count + 1, tick: ctx.time.tick, elapsed: ctx.time.elapsed, random: ctx.random(), ack: data.ack + ctx.events("ack").length });
    if (ctx.time.tick === 1) ctx.emit("ack", { dt });
  }
});
const finish = defineSystem({ id: "finish", phase: "update", after: ["simulate"], reads: ["Stats"], writes: [], structural: false,
  run(ctx) { ctx.getComponent("player", Stats); }
});
export default defineGame({ id: "host-integration", components: [Stats], systems: [finish, simulate, controls],
  scene: defineScene({ id: "scene", entities: [{ id: "parent" }, { id: "player", parent: "parent", components: [{ component: Stats }] }] })
});
`,
  );
  const result = await compileProject({
    projectRoot: root,
    outDir: "dist",
    engineRoot: fileURLToPath(new URL("../", import.meta.url)),
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir);
  const compiled = (await import(
    pathToFileURL(path.join(root, "dist/game.js")).href
  )) as { createGame(engine: EngineFacade): GameInstance };
  const host = new RuntimeHost(result.ir, { fixedDt: 0.25, seed: 7 });
  t.after(() => host.dispose());
  host.attach(compiled.createGame(host.facade));
  const initial = host.snapshot();
  assert.deepEqual(
    initial.scheduler.systems.map((s) => s.id),
    ["controls", "simulate", "finish"],
  );
  assert.deepEqual(initial.scheduler.systems[0], {
    id: "controls",
    phase: "input",
    before: [],
    after: [],
    reads: ["Stats"],
    writes: ["Stats", "Transform"],
    structural: false,
  });
  assert.equal(initial.scheduler.tick, 0);
  host.startRecording();
  const event = host.input("ArrowRight", true);
  assert.equal(event.tick, 1);
  assert.equal(event.source, "external");
  host.step(3);
  const stats = host.world.getComponent("player", "Stats");
  assert.equal(stats.count, 3);
  assert.equal(stats.tick, 3);
  assert.equal(stats.elapsed, 0.75);
  assert.equal(stats.input, 1);
  assert.equal(stats.ack, 1);
  assert.equal(host.world.getTransform("player").position[0], 2);
  assert.equal(
    host.world.records().find((e) => e.id === "player")?.parent,
    "parent",
  );
  assert.equal(host.inspect().scheduler.random.draws, 3);
  const trace = host.stopRecording();
  const final = host.snapshot();
  assert.equal(host.replay(trace).status, "passed");
  assert.deepEqual(host.snapshot(), final);
  host.restore(initial);
  host.input("ArrowRight", true);
  host.step(3);
  assert.deepEqual(host.snapshot(), final);
});

test("host: initial checkpoint includes configured scheduler before the first update", () => {
  const { host } = rig([increment]);
  try {
    const state = host.snapshot();
    assert.equal(state.scheduler.tick, 0);
    assert.equal(state.scheduler.systems[0]?.id, "increment");
    assert.equal(state.engineVersion, SDK_VERSION);
    assert.deepEqual(state.world, state.scheduler.world);
    host.step();
    host.restore(state);
    assert.equal(value(host), 0);
    assert.equal(host.facade.time.tick, 0);
  } finally {
    host.dispose();
  }
});

test("host: active tick/time are correct in every phase and options cannot change the clock", () => {
  const seen: unknown[] = [];
  const options = { fixedDt: 0.125, seed: 5 };
  const phases = [
    "input",
    "prePhysics",
    "physics",
    "postPhysics",
    "update",
    "presentation",
  ] as const;
  const { host } = rig(
    phases.map((phase) => ({
      id: phase,
      phase,
      reads: [],
      writes: [],
      run(ctx, dt) {
        seen.push([phase, ctx.time.tick, ctx.time.elapsed, dt]);
      },
    })),
    options,
  );
  try {
    options.fixedDt = 0.5;
    host.step(2);
    assert.deepEqual(
      seen,
      [1, 2].flatMap((tick) =>
        phases.map((p) => [p, tick, tick * 0.125, 0.125]),
      ),
    );
    assert.equal(host.facade.time.tick, 2);
  } finally {
    host.dispose();
  }
});

test("host: ordering metadata and component permissions reach the real scheduler unchanged", () => {
  const order: string[] = [];
  const { host } = rig([
    {
      id: "second",
      after: ["first"],
      reads: ["Counter"],
      writes: [],
      structural: false,
      run(ctx) {
        order.push("second");
        assert.equal(ctx.getComponent("root", Counter).value, 4);
      },
    },
    {
      id: "first",
      before: ["second"],
      writes: ["Counter"],
      run(ctx) {
        order.push("first");
        ctx.setComponent("root", Counter, { value: 4 });
      },
    },
  ]);
  try {
    host.step();
    assert.deepEqual(order, ["first", "second"]);
    assert.deepEqual(host.snapshot().scheduler.systems[0]?.writes, ["Counter"]);
  } finally {
    host.dispose();
  }
});

test("host: explicit empty reads/writes deny component queries instead of using M0 fallback", () => {
  const { host } = rig([
    {
      id: "forbidden",
      reads: [],
      writes: [],
      run(ctx) {
        ctx.query(Counter);
      },
    },
  ]);
  try {
    assert.throws(() => host.step(), /ACCESS_READ/);
    assert.equal(host.inspect().scheduler.tick, 0);
    assert.equal(host.inspect().scheduler.fault?.partialState, true);
  } finally {
    host.dispose();
  }
});

test("host: read-only component systems cannot write", () => {
  const { host } = rig([
    {
      id: "readonly",
      reads: ["Counter"],
      writes: [],
      run(ctx) {
        ctx.setComponent("root", Counter, { value: 5 });
      },
    },
  ]);
  try {
    assert.throws(() => host.step(), /ACCESS_WRITE/);
    assert.equal(value(host), 0);
  } finally {
    host.dispose();
  }
});

test("host: entity service Transform access is checked as well as facade access", () => {
  const { host } = rig([
    {
      id: "forbidden",
      reads: [],
      writes: [],
      run(ctx) {
        ctx.entities.getTransform(ctx.entities.resolve("root"));
      },
    },
  ]);
  try {
    assert.throws(() => host.step(), /ACCESS_READ/);
  } finally {
    host.dispose();
  }
});

test("host: omitted legacy access differs from explicit empty access", () => {
  const { host } = rig([
    {
      id: "legacy",
      run(ctx) {
        ctx.setComponent("root", Counter, { value: 6 });
        ctx.setTransform("root", { position: [1, 2, 3] });
      },
    },
  ]);
  try {
    host.step();
    assert.equal(value(host), 6);
    assert.deepEqual(host.world.getTransform("root").position, [1, 2, 3]);
  } finally {
    host.dispose();
  }
});

test("host: structural=false is forwarded and rejects queued entity creation", () => {
  const { host } = rig([
    {
      id: "forbidden",
      structural: false,
      run(ctx) {
        ctx.entities.spawn({ id: "child" });
      },
    },
  ]);
  try {
    assert.throws(() => host.step(), /ACCESS_STRUCTURAL/);
    assert.equal(host.world.isAlive("child"), false);
  } finally {
    host.dispose();
  }
});

test("host: queued parents/children commit at phase boundaries and are hidden within a phase", () => {
  const { host } = rig([
    {
      id: "create",
      phase: "input",
      structural: true,
      writes: ["Transform", "Counter"],
      run(ctx) {
        ctx.entities.spawn({
          id: "parent",
          components: { Counter: { value: 2 } },
        });
        ctx.entities.spawn({
          id: "child",
          parent: "parent",
          components: { Counter: { value: 3 } },
        });
        assert.equal(ctx.entities.isAlive("parent"), false);
      },
    },
    {
      id: "same-phase",
      phase: "input",
      after: ["create"],
      reads: [],
      writes: [],
      run(ctx) {
        assert.equal(ctx.entities.isAlive("child"), false);
      },
    },
    {
      id: "next-phase",
      phase: "prePhysics",
      reads: ["Counter"],
      writes: [],
      run(ctx) {
        assert.equal(ctx.entities.getComponent("child", "Counter").value, 3);
        assert.equal(ctx.entities.isAlive("parent"), true);
      },
    },
  ]);
  try {
    host.step();
    assert.equal(
      host.world.records().find((e) => e.id === "child")?.parent,
      "parent",
    );
  } finally {
    host.dispose();
  }
});

test("host: component add/remove commands follow FIFO semantics at a phase boundary", () => {
  const { host } = rig([
    {
      id: "edit",
      phase: "input",
      writes: ["Counter", "Flag"],
      structural: true,
      run(ctx) {
        ctx.entities.removeComponent("root", "Counter");
        ctx.entities.addComponent("root", "Counter", { value: 9 });
        ctx.entities.addComponent("root", "Flag");
      },
    },
    {
      id: "observe",
      phase: "update",
      reads: ["Counter", "Flag"],
      writes: [],
      run(ctx) {
        assert.equal(ctx.getComponent("root", Counter).value, 9);
        assert.equal(ctx.getComponent("root", Flag).on, false);
      },
    },
  ]);
  try {
    host.step();
  } finally {
    host.dispose();
  }
});

test("host: destroy commands cascade and invalidate handles", () => {
  const { host } = rig([
    {
      id: "destroy",
      writes: ["Transform", "Counter"],
      structural: true,
      run(ctx) {
        ctx.entities.destroy("root");
      },
    },
  ]);
  try {
    const old = host.world.resolve("root");
    host.world.spawn({ id: "child", parent: "root" });
    host.step();
    assert.equal(host.world.isAlive(old), false);
    assert.equal(host.world.isAlive("child"), false);
  } finally {
    host.dispose();
  }
});

test("host: failed structural batches do not commit earlier commands or claim a completed tick", () => {
  const { host } = rig([
    {
      id: "bad-batch",
      structural: true,
      run(ctx) {
        ctx.entities.spawn({ id: "candidate" });
        ctx.entities.spawn({ id: "candidate" });
      },
    },
  ]);
  try {
    assert.throws(() => host.step(), /DUPLICATE/);
    assert.equal(host.world.isAlive("candidate"), false);
    assert.equal(host.inspect().scheduler.tick, 0);
    assert.equal(host.inspect().world.pendingCommands, 0);
  } finally {
    host.dispose();
  }
});

test("host: snapshots are detached on capture and repeated restore, including vec3/schema state", () => {
  const { host } = rig([increment]);
  try {
    const snapshot = host.snapshot(),
      serialized = JSON.stringify(snapshot);
    const handle = host.world.resolve("root");
    host.step(3);
    host.world.setComponent("root", "Counter", { vector: [8, 9, 10] });
    assert.equal(JSON.stringify(snapshot), serialized);
    for (let i = 0; i < 3; i++) {
      host.restore(snapshot);
      assert.equal(value(host), 0);
      assert.equal(host.world.isAlive(handle), false);
      host.step();
      host.world.setComponent("root", "Counter", { vector: [i, 1, 2] });
      assert.equal(JSON.stringify(snapshot), serialized);
    }
    const captured = host.snapshot();
    captured.world.entities[0]!.components.Counter!.value = 100;
    assert.notEqual(
      captured.scheduler.world.entities[0]!.components.Counter!.value,
      100,
    );
    assert.equal(value(host), 1);
  } finally {
    host.dispose();
  }
});

test("host: inconsistent Host/scheduler world snapshots are rejected without changing current state", () => {
  const { host } = rig([increment]);
  try {
    host.step(2);
    const before = host.snapshot(),
      bad = structuredClone(before);
    bad.world.entities[0]!.components.Counter!.value = 999;
    assert.throws(() => host.restore(bad), /TC_RUNTIME_SNAPSHOT_WORLD/);
    assert.deepEqual(host.snapshot(), before);
  } finally {
    host.dispose();
  }
});

test("host: invalid world restore leaves original world handles, clock, random and events intact", () => {
  const { host } = rig([increment]);
  try {
    host.input("x", true);
    host.step();
    const before = host.snapshot(),
      bad = structuredClone(before);
    const old = host.world.resolve("root");
    bad.world.entities[0]!.components.Counter!.value = "invalid";
    bad.scheduler.world = structuredClone(bad.world);
    assert.throws(() => host.restore(bad));
    assert.deepEqual(host.snapshot(), before);
    assert.equal(host.world.isAlive(old), true);
  } finally {
    host.dispose();
  }
});

test("host: invalid clock/random/events/system snapshots are preflighted atomically", () => {
  const { host } = rig([increment]);
  try {
    host.step(2);
    const before = host.snapshot();
    const corruptions = [
      (s: typeof before) => {
        s.scheduler.time = 999;
      },
      (s: typeof before) => {
        s.scheduler.random.draws = -1;
      },
      (s: typeof before) => {
        s.scheduler.events.nextSequence = -1;
      },
      (s: typeof before) => {
        s.scheduler.systems[0]!.writes = [];
      },
    ];
    for (const corrupt of corruptions) {
      const bad = structuredClone(before);
      corrupt(bad);
      assert.throws(() => host.restore(bad));
      assert.deepEqual(host.snapshot(), before);
    }
  } finally {
    host.dispose();
  }
});

test("host: snapshot engine version and missing scheduler are rejected", () => {
  const { host } = rig();
  try {
    assert.throws(
      () => host.restore({ ...host.snapshot(), engineVersion: "different" }),
      /SNAPSHOT_VERSION/,
    );
    assert.throws(
      () => host.restore({ ...host.snapshot(), scheduler: null }),
      /SNAPSHOT_VERSION/,
    );
    assert.throws(
      () => new RuntimeHost({ ...sceneIR(), engineVersion: "different" }),
      /ENGINE_VERSION/,
    );
  } finally {
    host.dispose();
  }
});

test("host: a faulted partial tick is observable, cannot snapshot or advance, and can recover", () => {
  let fail = true;
  const { host } = rig([
    {
      id: "partial",
      writes: ["Counter"],
      run(ctx) {
        ctx.setComponent("root", Counter, { value: 8 });
        if (fail && ctx.time.tick === 2) throw new Error("deliberate");
      },
    },
  ]);
  try {
    const before = host.snapshot();
    assert.throws(() => host.step(3), /partialState=true.*deliberate/);
    assert.equal(value(host), 8);
    assert.equal(host.inspect().scheduler.tick, 1);
    assert.equal(host.inspect().scheduler.fault?.tick, 2);
    assert.equal(host.inspect().scheduler.fault?.stage, "system:partial");
    assert.equal(host.inspect().diagnostics.length, 1);
    assert.equal(host.inspect().diagnostics[0].system, "partial");
    assert.deepEqual(host.inspect().diagnostics[0].source, source);
    assert.throws(() => host.snapshot(), /SCHEDULER_FAULT/);
    assert.throws(() => host.step(), /TC_RUNTIME_SYSTEM/);
    host.restore(before);
    fail = false;
    host.step();
    assert.equal(host.snapshot().scheduler.tick, 1);
  } finally {
    host.dispose();
  }
});

test("host: mismatched timestep fails without advancing; zero update preserves configured clock", () => {
  const { host, game } = rig([increment], { fixedDt: 0.1 });
  try {
    assert.throws(() => game.update(0.2), /FIXED_DT/);
    assert.equal(host.snapshot().scheduler.tick, 0);
    game.update(0);
    host.step();
    assert.equal(host.snapshot().scheduler.tick, 1);
    game.update(0);
    assert.equal(host.snapshot().scheduler.tick, 1);
  } finally {
    host.dispose();
  }
});

test("host: replacing systems or mutating metadata never silently resets the clock", () => {
  const { host, systems } = rig([increment]);
  try {
    host.step(2);
    const before = host.snapshot();
    assert.throws(
      () => host.facade.configureGameSystems!([...systems]),
      /SYSTEMS_CHANGED/,
    );
    assert.deepEqual(host.snapshot(), before);
    systems[0]!.writes = [];
    assert.throws(() => host.step(), /SYSTEMS_CHANGED/);
    assert.equal(host.inspect().scheduler.tick, 2);
  } finally {
    host.dispose();
  }
});

test("host: IR/system metadata drift is rejected before configuration changes state", () => {
  const system = defineSystem(increment),
    host = new RuntimeHost(sceneIR([system]));
  try {
    assert.throws(
      () => host.facade.configureGameSystems!([{ ...system, reads: [] }]),
      /SYSTEM_CONTRACT/,
    );
    assert.equal(host.snapshot().scheduler.systems.length, 0);
    host.facade.configureGameSystems!([system]);
    assert.equal(host.snapshot().scheduler.systems.length, 1);
  } finally {
    host.dispose();
  }
});

test("host: empty compiled games tick; missing attachment and invalid counts do not", () => {
  const { host } = rig();
  const unattached = new RuntimeHost(sceneIR());
  try {
    host.step(2);
    assert.equal(host.facade.time.tick, 2);
    for (const n of [0, -1, 1.5, 10001, NaN])
      assert.throws(() => host.step(n), /STEPS/);
    assert.throws(() => unattached.step(), /NOT_ATTACHED/);
    assert.ok(unattached.snapshot().scheduler);
  } finally {
    host.dispose();
    unattached.dispose();
  }
});

test("host: non-scheduling GameInstance cannot report step success or replace an attached game", () => {
  const host = new RuntimeHost(sceneIR());
  try {
    host.facade.configureGameSystems!([]);
    host.attach({ update() {}, dispose() {} });
    assert.throws(() => host.step(), /TICK_NOT_COMPLETED/);
    assert.throws(
      () => host.attach({ update() {}, dispose() {} }),
      /GAME_CHANGED/,
    );
  } finally {
    host.dispose();
  }
});

test("host: input queues next-tick events, copies payload, and does not directly edit transforms", () => {
  const { host } = rig([
    {
      id: "input",
      phase: "input",
      writes: ["Counter"],
      run(ctx) {
        ctx.setComponent("root", Counter, {
          value: ctx.events("input.key").length,
        });
      },
    },
  ]);
  try {
    const event = host.input("ArrowRight", true);
    (event.payload as { key: string }).key = "tampered";
    assert.equal(value(host), 0);
    assert.equal(host.snapshot().scheduler.events.queue[0]?.source, "external");
    assert.equal(
      (host.snapshot().scheduler.events.queue[0]?.payload as { key: string })
        .key,
      "ArrowRight",
    );
    host.step();
    assert.equal(value(host), 1);
    host.step();
    assert.equal(value(host), 0);
  } finally {
    host.dispose();
  }
});

test("host: bounded external input validation rejects invalid data without adding events", () => {
  const { host } = rig();
  try {
    for (const key of ["", "x".repeat(65), "bad\nkey"])
      assert.throws(() => host.input(key, true), /RUNTIME_INPUT/);
    assert.throws(
      () => host.input("x", 1 as unknown as boolean),
      /RUNTIME_INPUT/,
    );
    assert.throws(() => host.emitExternal("", {}), /RUNTIME_INPUT/);
    assert.throws(
      () => host.emitExternal("event", { value: NaN }),
      /SERIALIZATION/,
    );
    assert.throws(
      () => host.emitExternal("event", "x".repeat(65537)),
      /INPUT_LIMIT/,
    );
    assert.equal(host.snapshot().scheduler.events.queue.length, 0);
    for (let i = 0; i < 4096; i++) host.input("a", true);
    assert.throws(() => host.input("a", true), /INPUT_LIMIT/);
  } finally {
    host.dispose();
  }
});

test("host: recording/replay reproduces input, external events, RNG and game-emitted next-tick events", () => {
  const { host } = rig(
    [
      {
        id: "random",
        writes: ["Counter"],
        run(ctx) {
          ctx.setComponent("root", Counter, {
            value:
              ctx.random() +
              ctx.events("input.key").length +
              ctx.events("debug").length +
              ctx.events("notice").length,
          });
          ctx.emit("notice", { at: ctx.time.tick });
        },
      },
    ],
    { seed: 246 },
  );
  try {
    host.startRecording();
    host.input("x", true);
    host.emitExternal("debug", { nested: [1, 2] });
    host.step(4);
    const trace = host.stopRecording(),
      final = host.snapshot(),
      traceText = JSON.stringify(trace);
    assert.equal(
      trace.actions.filter((action) => action.kind === "emit").length,
      2,
    );
    assert.equal(host.replay(trace).status, "passed");
    assert.deepEqual(host.snapshot(), final);
    host.step();
    assert.equal(JSON.stringify(trace), traceText);
    assert.equal(host.replay(trace).status, "passed");
    assert.deepEqual(host.snapshot(), final);
  } finally {
    host.dispose();
  }
});

test("host: failed replay returns failed with diagnostics instead of claiming success", () => {
  const { host } = rig([increment]);
  try {
    host.startRecording();
    host.step();
    const trace = host.stopRecording();
    trace.final.tick = 2;
    trace.final.time = 2 * trace.final.fixedDt;
    const result = host.replay(trace);
    assert.equal(result.status, "failed");
    assert.equal(result.fault?.partialState, true);
    assert.equal(
      host.inspect().diagnostics.at(-1)?.code,
      "TC_REPLAY_DIVERGENCE",
    );
  } finally {
    host.dispose();
  }
});

test("host: recording prevents restore and can be cancelled without losing current state", () => {
  const { host } = rig([increment]);
  try {
    const start = host.snapshot();
    host.startRecording();
    host.step();
    assert.throws(() => host.restore(start), /TRACE_RESTORE/);
    assert.equal(value(host), 1);
    host.cancelRecording();
    host.restore(start);
    assert.equal(value(host), 0);
  } finally {
    host.dispose();
  }
});

test("host: services reject use after dispose, inspection remains available and disposal is idempotent", () => {
  const { host, game } = rig([increment]);
  host.dispose();
  host.dispose();
  assert.equal(host.inspect().disposed, true);
  assert.equal(host.inspect().world.disposed, true);
  assert.equal(host.inspect().scheduler.disposed, true);
  assert.deepEqual(host.inspect().records, []);
  for (const operation of [
    () => host.step(),
    () => host.snapshot(),
    () => host.restore({}),
    () => host.input("x", true),
    () => host.emitExternal("x", {}),
    () => host.startRecording(),
    () => host.stopRecording(),
    () => host.replay({}),
    () => host.facade.time,
    () => host.facade.events(),
    () => host.facade.random(),
    () => game.update(1 / 60),
  ])
    assert.throws(operation, /DISPOSED/);
});

test("host: disposal releases world/scheduler even when game disposal throws", () => {
  const host = new RuntimeHost(sceneIR());
  host.facade.configureGameSystems!([]);
  host.attach({
    update() {},
    dispose() {
      throw new Error("dispose-failure");
    },
  });
  assert.throws(() => host.dispose(), /dispose-failure/);
  assert.equal(host.inspect().disposed, true);
  assert.equal(host.inspect().world.disposed, true);
  host.dispose();
});

test("host: async systems and returned promises are rejected rather than losing their result in a wrapper", () => {
  const asyncSystem = defineSystem({ id: "async", async run() {} });
  const host = new RuntimeHost(sceneIR([asyncSystem]));
  try {
    assert.throws(
      () => host.facade.configureGameSystems!([asyncSystem]),
      /SYSTEM_ASYNC/,
    );
  } finally {
    host.dispose();
  }
  const { host: promiseHost } = rig([
    {
      id: "promise",
      run() {
        return Promise.resolve();
      },
    },
  ]);
  try {
    assert.throws(() => promiseHost.step(), /ASYNC/);
    assert.equal(promiseHost.inspect().scheduler.tick, 0);
  } finally {
    promiseHost.dispose();
  }
});

function pluginHost(pluginFactories: readonly RuntimePluginFactory[] = []) {
  const host = new RuntimeHost(sceneIR(), {
    seed: 91,
    plugins: pluginFactories,
  });
  const systems: SystemDefinition[] = [];
  const game = instantiateGame(
    defineGame({
      id: "host-test",
      scene: defineScene({ id: "scene", entities: [] }),
      systems,
    }),
    host.facade,
  );
  host.attach(game);
  return host;
}

function statePlugin(
  options: { failRestoreOnce?: boolean; dispose?: () => void } = {},
) {
  let state = 0;
  let fail = options.failRestoreOnce ?? false;
  const plugin: RuntimePlugin = {
    id: "counter-plugin",
    version: "1",
    systems: [
      {
        id: "$engine.counter",
        phase: "input",
        reads: [],
        writes: [],
        structural: false,
        run() {
          state++;
        },
      },
    ],
    inspect: () => ({ state }),
    snapshot: () => ({ state }),
    validateSnapshot(value) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { state?: unknown }).state !== "number"
      )
        throw new Error("invalid counter snapshot");
    },
    restore(value) {
      state = (value as { state: number }).state;
      if (fail && state === 9) {
        fail = false;
        throw new Error("injected restore failure");
      }
    },
    dispose() {
      options.dispose?.();
    },
  };
  return {
    plugin,
    get state() {
      return state;
    },
  };
}

test("host plugins: services resolve through facade and absent services fail explicitly", () => {
  const input = {
    held: (action: string) => action === "move",
    pressed: () => false,
    released: () => false,
    axis: () => 0,
  };
  const host = pluginHost([
    () => ({
      id: "input-plugin",
      services: { input },
      snapshot: () => ({}),
      validateSnapshot() {},
      restore() {},
      dispose() {},
    }),
  ]);
  try {
    assert.equal(host.facade.input.held("move"), true);
    assert.throws(() => host.facade.physics, /TC_SERVICE_UNAVAILABLE.*physics/);
    assert.deepEqual(host.inspect().plugins.services, ["input"]);
  } finally {
    host.dispose();
  }
});

test("host plugins: engine systems run before same-phase game systems", () => {
  const order: string[] = [];
  const plugin: RuntimePlugin = {
    id: "ordering-plugin",
    systems: [
      { id: "$engine.input", phase: "input", run: () => order.push("engine") },
    ],
    snapshot: () => ({}),
    validateSnapshot() {},
    restore() {},
    dispose() {},
  };
  const systems = [
    defineSystem({
      id: "game-input",
      phase: "input",
      run: () => order.push("game"),
    }),
  ];
  const host = new RuntimeHost(sceneIR(systems), { plugins: [() => plugin] });
  try {
    const game = instantiateGame(
      defineGame({
        id: "host-test",
        scene: defineScene({ id: "scene", entities: [] }),
        systems,
      }),
      host.facade,
    );
    host.attach(game);
    host.step();
    assert.deepEqual(order, ["engine", "game"]);
  } finally {
    host.dispose();
  }
});

test("host plugins: snapshots restore plugin state, reject incompatible sets, and roll back failed restore", () => {
  const instance = statePlugin({ failRestoreOnce: true });
  const host = pluginHost([() => instance.plugin]);
  try {
    const checkpoint = host.snapshot();
    assert.deepEqual(checkpoint.plugins, {
      "counter-plugin": { version: "1", payload: { state: 0 } },
    });
    host.step(3);
    assert.equal(instance.state, 3);
    host.restore(checkpoint);
    assert.equal(instance.state, 0);
    host.step(2);
    const before = host.snapshot();
    const invalid = structuredClone(before);
    invalid.plugins!["counter-plugin"]!.payload = { state: 9 };
    assert.throws(
      () => host.restore(invalid),
      /TC_PLUGIN_RESTORE.*previous state restored/,
    );
    assert.equal(instance.state, 2);
    assert.deepEqual(host.snapshot(), before);
    const missing = structuredClone(before);
    delete missing.plugins;
    assert.throws(() => host.restore(missing), /TC_PLUGIN_SNAPSHOT_SET/);
  } finally {
    host.dispose();
  }
});

test("host plugins: recording/replay restores initial plugin state and reproduces plugin final state", () => {
  const instance = statePlugin();
  const host = pluginHost([() => instance.plugin]);
  try {
    host.startRecording();
    host.input("x", true);
    host.step(4);
    const trace = host.stopRecording();
    assert.deepEqual(trace.plugins?.initial["counter-plugin"]?.payload, {
      state: 0,
    });
    assert.deepEqual(trace.plugins?.final["counter-plugin"]?.payload, {
      state: 4,
    });
    assert.equal(host.replay(trace).status, "passed");
    assert.equal(instance.state, 4);
    assert.equal(
      host.replay({ ...trace, plugins: undefined }).status,
      "failed",
    );
  } finally {
    host.dispose();
  }
});

test("host plugins: constructor failure and dispose failures still release all created plugins and world", () => {
  let disposed = 0;
  assert.throws(
    () =>
      new RuntimeHost(sceneIR(), {
        plugins: [
          () => ({
            id: "first",
            snapshot: () => ({}),
            validateSnapshot() {},
            restore() {},
            dispose() {
              disposed++;
            },
          }),
          () => {
            throw new Error("factory failure");
          },
        ],
      }),
    /factory failure/,
  );
  assert.equal(disposed, 1);

  const disposable = (id: string, throws: boolean): RuntimePlugin => ({
    id,
    snapshot: () => ({}),
    validateSnapshot() {},
    restore() {},
    dispose() {
      disposed++;
      if (throws) throw new Error("dispose failure");
    },
  });
  const host = pluginHost([
    () => disposable("a", true),
    () => disposable("b", false),
  ]);
  assert.throws(() => host.dispose(), /TC_RUNTIME_DISPOSE/);
  assert.equal(disposed, 3);
  assert.equal(host.inspect().disposed, true);
});
