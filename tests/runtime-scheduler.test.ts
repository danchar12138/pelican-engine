import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorld } from "../packages/runtime/src/world.ts";
import {
  createScheduler,
  type RuntimeScheduler,
} from "../packages/runtime/src/scheduler.ts";
import { createEventBus } from "../packages/runtime/src/events.ts";
import {
  cloneSerializable,
  createRandom,
} from "../packages/runtime/src/random.ts";
import {
  SYSTEM_PHASES,
  type ScheduledSystem,
  type WorldAccess,
} from "../packages/runtime/src/contracts.ts";

const makeWorld = () =>
  createWorld({
    components: [
      { id: "Counter", schema: { value: { type: "number", default: 0 } } },
    ],
    entities: [{ id: "player", components: { Counter: { value: 0 } } }],
  });
const access = { reads: ["Counter"], writes: ["Counter"], structural: false };
const value = (world: ReturnType<typeof makeWorld>) =>
  world.getComponent("player", "Counter").value as number;
function fixture(
  options: { fixedDt?: number; maxSubsteps?: number; seed?: number } = {},
) {
  const world = makeWorld();
  let scheduler: RuntimeScheduler;
  scheduler = createScheduler({
    world,
    ...options,
    systems: [
      {
        id: "counter",
        ...access,
        run() {
          world.setComponent("player", "Counter", {
            value: value(world) + 1 + scheduler.random(),
          });
        },
      },
    ],
  });
  return { world, scheduler };
}

describe("M1 fixed-step scheduler and real World integration", () => {
  it("orders actual execution by phases then stable topological constraints", () => {
    const world = makeWorld(),
      seen: string[] = [];
    const systems: ScheduledSystem[] = [...SYSTEM_PHASES]
      .reverse()
      .map((phase) => ({
        id: phase,
        phase,
        run: () => {
          seen.push(phase);
        },
      }));
    systems.push({
      id: "first",
      phase: "update",
      before: ["update"],
      run: () => {
        seen.push("first");
      },
    });
    const scheduler = createScheduler({ world, systems });
    assert.equal(scheduler.step().status, "completed");
    assert.deepEqual(seen, [
      "input",
      "prePhysics",
      "physics",
      "postPhysics",
      "first",
      "update",
      "presentation",
    ]);
    assert.equal(scheduler.tick, 1);
    assert.equal(scheduler.time, 1 / 60);
  });
  it("allows forward cross-phase dependencies", () => {
    const scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        { id: "early", phase: "input", before: ["late"], run() {} },
        { id: "late", phase: "presentation", after: ["early"], run() {} },
      ],
    });
    assert.equal(scheduler.step().executed, 1);
  });
  for (const [label, systems, code] of [
    [
      "duplicates",
      [
        { id: "a", run() {} },
        { id: "a", run() {} },
      ],
      /TC_SCHEDULER_DUPLICATE/,
    ],
    [
      "unknown deps",
      [{ id: "a", after: ["missing"], run() {} }],
      /TC_SCHEDULER_DEPENDENCY/,
    ],
    [
      "cycles",
      [
        { id: "a", after: ["b"], run() {} },
        { id: "b", after: ["a"], run() {} },
      ],
      /TC_SCHEDULER_CYCLE/,
    ],
    [
      "self cycle",
      [{ id: "a", before: ["a"], run() {} }],
      /TC_SCHEDULER_CYCLE/,
    ],
    [
      "backwards phase",
      [
        { id: "a", phase: "update", before: ["b"], run() {} },
        { id: "b", phase: "input", run() {} },
      ],
      /TC_SCHEDULER_PHASE_ORDER/,
    ],
    [
      "invalid phase",
      [{ id: "a", phase: "unknown", run() {} }],
      /TC_SCHEDULER_PHASE/,
    ],
  ] as const)
    it(`rejects ${label} before execution`, () => {
      assert.throws(
        () =>
          createScheduler({
            world: makeWorld(),
            systems: systems as unknown as ScheduledSystem[],
          }),
        code,
      );
    });
  it("keeps a deterministic conflict order and diagnoses shared writes", () => {
    const seen: string[] = [];
    const scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "writer",
          ...access,
          run: () => {
            seen.push("writer");
          },
        },
        {
          id: "reader",
          reads: ["Counter"],
          writes: [],
          structural: false,
          run: () => {
            seen.push("reader");
          },
        },
      ],
    });
    assert.equal(
      scheduler.inspect().diagnostics[0].code,
      "TC_SCHEDULER_CONFLICT",
    );
    assert.deepEqual(scheduler.inspect().diagnostics[0].resources, ["Counter"]);
    scheduler.step(2);
    assert.deepEqual(seen, ["writer", "reader", "writer", "reader"]);
  });
  it("passes exactly {} for legacy undeclared access, preserving M0 behavior", () => {
    const world = makeWorld(),
      received: WorldAccess[] = [];
    const original = world.runSystem;
    world.runSystem = (id, permissions, callback) => {
      received.push(permissions);
      return original(id, permissions, callback);
    };
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "legacy",
          run() {
            world.setComponent("player", "Counter", { value: 4 });
          },
        },
      ],
    });
    assert.equal(scheduler.step().status, "completed");
    assert.deepEqual(received, [{}]);
    assert.equal(value(world), 4);
  });
  it("honors explicit empty writes and pauses without committing a failed tick", () => {
    const world = makeWorld();
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "denied",
          reads: ["Counter"],
          writes: [],
          structural: false,
          run() {
            world.setComponent("player", "Counter", { value: 9 });
          },
        },
      ],
    });
    const checkpoint = scheduler.snapshot();
    const report = scheduler.step();
    assert.equal(report.status, "faulted");
    assert.equal(report.executed, 0);
    assert.equal(report.tick, 0);
    assert.match(report.fault!.message, /ACCESS_WRITE/);
    assert.equal(value(world), 0);
    assert.throws(() => scheduler.resume(), /TC_SCHEDULER_FAULT/);
    scheduler.restore(checkpoint);
    assert.equal(scheduler.inspect().fault, null);
  });
  it("reports partial mutation instead of claiming atomic rollback", () => {
    const world = makeWorld();
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "partial",
          ...access,
          run() {
            world.setComponent("player", "Counter", { value: 7 });
            throw new Error("deliberate");
          },
        },
      ],
    });
    const checkpoint = scheduler.snapshot(),
      report = scheduler.advance(1 / 60);
    assert.equal(value(world), 7);
    assert.equal(report.tick, 0);
    assert.equal(report.status, "faulted");
    assert.equal(report.fault!.partialState, true);
    assert.equal(report.backlogTicks, 1);
    assert.equal(scheduler.step().executed, 0);
    assert.throws(() => scheduler.snapshot(), /TC_SCHEDULER_FAULT/);
    scheduler.restore(checkpoint);
    assert.equal(value(world), 0);
    assert.equal(scheduler.tick, 0);
  });
  it("distinguishes completed ticks from a later partial failure in one advance", () => {
    const world = makeWorld();
    let scheduler: RuntimeScheduler;
    scheduler = createScheduler({
      world,
      fixedDt: 0.1,
      systems: [
        {
          id: "second-fails",
          ...access,
          run() {
            world.setComponent("player", "Counter", { value: scheduler.tick });
            if (scheduler.tick === 2) throw new Error("second tick");
          },
        },
      ],
    });
    const report = scheduler.advance(0.3);
    assert.equal(report.status, "faulted");
    assert.equal(report.executed, 1);
    assert.equal(report.tick, 1);
    assert.equal(report.fault!.tick, 2);
    assert.equal(report.backlogTicks, 2);
    assert.equal(value(world), 2);
  });
  it("enforces read and structural permissions through the actual World", () => {
    for (const run of [
      (world: ReturnType<typeof makeWorld>) => {
        world.getComponent("player", "Counter");
      },
      (world: ReturnType<typeof makeWorld>) => {
        world.queue({ type: "spawn", entity: { id: "forbidden" } });
      },
    ]) {
      const world = makeWorld();
      const scheduler = createScheduler({
        world,
        systems: [
          {
            id: "denied",
            reads: [],
            writes: [],
            structural: false,
            run: () => run(world),
          },
        ],
      });
      const report = scheduler.step();
      assert.equal(report.status, "faulted");
      assert.match(report.fault!.message, /TC_WORLD_ACCESS_(READ|STRUCTURAL)/);
      assert.equal(world.isAlive("forbidden"), false);
    }
  });
  it("captures system metadata so later caller changes cannot weaken permissions", () => {
    const world = makeWorld();
    const system: ScheduledSystem = {
      id: "immutable-access",
      reads: ["Counter"],
      writes: [],
      structural: false,
      run() {
        world.setComponent("player", "Counter", { value: 8 });
      },
    };
    const scheduler = createScheduler({ world, systems: [system] });
    (system.writes as string[]).push("Counter");
    system.structural = true;
    system.id = "changed";
    assert.equal(scheduler.step().status, "faulted");
    assert.equal(scheduler.inspect().systems[0].id, "immutable-access");
    assert.equal(value(world), 0);
  });
  it("flushes commands at tick/phase boundaries, never inside runSystem", () => {
    const world = makeWorld(),
      seen: boolean[] = [];
    world.queue({ type: "spawn", entity: { id: "prequeued" } });
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "spawn",
          phase: "input",
          structural: true,
          reads: [],
          writes: ["Transform"],
          run() {
            assert.equal(world.isAlive("prequeued"), true);
            world.queue({ type: "spawn", entity: { id: "new" } });
            seen.push(world.isAlive("new"));
          },
        },
        {
          id: "same",
          phase: "input",
          run() {
            seen.push(world.isAlive("new"));
          },
        },
        {
          id: "later",
          phase: "physics",
          run() {
            seen.push(world.isAlive("new"));
          },
        },
      ],
    });
    assert.equal(scheduler.step().status, "completed");
    assert.deepEqual(seen, [false, false, true]);
    assert.equal(world.inspect().pendingCommands, 0);
  });
  it("reports flush failure and never commits tick success", () => {
    const world = makeWorld();
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "duplicate",
          structural: true,
          run() {
            world.queue({ type: "spawn", entity: { id: "player" } });
          },
        },
      ],
    });
    const report = scheduler.step();
    assert.equal(report.status, "faulted");
    assert.equal(report.tick, 0);
    assert.equal(report.fault!.stage, "flush:update");
  });
  it("uses fixed dt exactly and exposes the active tick to contexts", () => {
    const world = makeWorld();
    let scheduler: RuntimeScheduler;
    const seen: number[][] = [];
    scheduler = createScheduler({
      world,
      fixedDt: 0.02,
      systems: [
        {
          id: "clock",
          run(dt) {
            seen.push([
              dt,
              scheduler.tick,
              scheduler.time,
              scheduler.inspect().activeTick!,
            ]);
          },
        },
      ],
    });
    scheduler.advance(0.06);
    assert.deepEqual(seen, [
      [0.02, 1, 0.02, 1],
      [0.02, 2, 0.04, 2],
      [0.02, 3, 0.06, 3],
    ]);
    assert.equal(scheduler.inspect().tick, 3);
    assert.equal(scheduler.inspect().activeTick, null);
  });
  it("produces identical world/random state for different frame partitions", () => {
    const a = fixture({ maxSubsteps: 1000 }),
      b = fixture({ maxSubsteps: 1000 });
    assert.equal(a.scheduler.advance(1).executed, 60);
    for (let i = 0; i < 144; i++) b.scheduler.advance(1 / 144);
    assert.equal(b.scheduler.tick, 60);
    assert.deepEqual(a.world.snapshot(), b.world.snapshot());
    assert.deepEqual(
      a.scheduler.inspect().random,
      b.scheduler.inspect().random,
    );
    assert.ok(Math.abs(b.scheduler.inspect().backlogSeconds) < 1e-12);
  });
  it("retains all tick backlog and drains it with zero elapsed time", () => {
    const { scheduler } = fixture({ fixedDt: 0.1, maxSubsteps: 2 });
    const first = scheduler.advance(1);
    assert.equal(first.status, "backlogged");
    assert.equal(first.executed, 2);
    assert.equal(first.backlogTicks, 8);
    assert.equal(first.budgetExhausted, true);
    assert.equal(first.acceptedSeconds, 1);
    for (let i = 0; i < 4; i++) scheduler.advance(0);
    assert.equal(scheduler.tick, 10);
    assert.equal(scheduler.inspect().backlogTicks, 0);
  });
  it("does not silently accept paused time or erase existing backlog", () => {
    const { scheduler } = fixture({ fixedDt: 0.1, maxSubsteps: 1 });
    scheduler.advance(0.3);
    scheduler.pause();
    const before = scheduler.snapshot(),
      report = scheduler.advance(5);
    assert.equal(report.status, "paused");
    assert.equal(report.ignoredSeconds, 5);
    assert.equal(report.acceptedSeconds, 0);
    assert.equal(scheduler.step(10).executed, 0);
    assert.deepEqual(scheduler.snapshot(), before);
    scheduler.resume();
    scheduler.advance(0);
    scheduler.advance(0);
    assert.equal(scheduler.tick, 3);
  });
  it("honors pause requested in a tick only after that tick's phases finish", () => {
    let scheduler: RuntimeScheduler;
    const seen: string[] = [];
    scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "pause",
          phase: "input",
          run() {
            scheduler.pause();
            seen.push("input");
          },
        },
        {
          id: "finish",
          phase: "presentation",
          run() {
            seen.push("presentation");
          },
        },
      ],
    });
    const report = scheduler.step(3);
    assert.equal(report.executed, 1);
    assert.equal(report.status, "paused");
    assert.deepEqual(seen, ["input", "presentation"]);
  });
  it("replaces systems only at safe points, validates before replacing", () => {
    let calls = 0;
    const scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "ok",
          run() {
            calls++;
          },
        },
      ],
    });
    assert.throws(
      () => scheduler.setSystems([{ id: "bad", after: ["missing"], run() {} }]),
      /DEPENDENCY/,
    );
    scheduler.step();
    assert.equal(calls, 1);
    scheduler.setSystems([
      {
        id: "replace",
        run() {
          calls += 10;
        },
      },
    ]);
    scheduler.step();
    assert.equal(calls, 11);
    assert.equal(scheduler.tick, 2);
    scheduler.setSystems([
      {
        id: "unsafe",
        run() {
          scheduler.setSystems([]);
        },
      },
    ]);
    assert.equal(scheduler.step().status, "faulted");
    assert.match(scheduler.inspect().fault!.message, /SAFE_POINT/);
  });
  it("rejects reentrant stepping and asynchronous system definitions", () => {
    let scheduler: RuntimeScheduler;
    scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "nested",
          run() {
            scheduler.step();
          },
        },
      ],
    });
    assert.equal(scheduler.step().status, "faulted");
    assert.match(scheduler.inspect().fault!.message, /SAFE_POINT/);
    assert.throws(
      () =>
        createScheduler({
          world: makeWorld(),
          systems: [{ id: "async", async run() {} }],
        }),
      /TC_SCHEDULER_ASYNC/,
    );
  });
  it("classifies promise-returning system callbacks as failed synchronous ticks", async () => {
    const scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "promise",
          run: () => Promise.reject(new Error("no async work")),
        },
      ],
    });
    const report = scheduler.step();
    assert.equal(report.status, "faulted");
    assert.equal(report.tick, 0);
    assert.match(report.fault!.message, /TC_SCHEDULER_ASYNC/);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("rejects invalid clocks/counts without changing world or scheduler", () => {
    for (const fixedDt of [0, -1, NaN, Infinity])
      assert.throws(
        () => createScheduler({ world: makeWorld(), fixedDt }),
        /TC_SCHEDULER_DT/,
      );
    for (const maxSubsteps of [0, -1, 1.5, Infinity])
      assert.throws(
        () => createScheduler({ world: makeWorld(), maxSubsteps }),
        /TC_SCHEDULER_ARGUMENT/,
      );
    const { scheduler } = fixture(),
      before = scheduler.snapshot();
    for (const number of [-1, NaN, Infinity])
      assert.throws(() => scheduler.advance(number), /TC_SCHEDULER_ARGUMENT/);
    for (const number of [-1, 0.5, NaN, Infinity])
      assert.throws(() => scheduler.step(number), /TC_SCHEDULER_ARGUMENT/);
    assert.throws(
      () => scheduler.advance(Number.MAX_VALUE),
      /TC_SCHEDULER_LIMIT/,
    );
    assert.deepEqual(scheduler.snapshot(), before);
  });
});

describe("M1 queued events", () => {
  it("delivers by tick then sequence, with independently cloned payloads", () => {
    const scheduler = createScheduler({ world: makeWorld() }),
      seen: string[] = [];
    scheduler.events.on("event", (event) => {
      seen.push(`${event.tick}:${(event.payload as { n: number }).n}`);
      (event.payload as { n: number }).n = 999;
    });
    scheduler.events.on("event", (event) => {
      assert.notEqual((event.payload as { n: number }).n, 999);
    });
    const payload = { n: 3 };
    const receipt = scheduler.emit("event", payload, {
      tick: 3,
      source: "scheduled",
    });
    payload.n = 999;
    (receipt.payload as { n: number }).n = 999;
    scheduler.emit("event", { n: 1 }, { tick: 1, source: "input" });
    scheduler.emit("event", { n: 2 }, { tick: 1, source: "external" });
    scheduler.step(3);
    assert.deepEqual(seen, ["1:1", "1:2", "3:3"]);
    assert.equal(scheduler.events()[0].sequence, 0);
    const query = scheduler.events();
    (query[0].payload as { n: number }).n = 888;
    assert.equal((scheduler.events("event")[0].payload as { n: number }).n, 3);
    assert.deepEqual(scheduler.events("missing"), []);
  });
  it("exposes delivered events during systems, queues emitted events for the next tick", () => {
    let scheduler: RuntimeScheduler;
    const seen: string[][] = [];
    scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "sender",
          phase: "input",
          run() {
            seen.push(scheduler.events().map((e) => e.type));
            if (scheduler.tick === 1) scheduler.emit("next", { ok: true });
          },
        },
        {
          id: "later",
          phase: "presentation",
          run() {
            seen.push(scheduler.events().map((e) => e.type));
          },
        },
      ],
    });
    scheduler.emit("first", null);
    scheduler.step(2);
    assert.deepEqual(seen, [["first"], ["first"], ["next"], ["next"]]);
    assert.equal(scheduler.events()[0].source, "system");
    assert.throws(
      () => scheduler.emit("past", null, { tick: 2 }),
      /TC_EVENT_EMIT/,
    );
  });
  it("cannot reenter delivery through emissions in listeners", () => {
    const scheduler = createScheduler({ world: makeWorld() });
    let count = 0;
    scheduler.events.on("loop", () => {
      count++;
      if (count < 3) scheduler.emit("loop", null);
    });
    scheduler.emit("loop", null);
    scheduler.step();
    assert.equal(count, 1);
    scheduler.step();
    assert.equal(count, 2);
    scheduler.step();
    assert.equal(count, 3);
  });
  it("finishes remaining listeners and due events on throw, retains future events and pauses", () => {
    const world = makeWorld(),
      scheduler = createScheduler({ world });
    const seen: number[] = [];
    scheduler.events.on(
      "hit",
      () => {
        throw new Error("listener exploded");
      },
      { id: "broken" },
    );
    scheduler.events.on(
      "hit",
      (event) => {
        seen.push(event.sequence);
      },
      { id: "healthy" },
    );
    scheduler.emit("hit", 1);
    scheduler.emit("hit", 2);
    scheduler.emit("future", 3, { tick: 3 });
    const saved = scheduler.snapshot(),
      result = scheduler.step();
    assert.equal(result.status, "faulted");
    assert.equal(result.tick, 0);
    assert.equal(result.fault!.code, "TC_SCHEDULER_LISTENER");
    assert.equal(result.fault!.eventFaults.length, 2);
    assert.deepEqual(seen, [0, 1]);
    assert.equal(scheduler.inspect().events.queued, 1);
    assert.equal(scheduler.events().length, 2);
    scheduler.restore(saved);
    assert.equal(scheduler.inspect().events.queued, 3);
  });
  it("applies listener access with real World.runSystem and flushes before input systems", () => {
    const world = makeWorld();
    let observed = false;
    const scheduler = createScheduler({
      world,
      systems: [
        {
          id: "observe",
          phase: "input",
          run() {
            observed = world.isAlive("event-created");
          },
        },
      ],
    });
    scheduler.events.on(
      "spawn",
      () => {
        world.queue({ type: "spawn", entity: { id: "event-created" } });
      },
      {
        id: "spawn",
        access: { reads: [], writes: ["Transform"], structural: true },
      },
    );
    scheduler.emit("spawn", null);
    assert.equal(scheduler.step().status, "completed");
    assert.equal(observed, true);
    scheduler.events.on(
      "write",
      () => {
        world.setComponent("player", "Counter", { value: 9 });
      },
      { id: "denied", access: { reads: [], writes: [], structural: false } },
    );
    scheduler.emit("write", null);
    const report = scheduler.step();
    assert.equal(report.status, "faulted");
    assert.match(report.fault!.eventFaults[0].message, /ACCESS_WRITE/);
  });
  it("supports unsubscribing; rejects async listeners and unsafe subscription changes", () => {
    const scheduler = createScheduler({ world: makeWorld() });
    let count = 0;
    const off = scheduler.events.on("x", () => {
      count++;
    });
    off();
    off();
    scheduler.emit("x", null);
    scheduler.step();
    assert.equal(count, 0);
    assert.throws(
      () => scheduler.events.on("x", async () => {}),
      /TC_EVENT_ASYNC/,
    );
    scheduler.events.on("x", () => {
      scheduler.events.on("x", () => {});
    });
    scheduler.emit("x", null);
    const report = scheduler.step();
    assert.equal(report.status, "faulted");
    assert.match(report.fault!.eventFaults[0].message, /SAFE_POINT/);
  });
  it("a stale unsubscribe cannot remove a newly registered listener with the same id", () => {
    const scheduler = createScheduler({ world: makeWorld() });
    let count = 0;
    const oldOff = scheduler.events.on("x", () => {}, { id: "reuse" });
    oldOff();
    scheduler.events.on(
      "x",
      () => {
        count++;
      },
      { id: "reuse" },
    );
    oldOff();
    scheduler.emit("x", null);
    scheduler.step();
    assert.equal(count, 1);
  });
  it("standalone delivery keeps a monotonic tick cursor and defers recursive emissions", () => {
    const bus = createEventBus();
    let count = 0;
    bus.on("x", () => {
      count++;
      bus.emit("x", null);
    });
    bus.emit("x", null);
    bus.deliver(1);
    assert.equal(count, 1);
    assert.equal(bus.snapshot().queue[0].tick, 2);
    assert.throws(() => bus.deliver(0), /TC_EVENT_TICK/);
    bus.deliver(2);
    assert.equal(count, 2);
    assert.equal(bus.snapshot().queue[0].tick, 3);
  });
  it("classifies thenable listener results and still finishes its batch", async () => {
    const scheduler = createScheduler({ world: makeWorld() });
    let done = 0;
    scheduler.events.on("x", () => Promise.reject(new Error("not supported")), {
      id: "promise",
    });
    scheduler.events.on(
      "x",
      () => {
        done++;
      },
      { id: "other" },
    );
    scheduler.emit("x", null);
    const report = scheduler.step();
    assert.equal(report.fault!.eventFaults[0].code, "TC_EVENT_ASYNC");
    assert.equal(done, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("rejects malformed payloads and options without consuming a sequence", () => {
    const scheduler = createScheduler({ world: makeWorld() });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    const values = [
      undefined,
      NaN,
      Infinity,
      1n,
      () => {},
      Symbol("x"),
      new Date(),
      new Map(),
      circular,
      [1, undefined],
      new Array(2),
      accessor,
    ];
    for (const item of values)
      assert.throws(() => scheduler.emit("bad", item), /TC_SERIALIZATION/);
    assert.throws(() => scheduler.emit("", null), /TC_EVENT_EMIT/);
    assert.throws(
      () => scheduler.emit("bad", null, { tick: 0 }),
      /TC_EVENT_EMIT/,
    );
    assert.throws(
      () => scheduler.emit("bad", null, { tick: 1.5 }),
      /TC_EVENT_EMIT/,
    );
    assert.equal(
      scheduler.emit("good", { nested: [true, null, "ok", 4] }).sequence,
      0,
    );
    assert.equal(Object.is(scheduler.emit("zero", -0).payload, -0), true);
  });
  it("validates queued event snapshots fully before replacement", () => {
    const bus = createEventBus();
    bus.emit("ok", { n: 1 });
    const saved = bus.snapshot();
    for (const mutate of [
      (data: any) => {
        data.version = 99;
      },
      (data: any) => {
        data.queue.push({ ...data.queue[0] });
      },
      (data: any) => {
        data.queue[0].payload = undefined;
      },
      (data: any) => {
        data.queue[0].tick = 0;
      },
    ]) {
      const invalid = structuredClone(saved);
      mutate(invalid);
      assert.throws(
        () => bus.restore(invalid),
        /TC_EVENT_SNAPSHOT|TC_SERIALIZATION/,
      );
      assert.deepEqual(bus.snapshot(), saved);
    }
    saved.queue[0].payload = null;
    assert.notEqual(bus.snapshot().queue[0].payload, null);
  });
});

describe("M1 random, complete checkpoints and recording/replay", () => {
  it("has a stable seeded CPU sequence with reusable independent snapshots", () => {
    const rng = createRandom(123),
      other = createRandom(123),
      different = createRandom(124);
    const numbers = Array.from({ length: 10 }, () => rng.next());
    assert.deepEqual(
      numbers.slice(0, 5),
      [
        0.7872516233474016, 0.1785435655619949, 0.49531551403924823,
        0.23136196262203157, 0.375791602069512,
      ],
    );
    assert.deepEqual(
      numbers,
      Array.from({ length: 10 }, () => other.next()),
    );
    assert.notDeepEqual(
      numbers,
      Array.from({ length: 10 }, () => different.next()),
    );
    assert.ok(numbers.every((n) => n >= 0 && n < 1));
    const saved = rng.snapshot(),
      next = rng.next();
    rng.restore(saved);
    assert.equal(rng.next(), next);
    rng.restore(saved);
    assert.equal(rng.next(), next);
    const before = rng.snapshot();
    assert.throws(
      () => rng.restore({ ...saved, state: -1 }),
      /TC_RANDOM_SNAPSHOT/,
    );
    assert.deepEqual(rng.snapshot(), before);
    for (const seed of [-1, 0.5, 0x100000000, Infinity, NaN])
      assert.throws(() => createRandom(seed), /TC_RANDOM_SEED/);
  });
  it("restores world, accumulator, clock, random, delivered and queued events together", () => {
    const { scheduler, world } = fixture({ fixedDt: 0.1, seed: 0xffffffff });
    scheduler.emit("first", { n: [1, 2] });
    scheduler.emit("later", "value", { tick: 5 });
    scheduler.advance(0.15);
    const first = scheduler.snapshot();
    scheduler.advance(0.1);
    const second = scheduler.snapshot();
    scheduler.advance(0.3);
    const final = scheduler.snapshot();
    scheduler.restore(second);
    assert.deepEqual(scheduler.snapshot(), second);
    scheduler.advance(0.3);
    assert.deepEqual(scheduler.snapshot(), final);
    scheduler.restore(first);
    assert.deepEqual(world.snapshot(), first.world);
    scheduler.advance(0.1);
    assert.deepEqual(scheduler.snapshot(), second);
    scheduler.restore(first);
    scheduler.advance(0.1);
    assert.deepEqual(scheduler.snapshot(), second);
    assert.equal(first.tick, 1);
    assert.equal(
      (first.world.entities[0].components.Counter.value as number) <
        value(world),
      true,
    );
  });
  it("does not retain caller-owned checkpoint references during restore", () => {
    const { scheduler, world } = fixture();
    const saved = scheduler.snapshot();
    scheduler.restore(saved);
    saved.world.entities[0].components.Counter.value = 999;
    saved.random.state = 999;
    saved.events.queue.push({
      type: "fake",
      payload: null,
      tick: 99,
      sequence: 1,
      source: "external",
    });
    assert.equal(value(world), 0);
    assert.notEqual(scheduler.inspect().random.state, 999);
    assert.equal(scheduler.inspect().events.queued, 0);
  });
  it("rejects malformed/versioned snapshots before modifying any state", () => {
    const { scheduler } = fixture();
    scheduler.step();
    const saved = scheduler.snapshot();
    for (const mutate of [
      (data: any) => {
        data.version = 999;
      },
      (data: any) => {
        data.world.version = 999;
      },
      (data: any) => {
        data.random.version = 999;
      },
      (data: any) => {
        data.events.version = 999;
      },
      (data: any) => {
        data.random.state = 0x100000000;
      },
      (data: any) => {
        data.tick = 0;
      },
      (data: any) => {
        data.accumulator = -1;
      },
      (data: any) => {
        data.compensation = 1e9;
      },
      (data: any) => {
        data.world.entities[0].components.Counter.value = "wrong";
      },
      (data: any) => {
        data.world.entities[0].transform.position = [0, 0];
      },
      (data: any) => {
        data.world.entities.push(structuredClone(data.world.entities[0]));
      },
      (data: any) => {
        data.world.entities[0].parent = "missing";
      },
      (data: any) => {
        data.world.entities[0].parent = "player";
      },
      (data: any) => {
        data.world.components[0].schema.value.default = "wrong";
      },
      (data: any) => {
        data.systems = [];
      },
      (data: any) => {
        data.delivered = [undefined];
      },
    ]) {
      const invalid = structuredClone(saved);
      mutate(invalid);
      assert.throws(() => scheduler.restore(invalid));
      assert.deepEqual(scheduler.snapshot(), saved);
    }
  });
  it("refuses checkpointing with uncommitted structural commands", () => {
    const { scheduler, world } = fixture();
    world.queue({ type: "spawn", entity: { id: "pending" } });
    assert.throws(() => scheduler.snapshot(), /TC_SCHEDULER_PENDING/);
    scheduler.step();
    assert.equal(scheduler.snapshot().world.entities.length, 2);
  });
  it("records and replays external input, scheduled events, pauses, random and frame budgets", () => {
    const { scheduler, world } = fixture({
      fixedDt: 0.1,
      maxSubsteps: 2,
      seed: 42,
    });
    scheduler.events.on(
      "add",
      (event) => {
        world.setComponent("player", "Counter", {
          value: value(world) + (event.payload as number),
        });
      },
      { id: "add", access },
    );
    scheduler.startRecording();
    scheduler.emit("add", 10, { source: "input" });
    scheduler.advance(0.35);
    scheduler.emit("add", 20, { tick: 5, source: "scheduled" });
    scheduler.random();
    scheduler.advance(0);
    scheduler.pause();
    scheduler.advance(10);
    scheduler.step(2);
    scheduler.resume();
    scheduler.step(3);
    const trace = scheduler.stopRecording(),
      final = scheduler.snapshot();
    assert.equal(trace.actions.filter((a) => a.kind === "emit").length, 2);
    assert.equal(trace.actions.filter((a) => a.kind === "random").length, 1); // Tick-internal draws regenerate.
    scheduler.step(4);
    scheduler.emit("junk", null);
    const report = scheduler.replay(JSON.parse(JSON.stringify(trace)));
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.actionsExecuted, trace.actions.length);
    assert.deepEqual(scheduler.snapshot(), final);
    assert.equal(scheduler.replay(trace).status, "passed");
    assert.deepEqual(scheduler.snapshot(), final);
  });
  it("regenerates system-internal events and pause requests without double recording", () => {
    let scheduler: RuntimeScheduler;
    scheduler = createScheduler({
      world: makeWorld(),
      systems: [
        {
          id: "internal",
          run() {
            scheduler.random();
            scheduler.emit("internal", scheduler.tick);
            if (scheduler.tick === 2) scheduler.pause();
          },
        },
      ],
    });
    scheduler.startRecording();
    scheduler.step(5);
    scheduler.resume();
    scheduler.step();
    const trace = scheduler.stopRecording();
    assert.deepEqual(
      trace.actions.map((a) => a.kind),
      ["step", "resume", "step"],
    );
    assert.equal(scheduler.replay(trace).status, "passed");
    assert.deepEqual(scheduler.snapshot(), trace.final);
  });
  it("rejects malformed trace anywhere in the action list before restoring initial state", () => {
    const { scheduler } = fixture();
    scheduler.startRecording();
    scheduler.step();
    const trace = scheduler.stopRecording();
    scheduler.step();
    const before = scheduler.snapshot();
    for (const mutate of [
      (data: any) => {
        data.version = 2;
      },
      (data: any) => {
        data.initial.version = 2;
      },
      (data: any) => {
        data.final.random.version = 2;
      },
      (data: any) => {
        data.final.world.entities[0].components.Counter.value = "invalid";
      },
      (data: any) => {
        data.actions.push({ kind: "step", count: -1, atTick: 1 });
      },
      (data: any) => {
        data.actions.push({
          kind: "step",
          count: Number.MAX_SAFE_INTEGER,
          atTick: 1,
        });
      },
      (data: any) => {
        data.actions.push({ kind: "advance", seconds: Infinity, atTick: 1 });
      },
      (data: any) => {
        data.actions.push({
          kind: "advance",
          seconds: Number.MAX_VALUE,
          atTick: 1,
        });
      },
      (data: any) => {
        data.actions.push({ kind: "unknown", atTick: 1 });
      },
      (data: any) => {
        data.actions.push({
          kind: "emit",
          atTick: 2,
          event: {
            type: "x",
            payload: null,
            tick: 1,
            sequence: 0,
            source: "input",
          },
        });
      },
    ]) {
      const invalid = structuredClone(trace);
      mutate(invalid);
      assert.throws(() => scheduler.replay(invalid));
      assert.deepEqual(scheduler.snapshot(), before);
    }
  });
  it("reports replay divergence as a fault with no false success or rollback claim", () => {
    const { scheduler, world } = fixture();
    scheduler.startRecording();
    scheduler.step(2);
    const trace = scheduler.stopRecording();
    scheduler.setSystems([
      {
        id: "counter",
        ...access,
        run() {
          world.setComponent("player", "Counter", { value: -1 });
        },
      },
    ]);
    const report = scheduler.replay(trace);
    assert.equal(report.status, "failed");
    assert.equal(report.fault!.code, "TC_REPLAY_DIVERGENCE");
    assert.equal(report.fault!.partialState, true);
    assert.equal(scheduler.inspect().paused, true);
  });
  it("replays a JSON trace on a separate scheduler/world with the same system contract", () => {
    const a = fixture({ seed: 99 }),
      b = fixture({ seed: 0 });
    a.scheduler.startRecording();
    a.scheduler.advance(0.05);
    a.scheduler.random();
    a.scheduler.step(4);
    const trace = a.scheduler.stopRecording();
    const report = b.scheduler.replay(JSON.parse(JSON.stringify(trace)));
    assert.equal(report.status, "passed");
    assert.deepEqual(b.scheduler.snapshot(), a.scheduler.snapshot());
    assert.deepEqual(b.world.snapshot(), a.world.snapshot());
  });
  it("protects recording contracts and can cancel a failed recording to restore", () => {
    const { scheduler } = fixture();
    const checkpoint = scheduler.snapshot();
    scheduler.startRecording();
    assert.throws(() => scheduler.setSystems([]), /TC_TRACE_SYSTEMS/);
    assert.throws(
      () => scheduler.events.on("x", () => {}),
      /TC_TRACE_SUBSCRIPTION/,
    );
    assert.throws(() => scheduler.restore(checkpoint), /TC_TRACE_RESTORE/);
    scheduler.cancelRecording();
    scheduler.setSystems([
      {
        id: "bad",
        run() {
          throw new Error("bad");
        },
      },
    ]);
    const good = scheduler.snapshot();
    scheduler.startRecording();
    scheduler.step();
    assert.throws(() => scheduler.stopRecording(), /TC_SCHEDULER_FAULT/);
    scheduler.cancelRecording();
    scheduler.restore(good);
    assert.equal(scheduler.inspect().fault, null);
  });
  it("disposes owned queues/listeners/systems without disposing the shared World", () => {
    const { scheduler, world } = fixture();
    scheduler.events.on("x", () => {});
    scheduler.emit("x", null);
    scheduler.startRecording();
    scheduler.dispose();
    scheduler.dispose();
    assert.equal(scheduler.inspect().disposed, true);
    assert.equal(scheduler.inspect().events.queued, 0);
    assert.equal(scheduler.inspect().events.listeners.length, 0);
    assert.equal(scheduler.inspect().systems.length, 0);
    assert.equal(scheduler.inspect().recording, false);
    assert.equal(world.inspect().disposed, false);
    world.setComponent("player", "Counter", { value: 5 });
    assert.equal(value(world), 5);
    for (const operation of [
      () => scheduler.step(),
      () => scheduler.advance(1),
      () => scheduler.resume(),
      () => scheduler.pause(),
      () => scheduler.random(),
      () => scheduler.events(),
      () => scheduler.emit("x", null),
      () => scheduler.snapshot(),
    ])
      assert.throws(operation, /TC_SCHEDULER_DISPOSED|TC_EVENT_DISPOSED/);
  });
  it("clones special own JSON keys as data without prototype mutation", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"data"}',
    );
    const result = cloneSerializable(input);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
    assert.equal(({} as any).polluted, undefined);
    assert.deepEqual(result, input);
  });
});
