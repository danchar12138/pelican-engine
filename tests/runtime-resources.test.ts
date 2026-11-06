import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createResourceManager,
  ResourceError,
  type ResourceHandle,
  type ResourceSnapshot,
} from "../packages/runtime/src/resources.ts";

interface Resources {
  binary: {
    descriptor: { url: string; options?: { a?: number; b?: number } };
    value: Uint8Array;
  };
  text: { descriptor: { url: string }; value: string };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof ResourceError && error.code === expected;
}
function gated() {
  const manager = createResourceManager<Resources>();
  const calls: {
    descriptor: Resources["binary"]["descriptor"];
    signal: AbortSignal;
    gate: ReturnType<typeof deferred<Uint8Array>>;
  }[] = [];
  const disposed: Uint8Array[] = [];
  manager.registerLoader("binary", {
    load(descriptor, signal) {
      const gate = deferred<Uint8Array>();
      calls.push({ descriptor, signal, gate });
      return gate.promise;
    },
    dispose(value) {
      disposed.push(value);
    },
    estimateBytes(value) {
      return value.byteLength;
    },
  });
  return { manager, calls, disposed };
}
const snap = (resources: ResourceSnapshot["resources"]): ResourceSnapshot => ({
  format: "pelican.resources",
  version: 1,
  resources,
});
const item = (
  key: string,
  url = key,
  state: "pending" | "loaded" = "loaded",
) => ({ type: "binary", key, descriptor: { url }, state });

// Compile-only assertions: no index signature is needed and values retain their type.
function typeContract() {
  const manager = createResourceManager<Resources>();
  const scope = manager.createScope();
  const value: Uint8Array = manager.get({
    manager: 1,
    index: 0,
    generation: 1,
    type: "binary",
  });
  void value;
  // @ts-expect-error unknown type must not compile
  void manager.acquire("texture", "x", {}, scope);
  // @ts-expect-error descriptor must match resource type
  void manager.acquire("binary", "x", { path: "wrong" }, scope);
  // @ts-expect-error binary does not return a string
  const text: string = manager.get({
    manager: 1,
    index: 0,
    generation: 1,
    type: "binary",
  });
  void text;
}
void typeContract;

describe("M1 disposal, inspection and stable diagnostics", () => {
  it("continues disposing every owned resource after sync throw and async rejection", async () => {
    const manager = createResourceManager();
    const attempts: number[] = [];
    manager.registerLoader("bad-sync", {
      load: () => 1,
      dispose(value) {
        attempts.push(value as number);
        throw new Error("PRIVATE_TOKEN_SYNC");
      },
    });
    manager.registerLoader("bad-async", {
      load: () => 2,
      async dispose(value) {
        attempts.push(value as number);
        await tick();
        throw new Error("PRIVATE_TOKEN_ASYNC");
      },
    });
    manager.registerLoader("good", {
      load: () => 3,
      async dispose(value) {
        await tick();
        attempts.push(value as number);
      },
    });
    const scope = manager.createScope();
    await Promise.all(
      ["bad-sync", "bad-async", "good"].map((type) =>
        manager.acquire(type, type, {}, scope),
      ),
    );
    await manager.dispose();
    await manager.dispose();
    await scope.release();
    await manager.whenIdle();
    assert.deepEqual(attempts.sort(), [1, 2, 3]);
    const stats = manager.inspect();
    assert.equal(stats.owned.entries, 0);
    assert.equal(stats.owned.references, 0);
    assert.equal(stats.owned.scopes, 0);
    assert.equal(stats.counters.disposalsStarted, 3);
    assert.equal(stats.counters.disposalsCompleted, 1);
    assert.equal(stats.counters.disposalsFailed, 2);
    assert.equal(
      manager
        .getDiagnostics()
        .filter((d) => d.code === "TC_RESOURCE_DISPOSE_FAILED").length,
      2,
    );
    assert.ok(
      !JSON.stringify(manager.getDiagnostics()).includes("PRIVATE_TOKEN"),
    );
  });
  it("tracks ongoing asynchronous disposal and manager.dispose awaits already-started cleanup", async () => {
    const manager = createResourceManager<Resources>(),
      gate = deferred<void>();
    manager.registerLoader("binary", {
      load: () => new Uint8Array(9),
      dispose: () => gate.promise,
    });
    const scope = manager.createScope(),
      lease = await manager.acquire("binary", "x", { url: "x" }, scope);
    const releasing = lease.release();
    assert.equal(releasing, lease.release());
    assert.equal(manager.inspect().owned.inFlightDisposals, 1);
    assert.equal(manager.inspect().owned.entries, 0);
    let completed = false;
    const closing = manager.dispose().then(() => {
      completed = true;
    });
    await tick();
    assert.equal(completed, false);
    gate.resolve();
    await releasing;
    await closing;
    await manager.whenIdle();
    assert.equal(manager.inspect().owned.inFlightDisposals, 0);
  });
  it("keeps unknown estimates distinct from a legitimate zero byte resource", async () => {
    const manager = createResourceManager();
    const scope = manager.createScope();
    manager.registerLoader("unknown", { load: () => null, dispose() {} });
    manager.registerLoader("zero", {
      load: () => null,
      dispose() {},
      estimateBytes: () => 0,
    });
    manager.registerLoader("known", {
      load: () => null,
      dispose() {},
      estimateBytes: () => 10,
    });
    for (const type of ["unknown", "zero", "known"])
      await manager.acquire(type, "x", {}, scope);
    const stats = manager.inspect();
    assert.deepEqual(stats.bytes, {
      status: "unknown",
      knownBytes: 10,
      unknownEntries: 1,
    });
    assert.deepEqual(stats.entries.find((e) => e.type === "zero")!.bytes, {
      status: "known",
      value: 0,
    });
    await manager.dispose();
  });
  it("makes invalid and throwing estimates unknown without losing otherwise valid values", async () => {
    const manager = createResourceManager();
    const scope = manager.createScope();
    const estimates = [NaN, -1, Infinity, 1.5, undefined];
    for (const [index, estimate] of estimates.entries()) {
      manager.registerLoader(String(index), {
        load: () => 7,
        dispose() {},
        estimateBytes: () => estimate,
      });
      const lease = await manager.acquire(String(index), "x", {}, scope);
      assert.equal(manager.get(lease.handle), 7);
    }
    manager.registerLoader("throwing", {
      load: () => 8,
      dispose() {},
      estimateBytes() {
        throw new Error("private estimate");
      },
    });
    await manager.acquire("throwing", "x", {}, scope);
    assert.equal(manager.inspect().bytes.unknownEntries, 6);
    assert.equal(
      manager
        .getDiagnostics()
        .filter((d) => d.code === "TC_RESOURCE_ESTIMATE_FAILED").length,
      5,
    );
    await manager.dispose();
  });
  it("reports stable codes/modes and redacts URL credentials, query, fragment and loader errors", async () => {
    const manager = createResourceManager();
    manager.registerLoader("binary", {
      load() {
        throw new Error("AUTHORIZATION=secret-error");
      },
      dispose() {},
    });
    const key =
      "https://user:secret-password@example.test/asset?token=secret-query#secret-fragment";
    await assert.rejects(
      manager.acquire(
        "binary",
        key,
        { token: "secret-descriptor" },
        manager.createScope(),
      ),
      code("TC_RESOURCE_LOAD_FAILED"),
    );
    const diagnostic = manager
      .getDiagnostics()
      .find((d) => d.code === "TC_RESOURCE_LOAD_FAILED")!;
    assert.equal(diagnostic.type, "binary");
    assert.equal(diagnostic.mode, "load");
    assert.equal(diagnostic.key, "https://[redacted]@example.test/asset");
    const logs = JSON.stringify([
      manager.getDiagnostics(),
      manager.getEvents(),
    ]);
    for (const secret of [
      "secret-password",
      "secret-query",
      "secret-fragment",
      "secret-error",
      "secret-descriptor",
    ])
      assert.equal(logs.includes(secret), false);
    await manager.dispose();
  });
  it("bounds histories and isolates failed observers without breaking cleanup", async () => {
    const manager = createResourceManager({ historyLimit: 3 });
    let observed = 0;
    manager.registerLoader("data", { load: () => null, dispose() {} });
    const unsubscribe = manager.subscribe(() => {
      observed++;
    });
    manager.subscribe(() => {
      throw new Error("secret observer");
    });
    const scope = manager.createScope();
    await manager.acquire("data", "x", {}, scope);
    await scope.release();
    assert.ok(observed >= 3);
    unsubscribe();
    assert.equal(
      manager.getDiagnostics()[0]!.code,
      "TC_RESOURCE_OBSERVER_FAILED",
    );
    assert.equal(manager.getEvents().length, 3);
    const sequences = manager.getEvents().map((e) => e.sequence);
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
    );
    const copy = manager.getDiagnostics();
    (copy[0] as { code: string }).code = "tampered";
    assert.equal(
      manager.getDiagnostics()[0]!.code,
      "TC_RESOURCE_OBSERVER_FAILED",
    );
    await manager.dispose();
    const noHistory = createResourceManager({ historyLimit: 0 });
    assert.throws(
      () => noHistory.get({ manager: 1, index: 0, generation: 0, type: "x" }),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    assert.deepEqual(noHistory.getDiagnostics(), []);
    await noHistory.dispose();
    assert.throws(
      () => createResourceManager({ historyLimit: -1 }),
      RangeError,
    );
  });
  it("has idempotent disposal under an observer reentering manager/scope release", async () => {
    const manager = createResourceManager();
    let releases = 0;
    manager.registerLoader("data", {
      load: () => 1,
      dispose() {
        releases++;
      },
    });
    const scope = manager.createScope();
    await manager.acquire("data", "x", {}, scope);
    const closing: Promise<void>[] = [];
    manager.subscribe((event) => {
      if (event.code === "TC_RESOURCE_RELEASED") {
        closing.push(manager.dispose());
        closing.push(scope.release());
      }
    });
    const first = manager.dispose();
    await first;
    await Promise.all(closing);
    assert.equal(releases, 1);
    assert.equal(manager.dispose(), first);
    assert.equal(closing[0], first);
  });
  it("validates registration, identities and authentic scopes", async () => {
    const manager = createResourceManager();
    const foreign = createResourceManager();
    const scope = manager.createScope();
    assert.throws(
      () => manager.registerLoader("x", null as never),
      code("TC_RESOURCE_INVALID_LOADER"),
    );
    manager.registerLoader("x", { load: () => null, dispose() {} });
    assert.throws(
      () => manager.registerLoader("x", { load: () => null, dispose() {} }),
      code("TC_RESOURCE_LOADER_EXISTS"),
    );
    await assert.rejects(
      manager.acquire("missing", "x", {}, scope),
      code("TC_RESOURCE_LOADER_MISSING"),
    );
    await assert.rejects(
      manager.acquire("x", "", {}, scope),
      code("TC_RESOURCE_INVALID_IDENTITY"),
    );
    await assert.rejects(
      manager.acquire("x", "x", {}, foreign.createScope()),
      code("TC_RESOURCE_INVALID_SCOPE"),
    );
    await assert.rejects(
      manager.acquire("x", "x", {}, { ...scope }),
      code("TC_RESOURCE_INVALID_SCOPE"),
    );
    await manager.dispose();
    await foreign.dispose();
    assert.throws(
      () => manager.registerLoader("y", { load: () => null, dispose() {} }),
      code("TC_RESOURCE_DISPOSED"),
    );
  });
});

describe("M1 real loader integration and measured lifecycle", () => {
  it("loads a real temporary binary, shares it, rebuilds identity and repeats 200 ownership cycles", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pelican resources 中文 "));
    const path = join(root, "asset binary.bin");
    const expected = Uint8Array.from({ length: 8192 }, (_v, i) => i % 251);
    let loaded = 0,
      disposed = 0;
    const manager = createResourceManager<Resources>({ historyLimit: 8 });
    manager.registerLoader("binary", {
      async load(descriptor, signal) {
        const bytes = await readFile(descriptor.url, { signal });
        loaded++;
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      dispose(value) {
        disposed++;
        value.fill(0);
      },
      estimateBytes: (value) => value.byteLength,
    });
    try {
      await writeFile(path, expected);
      const started = performance.now();
      let previous: ResourceHandle<"binary"> | undefined;
      for (let cycle = 0; cycle < 200; cycle++) {
        const a = manager.createScope("scene"),
          b = manager.createScope("stream");
        const [first, second] = await Promise.all([
          manager.acquire("binary", "binary", { url: path }, a),
          manager.acquire("binary", "binary", { url: path }, b),
        ]);
        assert.deepEqual(manager.get(first.handle), expected);
        assert.equal(manager.get(first.handle), manager.get(second.handle));
        if (previous)
          assert.throws(
            () => manager.get(previous!),
            code("TC_RESOURCE_STALE_HANDLE"),
          );
        assert.equal(manager.inspect().bytes.knownBytes, 8192);
        const serialized = JSON.stringify(manager.snapshot());
        assert.ok(!serialized.includes('"value"'));
        await a.release();
        assert.equal(manager.get(second.handle)[1], expected[1]);
        previous = first.handle;
        await b.release();
        assert.equal(manager.inspect().owned.entries, 0);
        if (cycle === 0) {
          const target = manager.createScope("restored");
          const leases = await manager.restore(JSON.parse(serialized), target);
          assert.deepEqual(manager.get(leases[0]!.handle), expected);
          await target.release();
        }
      }
      await manager.dispose();
      await manager.whenIdle();
      const stats = manager.inspect();
      assert.equal(loaded, 201);
      assert.equal(disposed, 201);
      assert.equal(stats.counters.loadsStarted, 201);
      assert.equal(stats.counters.disposalsCompleted, 201);
      assert.equal(stats.counters.peakEntries, 1);
      assert.deepEqual(stats.owned, {
        entries: 0,
        pending: 0,
        loaded: 0,
        references: 0,
        scopes: 0,
        inFlightLoads: 0,
        inFlightDisposals: 0,
      });
      t.diagnostic(
        JSON.stringify({
          cycles: 200,
          payloadBytes: 8192,
          physicalReads: loaded,
          disposals: disposed,
          wallMs: performance.now() - started,
          owned: stats.owned,
          counters: stats.counters,
          measurement:
            "Owned payload/counters only; not an OS, heap, driver or GPU leak audit.",
        }),
      );
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("integrates compiled IR JSON, dynamic game module and binary loaders with one content scope", async () => {
    interface HostResources {
      json: { descriptor: { url: string }; value: unknown };
      module: {
        descriptor: { url: string };
        value: {
          createGame: (facade: { offset: number }) => { value: number };
        };
      };
      binary: Resources["binary"];
    }
    const root = await mkdtemp(join(tmpdir(), "pelican host integration "));
    const manager = createResourceManager<HostResources>();
    const released: string[] = [];
    manager.registerLoader("json", {
      async load(d, signal) {
        return JSON.parse(
          await readFile(d.url, { encoding: "utf8", signal }),
        ) as unknown;
      },
      dispose() {
        released.push("json");
      },
    });
    manager.registerLoader("module", {
      async load(d, signal) {
        if (signal.aborted) throw new Error("cancelled before import");
        const result = (await import(
          d.url
        )) as HostResources["module"]["value"];
        // Return imported ownership to manager even if cancellation happened while import ran.
        // Manager will dispose stale values; native module cache is outside its ownership.
        return result;
      },
      dispose() {
        released.push("module");
      },
    });
    manager.registerLoader("binary", {
      async load(d, signal) {
        return readFile(d.url, { signal });
      },
      dispose() {
        released.push("binary");
      },
      estimateBytes: (v) => v.byteLength,
    });
    try {
      const jsonPath = join(root, "compiled-ir.json"),
        binaryPath = join(root, "mesh.bin");
      await writeFile(
        jsonPath,
        JSON.stringify({ version: 1, scene: "sample" }),
      );
      await writeFile(binaryPath, new Uint8Array([3, 5, 8]));
      const moduleURL =
        "data:text/javascript," +
        encodeURIComponent(
          "export function createGame(facade) { return { value: facade.offset + 7 }; }",
        );
      const scope = manager.createScope("compiled-content");
      const [ir, game, mesh] = await Promise.all([
        manager.acquire("json", "scene", { url: jsonPath }, scope),
        manager.acquire("module", "game", { url: moduleURL }, scope),
        manager.acquire("binary", "mesh", { url: binaryPath }, scope),
      ]);
      assert.deepEqual(manager.get(ir.handle), { version: 1, scene: "sample" });
      assert.deepEqual(manager.get(game.handle).createGame({ offset: 10 }), {
        value: 17,
      });
      assert.deepEqual([...manager.get(mesh.handle)], [3, 5, 8]);
      const snapshot = manager.snapshot(scope);
      assert.equal(snapshot.resources.length, 3);
      assert.equal(
        snapshot.resources.every((r) => r.state === "loaded"),
        true,
      );
      assert.ok(!JSON.stringify(snapshot).includes('"createGame"'));
      assert.equal(manager.inspect().bytes.status, "unknown");
      assert.equal(manager.inspect().bytes.knownBytes, 3);
      await scope.release();
      assert.deepEqual(released.sort(), ["binary", "json", "module"]);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("M1 descriptor-only snapshots and transactional reconstruction", () => {
  it("snapshots pending work without pretending its value is loaded and rebuilds it", async () => {
    const original = gated();
    const owner = original.manager.createScope("compiled-content");
    const pending = original.manager.acquire(
      "binary",
      "pending",
      { url: "p" },
      owner,
    );
    const rejected = assert.rejects(pending, code("TC_RESOURCE_CANCELLED"));
    const snapshot = original.manager.snapshot(owner);
    assert.equal(snapshot.resources[0]!.state, "pending");
    assert.equal(JSON.stringify(snapshot).includes("generation"), false);
    assert.throws(
      () =>
        original.manager.get(
          original.manager.inspect().entries[0]!
            .handle as ResourceHandle<"binary">,
        ),
      code("TC_RESOURCE_NOT_READY"),
    );
    await owner.release();
    await rejected;
    await original.manager.whenIdle();
    await original.manager.dispose();
    const rebuilt = gated();
    const target = rebuilt.manager.createScope();
    const restored = rebuilt.manager.restore(
      JSON.parse(JSON.stringify(snapshot)),
      target,
    );
    assert.equal(rebuilt.manager.snapshot().resources[0]!.state, "pending");
    await tick();
    rebuilt.calls[0]!.gate.resolve(new Uint8Array([6]));
    const leases = await restored;
    const rebuiltValue = rebuilt.manager.get(leases[0]!.handle);
    assert.ok(rebuiltValue instanceof Uint8Array);
    assert.equal(rebuiltValue.byteLength, 1);
    assert.equal(rebuilt.manager.snapshot().resources[0]!.state, "loaded");
    assert.equal(rebuilt.manager.inspect().owned.scopes, 1);
    await target.release();
    assert.equal(rebuilt.disposed.length, 1);
    await rebuilt.manager.dispose();
  });
  it("deduplicates scope identities, sorts snapshots, deep-copies descriptors, and excludes opaque values", async () => {
    const manager = createResourceManager();
    const gpuLike = {
      texture: new Uint8Array([9]),
      execute() {
        return 42;
      },
      self: null as unknown,
    };
    gpuLike.self = gpuLike;
    manager.registerLoader("opaque", { load: () => gpuLike, dispose() {} });
    const scope = manager.createScope();
    await manager.acquire("opaque", "z", { nested: { b: 2, a: 1 } }, scope);
    await manager.acquire("opaque", "a", { nested: { b: 2, a: 1 } }, scope);
    await manager.acquire("opaque", "a", { nested: { a: 1, b: 2 } }, scope);
    const snapshot = manager.snapshot(scope);
    assert.deepEqual(
      snapshot.resources.map((r) => r.key),
      ["a", "z"],
    );
    assert.equal(manager.inspect().owned.references, 3);
    assert.ok(!JSON.stringify(snapshot).includes("execute"));
    (snapshot.resources[0]!.descriptor as { nested: { a: number } }).nested.a =
      99;
    assert.equal(
      (
        manager.snapshot(scope).resources[0]!.descriptor as {
          nested: { a: number };
        }
      ).nested.a,
      1,
    );
    assert.equal(
      JSON.stringify(manager.snapshot(scope)),
      JSON.stringify(manager.snapshot(scope)),
    );
    await manager.dispose();
  });
  it("validates the entire restore before changing the only live state", async () => {
    const manager = createResourceManager<Resources>();
    let loads = 0;
    manager.registerLoader("binary", {
      load: () => {
        loads++;
        return new Uint8Array([42]);
      },
      dispose() {},
    });
    const scope = manager.createScope();
    const original = await manager.acquire(
      "binary",
      "existing",
      { url: "original" },
      scope,
    );
    const before = manager.snapshot();
    await assert.rejects(
      manager.restore(
        snap([item("would-load"), item("existing", "conflict")]),
        scope,
      ),
      code("TC_RESOURCE_DESCRIPTOR_CONFLICT"),
    );
    assert.equal(loads, 1);
    assert.deepEqual(manager.snapshot(), before);
    assert.equal(manager.get(original.handle)[0], 42);
    assert.equal(manager.inspect().owned.references, 1);
    const missing = snap([
      item("would-load"),
      { ...item("missing"), type: "unregistered" },
    ]);
    await assert.rejects(
      manager.restore(missing, scope),
      code("TC_RESOURCE_LOADER_MISSING"),
    );
    assert.equal(loads, 1);
    await manager.dispose();
  });
  it("rejects malformed, duplicate and ambiguous snapshots without destroying live resources", async () => {
    const manager = createResourceManager<Resources>();
    manager.registerLoader("binary", {
      load: () => new Uint8Array(1),
      dispose() {},
    });
    const scope = manager.createScope();
    const original = await manager.acquire(
      "binary",
      "safe",
      { url: "safe" },
      scope,
    );
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...snap([]), version: 2 },
      { ...snap([]), extra: true },
      snap([item("x"), item("x")]),
      snap([item("x", "a", "pending"), item("x", "b", "loaded")]),
      { ...snap([]), resources: [{ ...item("x"), state: "failed" }] },
      { ...snap([]), resources: [{ ...item("x"), handle: { index: 1 } }] },
      {
        ...snap([]),
        resources: [{ type: "binary", key: "x", state: "loaded" }],
      },
      { ...snap([]), resources: [{ ...item("x"), descriptor: undefined }] },
      { ...snap([]), resources: [{ ...item("x"), key: "" }] },
    ];
    for (const bad of invalid) {
      await assert.rejects(
        manager.restore(bad, scope),
        code("TC_RESOURCE_INVALID_SNAPSHOT"),
      );
      assert.equal(manager.inspect().owned.references, 1);
      assert.equal(manager.get(original.handle).length, 1);
    }
    await manager.dispose();
  });
  it("rolls back successful and pending transaction references on another loader failure", async () => {
    const manager = createResourceManager<Resources>();
    const gates = new Map<string, ReturnType<typeof deferred<Uint8Array>>>();
    const released: Uint8Array[] = [];
    manager.registerLoader("binary", {
      load(d) {
        const gate = deferred<Uint8Array>();
        gates.set(d.url, gate);
        return gate.promise;
      },
      dispose(v) {
        released.push(v);
      },
    });
    const scope = manager.createScope();
    const live = manager.acquire("binary", "live", { url: "live" }, scope);
    await tick();
    gates.get("live")!.resolve(new Uint8Array([1]));
    const original = await live;
    const restoration = manager.restore(
      snap([item("live"), item("ok"), item("bad"), item("late")]),
      scope,
    );
    const rejection = assert.rejects(
      restoration,
      code("TC_RESOURCE_LOAD_FAILED"),
    );
    await tick();
    const ok = new Uint8Array([2]);
    gates.get("ok")!.resolve(ok);
    await tick();
    gates.get("bad")!.reject(new Error("expected transport failure"));
    await rejection;
    assert.equal(manager.inspect().owned.entries, 1);
    assert.equal(manager.inspect().owned.references, 1);
    assert.equal(manager.inspect().owned.scopes, 1);
    assert.equal(manager.get(original.handle)[0], 1);
    const late = new Uint8Array([3]);
    gates.get("late")!.resolve(late);
    await manager.whenIdle();
    assert.ok(released.includes(ok) && released.includes(late));
    await manager.dispose();
    assert.equal(released.length, 3);
  });
  it("rolls back restore cancellation even after loaded leases stopped listening to acquire signals", async () => {
    const manager = createResourceManager<Resources>();
    let released = 0;
    manager.registerLoader("binary", {
      load: () => new Uint8Array(1),
      dispose() {
        released++;
      },
    });
    const scope = manager.createScope(),
      controller = new AbortController();
    const unsubscribe = manager.subscribe((event) => {
      if (event.code === "TC_RESOURCE_LOADED") controller.abort();
    });
    await assert.rejects(
      manager.restore(snap([item("x")]), scope, { signal: controller.signal }),
      code("TC_RESOURCE_CANCELLED"),
    );
    assert.equal(manager.inspect().owned.references, 0);
    assert.equal(released, 1);
    unsubscribe();
    await manager.dispose();
  });
  it("cancels restoration if its target scope closes while loading", async () => {
    const { manager, calls, disposed } = gated();
    const scope = manager.createScope();
    const restoration = manager.restore(snap([item("x")]), scope);
    const rejection = assert.rejects(
      restoration,
      code("TC_RESOURCE_CANCELLED"),
    );
    await tick();
    await scope.release();
    await rejection;
    assert.equal(calls[0]!.signal.aborted, true);
    calls[0]!.gate.resolve(new Uint8Array(1));
    await manager.whenIdle();
    assert.equal(disposed.length, 1);
    await manager.dispose();
  });
  it("adds references instead of overwriting valid state and transfers ownership to target scope", async () => {
    const manager = createResourceManager<Resources>();
    let loads = 0,
      releases = 0;
    manager.registerLoader("binary", {
      load: () => {
        loads++;
        return new Uint8Array(1);
      },
      dispose() {
        releases++;
      },
    });
    const scope = manager.createScope();
    const original = await manager.acquire("binary", "x", { url: "x" }, scope);
    const leases = await manager.restore(manager.snapshot(), scope);
    assert.equal(loads, 1);
    assert.equal(manager.inspect().owned.references, 2);
    assert.deepEqual(leases[0]!.handle, original.handle);
    assert.equal(manager.inspect().owned.scopes, 1);
    await original.release();
    assert.equal(releases, 0);
    await scope.release();
    assert.equal(releases, 1);
    assert.equal(leases[0]!.released, true);
    await manager.dispose();
  });
  it("restoring a loaded snapshot reloads the descriptor rather than serializing its value", async () => {
    const first = createResourceManager<Resources>();
    first.registerLoader("text", { load: () => "old value", dispose() {} });
    await first.acquire(
      "text",
      "script",
      { url: "game.js" },
      first.createScope(),
    );
    const snapshot = first.snapshot();
    await first.dispose();
    assert.ok(!JSON.stringify(snapshot).includes("old value"));
    const second = createResourceManager<Resources>();
    second.registerLoader("text", {
      load: () => "new value from descriptor",
      dispose() {},
    });
    const leases = await second.restore(snapshot, second.createScope());
    assert.equal(second.get(leases[0]!.handle), "new value from descriptor");
    await second.dispose();
  });
});

describe("M1 safe descriptor identities", () => {
  it("rejects lossy JSON values, cycles, accessors, sparse arrays and opaque objects without reading them", async () => {
    const manager = createResourceManager();
    let loads = 0,
      getterCalls = 0;
    manager.registerLoader("data", {
      load() {
        loads++;
        return null;
      },
      dispose() {},
    });
    const scope = manager.createScope();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    });
    const invalid: unknown[] = [
      undefined,
      NaN,
      Infinity,
      BigInt(2),
      () => 0,
      new Date(),
      new Uint8Array(1),
      { a: undefined },
      { a: Symbol() },
      cyclic,
      getter,
      new Array(2),
      Object.assign([], { extra: 1 }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol()]: 1 },
      {
        toJSON() {
          getterCalls++;
          return {};
        },
      },
    ];
    for (const bad of invalid)
      await assert.rejects(
        manager.acquire("data", "bad", bad, scope),
        code("TC_RESOURCE_INVALID_DESCRIPTOR"),
      );
    assert.equal(loads, 0);
    assert.equal(getterCalls, 0);
    assert.equal(manager.inspect().owned.entries, 0);
    await manager.dispose();
  });
  it("accepts repeated acyclic branches, null prototype and __proto__ as plain data", async () => {
    const manager = createResourceManager();
    let loads = 0;
    manager.registerLoader("data", {
      load() {
        loads++;
        return null;
      },
      dispose() {},
    });
    const scope = manager.createScope();
    const repeated = { x: 1 };
    const a = await manager.acquire(
      "data",
      "x",
      { a: repeated, b: repeated },
      scope,
    );
    const b = await manager.acquire(
      "data",
      "x",
      { b: { x: 1 }, a: { x: 1 } },
      scope,
    );
    assert.deepEqual(a.handle, b.handle);
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.x = 1;
    await manager.acquire("data", "n", nullProto, scope);
    await manager.acquire("data", "n", { x: 1 }, scope);
    const proto = JSON.parse('{"__proto__":{"polluted":true}}');
    await manager.acquire("data", "proto", proto, scope);
    assert.equal(
      JSON.stringify(manager.snapshot()).includes('"__proto__"'),
      true,
    );
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.equal(loads, 3);
    await manager.dispose();
  });
  it("normalizes negative zero and accepts all ordinary JSON scalar descriptors", async () => {
    const manager = createResourceManager();
    let loads = 0;
    manager.registerLoader("data", {
      load() {
        loads++;
        return undefined;
      },
      dispose() {},
    });
    const scope = manager.createScope();
    const a = await manager.acquire("data", "number", -0, scope),
      b = await manager.acquire("data", "number", 0, scope);
    assert.deepEqual(a.handle, b.handle);
    for (const [index, value] of [
      null,
      true,
      false,
      "",
      [1, "x", null],
    ].entries())
      await manager.acquire("data", String(index), value, scope);
    assert.equal(loads, 6);
    assert.equal(manager.get(a.handle), undefined);
    await manager.dispose();
  });
});

describe("M1 resource sharing and typed ownership", () => {
  it("coalesces pending acquisitions across scopes, keeps refs, and disposes exactly once", async () => {
    const { manager, calls, disposed } = gated();
    const a = manager.createScope(),
      b = manager.createScope();
    const pa = manager.acquire("binary", "same", { url: "a" }, a);
    const pb = manager.acquire("binary", "same", { url: "a" }, b);
    assert.equal(manager.inspect().owned.pending, 1);
    assert.equal(manager.inspect().owned.references, 2);
    assert.equal(manager.inspect().bytes.status, "unknown");
    await tick();
    assert.equal(calls.length, 1);
    const data = new Uint8Array([1, 2, 3]);
    calls[0]!.gate.resolve(data);
    const [la, lb] = await Promise.all([pa, pb]);
    assert.deepEqual(la.handle, lb.handle);
    assert.equal(manager.get(la.handle), data);
    assert.equal(manager.inspect().bytes.status, "known");
    assert.equal(manager.inspect().bytes.knownBytes, 3);
    await a.release();
    assert.equal(la.released, true);
    assert.equal(lb.released, false);
    assert.equal(manager.get(lb.handle), data);
    assert.equal(disposed.length, 0);
    await lb.release();
    await b.release();
    await manager.dispose();
    await manager.whenIdle();
    assert.deepEqual(disposed, [data]);
    assert.equal(manager.inspect().owned.references, 0);
  });
  it("shares a loaded entry and gives independent leases within one scope", async () => {
    const { manager, calls, disposed } = gated();
    const scope = manager.createScope();
    const p = manager.acquire("binary", "x", { url: "x" }, scope);
    await tick();
    calls[0]!.gate.resolve(new Uint8Array(4));
    const first = await p;
    const second = await manager.acquire("binary", "x", { url: "x" }, scope);
    assert.notEqual(first, second);
    assert.equal(manager.inspect().owned.references, 2);
    assert.equal(calls.length, 1);
    await first.release();
    await first.release();
    assert.equal(manager.inspect().owned.references, 1);
    assert.equal(manager.get(second.handle).byteLength, 4);
    await scope.release();
    assert.equal(disposed.length, 1);
    await manager.dispose();
  });
  it("canonicalizes nested descriptor key order and protects it from caller mutation", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope();
    const descriptor = { url: "x", options: { b: 2, a: 1 } };
    const a = manager.acquire("binary", "x", descriptor, scope);
    descriptor.url = "mutated";
    descriptor.options.a = 99;
    const b = manager.acquire(
      "binary",
      "x",
      { options: { a: 1, b: 2 }, url: "x" },
      scope,
    );
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.descriptor, {
      options: { a: 1, b: 2 },
      url: "x",
    });
    assert.ok(Object.isFrozen(calls[0]!.descriptor.options));
    calls[0]!.gate.resolve(new Uint8Array(1));
    await Promise.all([a, b]);
    await scope.release();
    await manager.dispose();
  });
  it("rejects descriptor conflicts both while pending and loaded without changing refs", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope();
    const p = manager.acquire("binary", "x", { url: "first" }, scope);
    await assert.rejects(
      manager.acquire("binary", "x", { url: "second" }, scope),
      code("TC_RESOURCE_DESCRIPTOR_CONFLICT"),
    );
    assert.equal(manager.inspect().owned.references, 1);
    await tick();
    calls[0]!.gate.resolve(new Uint8Array(1));
    await p;
    await assert.rejects(
      manager.acquire("binary", "x", { url: "second" }, scope),
      code("TC_RESOURCE_DESCRIPTOR_CONFLICT"),
    );
    await manager.dispose();
  });
  it("separates identical keys by type and rejects foreign/wrong-type handles", async () => {
    const manager = createResourceManager<Resources>();
    manager.registerLoader("binary", {
      load: () => new Uint8Array([7]),
      dispose() {},
    });
    manager.registerLoader("text", { load: () => "text", dispose() {} });
    const scope = manager.createScope();
    const a = await manager.acquire("binary", "same", { url: "x" }, scope);
    const b = await manager.acquire("text", "same", { url: "x" }, scope);
    assert.equal(manager.get(a.handle)[0], 7);
    assert.equal(manager.get(b.handle), "text");
    assert.throws(
      () => manager.get({ ...a.handle, type: "text" }),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    assert.throws(
      () => manager.get({ ...a.handle, manager: manager.id + 1 }),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    assert.throws(
      () => manager.get(null as unknown as ResourceHandle<"binary">),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    await manager.dispose();
  });
  it("deletes on last release and reacquires with a new generation; stale handles stay invalid", async () => {
    const manager = createResourceManager<Resources>();
    manager.registerLoader("binary", {
      load: () => new Uint8Array([9]),
      dispose() {},
    });
    const scope = manager.createScope();
    const first = await manager.acquire("binary", "x", { url: "first" }, scope);
    await first.release();
    assert.throws(
      () => manager.get(first.handle),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    const next = await manager.acquire("binary", "x", { url: "second" }, scope);
    assert.equal(first.handle.index, next.handle.index);
    assert.ok(next.handle.generation > first.handle.generation);
    assert.throws(
      () => manager.get(first.handle),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    await manager.dispose();
  });
  it("releases child scopes but preserves resources owned by unrelated scopes", async () => {
    const manager = createResourceManager<Resources>();
    let releases = 0;
    manager.registerLoader("binary", {
      load: () => new Uint8Array(1),
      dispose() {
        releases++;
      },
    });
    const parent = manager.createScope(),
      child = manager.createScope(parent),
      grandchild = manager.createScope(child),
      other = manager.createScope();
    await manager.acquire("binary", "shared", { url: "x" }, grandchild);
    const shared = await manager.acquire(
      "binary",
      "shared",
      { url: "x" },
      other,
    );
    await manager.acquire("binary", "unique", { url: "x" }, child);
    await parent.release();
    assert.ok(parent.released && child.released && grandchild.released);
    assert.equal(manager.inspect().owned.scopes, 1);
    assert.equal(releases, 1);
    assert.equal(manager.get(shared.handle).length, 1);
    await assert.rejects(
      manager.acquire("binary", "x", { url: "x" }, child),
      code("TC_RESOURCE_INVALID_SCOPE"),
    );
    assert.throws(
      () => manager.createScope(parent),
      code("TC_RESOURCE_INVALID_SCOPE"),
    );
    await manager.dispose();
    assert.equal(releases, 2);
  });
});

describe("M1 real asynchronous cancellation and generation isolation", () => {
  it("cancels one waiter without aborting a shared load", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope(),
      a = new AbortController();
    const pa = manager.acquire("binary", "x", { url: "x" }, scope, {
      signal: a.signal,
    });
    const rejected = assert.rejects(pa, code("TC_RESOURCE_CANCELLED"));
    const pb = manager.acquire("binary", "x", { url: "x" }, scope);
    await tick();
    a.abort();
    await rejected;
    assert.equal(calls[0]!.signal.aborted, false);
    assert.equal(manager.inspect().owned.references, 1);
    calls[0]!.gate.resolve(new Uint8Array([3]));
    assert.equal(manager.get((await pb).handle)[0], 3);
    await manager.dispose();
  });
  it("aborts only after all waiters cancel, disposes an ignored-abort result, and isolates reused slot", async () => {
    const { manager, calls, disposed } = gated();
    const scope = manager.createScope(),
      a = new AbortController(),
      b = new AbortController();
    const pa = manager.acquire("binary", "x", { url: "old" }, scope, {
      signal: a.signal,
    });
    const pb = manager.acquire("binary", "x", { url: "old" }, scope, {
      signal: b.signal,
    });
    const rejectedA = assert.rejects(pa, code("TC_RESOURCE_CANCELLED")),
      rejectedB = assert.rejects(pb, code("TC_RESOURCE_CANCELLED"));
    const oldHandle = manager.inspect().entries[0]!
      .handle as ResourceHandle<"binary">;
    await tick();
    a.abort();
    assert.equal(calls[0]!.signal.aborted, false);
    b.abort();
    await Promise.all([rejectedA, rejectedB]);
    assert.equal(calls[0]!.signal.aborted, true);
    assert.equal(manager.inspect().owned.entries, 0);
    assert.equal(manager.inspect().owned.inFlightLoads, 1);
    const next = manager.acquire("binary", "x", { url: "new" }, scope);
    await tick();
    const fresh = new Uint8Array([22]);
    calls[1]!.gate.resolve(fresh);
    const lease = await next;
    assert.equal(lease.handle.index, oldHandle.index);
    assert.ok(lease.handle.generation > oldHandle.generation);
    const stale = new Uint8Array([11]);
    calls[0]!.gate.resolve(stale);
    await manager.whenIdle();
    assert.deepEqual(disposed, [stale]);
    assert.equal(manager.get(lease.handle), fresh);
    assert.throws(
      () => manager.get(oldHandle),
      code("TC_RESOURCE_STALE_HANDLE"),
    );
    assert.equal(manager.inspect().counters.staleResultsDisposed, 1);
    await manager.dispose();
    assert.deepEqual(disposed, [stale, fresh]);
  });
  it("uses a genuinely abort-aware loader and retries after abort rejection", async () => {
    const manager = createResourceManager<Resources>();
    let calls = 0,
      aborts = 0;
    manager.registerLoader("binary", {
      load(_descriptor, signal) {
        calls++;
        if (calls > 1) return new Uint8Array([5]);
        return new Promise<Uint8Array>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborts++;
              reject(new Error("private transport detail"));
            },
            { once: true },
          ),
        );
      },
      dispose() {},
    });
    const scope = manager.createScope(),
      controller = new AbortController();
    const p = manager.acquire("binary", "x", { url: "x" }, scope, {
      signal: controller.signal,
    });
    const rejection = assert.rejects(p, code("TC_RESOURCE_CANCELLED"));
    await tick();
    controller.abort();
    await rejection;
    await manager.whenIdle();
    assert.equal(aborts, 1);
    assert.equal(
      manager.get(
        (await manager.acquire("binary", "x", { url: "x" }, scope)).handle,
      )[0],
      5,
    );
    await manager.dispose();
  });
  it("skips loader work for pre-aborted and same-turn cancelled acquisitions", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      manager.acquire("binary", "x", { url: "x" }, scope, {
        signal: controller.signal,
      }),
      code("TC_RESOURCE_CANCELLED"),
    );
    const p = manager.acquire("binary", "x", { url: "x" }, scope);
    const rejection = assert.rejects(p, code("TC_RESOURCE_CANCELLED"));
    const release = scope.release();
    await Promise.all([release, rejection]);
    await manager.whenIdle();
    assert.equal(calls.length, 0);
    await manager.dispose();
  });
  it("scope cancellation affects its waiter but not another scope", async () => {
    const { manager, calls } = gated();
    const a = manager.createScope(),
      b = manager.createScope();
    const pa = manager.acquire("binary", "x", { url: "x" }, a);
    const rejected = assert.rejects(pa, code("TC_RESOURCE_CANCELLED"));
    const pb = manager.acquire("binary", "x", { url: "x" }, b);
    await tick();
    await a.release();
    await rejected;
    assert.equal(calls[0]!.signal.aborted, false);
    calls[0]!.gate.resolve(new Uint8Array(2));
    await pb;
    await manager.dispose();
  });
  it("detaches acquisition signals after delivery; lease ownership is explicit", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope(),
      controller = new AbortController();
    const p = manager.acquire("binary", "x", { url: "x" }, scope, {
      signal: controller.signal,
    });
    await tick();
    calls[0]!.gate.resolve(new Uint8Array(1));
    const lease = await p;
    controller.abort();
    assert.equal(lease.released, false);
    assert.equal(manager.inspect().owned.references, 1);
    await manager.dispose();
  });
  it("disposes immediately without waiting for ignored abort, then cleans late values", async () => {
    const { manager, calls, disposed } = gated();
    const scope = manager.createScope();
    const p = manager.acquire("binary", "x", { url: "x" }, scope);
    const rejected = assert.rejects(p, code("TC_RESOURCE_CANCELLED"));
    await tick();
    const closing = manager.dispose();
    assert.equal(closing, manager.dispose());
    await closing;
    await rejected;
    assert.equal(calls[0]!.signal.aborted, true);
    assert.equal(manager.inspect().owned.inFlightLoads, 1);
    const data = new Uint8Array(3);
    calls[0]!.gate.resolve(data);
    await manager.whenIdle();
    assert.deepEqual(disposed, [data]);
    assert.equal(manager.inspect().owned.inFlightLoads, 0);
    assert.throws(() => manager.createScope(), code("TC_RESOURCE_DISPOSED"));
    await assert.rejects(
      manager.acquire("binary", "x", { url: "x" }, scope),
      code("TC_RESOURCE_DISPOSED"),
    );
  });
  it("retries after shared load failure and does not surface loader secrets", async () => {
    const { manager, calls } = gated();
    const scope = manager.createScope();
    const a = manager.acquire("binary", "x", { url: "x" }, scope),
      b = manager.acquire("binary", "x", { url: "x" }, scope);
    const rejectedA = assert.rejects(a, code("TC_RESOURCE_LOAD_FAILED")),
      rejectedB = assert.rejects(b, code("TC_RESOURCE_LOAD_FAILED"));
    await tick();
    calls[0]!.gate.reject(new Error("token=DO_NOT_LOG_THIS"));
    await Promise.all([rejectedA, rejectedB]);
    assert.equal(manager.inspect().owned.entries, 0);
    assert.equal(manager.inspect().owned.references, 0);
    const next = manager.acquire("binary", "x", { url: "x" }, scope);
    await tick();
    calls[1]!.gate.resolve(new Uint8Array([8]));
    assert.equal(manager.get((await next).handle)[0], 8);
    assert.ok(
      !JSON.stringify(manager.getDiagnostics()).includes("DO_NOT_LOG_THIS"),
    );
    await manager.dispose();
  });
});
