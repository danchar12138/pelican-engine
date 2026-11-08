import assert from "node:assert/strict";
import test from "node:test";
import {
  SDK_VERSION, defineGame, defineScene, defineSystem, instantiateGame,
  type GameRuntimeDefinition, type GameRuntimeState, type JsonValue,
} from "../packages/sdk/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import type { RuntimePluginFactory } from "../packages/runtime/src/plugins.ts";

const system = defineSystem({ id: "counter", writes: ["Transform"], structural: false });
const source = { file: "game.ts", line: 6, column: 1, length: 8 };
const ir = (): SceneIR => ({
  format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "lifecycle",
  scene: {
    id: "main", camera: { position: [0, 1, 5], target: [0, 0, 0], fov: 50, near: .1, far: 100 },
    environment: { background: "#000000", ambientIntensity: 1 }, gravity: [0, -9.81, 0],
    entities: [{ id: "root", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: {} }],
  },
  systems: [{ id: "counter", phase: "update", writes: ["Transform"], structural: false, source }],
  components: [], prefabs: [], materials: [], computes: [], assets: [],
});
function rig(runtime: GameRuntimeDefinition, plugins: RuntimePluginFactory[] = []) {
  const host = new RuntimeHost(ir(), { plugins });
  const game = instantiateGame(defineGame({
    id: "lifecycle", scene: defineScene({ id: "main", entities: [] }), systems: [system], runtime,
  }), host.facade);
  host.attach(game);
  return { host, game };
}
function counter(options: { rejectRestore?: number; divergence?: () => boolean } = {}): GameRuntimeDefinition {
  return {
    version: "1",
    create() {
      let count = 0;
      return {
        systems: { counter(ctx) { count += options.divergence?.() ? 2 : 1; ctx.setTransform("root", { position: [count, 0, 0] }); } },
        snapshot: () => ({ count }),
        validateSnapshot(value) {
          if (!value || typeof value !== "object" || !("count" in value) || !Number.isSafeInteger(value.count))
            throw new Error("TC_TEST_STATE: Expected integer count.");
        },
        restore(value) {
          count = (value as { count: number }).count;
          if (count === options.rejectRestore) throw new Error("TC_TEST_RESTORE: Deliberate mutation then failure.");
        },
      };
    },
  };
}
const count = (host: RuntimeHost) => (host.snapshot().runtime!.payload as { count: number }).count;

test("runtime factory closes over each instance and host checkpoint restores closure plus world", async () => {
  const runtime = counter();
  const a = rig(runtime), b = rig(runtime);
  try {
    await Promise.all([a.game.ready, b.game.ready]);
    a.host.step(3); b.host.step();
    assert.equal(count(a.host), 3); assert.equal(count(b.host), 1);
    const checkpoint = a.host.snapshot();
    a.host.step(2); a.host.restore(checkpoint); a.host.step();
    assert.equal(count(a.host), 4);
    assert.equal(a.host.world.getTransform("root").position[0], 4);
    assert.equal(count(b.host), 1);
    (checkpoint.runtime!.payload as { count: number }).count = 99;
    assert.equal(count(a.host), 4, "snapshots are detached");
  } finally { a.host.dispose(); b.host.dispose(); }
});

test("runtime restore failure rolls back author closure, scheduler, world and plugins", () => {
  let sidecar = 0;
  const plugin: RuntimePluginFactory = () => ({
    id: "sidecar", snapshot: () => sidecar, validateSnapshot() {},
    restore(value) { sidecar = Number(value); }, dispose() {},
  });
  for (const plugins of [[], [plugin]]) {
    const { host } = rig(counter({ rejectRestore: 2 }), plugins);
    try {
      host.step(2); sidecar = 2;
      const checkpoint = host.snapshot();
      host.step(2); sidecar = 4;
      const before = host.snapshot();
      assert.throws(() => host.restore(checkpoint), /TC_TEST_RESTORE.*previous state restored/);
      assert.deepEqual(host.snapshot(), before);
      assert.equal(sidecar, 4);
      host.step(); assert.equal(count(host), 5);
    } finally { host.dispose(); }
  }
});

test("runtime snapshot validation/version mismatches reject before mutation", () => {
  const { host } = rig(counter());
  try {
    host.step(); const before = host.snapshot();
    for (const change of [
      (data: typeof before) => { data.runtime!.runtimeVersion = "future"; },
      (data: typeof before) => { data.runtime!.payload = { count: "bad" }; },
      (data: typeof before) => { delete data.runtime; },
    ]) {
      const corrupt = structuredClone(before); change(corrupt);
      assert.throws(() => host.restore(corrupt), /TC_GAME_RUNTIME_SNAPSHOT|TC_TEST_STATE/);
      assert.deepEqual(host.snapshot(), before);
    }
  } finally { host.dispose(); }
});

test("record/replay includes author state and rolls back on final divergence", async () => {
  let diverge = false;
  const { host } = rig(counter({ divergence: () => diverge }));
  try {
    host.step(2); host.startRecording(); host.step(3);
    const trace = host.stopRecording();
    assert.equal((trace.runtime!.initial.payload as { count: number }).count, 2);
    assert.equal((trace.runtime!.final.payload as { count: number }).count, 5);
    host.step(4);
    assert.equal(host.replay(trace).status, "passed");
    assert.equal(count(host), 5);
    assert.equal((await host.replayAsync(trace)).status, "passed");
    host.step(); const before = host.snapshot(); diverge = true;
    assert.equal(host.replay(trace).status, "failed");
    assert.deepEqual(host.snapshot(), before);
    assert.equal((await host.replayAsync(trace)).status, "failed");
    assert.deepEqual(host.snapshot(), before);
    const corrupt = structuredClone(trace); corrupt.runtime!.final.payload = { count: 777 };
    diverge = false;
    assert.equal(host.replay(corrupt).status, "failed");
    assert.deepEqual(host.snapshot(), before);
    assert.ok(host.inspect().diagnostics.some(d => d.code === "TC_REPLAY_DIVERGENCE"));
  } finally { host.dispose(); }
});

test("async initialization gates synchronous updates and async stepping awaits dependencies", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const { host, game } = rig({ version: "1", async create(scope) {
    await gate; scope.signal.throwIfAborted();
    return counter().create(scope);
  } });
  try {
    assert.equal(game.status, "initializing");
    assert.throws(() => host.step(), /TC_GAME_RUNTIME_NOT_READY/);
    assert.equal(host.inspect().scheduler.tick, 0);
    assert.throws(() => host.snapshot(), /TC_GAME_RUNTIME_NOT_READY/);
    const pending = host.stepAsync(2);
    resolve(); await pending;
    assert.equal(game.status, "ready"); assert.equal(count(host), 2);
  } finally { host.dispose(); }
});

test("scope releases in reverse order, continues after errors and disposes only once", () => {
  const released: string[] = [];
  let signal!: AbortSignal;
  const { host, game } = rig({ version: "1", create(scope) {
    signal = scope.signal;
    scope.defer(() => { released.push("first"); });
    scope.defer(() => { released.push("second"); throw new Error("release failed"); });
    return { systems: { counter() {} }, dispose() { released.push("runtime"); } };
  } });
  assert.throws(() => host.dispose(), /TC_RUNTIME_DISPOSE/);
  game.dispose(); host.dispose();
  assert.deepEqual(released, ["runtime", "second", "first"]);
  assert.equal(signal.aborted, true);
});

test("initialization failure releases resources; cancelled async results are also released", async () => {
  const released: string[] = [];
  const failed = rig({ version: "1", create(scope) {
    scope.defer(() => { released.push("failed"); }); throw new Error("broken dependency");
  } });
  await assert.rejects(failed.game.ready!, /TC_GAME_RUNTIME_INIT.*broken dependency/);
  assert.throws(() => failed.host.step(), /TC_GAME_RUNTIME_INIT/);
  failed.host.dispose();
  let resolve!: (state: GameRuntimeState) => void;
  let late!: () => void;
  const cancelled = rig({ version: "1", create(scope) {
    scope.defer(() => { released.push("cancelled"); });
    late = () => scope.defer(() => { released.push("late defer"); });
    return new Promise(done => { resolve = done; });
  } });
  cancelled.host.dispose(); late();
  resolve({ dispose() { released.push("late result"); } });
  await assert.rejects(cancelled.game.ready!, /TC_GAME_RUNTIME_INIT/);
  assert.deepEqual(released, ["failed", "cancelled", "late defer", "late result"]);
});

test("runtime rejects missing/undeclared bindings, partial state hooks and async system returns", async () => {
  for (const state of [
    {}, { systems: { wrong() {} } }, { systems: { counter() {} }, snapshot: () => null },
    { systems: { async counter() {} } },
  ] as GameRuntimeState[]) {
    const { host, game } = rig({ version: "1", create: () => state });
    await assert.rejects(game.ready!, /TC_GAME_RUNTIME_INIT/); host.dispose();
  }
  const { host } = rig({ version: "1", create: () => ({ systems: {
    counter: (() => Promise.resolve()) as unknown as (ctx: unknown, dt: number) => void,
  } }) });
  try {
    assert.throws(() => host.step(), /TC_GAME_RUNTIME_ASYNC/);
    assert.equal(host.inspect().diagnostics.at(-1)?.source?.file, "game.ts");
    assert.equal(host.inspect().diagnostics.at(-1)?.system, "counter");
  } finally { host.dispose(); }
});

test("author snapshots reject non-JSON data without executing accessors", () => {
  let accessed = false;
  const { host } = rig({ version: "1", create: () => ({ systems: { counter() {} },
    snapshot: () => ({ get value() { accessed = true; return 1; } }) as JsonValue,
    validateSnapshot() {}, restore() {},
  }) });
  try { assert.throws(() => host.snapshot(), /TC_STATE_JSON/); assert.equal(accessed, false); }
  finally { host.dispose(); }
});

test("scope own deduplicates objects and binds disposal to the resource", () => {
  const order: number[] = [];
  const { host } = rig({ version: "1", create(scope) {
    const a = { value: 1, dispose() { order.push(this.value); } };
    assert.equal(scope.own(a), a); scope.own(a);
    scope.defer(() => { order.push(2); });
    scope.own({ dispose() { order.push(3); } });
    return { systems: { counter() {} } };
  } });
  host.dispose(); assert.deepEqual(order, [3, 2, 1]);
});

test("plugin restore failure also rolls back author state and rollback failures are explicit", () => {
  let sidecar = 0;
  let rejectRollback = false;
  const plugin: RuntimePluginFactory = () => ({
    id: "failing-sidecar", snapshot: () => sidecar, validateSnapshot() {},
    restore(value) { sidecar = Number(value); if (value === 1 || rejectRollback) throw new Error("TC_TEST_PLUGIN_RESTORE"); },
    dispose() {},
  });
  const { host } = rig(counter(), [plugin]);
  try {
    host.step(); sidecar = 1; const target = host.snapshot();
    host.step(); sidecar = 2; const before = host.snapshot();
    assert.throws(() => host.restore(target), /previous state restored/);
    assert.deepEqual(host.snapshot(), before);
    rejectRollback = true;
    assert.throws(() => host.restore(target), /partialState=true.*rollback failures/);
    assert.equal(host.inspect().diagnostics.at(-1)?.partialState, true);
  } finally { host.dispose(); }
});

test("async initialization failure is observable in host diagnostics without advancing", async () => {
  const { host } = rig({ version: "1", async create(scope) {
    scope.defer(() => {});
    await Promise.resolve(); throw new Error("TC_DEPENDENCY_FAILURE: initialization failed");
  } });
  try {
    await assert.rejects(host.stepAsync(), /TC_GAME_RUNTIME_INIT/);
    assert.equal(host.inspect().scheduler.tick, 0);
    assert.equal(host.inspect().diagnostics.at(-1)?.code, "TC_GAME_RUNTIME_INIT");
  } finally { host.dispose(); }
});

test("a payload at the JSON size limit can restore through its runtime envelope", () => {
  const text = "x".repeat(65520);
  let restored = "";
  const { host } = rig({ version: "1", create: () => ({ systems: { counter() {} },
    snapshot: () => text, validateSnapshot(value) { assert.equal(typeof value, "string"); },
    restore(value) { restored = value as string; },
  }) });
  try { const checkpoint = host.snapshot(); host.restore(checkpoint); assert.equal(restored, text); }
  finally { host.dispose(); }
});

test("host enforces build-visible factory version before acquiring resources", () => {
  const definition = ir(); definition.runtime = { version: "compiled-v2" };
  const host = new RuntimeHost(definition);
  let created = false;
  try {
    assert.throws(() => instantiateGame(defineGame({
      id: "lifecycle", scene: defineScene({ id: "main", entities: [] }), systems: [system],
      runtime: { version: "stale-v1", create() { created = true; return {}; } },
    }), host.facade), /TC_GAME_RUNTIME_CONTRACT/);
    assert.equal(created, false);
  } finally { host.dispose(); }
});
