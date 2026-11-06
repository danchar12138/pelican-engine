import { createConsumer } from "./adapters.ts";
import {
  affectedChunks,
  assertCoord,
  assertOrigin,
  buildChunk,
  chunkId,
  clone,
  collisionBuild,
  coordValid,
  fail,
  heightAt,
  inside,
  key,
  localPoint,
  navBuild,
  navId,
  normalizePoint,
  renderBuild,
  vector,
  vertexKey,
} from "./geometry.ts";
import type {
  ChunkCoord,
  ChunkData,
  ChunkLoadResult,
  HeightEdit,
  NavigationAddress,
  PreparedWorldUpdate,
  Vec3,
  WorldConfig,
  WorldInspection,
  WorldOrigin,
  WorldPoint,
  WorldProbe,
  WorldProbeOptions,
  WorldSnapshot,
  WorldTransaction,
} from "./types.ts";
interface State {
  origin: WorldOrigin;
  edits: Map<string, number>;
  revisions: Map<string, number>;
  chunks: Map<string, ChunkData>;
}
interface Pending {
  generation: number;
  version: number;
  controller: AbortController;
  resolve: (r: ChunkLoadResult) => void;
  reject: (e: unknown) => void;
}

export function createWorldProbe(options: WorldProbeOptions = {}): WorldProbe {
  const config: WorldConfig = {
    seed: options.seed ?? 12345,
    chunkSize: options.chunkSize ?? 8,
    cellsPerChunk: options.cellsPerChunk ?? 4,
    bounds: clone(options.bounds ?? { min: [-1, -1], max: [1, 1] }),
    navMaxStep: options.navMaxStep ?? 0.75,
  };
  if (
    !Number.isSafeInteger(config.seed) ||
    config.seed < 0 ||
    config.seed > 0xffffffff
  )
    fail("WORLD_CONFIG", "seed must be uint32.");
  if (
    !Number.isFinite(config.chunkSize) ||
    config.chunkSize < 1 ||
    config.chunkSize > 1024 ||
    !Number.isInteger(config.cellsPerChunk) ||
    config.cellsPerChunk < 2 ||
    config.cellsPerChunk > 16
  )
    fail(
      "WORLD_CONFIG",
      "chunkSize must be in [1,1024]; cellsPerChunk is an integer in [2,16].",
    );
  if (
    !config.bounds ||
    !coordValid(config.bounds.min) ||
    !coordValid(config.bounds.max) ||
    config.bounds.min.some(
      (v, i) => config.bounds.max[i] < v || config.bounds.max[i] - v >= 8,
    )
  )
    fail("WORLD_CONFIG", "Use a finite map no larger than 8×8 chunks.");
  if (
    !Number.isFinite(config.navMaxStep) ||
    config.navMaxStep <= 0 ||
    config.navMaxStep > 100
  )
    fail("WORLD_CONFIG", "navMaxStep must be finite in (0,100].");
  const origin: WorldOrigin = clone<WorldOrigin>(
    options.origin ?? { chunk: [0, 0], offset: [0, 0, 0] },
  );
  assertOrigin(origin, config);
  let state: State = {
    origin,
    edits: new Map(),
    revisions: new Map(),
    chunks: new Map(),
  };
  let epoch = 0,
    disposed = false,
    faulted = false;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Pending>(),
    generations = new Map<string, number>();
  const metrics: WorldInspection["metrics"] = {
    loadRequests: 0,
    cancelledLoads: 0,
    staleResults: 0,
    committedTransactions: 0,
    failedTransactions: 0,
    discardedPreparations: 0,
    prepareWallMs: 0,
    commitWallMs: 0,
  };
  const initial: WorldTransaction = {
    epoch: 0,
    reason: "load",
    config,
    origin,
    chunks: [],
  };
  const render = createConsumer("render", renderBuild(initial), renderBuild),
    physics = createConsumer(
      "physics",
      collisionBuild(initial),
      collisionBuild,
    ),
    nav = createConsumer("nav", navBuild(initial), navBuild);
  const adapters = [render, physics, nav, ...(options.adapters ?? [])];
  if (
    new Set(adapters.map((a) => a.name)).size !== adapters.length ||
    adapters.some((a) => !a.name || typeof a.prepare !== "function")
  )
    fail(
      "WORLD_ADAPTER",
      "Adapters require unique nonempty names and prepare().",
    );
  function alive(): void {
    if (disposed) fail("WORLD_DISPOSED", "Create a new world after disposal.");
    if (faulted)
      fail(
        "WORLD_FAULTED",
        "An adapter violated its rollback contract; recreate the world.",
      );
  }
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    alive();
    const operation = tail.then(() => {
      alive();
      return task();
    });
    tail = operation.catch(() => {});
    return operation;
  }
  function nextState(): State {
    return {
      origin: clone(state.origin),
      edits: new Map(state.edits),
      revisions: new Map(state.revisions),
      chunks: new Map(state.chunks),
    };
  }
  function bump(c: ChunkCoord, status: "cancelled" | "stale"): number {
    const id = key(c),
      generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      p.controller.abort();
      if (status === "cancelled") metrics.cancelledLoads++;
      p.resolve({
        status,
        id: chunkId(c),
        generation: p.generation,
        version: p.version,
      });
    }
    return generation;
  }
  const current = (id: string, p: Pending): boolean =>
    !disposed &&
    !faulted &&
    pending.get(id) === p &&
    generations.get(id) === p.generation &&
    (state.revisions.get(id) ?? 0) === p.version;
  function discard(prepared: PreparedWorldUpdate[]): void {
    for (const p of prepared.reverse()) {
      try {
        p.discard();
        metrics.discardedPreparations++;
      } catch {
        faulted = true;
      }
    }
  }
  async function publish(
    next: State,
    reason: WorldTransaction["reason"],
    valid: () => boolean = () => !disposed,
  ): Promise<boolean> {
    if (!valid()) return false;
    const transaction: WorldTransaction = {
      epoch: epoch + 1,
      reason,
      config: clone(config),
      origin: clone(next.origin),
      chunks: [...next.chunks.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(clone),
    };
    const prepared: PreparedWorldUpdate[] = [];
    const prepareStart = performance.now();
    try {
      for (const adapter of adapters) {
        const p = await adapter.prepare(clone(transaction));
        if (
          !p ||
          typeof p.commit !== "function" ||
          typeof p.rollback !== "function" ||
          typeof p.discard !== "function"
        )
          fail(
            "WORLD_ADAPTER_CONTRACT",
            `${adapter.name} returned an invalid preparation.`,
          );
        prepared.push(p);
        if (!valid()) {
          discard(prepared);
          return false;
        }
      }
    } catch (error) {
      discard(prepared);
      metrics.failedTransactions++;
      fail("WORLD_PREPARE", `No world state committed: ${String(error)}`);
    } finally {
      metrics.prepareWallMs += performance.now() - prepareStart;
    }
    const attempted: PreparedWorldUpdate[] = [];
    const commitStart = performance.now();
    try {
      // No await / observer callback in this section: built-in consumers and world publish in one JS turn.
      for (const p of prepared) {
        attempted.push(p);
        const result: unknown = p.commit();
        if (result && typeof (result as Promise<unknown>).then === "function")
          fail("WORLD_ADAPTER_CONTRACT", "commit() must be synchronous.");
      }
      state = next;
      epoch = transaction.epoch;
      metrics.committedTransactions++;
      return true;
    } catch (error) {
      for (const p of attempted.reverse()) {
        try {
          p.rollback();
        } catch {
          faulted = true;
        }
      }
      discard(prepared.filter((p) => !attempted.includes(p)));
      metrics.failedTransactions++;
      fail(
        faulted ? "WORLD_ROLLBACK" : "WORLD_COMMIT",
        `World state was not published; ${faulted ? "adapter rollback failed" : "all attempted consumers rolled back"}: ${String(error)}`,
      );
    } finally {
      metrics.commitWallMs += performance.now() - commitStart;
    }
  }
  function pointValid(p: WorldPoint): void {
    if (
      !p ||
      !coordValid(p.chunk) ||
      !vector(p.local, 3) ||
      p.local.some((v) => Math.abs(v) > 1e9)
    )
      fail("WORLD_POINT", "Expected an integer chunk and finite local XYZ.");
  }
  function snapshot(): WorldSnapshot {
    alive();
    const ordered = <T>(m: Map<string, T>): [string, T][] =>
      [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return {
      format: "pelican-m0-world",
      version: 1,
      config: clone(config),
      origin: clone(state.origin),
      edits: ordered(state.edits).map(([k, height]) => ({
        vertex: k.split(":").map(Number) as ChunkCoord,
        height,
      })),
      revisions: ordered(state.revisions).map(([k, version]) => ({
        coord: k.split(":").map(Number) as ChunkCoord,
        version,
      })),
      resident: ordered(state.chunks).map(([, c]) => clone(c)),
    };
  }
  function parseSnapshot(input: WorldSnapshot): State {
    try {
      if (!input || input.format !== "pelican-m0-world" || input.version !== 1)
        throw new Error("format / version mismatch");
      const c = input.config;
      if (
        !c ||
        c.seed !== config.seed ||
        c.chunkSize !== config.chunkSize ||
        c.cellsPerChunk !== config.cellsPerChunk ||
        c.navMaxStep !== config.navMaxStep ||
        JSON.stringify(c.bounds) !== JSON.stringify(config.bounds)
      )
        throw new Error("configuration mismatch");
      assertOrigin(input.origin, config);
      if (
        !Array.isArray(input.edits) ||
        !Array.isArray(input.revisions) ||
        !Array.isArray(input.resident)
      )
        throw new Error("missing arrays");
      const limit =
        (config.bounds.max[0] - config.bounds.min[0] + 1) *
        (config.bounds.max[1] - config.bounds.min[1] + 1);
      if (
        input.edits.length > limit * (config.cellsPerChunk + 1) ** 2 ||
        input.revisions.length > limit ||
        input.resident.length > limit
      )
        throw new Error("snapshot exceeds finite map");
      const next: State = {
        origin: clone(input.origin),
        edits: new Map(),
        revisions: new Map(),
        chunks: new Map(),
      };
      for (const e of input.edits) {
        if (
          !e ||
          !vector(e.vertex, 2) ||
          !e.vertex.every(Number.isSafeInteger) ||
          !Number.isFinite(e.height) ||
          Math.abs(e.height) > 100 ||
          !affectedChunks(e.vertex, config).length ||
          next.edits.has(key(e.vertex))
        )
          throw new Error("invalid / duplicate persistent vertex");
        next.edits.set(key(e.vertex), e.height);
      }
      for (const r of input.revisions) {
        assertCoord(r.coord, config);
        if (
          !Number.isSafeInteger(r.version) ||
          r.version < 1 ||
          next.revisions.has(key(r.coord))
        )
          throw new Error("invalid / duplicate revision");
        next.revisions.set(key(r.coord), r.version);
      }
      for (const e of input.edits)
        for (const coord of affectedChunks(e.vertex, config))
          if (!next.revisions.has(key(coord)))
            throw new Error("edited chunk lacks revision");
      for (const c of input.resident) {
        assertCoord(c.coord, config);
        const id = key(c.coord),
          expected = buildChunk(
            c.coord,
            next.revisions.get(id) ?? 0,
            config,
            next.edits,
          );
        if (
          next.chunks.has(id) ||
          c.id !== expected.id ||
          c.version !== expected.version ||
          !Array.isArray(c.heights) ||
          c.heights.length !== expected.heights.length ||
          c.heights.some((h, i) => h !== expected.heights[i])
        )
          throw new Error(
            "resident mesh / height data disagrees with persistent state",
          );
        next.chunks.set(id, expected);
      }
      return next;
    } catch (error) {
      fail(
        "WORLD_SNAPSHOT",
        `Snapshot rejected before commit: ${String(error)}`,
      );
    }
  }

  return {
    loadChunk(coord) {
      alive();
      assertCoord(coord, config);
      coord = [...coord];
      metrics.loadRequests++;
      const id = key(coord),
        generation = bump(coord, "stale"),
        version = state.revisions.get(id) ?? 0;
      if (state.chunks.has(id))
        return Promise.resolve({
          status: "already-loaded",
          id: chunkId(coord),
          generation,
          version,
        });
      let p: Pending;
      const promise = new Promise<ChunkLoadResult>((resolve, reject) => {
        p = {
          generation,
          version,
          controller: new AbortController(),
          resolve,
          reject,
        };
        pending.set(id, p);
      });
      void Promise.resolve().then(async () => {
        try {
          if (options.beforeBuild)
            await options.beforeBuild(
              { coord: [...coord], generation, version },
              p.controller.signal,
            );
          if (!current(id, p)) {
            metrics.staleResults++;
            return;
          }
          await enqueue(async () => {
            if (!current(id, p)) {
              metrics.staleResults++;
              return;
            }
            const next = nextState();
            next.chunks.set(id, buildChunk(coord, version, config, next.edits));
            const committed = await publish(next, "load", () => current(id, p));
            if (committed) {
              pending.delete(id);
              p.resolve({
                status: "loaded",
                id: chunkId(coord),
                generation,
                version,
              });
            } else {
              metrics.staleResults++;
              if (pending.get(id) === p) {
                pending.delete(id);
                p.reject(
                  new Error(
                    "WORLD_FAULTED: load preparation was not publishable.",
                  ),
                );
              }
            }
          });
        } catch (error) {
          if (pending.get(id) === p) {
            pending.delete(id);
            p.reject(error);
          } else metrics.staleResults++;
        }
      });
      return promise;
    },
    cancelLoad(coord) {
      alive();
      assertCoord(coord, config);
      if (!pending.has(key(coord))) return false;
      bump(coord, "cancelled");
      return true;
    },
    async unloadChunk(coord) {
      alive();
      assertCoord(coord, config);
      coord = [...coord];
      const id = key(coord),
        generation = bump(coord, "cancelled");
      return enqueue(async () => {
        if (generations.get(id) !== generation)
          return { status: "stale" as const, id: chunkId(coord) };
        if (!state.chunks.has(id))
          return { status: "absent" as const, id: chunkId(coord) };
        const next = nextState();
        next.chunks.delete(id);
        const committed = await publish(
          next,
          "unload",
          () => !disposed && generations.get(id) === generation,
        );
        return {
          status: committed ? ("unloaded" as const) : ("stale" as const),
          id: chunkId(coord),
        };
      });
    },
    async applyEdits(edits: HeightEdit[]) {
      alive();
      if (!Array.isArray(edits) || edits.length > 4096)
        fail("WORLD_EDIT", "Supply at most 4096 height edits.");
      const validated = edits.map((e) => {
        if (!e) fail("WORLD_EDIT", "Missing height edit.");
        assertCoord(e.chunk, config);
        if (
          !Number.isInteger(e.x) ||
          !Number.isInteger(e.z) ||
          e.x < 0 ||
          e.z < 0 ||
          e.x > config.cellsPerChunk ||
          e.z > config.cellsPerChunk ||
          !Number.isFinite(e.height) ||
          Math.abs(e.height) > 100
        )
          fail(
            "WORLD_EDIT",
            "Vertex indices must address the chunk grid; height must be finite in [-100,100].",
          );
        return {
          vertex: [
            e.chunk[0] * config.cellsPerChunk + e.x,
            e.chunk[1] * config.cellsPerChunk + e.z,
          ] as ChunkCoord,
          height: e.height,
        };
      });
      await enqueue(async () => {
        const next = nextState(),
          affected = new Map<string, ChunkCoord>();
        for (const e of validated) {
          next.edits.set(key(e.vertex), e.height);
          for (const c of affectedChunks(e.vertex, config))
            affected.set(key(c), c);
        }
        if (!affected.size) return;
        for (const [id, c] of affected) {
          const version = (next.revisions.get(id) ?? 0) + 1;
          next.revisions.set(id, version);
          if (next.chunks.has(id))
            next.chunks.set(id, buildChunk(c, version, config, next.edits));
        }
        if (await publish(next, "edit"))
          for (const c of affected.values()) bump(c, "stale");
      });
    },
    async setOrigin(nextOrigin) {
      alive();
      assertOrigin(nextOrigin, config);
      const o = clone(nextOrigin);
      await enqueue(async () => {
        const next = nextState();
        next.origin = o;
        await publish(next, "origin");
      });
    },
    snapshot,
    async restore(input) {
      alive();
      const next = parseSnapshot(input);
      await enqueue(async () => {
        if (await publish(next, "restore"))
          for (const [id] of pending)
            bump(id.split(":").map(Number) as ChunkCoord, "stale");
      });
    },
    inspect() {
      const r = render.read(),
        p = physics.read(),
        n = nav.read(),
        mismatches: string[] = [];
      if (!disposed) {
        if (r.epoch !== epoch || p.epoch !== epoch || n.epoch !== epoch)
          mismatches.push("epoch");
        const expected = [...state.chunks.values()]
          .map((c) => ({ id: c.id, version: c.version }))
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const [name, list] of [
          ["render", r.chunks],
          ["physics", p.chunks],
          ["nav", n.versions],
        ] as const) {
          const actual = list
            .map((c) => ({ id: c.id, version: c.version }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            mismatches.push(name);
        }
      }
      return {
        disposed,
        faulted,
        epoch,
        origin: clone(state.origin),
        resident: [...state.chunks.values()].map((c) => ({
          id: c.id,
          version: c.version,
        })),
        pending: [...pending].map(([id, p]) => ({
          id: `chunk:${id}`,
          generation: p.generation,
        })),
        persistentEdits: state.edits.size,
        persistentRevisions: state.revisions.size,
        consumers: {
          renderEpoch: r.epoch,
          physicsEpoch: p.epoch,
          navEpoch: n.epoch,
          consistent: !faulted && !mismatches.length,
          mismatches,
        },
        metrics: clone(metrics),
        resources: {
          residentHeightValues: [...state.chunks.values()].reduce(
            (sum, c) => sum + c.heights.length,
            0,
          ),
          renderScalars: r.chunks.reduce(
            (sum, c) => sum + c.positions.length + c.indices.length,
            0,
          ),
          collisionHeightValues: p.chunks.reduce(
            (sum, c) => sum + c.heights.length,
            0,
          ),
          navNodes: n.nodes.length,
          navEdges: n.nodes.reduce(
            (sum, node) => sum + node.neighbors.length,
            0,
          ),
        },
      };
    },
    getRenderState() {
      alive();
      return clone(render.read());
    },
    getCollisionState() {
      alive();
      return clone(physics.read());
    },
    getNavigationState() {
      alive();
      return clone(nav.read());
    },
    sampleHeight(point) {
      alive();
      pointValid(point);
      const normalized = normalizePoint(point, config);
      const c = physics
        .read()
        .chunks.find((c) => key(c.coord) === key(normalized.chunk));
      if (!c) return null;
      return {
        height: heightAt(
          c.heights,
          c.cells,
          normalized.local[0] / c.cellSize,
          normalized.local[2] / c.cellSize,
        ),
        chunkId: c.id,
        version: c.version,
      };
    },
    findPath(start: NavigationAddress, goal: NavigationAddress) {
      alive();
      for (const a of [start, goal])
        if (
          !a ||
          !coordValid(a.chunk) ||
          !vector(a.cell, 2) ||
          a.cell.some(
            (v) => !Number.isInteger(v) || v < 0 || v >= config.cellsPerChunk,
          )
        )
          fail(
            "WORLD_NAV",
            "Expected a chunk and an integer cell inside its grid.",
          );
      const n = nav.read(),
        nodes = new Map(n.nodes.map((node) => [node.id, node])),
        source = navId(start),
        target = navId(goal);
      if (!nodes.has(source) || !nodes.has(target))
        return { epoch, found: false, visited: 0, nodes: [] };
      const queue = [source],
        parents = new Map<string, string | null>([[source, null]]);
      let head = 0;
      while (head < queue.length) {
        const id = queue[head++];
        if (id === target) break;
        for (const neighbor of nodes.get(id)!.neighbors)
          if (!parents.has(neighbor)) {
            parents.set(neighbor, id);
            queue.push(neighbor);
          }
      }
      if (!parents.has(target))
        return { epoch, found: false, visited: head, nodes: [] };
      const path: string[] = [];
      for (let id: string | null = target; id !== null; id = parents.get(id)!)
        path.push(id);
      return {
        epoch,
        found: true,
        visited: head,
        nodes: clone(path.reverse().map((id) => nodes.get(id)!)),
      };
    },
    toLocal(point) {
      alive();
      pointValid(point);
      return localPoint(point, state.origin, config);
    },
    fromLocal(point: Vec3) {
      alive();
      if (!vector(point, 3) || point.some((v) => Math.abs(v) > 1e9))
        fail("WORLD_POINT", "Expected finite origin-local XYZ.");
      const p = normalizePoint(
        {
          chunk: [...state.origin.chunk],
          local: point.map((v, i) => v + state.origin.offset[i]) as Vec3,
        },
        config,
      );
      if (!coordValid(p.chunk))
        fail("WORLD_POINT", "Converted coordinate exceeds prototype range.");
      return p;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id] of pending)
        bump(id.split(":").map(Number) as ChunkCoord, "cancelled");
      for (const adapter of adapters) {
        try {
          adapter.dispose?.();
        } catch {
          faulted = true;
        }
      }
      state.chunks.clear();
      state.edits.clear();
      state.revisions.clear();
      generations.clear();
    },
  };
}
