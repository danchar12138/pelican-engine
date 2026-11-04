import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { createScheduler } from "../packages/runtime/src/scheduler.ts";
import { ResourceManager } from "../packages/runtime/src/resources.ts";

export async function runFoundationProbe(
  engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const project = path.join(engineRoot, "examples/m1");
  const output = path.join(engineRoot, ".threecat/m1-cpu-compiled");
  const compiled = await compileProject({
    projectRoot: project,
    outDir: output,
    engineRoot,
  });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const module = await import(
    pathToFileURL(path.join(output, "game.js")).href + `?probe=${Date.now()}`
  );
  const host = new RuntimeHost(compiled.ir!);
  host.attach(module.createGame(host.facade));
  const initial = host.snapshot();
  host.input("ArrowRight", true);
  host.step(60);
  const beforeReplay = host.inspect();
  assert.equal(beforeReplay.world.entities, 4);
  assert.equal(host.world.getComponent("spinner", "Progress").ticks, 60);
  assert.equal(host.world.getComponent("spinner", "Progress").events, 1);
  assert.equal(host.world.getTransform("spinner").position[0], -0.65);
  host.restore(initial);
  host.startRecording();
  host.input("ArrowLeft", true);
  host.step(30);
  const trace = host.stopRecording();
  const recorded = host.snapshot();
  host.step(5);
  const replay = host.replay(trace);
  assert.equal(replay.status, "passed");
  assert.deepEqual(host.snapshot(), recorded);
  const invalid = structuredClone(recorded);
  invalid.world.entities[0].transform.position = [NaN, 0, 0];
  assert.throws(() => host.restore(invalid));
  assert.deepEqual(host.snapshot(), recorded);
  host.dispose();
  assert.equal(host.inspect().world.entities, 0);

  const definitions = [
    {
      id: "Health",
      schema: { value: { type: "number" as const, default: 10 } },
    },
  ];
  const world = createWorld({ components: definitions, initialCapacity: 4 });
  const spawnStart = performance.now();
  for (let i = 0; i < 10000; i++)
    world.spawn({
      id: `entity-${i}`,
      components: i % 2 ? { Health: { value: i } } : {},
    });
  const spawnMs = performance.now() - spawnStart;
  const queryStart = performance.now();
  let matches = 0;
  for (let i = 0; i < 100; i++) matches = world.query("Health").length;
  const meanQueryMs = (performance.now() - queryStart) / 100;
  assert.equal(matches, 5000);
  const stale = world.resolve("entity-3");
  const state = world.snapshot();
  world.restore(state);
  assert.equal(world.isAlive(stale), false);
  assert.throws(() =>
    world.runSystem("unauthorized", { reads: [], writes: [] }, () =>
      world.setComponent("entity-3", "Health", { value: 0 }),
    ),
  );
  const sizeBefore = world.inspect().entities;
  world.queue({ type: "spawn", entity: { id: "candidate" } });
  world.queue({ type: "destroy", entity: "missing" });
  assert.throws(() => world.flush());
  assert.equal(world.inspect().entities, sizeBefore);
  assert.equal(world.isAlive("candidate"), false);
  const worldReport = {
    passed: true,
    load: { entities: sizeBefore, components: 1, matching: matches },
    storage: "typed SoA columns",
    spawnWallMs: spawnMs,
    queryWallMeanMs: meanQueryMs,
    capacity: world.inspect().capacity,
    staleHandleRejected: true,
    permissionRejected: true,
    atomicCommandFailure: true,
    snapshotBytes: Buffer.byteLength(JSON.stringify(state)),
    limitations: [
      "Measures this CPU process only, not a universal throughput guarantee",
      "Atomic structural commits currently copy candidate column state",
    ],
  };
  world.dispose();

  const clock = (slices: number[]) => {
    const w = createWorld({
      components: definitions,
      entities: [{ id: "clock", components: { Health: { value: 0 } } }],
    });
    const scheduler = createScheduler({
      world: w,
      fixedDt: 1 / 60,
      maxSubsteps: 120,
      seed: 9,
      systems: [
        {
          id: "count",
          writes: ["Health"],
          run() {
            const value = w.getComponent("clock", "Health").value as number;
            w.setComponent("clock", "Health", { value: value + 1 });
          },
        },
      ],
    });
    for (const seconds of slices) scheduler.advance(seconds);
    const report = {
      tick: scheduler.tick,
      value: w.getComponent("clock", "Health").value,
      snapshot: scheduler.snapshot(),
    };
    scheduler.dispose();
    w.dispose();
    return report;
  };
  const at30 = clock(Array(30).fill(1 / 30));
  const at144 = clock(Array(144).fill(1 / 144));
  assert.equal(at30.tick, 60);
  assert.equal(at144.tick, 60);
  assert.equal(at30.value, at144.value);

  const directory = await mkdtemp(path.join(tmpdir(), "threecat-resource-m1-"));
  const file = path.join(directory, "payload.bin");
  await writeFile(file, new Uint8Array([1, 2, 3, 4]));
  const resources = new ResourceManager<{
    bytes: { descriptor: { path: string }; value: Uint8Array };
  }>();
  let reads = 0,
    frees = 0;
  resources.registerLoader("bytes", {
    async load(descriptor, signal) {
      reads++;
      return readFile(descriptor.path, { signal });
    },
    dispose() {
      frees++;
    },
    estimateBytes: (value) => value.byteLength,
  });
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const a = resources.createScope(),
      b = resources.createScope();
    const [first, second] = await Promise.all([
      resources.acquire("bytes", "shared", { path: file }, a),
      resources.acquire("bytes", "shared", { path: file }, b),
    ]);
    assert.deepEqual(first.handle, second.handle);
    assert.equal(resources.get(first.handle).byteLength, 4);
    await a.release();
    assert.equal(resources.get(second.handle).byteLength, 4);
    await b.release();
    assert.throws(() => resources.get(first.handle));
  }
  await resources.whenIdle();
  const resourceReport = {
    passed: true,
    cycles: 100,
    reads,
    disposals: frees,
    wallMs: performance.now() - start,
    inspection: resources.inspect(),
    limitations: [
      "Ownership counts do not establish OS or driver leak freedom",
    ],
  };
  assert.equal(reads, 100);
  assert.equal(frees, 100);
  assert.equal(resourceReport.inspection.owned.entries, 0);
  await resources.dispose();
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error("Unexpected temporary cleanup target");
  await rm(directory, { recursive: true, force: true });
  return {
    compiler: compiled.report,
    runtime: {
      passed: true,
      initialTick: initial.scheduler.tick,
      finalTick: recorded.scheduler.tick,
      records: beforeReplay.records,
      replay,
      inputAndEvents: true,
      invalidRestoreRejectedAtomically: true,
      world: worldReport,
    },
    scheduler: {
      passed: true,
      at30,
      at144,
      fixedStepIndependentOfDisplayRate: true,
    },
    resources: resourceReport,
  };
}
