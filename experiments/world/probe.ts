import { createWorldProbe } from "./world.ts";
import type {
  WorldInspection,
  WorldProbeOptions,
  WorldAdapter,
} from "./types.ts";
export interface WorldProbeReport {
  prototype: "threecat-m0-world-streaming";
  version: 1;
  passed: boolean;
  checks: Record<string, boolean>;
  load: { chunks: number; verticesPerChunk: number; trianglesPerChunk: number };
  edits: {
    sharedBorderHeight: number;
    versions: { id: string; version: number }[];
    blockedCells: number;
    pathBefore: number;
    pathAfter: number;
  };
  asyncTransactions: {
    cancelSettledBeforeSource: boolean;
    lateResultDiscarded: boolean;
    newGenerationKept: boolean;
    editInvalidatedOldLoad: boolean;
    unchangedDuringPrepare: boolean;
    rollbackRestored: boolean;
    staleResults: number;
  };
  snapshot: {
    bytes: number;
    captureWallMs: number;
    restoreWallMs: number;
    logicalStateRestoredExactly: boolean;
    geometryRestoredExactly: boolean;
  };
  precision: {
    chunk: [number, number];
    float32GlobalError: number;
    float32LocalError: number;
    roundTripError: number;
  };
  timing: { totalWallMs: number; prepareWallMs: number; commitWallMs: number };
  lifecycle: { cycles: number; allReleased: boolean };
  final: WorldInspection;
  limitations: string[];
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function withoutEpoch<T extends { epoch: number }>(value: T): Omit<T, "epoch"> {
  const { epoch: _epoch, ...rest } = value;
  return rest;
}
export async function runWorldProbe(
  options: Pick<WorldProbeOptions, "seed"> = {},
): Promise<WorldProbeReport> {
  const start = performance.now(),
    seed = options.seed ?? 12345,
    world = createWorldProbe({ seed });
  const checks: Record<string, boolean> = {};
  try {
    await Promise.all([
      world.loadChunk([0, 0]),
      world.loadChunk([1, 0]),
      world.loadChunk([-1, 0]),
    ]);
    checks.loaded =
      world.inspect().resident.length === 3 &&
      world.inspect().consumers.consistent;
    const before = world.getRenderState();
    const pathBefore = world.findPath(
      { chunk: [0, 0], cell: [2, 1] },
      { chunk: [1, 0], cell: [1, 1] },
    );
    await world.applyEdits([{ chunk: [0, 0], x: 4, z: 2, height: 2 }]);
    const after = world.getRenderState(),
      collision = world.getCollisionState(),
      nav = world.getNavigationState();
    const left = collision.chunks.find((c) => c.id === "chunk:0:0")!,
      right = collision.chunks.find((c) => c.id === "chunk:1:0")!;
    checks.borderShared =
      left.heights[2 * 5 + 4] === 2 && right.heights[2 * 5] === 2;
    checks.atomicVersions =
      left.version === 1 &&
      right.version === 1 &&
      world.inspect().consumers.consistent;
    checks.geometryChanged = !same(
      before.chunks.find((c) => c.id === left.id)!.positions,
      after.chunks.find((c) => c.id === left.id)!.positions,
    );
    checks.collisionChanged =
      world.sampleHeight({ chunk: [1, 0], local: [0, 0, 4] })?.height === 2;
    const pathAfter = world.findPath(
      { chunk: [0, 0], cell: [2, 1] },
      { chunk: [1, 0], cell: [1, 1] },
    );
    checks.navigationChanged =
      pathBefore.found &&
      pathAfter.found &&
      pathAfter.nodes.length > pathBefore.nodes.length &&
      nav.blockedCells > 0;
    await world.unloadChunk([0, 0]);
    await world.loadChunk([0, 0]);
    checks.persistentReturn =
      world.sampleHeight({ chunk: [0, 0], local: [8 - 1e-6, 0, 4] })!.height >
        1.999 &&
      world.getCollisionState().chunks.find((c) => c.id === left.id)!
        .version === 1;
    const capture = performance.now(),
      snapshot = world.snapshot(),
      captureWallMs = performance.now() - capture;
    const geometry = withoutEpoch(world.getRenderState());
    await world.applyEdits([{ chunk: [0, 0], x: 1, z: 1, height: -1 }]);
    await world.unloadChunk([1, 0]);
    await world.setOrigin({ chunk: [1, 0], offset: [0, 0, 0] });
    const restoreStart = performance.now();
    await world.restore(JSON.parse(JSON.stringify(snapshot)));
    const restoreWallMs = performance.now() - restoreStart;
    const logicalStateRestoredExactly = same(world.snapshot(), snapshot),
      geometryRestoredExactly = same(
        withoutEpoch(world.getRenderState()),
        geometry,
      );
    checks.restore =
      logicalStateRestoredExactly &&
      geometryRestoredExactly &&
      world.inspect().consumers.consistent;
    const far = createWorldProbe({
      seed,
      bounds: { min: [100000000, -100000000], max: [100000001, -100000000] },
      origin: { chunk: [100000000, -100000000], offset: [0, 0, 0] },
    });
    const point = {
      chunk: [100000000, -100000000] as [number, number],
      local: [3.125, 0.000125, 2.25] as [number, number, number],
    };
    let float32GlobalError = 0,
      float32LocalError = 0,
      roundTripError = 0;
    try {
      await far.loadChunk(point.chunk);
      const local = far.toLocal(point),
        round = far.fromLocal(local);
      float32GlobalError = Math.abs(
        Math.fround(point.chunk[0] * 8 + point.local[0]) -
          (point.chunk[0] * 8 + point.local[0]),
      );
      float32LocalError = Math.abs(Math.fround(local[0]) - point.local[0]);
      roundTripError = Math.max(
        ...round.local.map((x, i) => Math.abs(x - point.local[i])),
      );
      checks.originPrecision =
        float32GlobalError > 1 &&
        float32LocalError === 0 &&
        roundTripError === 0 &&
        same(round.chunk, point.chunk);
      const old = far.getRenderState();
      await far.setOrigin({
        chunk: [100000001, -100000000],
        offset: [0, 0, 0],
      });
      const shifted = far.getRenderState();
      checks.originSynchronization =
        shifted.chunks[0].positions[0] === old.chunks[0].positions[0] - 8 &&
        shifted.chunks[0].version === old.chunks[0].version &&
        far.inspect().consumers.consistent;
    } finally {
      far.dispose();
    }
    let allReleased = true;
    for (let cycle = 0; cycle < 8; cycle++) {
      const temporary = createWorldProbe({ seed });
      await temporary.restore(snapshot);
      await temporary.unloadChunk([0, 0]);
      temporary.dispose();
      temporary.dispose();
      const i = temporary.inspect();
      allReleased &&=
        i.disposed &&
        i.pending.length === 0 &&
        i.resident.length === 0 &&
        i.persistentEdits === 0 &&
        Object.values(i.resources).every((n) => n === 0);
    }
    checks.released = allReleased;
    const asyncTransactions = await asyncTransactionEvidence(seed);
    checks.asyncRaces =
      asyncTransactions.cancelSettledBeforeSource &&
      asyncTransactions.lateResultDiscarded &&
      asyncTransactions.newGenerationKept &&
      asyncTransactions.editInvalidatedOldLoad;
    checks.transactionRollback =
      asyncTransactions.unchangedDuringPrepare &&
      asyncTransactions.rollbackRestored;
    const final = world.inspect();
    return {
      prototype: "threecat-m0-world-streaming",
      version: 1,
      passed: Object.values(checks).every(Boolean),
      checks,
      load: {
        chunks: before.chunks.length,
        verticesPerChunk: before.chunks[0].positions.length / 3,
        trianglesPerChunk: before.chunks[0].indices.length / 3,
      },
      edits: {
        sharedBorderHeight: left.heights[14],
        versions: final.resident,
        blockedCells: nav.blockedCells,
        pathBefore: pathBefore.nodes.length,
        pathAfter: pathAfter.nodes.length,
      },
      asyncTransactions,
      snapshot: {
        bytes: new TextEncoder().encode(JSON.stringify(snapshot)).length,
        captureWallMs,
        restoreWallMs,
        logicalStateRestoredExactly,
        geometryRestoredExactly,
      },
      precision: {
        chunk: point.chunk,
        float32GlobalError,
        float32LocalError,
        roundTripError,
      },
      timing: {
        totalWallMs: performance.now() - start,
        prepareWallMs: final.metrics.prepareWallMs,
        commitWallMs: final.metrics.commitWallMs,
      },
      lifecycle: { cycles: 8, allReleased },
      final,
      limitations: [
        "Finite CPU reference: at most 8×8 chunks and 16×16 cells per chunk; report exercises three 4×4-cell chunks.",
        "Procedural height grid only; no production terrain, holes, caves, LOD, geometry destruction, disk I/O or asset bandwidth measurement.",
        "Collision is real triangle-consistent height sampling, not a rigid-body solver or broadphase.",
        "Navigation is a real four-neighbor cell graph and BFS, not a Recast / volumetric / continuous navmesh library.",
        "Each commit rebuilds all resident consumer artifacts; no incremental BVH/GPU upload is performed here.",
        "Adapters must prepare without side effects; commit/rollback/discard are synchronous, trusted and non-reentrant. Rollback violation faults the world.",
        "Snapshot persistence is JSON data in memory/files; no disk journal or crash durability protocol.",
        "Logical release counts are not a process/GPU memory leak audit. An uncooperative asynchronous hook cannot be forcibly terminated.",
        "Origin-local precision covers split chunk/local coordinates; callers must not first collapse large positions to global Float32.",
        "Real WebGPU, BVH and physics/navigation library adapters require separate mainline integration verification.",
      ],
    };
  } finally {
    world.dispose();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function asyncTransactionEvidence(
  seed: number,
): Promise<WorldProbeReport["asyncTransactions"]> {
  const entered = [deferred(), deferred(), deferred()],
    release = [deferred(), deferred(), deferred()];
  let calls = 0;
  const w = createWorldProbe({
    seed,
    beforeBuild() {
      const i = calls++;
      entered[i].resolve();
      return release[i].promise;
    },
  });
  let cancelSettledBeforeSource = false,
    lateResultDiscarded = false,
    newGenerationKept = false,
    editInvalidatedOldLoad = false,
    staleResults = 0;
  try {
    const old = w.loadChunk([0, 0]);
    await entered[0].promise;
    w.cancelLoad([0, 0]);
    cancelSettledBeforeSource = (await old).status === "cancelled";
    const fresh = w.loadChunk([0, 0]);
    await entered[1].promise;
    release[1].resolve();
    newGenerationKept = (await fresh).status === "loaded";
    const saved = w.snapshot(),
      epoch = w.inspect().epoch;
    release[0].resolve();
    await release[0].promise;
    lateResultDiscarded =
      same(w.snapshot(), saved) &&
      w.inspect().epoch === epoch &&
      w.inspect().metrics.staleResults > 0;
    const pending = w.loadChunk([1, 0]);
    await entered[2].promise;
    await w.applyEdits([{ chunk: [1, 0], x: 1, z: 1, height: 2 }]);
    editInvalidatedOldLoad = (await pending).status === "stale";
    release[2].resolve();
    await release[2].promise;
    editInvalidatedOldLoad &&= !w
      .inspect()
      .resident.some((c) => c.id === "chunk:1:0");
    staleResults = w.inspect().metrics.staleResults;
  } finally {
    release.forEach((d) => d.resolve());
    w.dispose();
  }
  const prepared = deferred(),
    ready = deferred();
  let value = 0;
  const adapter: WorldAdapter = {
    name: "report-failure-injection",
    async prepare(t) {
      const previous = value;
      if (t.reason === "edit") {
        ready.resolve();
        await prepared.promise;
      }
      return {
        commit() {
          value = t.epoch;
          if (t.reason === "edit")
            throw new Error("intentional partial commit failure");
        },
        rollback() {
          value = previous;
        },
        discard() {},
      };
    },
  };
  const transactionWorld = createWorldProbe({ seed, adapters: [adapter] });
  let unchangedDuringPrepare = false,
    rollbackRestored = false;
  try {
    await transactionWorld.loadChunk([0, 0]);
    const logical = transactionWorld.snapshot(),
      r = transactionWorld.getRenderState(),
      p = transactionWorld.getCollisionState(),
      n = transactionWorld.getNavigationState(),
      old = value;
    const result = transactionWorld
      .applyEdits([{ chunk: [0, 0], x: 1, z: 1, height: 2 }])
      .then(
        () => false,
        (error) => String(error).includes("WORLD_COMMIT"),
      );
    await ready.promise;
    unchangedDuringPrepare =
      same(transactionWorld.snapshot(), logical) &&
      same(transactionWorld.getRenderState(), r) &&
      same(transactionWorld.getCollisionState(), p) &&
      same(transactionWorld.getNavigationState(), n);
    prepared.resolve();
    const rejected = await result;
    rollbackRestored =
      rejected &&
      value === old &&
      same(transactionWorld.snapshot(), logical) &&
      same(transactionWorld.getRenderState(), r) &&
      same(transactionWorld.getCollisionState(), p) &&
      same(transactionWorld.getNavigationState(), n) &&
      transactionWorld.inspect().consumers.consistent;
  } finally {
    prepared.resolve();
    transactionWorld.dispose();
  }
  return {
    cancelSettledBeforeSource,
    lateResultDiscarded,
    newGenerationKept,
    editInvalidatedOldLoad,
    unchangedDuringPrepare,
    rollbackRestored,
    staleResults,
  };
}
