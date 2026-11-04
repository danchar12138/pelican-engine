import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorldProbe,
  runWorldProbe,
  type ChunkCoord,
  type WorldAdapter,
  type WorldOrigin,
} from "../experiments/world/index.ts";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function gateSource() {
  const calls: {
    coord: ChunkCoord;
    generation: number;
    signal: AbortSignal;
    gate: ReturnType<typeof deferred>;
  }[] = [];
  return {
    calls,
    beforeBuild(
      request: { coord: ChunkCoord; generation: number },
      signal: AbortSignal,
    ) {
      const gate = deferred();
      calls.push({ ...request, signal, gate });
      return gate.promise;
    },
  };
}
const logicalGeometry = (w: ReturnType<typeof createWorldProbe>) => {
  const { epoch: _epoch, ...geometry } = w.getRenderState();
  return geometry;
};

describe("M0 world: finite real geometry / collision / graph", () => {
  it("runs the measured full sidecar probe", async () => {
    const report = await runWorldProbe();
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert.equal(report.snapshot.logicalStateRestoredExactly, true);
    assert.equal(report.snapshot.geometryRestoredExactly, true);
    assert.equal(report.edits.pathBefore, 4);
    assert.equal(report.edits.pathAfter, 6);
    assert.ok(report.snapshot.bytes > 1000);
    assert.ok(report.timing.prepareWallMs > 0);
    assert.equal(report.lifecycle.allReleased, true);
  });
  it("generates indexed triangles, collision heights and a real path across resident chunk boundaries", async () => {
    const w = createWorldProbe();
    await Promise.all([w.loadChunk([0, 0]), w.loadChunk([1, 0])]);
    const render = w.getRenderState(),
      physics = w.getCollisionState(),
      nav = w.getNavigationState();
    assert.equal(render.chunks.length, 2);
    assert.equal(physics.chunks.length, 2);
    assert.equal(nav.nodes.length, 32);
    for (const c of render.chunks) {
      assert.equal(c.positions.length, 75);
      assert.equal(c.indices.length, 96);
      assert.ok(c.positions.every(Number.isFinite));
      assert.ok(
        c.indices.every((i) => Number.isInteger(i) && i >= 0 && i < 25),
      );
    }
    // The collision sample uses the same triangle diagonal as the render mesh.
    const c = physics.chunks.find((c) => c.id === "chunk:0:0")!;
    const sampled = w.sampleHeight({ chunk: [0, 0], local: [0.5, 0, 0.75] })!;
    assert.equal(
      sampled.height,
      c.heights[0] +
        (c.heights[1] - c.heights[0]) * 0.25 +
        (c.heights[5] - c.heights[0]) * 0.375,
    );
    const path = w.findPath(
      { chunk: [0, 0], cell: [3, 1] },
      { chunk: [1, 0], cell: [0, 1] },
    );
    assert.equal(path.found, true);
    assert.equal(path.nodes.length, 2);
    assert.ok(path.nodes[0].neighbors.includes(path.nodes[1].id));
    assert.equal(w.inspect().consumers.consistent, true);
    await w.unloadChunk([1, 0]);
    assert.equal(
      w.findPath(
        { chunk: [0, 0], cell: [3, 1] },
        { chunk: [1, 0], cell: [0, 1] },
      ).found,
      false,
    );
    w.dispose();
  });
  it("an edit actually changes mesh, collision and traversability in the same version", async () => {
    const w = createWorldProbe();
    await w.loadChunk([0, 0]);
    const old = w.getRenderState();
    await w.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 2 }]);
    const r = w.getRenderState(),
      p = w.getCollisionState(),
      n = w.getNavigationState();
    assert.notDeepEqual(r.chunks[0].positions, old.chunks[0].positions);
    assert.equal(r.chunks[0].positions[(2 * 5 + 2) * 3 + 1], 2);
    assert.equal(p.chunks[0].heights[2 * 5 + 2], 2);
    assert.equal(
      w.sampleHeight({ chunk: [0, 0], local: [4, 0, 4] })!.height,
      2,
    );
    assert.equal(n.blockedCells, 4);
    assert.equal(n.nodes.length, 12);
    assert.equal(r.chunks[0].version, 1);
    assert.equal(p.chunks[0].version, 1);
    assert.equal(n.versions[0].version, 1);
    assert.equal(r.epoch, p.epoch);
    assert.equal(p.epoch, n.epoch);
    w.dispose();
  });
  it("shared corner edits persist in all four neighbors including negative chunk coordinates", async () => {
    const w = createWorldProbe();
    const coords: ChunkCoord[] = [
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ];
    await Promise.all(coords.map((c) => w.loadChunk(c)));
    await w.applyEdits([{ chunk: [0, 0], x: 0, z: 0, height: 1.5 }]);
    for (const c of w.getCollisionState().chunks) {
      const x = c.coord[0] < 0 ? 4 : 0,
        z = c.coord[1] < 0 ? 4 : 0;
      assert.equal(c.heights[z * 5 + x], 1.5);
      assert.equal(c.version, 1);
    }
    assert.equal(w.snapshot().edits.length, 1);
    assert.equal(w.snapshot().revisions.length, 4);
    await Promise.all(coords.map((c) => w.unloadChunk(c)));
    assert.equal(w.inspect().resident.length, 0);
    assert.equal(w.inspect().persistentEdits, 1);
    await Promise.all(coords.map((c) => w.loadChunk(c)));
    assert.equal(w.inspect().consumers.consistent, true);
    for (const c of w.getCollisionState().chunks) {
      const x = c.coord[0] < 0 ? 4 : 0,
        z = c.coord[1] < 0 ? 4 : 0;
      assert.equal(c.heights[z * 5 + x], 1.5);
      assert.equal(c.version, 1);
    }
    w.dispose();
  });
  it("multiple edits to one canonical vertex use the last value and one version increment", async () => {
    const w = createWorldProbe();
    await w.loadChunk([0, 0]);
    await w.loadChunk([1, 0]);
    await w.applyEdits([
      { chunk: [0, 0], x: 4, z: 2, height: 1 },
      { chunk: [1, 0], x: 0, z: 2, height: 2.5 },
    ]);
    assert.equal(w.snapshot().edits.length, 1);
    assert.ok(w.getCollisionState().chunks.every((c) => c.version === 1));
    assert.equal(
      w.getCollisionState().chunks.find((c) => c.id === "chunk:0:0")!
        .heights[14],
      2.5,
    );
    w.dispose();
  });
});

describe("M0 world: cancellation, generations and asynchronous stale results", () => {
  it("cancels promptly without waiting for an uncooperative old result and keeps a newer generation", async () => {
    const source = gateSource(),
      w = createWorldProbe({ beforeBuild: source.beforeBuild });
    const old = w.loadChunk([0, 0]);
    await flush();
    assert.equal(source.calls.length, 1);
    assert.equal(w.cancelLoad([0, 0]), true);
    assert.equal((await old).status, "cancelled");
    assert.equal(source.calls[0].signal.aborted, true);
    const newer = w.loadChunk([0, 0]);
    await flush();
    assert.ok(source.calls[1].generation > source.calls[0].generation);
    source.calls[1].gate.resolve();
    assert.equal((await newer).status, "loaded");
    const committed = w.snapshot(),
      epoch = w.inspect().epoch;
    source.calls[0].gate.resolve();
    await flush();
    assert.deepEqual(w.snapshot(), committed);
    assert.equal(w.inspect().epoch, epoch);
    assert.ok(w.inspect().metrics.staleResults >= 1);
    assert.equal(w.cancelLoad([0, 0]), false);
    w.dispose();
  });
  it("supersedes an in-flight load with a newer load and ignores the old late error", async () => {
    const source = gateSource(),
      w = createWorldProbe({ beforeBuild: source.beforeBuild });
    const a = w.loadChunk([0, 0]);
    await flush();
    const b = w.loadChunk([0, 0]);
    await flush();
    assert.equal((await a).status, "stale");
    source.calls[1].gate.resolve();
    assert.equal((await b).status, "loaded");
    source.calls[0].gate.reject(new Error("old I/O failed"));
    await flush();
    assert.equal(w.inspect().resident.length, 1);
    assert.equal(w.inspect().pending.length, 0);
    w.dispose();
  });
  it("unload cancels a pending load and its late completion cannot resurrect the chunk", async () => {
    const source = gateSource(),
      w = createWorldProbe({ beforeBuild: source.beforeBuild });
    const load = w.loadChunk([0, 0]);
    await flush();
    assert.equal((await w.unloadChunk([0, 0])).status, "absent");
    assert.equal((await load).status, "cancelled");
    source.calls[0].gate.resolve();
    await flush();
    assert.equal(w.inspect().resident.length, 0);
    assert.equal(w.getRenderState().chunks.length, 0);
    w.dispose();
  });
  it("an edit invalidates an older load and a reload uses persistent current data", async () => {
    const source = gateSource(),
      w = createWorldProbe({ beforeBuild: source.beforeBuild });
    const a = w.loadChunk([0, 0]);
    await flush();
    await w.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 3 }]);
    assert.equal((await a).status, "stale");
    source.calls[0].gate.resolve();
    await flush();
    assert.equal(w.inspect().resident.length, 0);
    const b = w.loadChunk([0, 0]);
    await flush();
    source.calls[1].gate.resolve();
    const result = await b;
    assert.equal(result.version, 1);
    assert.equal(
      w.sampleHeight({ chunk: [0, 0], local: [4, 0, 4] })!.height,
      3,
    );
    w.dispose();
  });
  it("a newer load intent defeats an unload already waiting in adapter preparation", async () => {
    const gate = deferred(),
      entered = deferred();
    const adapter: WorldAdapter = {
      name: "hold-unload",
      async prepare(t) {
        if (t.reason === "unload") {
          entered.resolve();
          await gate.promise;
        }
        return { commit() {}, rollback() {}, discard() {} };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    await w.loadChunk([0, 0]);
    const unload = w.unloadChunk([0, 0]);
    await entered.promise;
    assert.equal((await w.loadChunk([0, 0])).status, "already-loaded");
    gate.resolve();
    assert.equal((await unload).status, "stale");
    assert.equal(w.inspect().resident.length, 1);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
  it("dispose cancels callers immediately and discards preparation that finishes later", async () => {
    const gate = deferred(),
      entered = deferred();
    let discarded = 0,
      committed = 0;
    const adapter: WorldAdapter = {
      name: "slow-consumer",
      async prepare() {
        entered.resolve();
        await gate.promise;
        return {
          commit() {
            committed++;
          },
          rollback() {},
          discard() {
            discarded++;
          },
        };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    const load = w.loadChunk([0, 0]);
    await entered.promise;
    w.dispose();
    assert.equal((await load).status, "cancelled");
    gate.resolve();
    await flush();
    assert.equal(committed, 0);
    assert.equal(discarded, 1);
    assert.equal(w.inspect().pending.length, 0);
    assert.ok(Object.values(w.inspect().resources).every((n) => n === 0));
  });
  it("a source failure rejects, clears pending state and permits retry", async () => {
    let fail = true;
    const w = createWorldProbe({
      async beforeBuild() {
        if (fail) throw new Error("storage unavailable");
      },
    });
    await assert.rejects(w.loadChunk([0, 0]), /storage unavailable/);
    assert.equal(w.inspect().pending.length, 0);
    assert.equal(w.inspect().resident.length, 0);
    fail = false;
    assert.equal((await w.loadChunk([0, 0])).status, "loaded");
    w.dispose();
  });
});

describe("M0 world: prepare / commit atomicity and rollback", () => {
  it("keeps all visible consumers unchanged until every adapter is prepared", async () => {
    const gate = deferred(),
      entered = deferred();
    const adapter: WorldAdapter = {
      name: "hold-edit",
      async prepare(t) {
        if (t.reason === "edit") {
          entered.resolve();
          await gate.promise;
        }
        return { commit() {}, rollback() {}, discard() {} };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    await w.loadChunk([0, 0]);
    const snapshot = w.snapshot(),
      r = w.getRenderState(),
      p = w.getCollisionState(),
      n = w.getNavigationState();
    const edit = w.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 2 }]);
    await entered.promise;
    assert.deepEqual(w.snapshot(), snapshot);
    assert.deepEqual(w.getRenderState(), r);
    assert.deepEqual(w.getCollisionState(), p);
    assert.deepEqual(w.getNavigationState(), n);
    assert.equal(w.inspect().consumers.consistent, true);
    gate.resolve();
    await edit;
    assert.equal(w.getRenderState().epoch, r.epoch + 1);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
  it("discards real prepared artifacts if a later consumer fails to prepare", async () => {
    let discarded = 0;
    const first: WorldAdapter = {
      name: "prepared-extra",
      prepare() {
        return {
          commit() {},
          rollback() {},
          discard() {
            discarded++;
          },
        };
      },
    };
    const failing: WorldAdapter = {
      name: "fail-prepare",
      prepare(t) {
        if (t.reason === "edit") throw new Error("cannot build consumer");
        return { commit() {}, rollback() {}, discard() {} };
      },
    };
    const w = createWorldProbe({ adapters: [first, failing] });
    await w.loadChunk([0, 0]);
    const before = w.snapshot(),
      r = w.getRenderState();
    await assert.rejects(
      w.applyEdits([{ chunk: [0, 0], x: 1, z: 1, height: 2 }]),
      /WORLD_PREPARE/,
    );
    assert.deepEqual(w.snapshot(), before);
    assert.deepEqual(w.getRenderState(), r);
    assert.equal(discarded, 1);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
  it("rolls back all consumers including the one whose commit partially failed, then can retry", async () => {
    let value = 0,
      shouldFail = true;
    const adapter: WorldAdapter = {
      name: "partial-commit",
      prepare(t) {
        const previous = value;
        return {
          commit() {
            value = t.epoch;
            if (shouldFail && t.reason === "edit")
              throw new Error("partial publish");
          },
          rollback() {
            value = previous;
          },
          discard() {},
        };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    await w.loadChunk([0, 0]);
    const before = w.snapshot(),
      r = w.getRenderState(),
      p = w.getCollisionState(),
      n = w.getNavigationState(),
      old = value;
    await assert.rejects(
      w.applyEdits([{ chunk: [0, 0], x: 1, z: 1, height: 2 }]),
      /WORLD_COMMIT/,
    );
    assert.equal(value, old);
    assert.deepEqual(w.snapshot(), before);
    assert.deepEqual(w.getRenderState(), r);
    assert.deepEqual(w.getCollisionState(), p);
    assert.deepEqual(w.getNavigationState(), n);
    assert.equal(w.inspect().faulted, false);
    assert.equal(w.inspect().consumers.consistent, true);
    shouldFail = false;
    await w.applyEdits([{ chunk: [0, 0], x: 1, z: 1, height: 2 }]);
    assert.equal(w.inspect().epoch, r.epoch + 1);
    w.dispose();
  });
  it("detects broken rollback, rejects a load caller and faults further operations", async () => {
    const adapter: WorldAdapter = {
      name: "broken",
      prepare() {
        return {
          commit() {
            throw new Error("commit failed");
          },
          rollback() {
            throw new Error("rollback failed");
          },
          discard() {},
        };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    await assert.rejects(w.loadChunk([0, 0]), /WORLD_ROLLBACK/);
    assert.equal(w.inspect().faulted, true);
    assert.equal(w.inspect().pending.length, 0);
    assert.equal(w.inspect().resident.length, 0);
    assert.throws(() => w.getRenderState(), /WORLD_FAULTED/);
    w.dispose();
  });
  it("each custom adapter receives private preparation input and cannot alias world or built-in data", async () => {
    const adapter: WorldAdapter = {
      name: "mutates-input",
      prepare(t) {
        if (t.chunks[0]) t.chunks[0].heights[0] = 999;
        t.origin.offset[0] = 999;
        return { commit() {}, rollback() {}, discard() {} };
      },
    };
    const w = createWorldProbe({ adapters: [adapter] });
    await w.loadChunk([0, 0]);
    assert.notEqual(w.getCollisionState().chunks[0].heights[0], 999);
    assert.equal(w.inspect().origin.offset[0], 0);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
});

describe("M0 world: persistence, snapshot validation and origin-local coordinates", () => {
  it("restores unloaded persistent edits and resident geometry across a different origin", async () => {
    const w = createWorldProbe();
    await w.loadChunk([0, 0]);
    await w.applyEdits([
      { chunk: [0, 0], x: 2, z: 2, height: 1.25 },
      { chunk: [1, 0], x: 2, z: 2, height: 1.75 },
    ]);
    const saved = w.snapshot(),
      geometry = logicalGeometry(w),
      epoch = w.inspect().epoch;
    await w.setOrigin({ chunk: [1, 0], offset: [0.125, 1.5, 0.25] });
    await w.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: -3 }]);
    await w.unloadChunk([0, 0]);
    await w.restore(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(w.snapshot(), saved);
    assert.deepEqual(logicalGeometry(w), geometry);
    assert.ok(w.inspect().epoch > epoch);
    await w.loadChunk([1, 0]);
    assert.equal(
      w.sampleHeight({ chunk: [1, 0], local: [4, 0, 4] })!.height,
      1.75,
    );
    w.dispose();
  });
  it("restoration invalidates an in-flight old-world load without resurrecting it", async () => {
    const source = gateSource(),
      w = createWorldProbe({ beforeBuild: source.beforeBuild });
    const saved = w.snapshot();
    const load = w.loadChunk([0, 0]);
    await flush();
    await w.restore(saved);
    assert.equal((await load).status, "stale");
    source.calls[0].gate.resolve();
    await flush();
    assert.deepEqual(w.snapshot(), saved);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
  it("rejects malformed snapshots atomically rather than trusting saved derived geometry", async () => {
    const w = createWorldProbe();
    await w.loadChunk([0, 0]);
    await w.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 1 }]);
    const before = w.snapshot(),
      epoch = w.inspect().epoch;
    const corruptions: ((s: typeof before) => void)[] = [
      (s) => {
        s.version = 2 as 1;
      },
      (s) => {
        s.origin.offset[0] = NaN;
      },
      (s) => {
        s.config.seed++;
      },
      (s) => {
        s.resident[0].heights[0] += 1;
      },
      (s) => {
        s.resident[0].heights[0] = Infinity;
      },
      (s) => {
        s.resident[0].version++;
      },
      (s) => {
        s.edits[0].height = NaN;
      },
      (s) => {
        s.edits.push(s.edits[0]);
      },
      (s) => {
        s.revisions = [];
      },
      (s) => {
        s.resident.push(s.resident[0]);
      },
    ];
    for (const corrupt of corruptions) {
      const bad = w.snapshot();
      corrupt(bad);
      await assert.rejects(w.restore(bad), /WORLD_SNAPSHOT/);
      assert.deepEqual(w.snapshot(), before);
      assert.equal(w.inspect().epoch, epoch);
    }
    w.dispose();
  });
  it("preserves precision at large chunk coordinates and synchronizes all origins without changing content revisions", async () => {
    const c: ChunkCoord = [100000000, -100000000],
      w = createWorldProbe({
        bounds: { min: c, max: [c[0] + 1, c[1]] },
        origin: { chunk: c, offset: [0, 0, 0] },
      });
    await w.loadChunk(c);
    await w.applyEdits([{ chunk: c, x: 2, z: 2, height: 0.000125 }]);
    const point = {
        chunk: c,
        local: [3.125, 0.000125, 2.25] as [number, number, number],
      },
      local = w.toLocal(point);
    assert.deepEqual(local, point.local);
    assert.deepEqual(w.fromLocal(local), point);
    assert.notEqual(Math.fround(c[0] * 8 + 3.125), c[0] * 8 + 3.125);
    assert.equal(Math.fround(local[0]), 3.125);
    const old = w.getRenderState();
    const origin: WorldOrigin = {
      chunk: [c[0] + 1, c[1]],
      offset: [0.125, 0.25, -0.5],
    };
    await w.setOrigin(origin);
    const shifted = w.getRenderState();
    assert.equal(
      shifted.chunks[0].positions[0],
      old.chunks[0].positions[0] - 8.125,
    );
    assert.equal(shifted.chunks[0].version, old.chunks[0].version);
    assert.deepEqual(w.getCollisionState().origin, origin);
    assert.deepEqual(w.getNavigationState().origin, origin);
    const round = w.fromLocal(w.toLocal(point));
    assert.deepEqual(round.chunk, point.chunk);
    assert.ok(
      round.local.every((x, i) => Math.abs(x - point.local[i]) < 1e-12),
    );
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
  it("returned data and input snapshots are independent copies", async () => {
    const w = createWorldProbe();
    await w.loadChunk([0, 0]);
    const saved = w.snapshot(),
      before = w.snapshot(),
      r = w.getRenderState(),
      p = w.getCollisionState(),
      n = w.getNavigationState();
    r.chunks[0].positions[0] = 999;
    p.chunks[0].heights[0] = 999;
    n.nodes[0].neighbors.length = 0;
    saved.resident[0].heights[0] = 999;
    assert.deepEqual(w.snapshot(), before);
    const restored = createWorldProbe();
    await restored.restore(before);
    before.resident[0].heights[0] = 999;
    assert.notEqual(restored.snapshot().resident[0].heights[0], 999);
    w.dispose();
    restored.dispose();
  });
  it("validates finite limits and disposes all owned data with no background worker", async () => {
    assert.throws(
      () => createWorldProbe({ bounds: { min: [0, 0], max: [8, 8] } }),
      /WORLD_CONFIG/,
    );
    assert.throws(() => createWorldProbe({ cellsPerChunk: 1 }), /WORLD_CONFIG/);
    assert.throws(() => createWorldProbe({ navMaxStep: 0 }), /WORLD_CONFIG/);
    const w = createWorldProbe();
    assert.throws(() => w.loadChunk([2, 0]), /WORLD_COORD/);
    await assert.rejects(
      w.applyEdits([{ chunk: [0, 0], x: 5, z: 0, height: 1 }]),
      /WORLD_EDIT/,
    );
    await assert.rejects(
      w.applyEdits([{ chunk: [0, 0], x: 0, z: 0, height: NaN }]),
      /WORLD_EDIT/,
    );
    await w.loadChunk([0, 0]);
    w.dispose();
    w.dispose();
    assert.ok(Object.values(w.inspect().resources).every((n) => n === 0));
    assert.equal(w.inspect().persistentEdits, 0);
    assert.throws(() => w.loadChunk([0, 0]), /WORLD_DISPOSED/);
    assert.throws(() => w.snapshot(), /WORLD_DISPOSED/);
    assert.throws(() => w.getRenderState(), /WORLD_DISPOSED/);
  });
});

describe("M0 world: failed restore preserves asynchronous current-world work", () => {
  it("does not cancel a current load or publish restored state when restore preparation fails", async () => {
    const gate = deferred(),
      entered = deferred();
    const adapter: WorldAdapter = {
      name: "reject-restore",
      prepare(t) {
        if (t.reason === "restore")
          throw new Error("restore consumer unavailable");
        return { commit() {}, rollback() {}, discard() {} };
      },
    };
    const w = createWorldProbe({
      adapters: [adapter],
      beforeBuild(request) {
        if (request.coord[0] === 1) {
          entered.resolve();
          return gate.promise;
        }
        return Promise.resolve();
      },
    });
    await w.loadChunk([0, 0]);
    const saved = w.snapshot();
    const loading = w.loadChunk([1, 0]);
    await entered.promise;
    const oldEpoch = w.inspect().epoch;
    await assert.rejects(w.restore(saved), /WORLD_PREPARE/);
    assert.deepEqual(w.snapshot(), saved);
    assert.equal(w.inspect().epoch, oldEpoch);
    assert.equal(w.inspect().pending.length, 1);
    gate.resolve();
    assert.equal((await loading).status, "loaded");
    assert.equal(w.inspect().resident.length, 2);
    assert.equal(w.inspect().consumers.consistent, true);
    w.dispose();
  });
});
