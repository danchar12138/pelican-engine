import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeHost, type HostTrace } from "../packages/runtime/src/host.ts";
import {
  createScheduler,
  type RuntimeScheduler,
  type SchedulerTrace,
} from "../packages/runtime/src/scheduler.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import type { RuntimePluginFactory } from "../packages/runtime/src/plugins.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import { createRenderSettingsDriver } from "../packages/runtime/src/render-settings.ts";
import {
  SDK_VERSION,
  defineComponent,
  defineGame,
  defineScene,
  defineSystem,
  instantiateGame,
  type ComputeService,
  type ComputeBufferHandle,
  type SystemDefinition,
} from "../packages/sdk/src/index.ts";

const Counter = defineComponent({
  id: "Counter",
  schema: { value: { type: "number", default: 0 } },
});
const source = { file: "async-game.ts", line: 1, column: 1, length: 1 };
const transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
} as const;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("cached nested render effect services cannot mutate across a pending async tick", async () => {
  const gate = deferred();
  const render = createRenderSettingsDriver();
  const rig = hostRig({ compute: false, extraPlugins: [render.factory, () => ({ id: "deferred-render-boundary", snapshot: () => null, validateSnapshot() {}, restore() {}, dispose() {}, settle: () => gate.promise })] });
  const cached = rig.host.facade.render.effects;
  const cachedBuffers = rig.host.facade.render.buffers;
  const cachedTextures = rig.host.facade.render.textures;
  const cachedEffectTextures = cached.textures;
  assert.equal(cached, rig.host.facade.render.effects);
  assert.equal(cachedTextures, rig.host.facade.render.textures);
  assert.equal(cachedEffectTextures, cached.textures);
  const pending = rig.host.stepAsync(1);
  assert.throws(() => cached.resetHistory(), /TC_RUNTIME_ASYNC_ACTIVE/);
  assert.throws(() => cachedBuffers.state("missing"), /TC_RUNTIME_ASYNC_ACTIVE/);
  assert.throws(() => cachedTextures.state("missing"), /TC_RUNTIME_ASYNC_ACTIVE/);
  assert.throws(() => cachedEffectTextures.state("missing"), /TC_RUNTIME_ASYNC_ACTIVE/);
  assert.throws(() => cachedTextures.unbind("missing", "slot"), /TC_RUNTIME_ASYNC_ACTIVE/);
  assert.throws(() => cachedEffectTextures.unbind("missing", "slot"), /TC_RUNTIME_ASYNC_ACTIVE/);
  gate.resolve();
  await pending;
  assert.doesNotThrow(() => cached.resetHistory());
  assert.throws(() => cachedBuffers.state("missing"), /TC_RENDER_BUFFER_/);
  assert.throws(() => cachedTextures.state("missing"), /TC_RENDER_TEXTURE_/);
  assert.throws(() => cachedEffectTextures.state("missing"), /TC_POSTPROCESS_|TC_RENDER_TEXTURE_/);
  rig.host.dispose();
});

function schedulerRig(
  options: {
    deferredFeedback?: boolean;
    feedback?: boolean;
    pauseAt?: number;
    failAt?: number;
    fixedDt?: number;
  } = {},
) {
  const world = createWorld({
    components: [Counter],
    entities: [{ id: "root", components: { Counter: { value: 0 } } }],
  });
  let mirror = 0,
    pending = 0;
  let scheduler!: RuntimeScheduler;
  scheduler = createScheduler({
    world,
    seed: 17,
    fixedDt: options.fixedDt ?? 0.1,
    maxSubsteps: 2,
    systems: [
      {
        id: "counter",
        reads: ["Counter"],
        writes: ["Counter"],
        structural: false,
        run() {
          if (scheduler.tick === options.failAt)
            throw new Error("TC_TEST_TICK: Failed system.");
          const input = scheduler
            .events("input")
            .reduce(
              (sum, event) =>
                sum + Number((event.payload as { amount: number }).amount),
              0,
            );
          const value =
            Number(world.getComponent("root", "Counter").value) +
            1 +
            input +
            scheduler.random() +
            (options.feedback ? mirror : 0);
          world.setComponent("root", "Counter", { value });
          pending = value * 2;
          if (!options.deferredFeedback) mirror = pending;
          if (scheduler.tick % 2 === 0) scheduler.emit("echo", { value });
          if (scheduler.tick === options.pauseAt) scheduler.pause();
        },
      },
    ],
  });
  return {
    world,
    scheduler,
    commit: () => {
      mirror = pending;
    },
    mirror: () => mirror,
  };
}

function mixedTrace(scheduler: RuntimeScheduler): SchedulerTrace {
  scheduler.startRecording();
  scheduler.emit("input", { amount: 3 });
  scheduler.random();
  scheduler.step(3);
  scheduler.advance(scheduler.inspect().fixedDt * 7.25);
  scheduler.pause();
  scheduler.step(4);
  scheduler.advance(5);
  scheduler.random();
  scheduler.emit(
    "input",
    { amount: 8 },
    { tick: scheduler.tick + 2, source: "input" },
  );
  scheduler.resume();
  scheduler.advance(0);
  scheduler.advance(scheduler.inspect().fixedDt * 0.1);
  scheduler.step(2);
  scheduler.advance(0);
  return scheduler.stopRecording();
}

for (const fixedDt of [0.1, 1 / 60]) {
  test(`async scheduler preserves every action, backlog and compensation at dt=${fixedDt}`, async () => {
    const original = schedulerRig({ fixedDt });
    const trace = mixedTrace(original.scheduler);
    const sync = schedulerRig({ fixedDt }),
      async = schedulerRig({ fixedDt });
    const syncResult = sync.scheduler.replay(trace);
    const seen: number[] = [];
    const result = await async.scheduler.replayAsync(trace, async () => {
      seen.push(async.scheduler.tick);
      await Promise.resolve();
    });
    assert.deepEqual(result, syncResult);
    assert.equal(result.status, "passed");
    assert.equal(result.actionsExecuted, trace.actions.length);
    assert.deepEqual(async.scheduler.snapshot(), trace.final);
    assert.deepEqual(async.scheduler.snapshot(), sync.scheduler.snapshot());
    assert.deepEqual(
      seen,
      Array.from({ length: trace.final.tick }, (_, index) => index + 1),
    );
    assert.ok(trace.final.accumulator > 0);
    assert.ok(trace.actions.some((action) => action.kind === "advance"));
  });
}

test("async replay commits output feedback between every step-N and advance substep", async () => {
  const original = schedulerRig({ feedback: true });
  const trace = mixedTrace(original.scheduler);
  const target = schedulerRig({ feedback: true, deferredFeedback: true });
  let settled = 0;
  const result = await target.scheduler.replayAsync(trace, async () => {
    await Promise.resolve();
    target.commit();
    settled++;
  });
  assert.equal(result.status, "passed");
  assert.equal(settled, trace.final.tick);
  assert.equal(target.mirror(), original.mirror());
  assert.deepEqual(target.scheduler.snapshot(), trace.final);
});

test("paused and zero-execution actions never invoke afterTick", async () => {
  const original = schedulerRig();
  original.scheduler.startRecording();
  original.scheduler.step(0);
  original.scheduler.advance(0.01);
  original.scheduler.pause();
  original.scheduler.step(10);
  original.scheduler.advance(20);
  original.scheduler.resume();
  const trace = original.scheduler.stopRecording();
  let settled = 0;
  const target = schedulerRig();
  assert.equal(
    (
      await target.scheduler.replayAsync(trace, async () => {
        settled++;
      })
    ).status,
    "passed",
  );
  assert.equal(settled, 0);
  assert.deepEqual(target.scheduler.snapshot(), trace.final);
});

test("internal pauses, emissions and RNG retain ordinary recording semantics", async () => {
  const original = schedulerRig({ pauseAt: 2 });
  original.scheduler.startRecording();
  original.scheduler.advance(1);
  original.scheduler.resume();
  original.scheduler.step(2);
  const trace = original.scheduler.stopRecording();
  assert.deepEqual(
    trace.actions.map((action) => action.kind),
    ["advance", "resume", "step"],
  );
  const target = schedulerRig({ pauseAt: 2 });
  let settled = 0;
  assert.equal(
    (
      await target.scheduler.replayAsync(trace, async () => {
        settled++;
      })
    ).status,
    "passed",
  );
  assert.equal(settled, 4);
  assert.deepEqual(target.scheduler.snapshot(), trace.final);
});

test("scheduler async preflight rejects late malformed actions before any writes", async () => {
  const original = schedulerRig();
  const trace = mixedTrace(original.scheduler);
  const target = schedulerRig();
  target.scheduler.step(2);
  const before = target.scheduler.snapshot(),
    handle = target.world.resolve("root");
  for (const mutate of [
    (data: SchedulerTrace) => {
      data.actions.push({ kind: "step", count: -1, atTick: 0 });
    },
    (data: SchedulerTrace) => {
      data.final.random.state = -1;
    },
    (data: SchedulerTrace) => {
      data.final.accumulator = -1;
    },
    (data: SchedulerTrace) => {
      data.initial.world.entities[0].parent = "missing";
    },
  ]) {
    const invalid = structuredClone(trace);
    mutate(invalid);
    await assert.rejects(
      target.scheduler.replayAsync(invalid, async () => {
        assert.fail("settled during preflight");
      }),
    );
    assert.deepEqual(target.scheduler.snapshot(), before);
    assert.equal(target.world.isAlive(handle), true);
  }
});

test("scheduler live replay blocks mutations and reentrancy throughout awaits", async () => {
  const original = schedulerRig(),
    trace = mixedTrace(original.scheduler);
  const target = schedulerRig(),
    gate = deferred();
  let calls = 0;
  const pending = target.scheduler.replayAsync(trace, async () => {
    calls++;
    assert.throws(() => target.scheduler.pause(), /TC_SCHEDULER_ASYNC_ACTIVE/);
    if (calls === 1) await gate.promise;
  });
  const state = target.scheduler.inspect();
  assert.equal(state.replaying, true);
  assert.equal(state.asyncActive, true);
  for (const mutate of [
    () => target.scheduler.step(),
    () => target.scheduler.advance(1),
    () => target.scheduler.resume(),
    () => target.scheduler.random(),
    () => target.scheduler.emit("injected", {}),
    () => target.scheduler.events.on("injected", () => {}),
    () => target.scheduler.restore(trace.initial),
    () => target.scheduler.setSystems([]),
    () => target.scheduler.startRecording(),
    () => target.scheduler.cancelRecording(),
    () => target.scheduler.stopRecording(),
    () => target.scheduler.replay(trace),
  ])
    assert.throws(mutate, /TC_SCHEDULER_ASYNC_ACTIVE/);
  await assert.rejects(
    target.scheduler.replayAsync(trace, async () => {}),
    /TC_SCHEDULER_ASYNC_ACTIVE/,
  );
  assert.deepEqual(target.scheduler.inspect(), state);
  gate.resolve();
  assert.equal((await pending).status, "passed");
  assert.equal(target.scheduler.inspect().replaying, false);
});

for (const failure of ["throw", "reject"] as const) {
  test(`scheduler ${failure} from settle faults deterministically without executing the next tick`, async () => {
    const original = schedulerRig(),
      trace = mixedTrace(original.scheduler);
    const target = schedulerRig();
    const result = await target.scheduler.replayAsync(trace, () => {
      if (failure === "throw") throw new Error("TC_TEST_SETTLE");
      return Promise.reject(new Error("TC_TEST_SETTLE"));
    });
    assert.equal(result.status, "failed");
    assert.equal(result.fault?.code, "TC_SCHEDULER_SETTLE");
    assert.equal(result.fault?.tick, 1);
    assert.equal(result.fault?.stage, "settle");
    assert.equal(result.actionsExecuted, 2);
    assert.equal(target.scheduler.tick, 1);
    assert.equal(target.scheduler.step().executed, 0);
    assert.throws(() => target.scheduler.snapshot(), /TC_SCHEDULER_FAULT/);
    target.scheduler.restore(trace.initial);
    assert.equal(target.scheduler.step().executed, 1);
  });
}

test("failed system ticks are not settled and preserve scheduler fault details", async () => {
  const original = schedulerRig(),
    trace = mixedTrace(original.scheduler);
  const target = schedulerRig({ failAt: 2 });
  const seen: number[] = [];
  const result = await target.scheduler.replayAsync(trace, async () => {
    seen.push(target.scheduler.tick);
  });
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "TC_SCHEDULER_TICK");
  assert.equal(result.fault?.stage, "system:counter");
  assert.deepEqual(seen, [1]);
  assert.equal(target.scheduler.tick, 1);
});

test("scheduler disposal invalidates a late settle without another tick or fault mutation", async () => {
  const original = schedulerRig(),
    trace = mixedTrace(original.scheduler);
  const target = schedulerRig(),
    gate = deferred();
  const pending = target.scheduler.replayAsync(trace, () => gate.promise);
  target.scheduler.dispose();
  const disposed = target.scheduler.inspect();
  gate.resolve();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.fault!.message, /TC_SCHEDULER_DISPOSED/);
  assert.equal(target.scheduler.tick, 1);
  assert.equal(target.scheduler.inspect().fault, disposed.fault);
  assert.equal(target.scheduler.inspect().replaying, false);
});

test("async replay preserves event-listener faults and never settles the failed tick", async () => {
  const original = schedulerRig(),
    target = schedulerRig();
  original.scheduler.events.on("input", () => {}, { id: "input-listener" });
  target.scheduler.events.on(
    "input",
    () => {
      throw new Error("TC_TEST_LISTENER");
    },
    { id: "input-listener" },
  );
  const trace = mixedTrace(original.scheduler);
  let calls = 0;
  const result = await target.scheduler.replayAsync(trace, async () => {
    calls++;
  });
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "TC_SCHEDULER_LISTENER");
  assert.equal(result.fault?.eventFaults[0].listener, "input-listener");
  assert.equal(target.scheduler.tick, 0);
  assert.equal(calls, 0);
});

test("async replay diagnoses valid-shaped RNG and final-state divergences", async () => {
  const original = schedulerRig(),
    trace = mixedTrace(original.scheduler);
  for (const mutate of [
    (data: SchedulerTrace) => {
      const action = data.actions.find((action) => action.kind === "random")!;
      if (action.kind === "random") action.value = (action.value + 0.5) % 1;
    },
    (data: SchedulerTrace) => {
      data.final.world.entities[0].components.Counter.value = -1;
    },
  ]) {
    const invalid = structuredClone(trace);
    mutate(invalid);
    const target = schedulerRig();
    const result = await target.scheduler.replayAsync(invalid, async () => {});
    assert.equal(result.status, "failed");
    assert.equal(result.fault?.code, "TC_REPLAY_DIVERGENCE");
    assert.equal(target.scheduler.inspect().replaying, false);
  }
});

test("async replay callback validation is atomic", async () => {
  const original = schedulerRig(),
    trace = mixedTrace(original.scheduler),
    target = schedulerRig();
  const before = target.scheduler.snapshot();
  await assert.rejects(
    target.scheduler.replayAsync(
      trace,
      undefined as unknown as () => Promise<void>,
    ),
    /TC_SCHEDULER_ARGUMENT/,
  );
  assert.deepEqual(target.scheduler.snapshot(), before);
});

interface ComputeControl {
  gate?: () => Promise<void>;
  onSettle?: () => void;
  failure?: string;
  lost: boolean;
  disposed: boolean;
  settles: number;
  commits: number;
  restores: number;
  worldChecks: number;
}
let ownerSerial = 0;
function fakeCompute(control: ComputeControl): RuntimePluginFactory {
  return () => {
    const owner = ++ownerSerial;
    let generation = 0,
      mirror = 0,
      revision = 0,
      pending: number | undefined;
    let taskStatus: "queued" | "succeeded" | "cancelled" = "succeeded";
    const handle = () => ({ owner, index: 0, generation });
    const check = (buffer: ComputeBufferHandle) => {
      if (
        buffer.owner !== owner ||
        buffer.generation !== generation ||
        buffer.index !== 0
      )
        throw new Error(
          "TC_TEST_HANDLE: Resolve buffer by name after restore.",
        );
    };
    const textureUnavailable = (): never => { throw new Error("TC_TEST_TEXTURE: This boundary fixture exercises buffer access only."); };
    const service: ComputeService = {
      createTexture: textureUnavailable, resolveTexture: textureUnavailable, describeTexture: textureUnavailable,
      readTexture: textureUnavailable, writeTexture: textureUnavailable, releaseTexture: textureUnavailable,
      createBuffer: () => handle(),
      resolve(id) {
        assert.equal(id, "feedback");
        return handle();
      },
      describeBuffer(buffer) {
        check(buffer);
        return { id: "feedback", type: "float", count: 1, revision };
      },
      readBuffer(buffer) {
        check(buffer);
        return [mirror];
      },
      writeBuffer(buffer, data) {
        check(buffer);
        mirror = Number(data[0]);
        revision++;
      },
      releaseBuffer(buffer) {
        check(buffer);
        generation++;
      },
      dispatch(_kernel, input) {
        check(input.output);
        assert.equal(
          pending,
          undefined,
          "the preceding tick must have settled",
        );
        pending = Number(input.parameters!.value);
        taskStatus = "queued";
        return { owner, id: revision };
      },
      task: () => ({ status: taskStatus }),
      tasks: () => [],
      cancel() {
        taskStatus = "cancelled";
      },
      releaseTask() {},
    };
    return {
      id: "compute",
      version: "1",
      services: { compute: service },
      snapshot() {
        assert.equal(pending, undefined);
        return { mirror, revision, entity: "root" };
      },
      validateSnapshot(value) {
        const data = value as { mirror: number; revision: number };
        if (
          !data ||
          !Number.isFinite(data.mirror) ||
          !Number.isSafeInteger(data.revision) ||
          data.revision < 0
        )
          throw new Error("TC_TEST_PLUGIN_SNAPSHOT");
      },
      validateWorld(value, world) {
        control.worldChecks++;
        if (
          !world.entities.some(
            (entity) => entity.id === (value as { entity: string }).entity,
          )
        )
          throw new Error("TC_TEST_PLUGIN_WORLD");
      },
      restore(value) {
        control.restores++;
        const data = value as { mirror: number; revision: number };
        mirror = data.mirror;
        revision = data.revision;
        pending = undefined;
        generation++;
      },
      inspect: () => ({ mirror, revision, pending: pending ?? null }),
      async settle() {
        control.settles++;
        control.onSettle?.();
        await (control.gate?.() ?? Promise.resolve());
        if (
          control.disposed ||
          control.lost ||
          control.failure ||
          taskStatus === "cancelled"
        )
          throw new Error(
            control.failure ??
              (control.lost ? "TC_TEST_DEVICE_LOST" : "TC_TEST_CANCELLED"),
          );
        if (pending !== undefined) {
          mirror = pending;
          pending = undefined;
          revision++;
          control.commits++;
          taskStatus = "succeeded";
        }
      },
      dispose() {
        control.disposed = true;
        generation++;
        pending = undefined;
      },
    };
  };
}

function hostRig(
  options: {
    compute?: boolean;
    failure?: boolean;
    attached?: boolean;
    extraPlugins?: RuntimePluginFactory[];
  } = {},
) {
  const control: ComputeControl = {
    lost: false,
    disposed: false,
    settles: 0,
    commits: 0,
    restores: 0,
    worldChecks: 0,
  };
  const system = defineSystem({
    id: "feedback",
    reads: ["Counter"],
    writes: ["Counter"],
    structural: false,
    run(ctx) {
      if (options.failure) throw new Error("TC_TEST_SYSTEM: Failed tick.");
      const input = ctx
        .events("input.amount")
        .reduce(
          (sum, event) =>
            sum + Number((event.payload as { amount: number }).amount),
          0,
        );
      const buffer =
        options.compute === false ? undefined : ctx.compute.resolve("feedback");
      const mirror = buffer ? Number(ctx.compute.readBuffer(buffer)[0]) : 0;
      const value =
        ctx.getComponent("root", Counter).value +
        1 +
        mirror +
        input +
        ctx.random();
      ctx.setComponent("root", Counter, { value });
      if (buffer)
        ctx.compute.dispatch("double", {
          output: buffer,
          parameters: { value: value * 2 },
        });
    },
  });
  const systems: SystemDefinition[] = [system];
  const ir: SceneIR = {
    format: "pelican.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "async-test",
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
        { id: "root", transform, components: { Counter: { value: 0 } } },
      ],
    },
    components: [{ id: Counter.id, schema: Counter.schema, source }],
    systems: systems.map((system) => ({
      id: system.id,
      phase: system.phase ?? "update",
      source,
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
  const host = new RuntimeHost(ir, {
    plugins: [
      ...(options.compute === false ? [] : [fakeCompute(control)]),
      ...(options.extraPlugins ?? []),
    ],
  });
  const game = instantiateGame(
    defineGame({
      id: ir.gameId,
      scene: defineScene({ id: "scene", entities: [] }),
      systems,
    }),
    host.facade,
  );
  if (options.attached !== false) host.attach(game);
  return { host, control, game };
}

async function recordedHost() {
  const rig = hostRig();
  rig.host.startRecording();
  rig.host.emitExternal("input.amount", { amount: 2 });
  rig.host.facade.random();
  await rig.host.stepAsync(3);
  rig.host.input("go", true);
  await rig.host.stepAsync(2);
  return { ...rig, trace: rig.host.stopRecording() };
}

test("host records ordinary steps and committed mirrors, then replays across owners and invalid generations", async () => {
  const original = await recordedHost(),
    target = hostRig();
  const stale = target.host.facade.compute.resolve("feedback");
  assert.deepEqual(
    original.trace.actions
      .filter((action) => action.kind === "step")
      .map((action) => action.count),
    [1, 1, 1, 1, 1],
  );
  assert.equal(
    (original.trace.plugins!.final.compute.payload as { revision: number })
      .revision,
    5,
  );
  assert.equal(
    (await target.host.replayAsync(original.trace)).status,
    "passed",
  );
  assert.deepEqual(target.host.snapshot(), original.host.snapshot());
  assert.equal(target.control.settles, 5);
  assert.equal(target.control.commits, 5);
  assert.equal(target.control.worldChecks, 2);
  assert.throws(
    () => target.host.facade.compute.readBuffer(stale),
    /TC_TEST_HANDLE/,
  );
  const saved = target.host.snapshot();
  target.host.restore(saved);
  assert.equal(
    (await target.host.replayAsync(original.trace)).status,
    "passed",
  );
  assert.deepEqual(target.host.snapshot(), original.host.snapshot());
  original.host.dispose();
  target.host.dispose();
});

test("sync replay refuses settle plugins before world, handles or sidecars change", async () => {
  const { host, control, trace } = await recordedHost();
  const before = host.snapshot(),
    handle = host.world.resolve("root"),
    buffer = host.facade.compute.resolve("feedback");
  assert.deepEqual(host.replay(trace), {
    status: "failed",
    actionsExecuted: 0,
    fault: null,
  });
  assert.equal(
    host.inspect().diagnostics.at(-1)!.code,
    "TC_RUNTIME_REPLAY_ASYNC_REQUIRED",
  );
  assert.deepEqual(host.snapshot(), before);
  assert.equal(host.world.isAlive(handle), true);
  assert.doesNotThrow(() => host.facade.compute.readBuffer(buffer));
  assert.equal(control.restores, 0);
  host.dispose();
});

test("host async replay settles grouped steps and advances while skipping paused operations", async () => {
  const original = await recordedHost(),
    target = hostRig();
  const trace = structuredClone(original.trace);
  const steps = trace.actions
    .map((action, index) => (action.kind === "step" ? index : -1))
    .filter((index) => index >= 0);
  trace.actions.splice(
    steps[3],
    2,
    { kind: "pause", atTick: 3 },
    { kind: "step", count: 20, atTick: 3 },
    { kind: "advance", seconds: 10, atTick: 3 },
    { kind: "resume", atTick: 3 },
    { kind: "advance", seconds: trace.initial.fixedDt * 2, atTick: 3 },
  );
  trace.actions.splice(steps[0], 3, { kind: "step", count: 3, atTick: 0 });
  assert.equal((await target.host.replayAsync(trace)).status, "passed");
  assert.equal(target.control.settles, 5);
  assert.equal(target.control.commits, 5);
  assert.deepEqual(target.host.snapshot(), original.host.snapshot());
  original.host.dispose();
  target.host.dispose();
});

test("host sync stepping remains an explicit synchronous engine boundary", async () => {
  const { host, control } = hostRig();
  host.step();
  assert.equal(host.inspect().scheduler.tick, 1);
  assert.equal(control.settles, 0);
  assert.equal(control.commits, 0);
  await assert.rejects(host.stepAsync(), /TC_RUNTIME_SYSTEM/);
  assert.equal(control.settles, 0);
  host.dispose();
});

test("hosts without settle plugins retain sync/async step and replay parity", async () => {
  const sync = hostRig({ compute: false }),
    async = hostRig({ compute: false });
  sync.host.startRecording();
  async.host.startRecording();
  sync.host.step(3);
  await async.host.stepAsync(3);
  assert.deepEqual(sync.host.stopRecording(), async.host.stopRecording());
  sync.host.startRecording();
  sync.host.step(2);
  const trace = sync.host.stopRecording();
  assert.equal(sync.host.replay(trace).status, "passed");
  assert.equal((await async.host.replayAsync(trace)).status, "passed");
  assert.deepEqual(sync.host.snapshot(), async.host.snapshot());
  sync.host.dispose();
  async.host.dispose();
});

test("host async count and attachment validation matches synchronous step", async () => {
  const { host } = hostRig({ compute: false });
  for (const count of [0, -1, 1.5, NaN, Infinity, 10001]) {
    assert.throws(() => host.step(count), /TC_RUNTIME_STEPS/);
    await assert.rejects(host.stepAsync(count), /TC_RUNTIME_STEPS/);
  }
  assert.equal(host.inspect().scheduler.tick, 0);
  host.dispose();
  const unattached = hostRig({ attached: false });
  await assert.rejects(unattached.host.stepAsync(), /TC_RUNTIME_NOT_ATTACHED/);
  unattached.host.dispose();
});

test("host preflights the entire trace and both plugin/world endpoints atomically", async () => {
  const { host, control, trace } = await recordedHost();
  const before = host.snapshot(),
    handle = host.world.resolve("root");
  for (const mutate of [
    (data: HostTrace) => {
      data.actions.push({ kind: "step", count: -1, atTick: 0 });
    },
    (data: HostTrace) => {
      data.final.world.entities[0].parent = "absent";
    },
    (data: HostTrace) => {
      (data.plugins!.initial.compute.payload as { mirror: number }).mirror =
        NaN;
    },
    (data: HostTrace) => {
      data.plugins!.final.compute.version = "wrong";
    },
    (data: HostTrace) => {
      (data.plugins!.final.compute.payload as { entity: string }).entity =
        "absent";
    },
    (data: HostTrace) => {
      delete data.plugins;
    },
  ]) {
    const invalid = structuredClone(trace);
    mutate(invalid);
    assert.equal((await host.replayAsync(invalid)).status, "failed");
    assert.deepEqual(host.snapshot(), before);
    assert.equal(host.world.isAlive(handle), true);
    assert.equal(control.restores, 0);
    assert.equal(control.settles, 5);
  }
  host.startRecording();
  assert.equal((await host.replayAsync(trace)).status, "failed");
  assert.equal(control.restores, 0);
  host.cancelRecording();
  host.dispose();
});

test("host validates all plugins before restoring any plugin", async () => {
  let restores = 0;
  const extra: RuntimePluginFactory = () => ({
    id: "second",
    snapshot: () => 1,
    validateSnapshot(value) {
      if (value !== 1) throw new Error("TC_TEST_SECOND_PLUGIN");
    },
    restore() {
      restores++;
    },
    dispose() {},
  });
  const { host, control } = hostRig({ extraPlugins: [extra] });
  host.startRecording();
  await host.stepAsync();
  const trace = host.stopRecording(),
    before = host.snapshot();
  trace.plugins!.final.second.payload = 2;
  assert.equal((await host.replayAsync(trace)).status, "failed");
  assert.deepEqual(host.snapshot(), before);
  assert.equal(control.restores, 0);
  assert.equal(restores, 0);
  host.dispose();
});

test("host replay checks final sidecars even when scheduler/world replay matches", async () => {
  const { host, trace } = await recordedHost();
  (trace.plugins!.final.compute.payload as { mirror: number }).mirror++;
  assert.equal((await host.replayAsync(trace)).status, "failed");
  assert.equal(host.inspect().diagnostics.at(-1)!.code, "TC_REPLAY_DIVERGENCE");
  assert.match(
    host.inspect().diagnostics.at(-1)!.message,
    /Final plugin state differs/,
  );
  host.dispose();
});

for (const operation of ["step", "replay"] as const) {
  test(`host pending async ${operation} rejects overlap, facade/world/service mutations and recording cancellation`, async () => {
    const recorded = await recordedHost();
    const { host, control, game } = hostRig(),
      gate = deferred();
    const service = host.facade.compute,
      buffer = service.resolve("feedback");
    const write = service.writeBuffer;
    control.gate = () => gate.promise;
    control.onSettle = () => {
      assert.throws(() => host.step(), /TC_RUNTIME_ASYNC_ACTIVE/);
    };
    const pending =
      operation === "step"
        ? host.stepAsync(2)
        : host.replayAsync(recorded.trace);
    const before = host.inspect();
    assert.equal(before.scheduler.tick, 1);
    assert.equal(before.scheduler.replaying, operation === "replay");
    for (const mutate of [
      () => host.step(),
      () => game.update(1 / 60),
      () => host.facade.random(),
      () => host.facade.emit("injected", {}),
      () => host.emitExternal("injected", {}),
      () => host.input("go", true),
      () => host.startRecording(),
      () => host.stopRecording(),
      () => host.cancelRecording(),
      () => host.restore(recorded.host.snapshot()),
      () => host.world.setComponent("root", "Counter", { value: 99 }),
      () => host.facade.setTransform("root", { position: [9, 9, 9] }),
      () => host.facade.entities.destroy("root"),
      () => host.world.flush(),
      () => host.world.runSystem("injected", {}, () => {}),
      () => write(buffer, [99]),
      () => host.replay(recorded.trace),
    ])
      assert.throws(mutate, /TC_RUNTIME_ASYNC_ACTIVE/);
    await assert.rejects(host.stepAsync(), /TC_RUNTIME_ASYNC_ACTIVE/);
    await assert.rejects(
      host.replayAsync(recorded.trace),
      /TC_RUNTIME_ASYNC_ACTIVE/,
    );
    assert.deepEqual(host.inspect(), before);
    gate.resolve();
    const result = await pending;
    if (operation === "replay") assert.equal(result!.status, "passed");
    assert.equal(host.inspect().scheduler.tick, operation === "step" ? 2 : 5);
    recorded.host.dispose();
    host.dispose();
  });
}

test("host settles each plugin after each successful tick in registration order", async () => {
  const order: string[] = [],
    gate = deferred();
  const extra: RuntimePluginFactory = () => ({
    id: "second",
    snapshot: () => null,
    validateSnapshot() {},
    restore() {},
    async settle() {
      order.push("second");
    },
    dispose() {},
  });
  const { host, control } = hostRig({ extraPlugins: [extra] });
  control.onSettle = () => {
    order.push("compute");
  };
  control.gate = () => gate.promise;
  const pending = host.stepAsync(2);
  assert.deepEqual(order, ["compute"]);
  gate.resolve();
  await pending;
  assert.deepEqual(order, ["compute", "second", "compute", "second"]);
  host.dispose();
});

test("host system faults do not settle and keep source diagnostics", async () => {
  const { host, control } = hostRig({ failure: true });
  await assert.rejects(host.stepAsync(2), /TC_RUNTIME_SYSTEM/);
  assert.equal(control.settles, 0);
  assert.equal(host.inspect().scheduler.tick, 0);
  assert.equal(host.inspect().diagnostics.at(-1)!.system, "feedback");
  assert.deepEqual(host.inspect().diagnostics.at(-1)!.source, source);
  host.dispose();
});

for (const failure of ["reject", "loss", "cancel"] as const) {
  test(`host settle ${failure} stops stepping with a stable partial-state fault and permits checkpoint recovery`, async () => {
    const { host, control } = hostRig(),
      before = host.snapshot();
    if (failure === "reject") control.failure = "TC_TEST_FAILURE";
    if (failure === "loss") control.lost = true;
    if (failure === "cancel")
      control.onSettle = () => {
        control.failure = "TC_TEST_CANCELLED";
      };
    await assert.rejects(host.stepAsync(3), /TC_RUNTIME_SETTLE/);
    assert.equal(host.inspect().scheduler.tick, 1);
    assert.equal(host.inspect().scheduler.fault!.code, "TC_SCHEDULER_SETTLE");
    assert.equal(host.inspect().diagnostics.at(-1)!.code, "TC_RUNTIME_SETTLE");
    assert.equal(control.commits, 0);
    assert.throws(() => host.snapshot(), /TC_SCHEDULER_FAULT/);
    control.lost = false;
    control.failure = undefined;
    control.onSettle = undefined;
    host.restore(before);
    await host.stepAsync();
    assert.equal(control.commits, 1);
    host.dispose();
  });
}

test("host replay settle failure returns failed and reports the responsible plugin", async () => {
  const { host, control, trace } = await recordedHost();
  control.failure = "TC_TEST_DEVICE_FAILURE";
  const result = await host.replayAsync(trace);
  assert.equal(result.status, "failed");
  assert.equal(result.fault?.code, "TC_SCHEDULER_SETTLE");
  assert.equal(host.inspect().scheduler.tick, 1);
  assert.equal(host.inspect().diagnostics.at(-1)!.code, "TC_RUNTIME_SETTLE");
  assert.match(host.inspect().diagnostics.at(-1)!.message, /Plugin compute/);
  host.dispose();
});

test("a synchronous settle throw is observed and prevents subsequent plugin boundaries", async () => {
  let laterSettles = 0;
  const throwing: RuntimePluginFactory = () => ({
    id: "throwing",
    snapshot: () => null,
    validateSnapshot() {},
    restore() {},
    dispose() {},
    settle() {
      throw new Error("TC_TEST_SYNC_SETTLE");
    },
  });
  const later: RuntimePluginFactory = () => ({
    id: "later",
    snapshot: () => null,
    validateSnapshot() {},
    restore() {},
    dispose() {},
    async settle() {
      laterSettles++;
    },
  });
  const { host } = hostRig({ compute: false, extraPlugins: [throwing, later] });
  await assert.rejects(host.stepAsync(2), /TC_RUNTIME_SETTLE: Plugin throwing/);
  assert.equal(host.inspect().scheduler.tick, 1);
  assert.equal(laterSettles, 0);
  assert.equal(host.inspect().diagnostics.at(-1)!.code, "TC_RUNTIME_SETTLE");
  host.dispose();
});

test("device loss while settlement is pending prevents a late commit and next tick", async () => {
  const { host, control } = hostRig(),
    gate = deferred();
  control.gate = () => gate.promise;
  const pending = host.stepAsync(3);
  assert.equal(host.inspect().scheduler.tick, 1);
  control.lost = true;
  gate.resolve();
  await assert.rejects(pending, /TC_RUNTIME_SETTLE.*TC_TEST_DEVICE_LOST/);
  assert.equal(control.commits, 0);
  assert.equal(control.settles, 1);
  assert.equal(host.inspect().scheduler.tick, 1);
  host.dispose();
});

for (const operation of ["step", "replay"] as const) {
  test(`host disposal during async ${operation} ignores late completion and never starts another tick/plugin`, async () => {
    let laterSettles = 0;
    const extra: RuntimePluginFactory = () => ({
      id: "later",
      snapshot: () => null,
      validateSnapshot() {},
      restore() {},
      async settle() {
        laterSettles++;
      },
      dispose() {},
    });
    const { host, control } = hostRig({ extraPlugins: [extra] });
    host.startRecording();
    await host.stepAsync(2);
    const trace = host.stopRecording();
    laterSettles = 0;
    const gate = deferred();
    control.gate = () => gate.promise;
    const pending =
      operation === "step" ? host.stepAsync(2) : host.replayAsync(trace);
    const tick = host.inspect().scheduler.tick,
      commits = control.commits;
    host.dispose();
    host.dispose();
    gate.resolve();
    if (operation === "step")
      await assert.rejects(pending, /TC_RUNTIME_DISPOSED/);
    else assert.equal((await pending)!.status, "failed");
    assert.equal(host.inspect().scheduler.tick, tick);
    assert.equal(host.inspect().scheduler.fault, null);
    assert.equal(host.inspect().scheduler.replaying, false);
    assert.equal(host.inspect().world.disposed, true);
    assert.equal(control.commits, commits);
    assert.equal(laterSettles, 0);
  });
}
