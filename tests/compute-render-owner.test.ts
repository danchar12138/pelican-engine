import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import type { ComputeDriverOptions, ComputeExecutionRequest, ComputeExecutor } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeBufferInput, GraphType, GraphValue, RenderCapabilities } from "../packages/sdk/src/index.ts";
import type { RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

type Kernel = ComputeExecutionRequest["kernel"];
type Version = { key: string; revision: number };
const capabilities = (): RenderCapabilities => ({ backend: "webgpu", compute: true, availableModes: ["raster", "path", "hybrid"] });
const kernel = (): Kernel => ({
  id: "step", count: 2, workgroupSize: 64, outputType: "float",
  source: { file: "game.ts", line: 1, column: 1, length: 1 },
  buffers: [{ name: "data", type: "float" }],
  graph: {
    nodes: [{ id: "index", op: "input", name: "index" }, { id: "read", op: "readBuffer", inputs: ["index"], buffer: "data" }],
    output: "read", outputType: "float", nodeTypes: { index: "float", read: "float" }, bufferTypes: { data: "float" },
  },
});
class Executor implements ComputeExecutor {
  requests: ComputeExecutionRequest[] = [];
  commits: Version[] = [];
  discards: string[] = [];
  collections: Version[][] = [];
  releases: string[] = [];
  disposed = 0;
  implementation = async (request: ComputeExecutionRequest): Promise<readonly GraphValue[]> => request.inputs.data.values;
  onCommit?: (key: string, revision: number) => void;
  onDiscard?: (key: string) => void;
  onCollect?: (live: readonly Version[]) => void;
  run(request: ComputeExecutionRequest) { this.requests.push(request); return this.implementation(request); }
  commit(key: string, revision: number) { this.commits.push({ key, revision }); this.onCommit?.(key, revision); }
  discard(key: string) { this.discards.push(key); this.onDiscard?.(key); }
  collect(live: readonly Version[]) { this.collections.push(structuredClone([...live])); this.onCollect?.(live); }
  release(key: string) { this.releases.push(key); }
  dispose() { this.disposed++; }
}
function setup(t: TestContext, options: Partial<ComputeDriverOptions> = {}) {
  const executor = new Executor();
  const driver = createComputeDriver({ kernels: [kernel()], capabilities, executor, buffers: [{ id: "values", type: "float", count: 2, data: [1, 2] }], ...options });
  t.after(() => driver.dispose());
  const service = driver.service;
  const plugin = driver.factory({} as RuntimePluginContext);
  const dispatch = (id = "values") => {
    const output = service.resolve(id);
    return service.dispatch("step", { output, bindings: { data: output } });
  };
  return { driver, service, plugin, executor, dispatch };
}
const code = (expected: string) => (error: unknown) => {
  assert(error instanceof Error);
  assert.match(error.message, new RegExp(`^${expected}:`));
  assert.match(error.message, /Repair:/);
  return true;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanupErrors = (driver: ReturnType<typeof createComputeDriver>) => (driver.inspect() as { cleanupErrors: number }).cleanupErrors;

test("initial buffers: absent and empty definitions work without an executor or capability access", async t => {
  for (const buffers of [undefined, []]) {
    let queries = 0;
    const { driver, plugin } = setup(t, { kernels: [], executor: undefined, buffers, capabilities() { queries++; throw new Error("not initialized"); } });
    assert.deepEqual(plugin.snapshot(), { version: 1, kernels: [], buffers: [] });
    await driver.flush();
    plugin.restore(plugin.snapshot());
    assert.equal(queries, 0);
  }
});

test("initial buffers: every graph type supports explicit and default data with detached ownership", t => {
  const types: GraphType[] = ["bool", "float", "vec2", "vec3", "vec4"];
  const definitions: ComputeBufferInput[] = types.flatMap(type => {
    const value: GraphValue = type === "bool" ? true : type === "float" ? 3 : Array(Number(type.slice(3))).fill(3) as unknown as GraphValue;
    return [{ id: type, type, count: 2, data: [value, value] }, { id: `${type}-zero`, type, count: 2 }];
  });
  const expected = structuredClone(definitions);
  const { driver, service } = setup(t, { kernels: [], executor: undefined, buffers: definitions });
  for (const definition of expected) {
    const zero: GraphValue = definition.type === "bool" ? false : definition.type === "float" ? 0 : Array(Number(definition.type.slice(3))).fill(0) as unknown as GraphValue;
    const handle = service.resolve(definition.id);
    assert.deepEqual(service.readBuffer(handle), definition.data ?? [zero, zero]);
    assert.deepEqual(service.describeBuffer(handle), { id: definition.id, type: definition.type, count: 2, revision: 0 });
  }
  (definitions[4].data![0] as unknown as number[])[0] = 99;
  definitions[0].id = "renamed";
  definitions.length = 0;
  assert.deepEqual(driver.resource("vec2").values, [[3, 3], [3, 3]]);
  assert.equal(service.describeBuffer(service.resolve("bool")).id, "bool");
});

test("initial buffers: invalid late definitions fail atomically and dispose the transferred executor", () => {
  let reads = 0;
  const accessor = Object.defineProperty([], "0", { enumerable: true, get() { reads++; return { id: "getter", type: "float", count: 2 }; } });
  const badData = Object.defineProperty([1, 2], "1", { enumerable: true, get() { reads++; return 2; } });
  const valid = { id: "first", type: "float", count: 2, data: [1, 2] };
  const cases: [unknown, string][] = [
    [null, "TC_COMPUTE_BUFFER"], [[, valid], "TC_COMPUTE_BUFFER"], [accessor, "TC_COMPUTE_BUFFER"],
    [[valid, valid], "TC_COMPUTE_BUFFER_NAME"], [[valid, { id: "bad", type: "float", count: 0 }], "TC_COMPUTE_BUFFER"],
    [[valid, { id: "bad", type: "mat4", count: 2 }], "TC_COMPUTE_BUFFER"],
    [[valid, { id: "bad", type: "float", count: 2, data: [1] }], "TC_COMPUTE_COUNT"],
    [[valid, { id: "bad", type: "float", count: 2, data: badData }], "TC_COMPUTE_VALUE"],
    [[valid, { id: "bad", type: "float", count: 2, data: [1, Infinity] }], "TC_COMPUTE_VALUE"],
    [[valid, { id: "bad", type: "vec2", count: 2, data: [[1, 2], [3]] }], "TC_COMPUTE_VALUE"],
    [[valid, { id: "bad", type: "bool", count: 2, data: [true, 1] }], "TC_COMPUTE_VALUE"],
    [[valid, { id: "bad", type: "float", count: 2, extra: 1 }], "TC_COMPUTE_BUFFER"],
  ];
  for (const [buffers, expected] of cases) {
    const executor = new Executor();
    executor.dispose = () => { executor.disposed++; throw new Error("cleanup failed too"); };
    let returned = false;
    assert.throws(() => {
      createComputeDriver({ kernels: [], capabilities, executor, buffers: buffers as ComputeBufferInput[] });
      returned = true;
    }, code(expected));
    assert.equal(returned, false);
    assert.equal(executor.disposed, 1);
    assert.deepEqual(executor.requests, []);
    assert.deepEqual(executor.releases, []);
    assert.deepEqual(valid.data, [1, 2]);
  }
  const executor = new Executor();
  assert.throws(() => createComputeDriver({ kernels: [kernel(), kernel()], capabilities, executor }), code("TC_COMPUTE_KERNEL"));
  assert.equal(executor.disposed, 1);
  assert.equal(reads, 0);
});

test("resource: private immutable detached committed data keeps public descriptions unchanged", t => {
  const { driver, service, plugin } = setup(t, { buffers: [{ id: "vector", type: "vec2", count: 2, data: [[1, 2], [3, 4]] }] });
  const handle = service.resolve("vector"), resource = driver.resource("vector"), another = driver.resource("vector");
  assert.deepEqual(Object.keys(resource).sort(), ["key", "revision", "type", "values"]);
  assert.equal(resource.key, `compute:${handle.owner}:${handle.index}:${handle.generation}`);
  assert.notEqual(resource, another);
  assert.notEqual(resource.values, another.values);
  assert.notEqual(resource.values[0], another.values[0]);
  assert(Object.isFrozen(resource) && Object.isFrozen(resource.values) && Object.isFrozen(resource.values[0]));
  assert.throws(() => { (resource.values[0] as unknown as number[])[0] = 100; }, TypeError);
  assert.throws(() => { resource.revision = 99; }, TypeError);
  const read = service.readBuffer(handle);
  (read[0] as unknown as number[])[0] = 99;
  assert.deepEqual(driver.resource("vector").values, [[1, 2], [3, 4]]);
  assert.equal("resource" in service, false);
  assert.equal("setRenderPins" in service, false);
  assert.deepEqual(Object.keys(service.describeBuffer(handle)).sort(), ["count", "id", "revision", "type"]);
  service.writeBuffer(handle, [[5, 6]], 1);
  assert.deepEqual(resource.values, [[1, 2], [3, 4]]);
  assert.equal(resource.revision, 0);
  assert.deepEqual(driver.resource("vector"), { key: resource.key, type: "vec2", revision: 1, values: [[1, 2], [5, 6]] });
  plugin.restore(plugin.snapshot());
  assert.notEqual(driver.resource("vector").key, resource.key);
  assert.equal(driver.resource("vector").revision, 0);
  assert.throws(() => driver.resource("absent"), code("TC_COMPUTE_BUFFER_NAME"));
  driver.dispose();
  assert.throws(() => driver.resource("vector"), code("TC_COMPUTE_DISPOSED"));
});

test("pins: duplicate logical references block release without deletion, recycling or executor cleanup", t => {
  const { driver, service, executor, dispatch } = setup(t);
  const handle = service.resolve("values"), before = driver.resource("values"), pins = ["values", "values"];
  driver.setRenderPins(pins);
  pins.length = 0;
  assert.throws(() => service.releaseBuffer(handle), code("TC_COMPUTE_BUFFER_IN_USE"));
  assert.deepEqual(driver.resource("values"), before);
  assert.deepEqual(executor.releases, []);
  driver.setRenderPins(["values"]);
  const task = dispatch();
  assert.throws(() => service.releaseBuffer(handle), code("TC_COMPUTE_BUFFER_IN_USE"));
  driver.setRenderPins([]);
  assert.throws(() => service.releaseBuffer(handle), code("TC_COMPUTE_BUSY"));
  service.cancel(task);
  service.releaseBuffer(handle);
  assert.deepEqual(executor.releases, [before.key]);
  const replacement = service.createBuffer({ id: "values", type: "float", count: 2 });
  assert.equal(replacement.index, handle.index);
  assert.equal(replacement.generation, handle.generation + 1);
});

test("pins: dense validation is atomic, does not run getters, and permits future names", t => {
  const { driver, service } = setup(t);
  driver.setRenderPins(["values"]);
  let reads = 0;
  const accessor = Object.defineProperty(["values"], "0", { enumerable: true, get() { reads++; return "values"; } });
  for (const invalid of [null, "values", [, "values"], ["values", ""], ["values", "  "], ["values", 2], accessor, Object.assign(["values"], { extra: true })]) {
    assert.throws(() => driver.setRenderPins(invalid as string[]), code("TC_COMPUTE_BUFFER_NAME"));
    assert.throws(() => service.releaseBuffer(service.resolve("values")), code("TC_COMPUTE_BUFFER_IN_USE"));
  }
  assert.equal(reads, 0);
  driver.setRenderPins(["future", "future"]);
  service.releaseBuffer(service.resolve("values"));
  const future = service.createBuffer({ id: "future", type: "float", count: 2 });
  assert.throws(() => service.releaseBuffer(future), code("TC_COMPUTE_BUFFER_IN_USE"));
});

test("pins: render can restore new logical names before compute recreates physical identities", t => {
  const { driver, service, plugin, executor } = setup(t);
  const old = service.resolve("values"), oldKey = driver.resource("values").key;
  const checkpoint = structuredClone(plugin.snapshot()) as { buffers: ComputeBufferInput[] };
  checkpoint.buffers = [{ id: "restored", type: "float", count: 2, data: [7, 8] }];
  plugin.validateSnapshot(checkpoint);
  driver.setRenderPins(["restored", "restored"]);
  plugin.restore(checkpoint);
  const restored = service.resolve("restored");
  assert.notEqual(restored.owner, old.owner);
  assert.notEqual(driver.resource("restored").key, oldKey);
  assert.deepEqual(executor.releases, [oldKey]);
  assert.throws(() => service.readBuffer(old), code("TC_COMPUTE_BUFFER_HANDLE"));
  assert.throws(() => service.releaseBuffer(restored), code("TC_COMPUTE_BUFFER_IN_USE"));
  driver.setRenderPins(["restored"]);
  plugin.restore(plugin.snapshot());
  assert.throws(() => service.releaseBuffer(service.resolve("restored")), code("TC_COMPUTE_BUFFER_IN_USE"));
  driver.setRenderPins([]);
  service.releaseBuffer(service.resolve("restored"));
});

test("pins: disposal clears references and empty peer cleanup remains safe", t => {
  const { driver, executor } = setup(t);
  driver.setRenderPins(["values", "future"]);
  driver.dispose();
  driver.setRenderPins([]);
  driver.setRenderPins([]);
  assert.throws(() => driver.setRenderPins(["future"]), code("TC_COMPUTE_DISPOSED"));
  driver.dispose();
  assert.equal(executor.disposed, 1);
});

test("commit: executor publication precedes CPU publication and discard follows task success", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const handle = service.resolve("values"), key = driver.resource("values").key, events: string[] = [];
  executor.implementation = async () => { events.push("run"); return [3, 4]; };
  const task = dispatch();
  executor.onCommit = (actual, revision) => {
    events.push("commit");
    assert.deepEqual({ key: actual, revision }, { key, revision: 1 });
    assert.deepEqual(driver.resource("values").values, [1, 2]);
    assert.equal(driver.resource("values").revision, 0);
    assert.equal(service.task(task).status, "running");
    assert.throws(() => service.writeBuffer(handle, [9]), code("TC_COMPUTE_BUSY"));
  };
  executor.onDiscard = actual => {
    events.push("discard");
    assert.equal(actual, key);
    assert.equal(service.task(task).status, "succeeded");
    assert.deepEqual(service.readBuffer(handle), [3, 4]);
  };
  executor.onCollect = () => { events.push("collect"); };
  await driver.flush();
  assert.equal(executor.requests[0].output.retain, true);
  assert.deepEqual(events, ["run", "commit", "discard", "collect"]);
  assert.deepEqual(executor.collections, [[{ key, revision: 1 }]]);
});

test("commit: executors without commit keep the original output shape and CPU behavior", async t => {
  let request!: ComputeExecutionRequest;
  const executor: ComputeExecutor = { async run(input) { request = input; return [8, 9]; }, release() {}, dispose() {} };
  const { driver, service, dispatch } = setup(t, { executor });
  const task = dispatch();
  await driver.flush();
  assert.equal(Object.hasOwn(request.output, "retain"), false);
  assert.deepEqual(Object.keys(request.output).sort(), ["count", "key", "type"]);
  assert.deepEqual(service.readBuffer(service.resolve("values")), [8, 9]);
  assert.equal(service.task(task).status, "succeeded");
});

test("commit: throwing publication fails the task and preserves the previous committed CPU revision", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  service.writeBuffer(service.resolve("values"), [5, 6]);
  const before = driver.resource("values");
  executor.implementation = async () => [8, 9];
  executor.onCommit = () => { throw new Error("publication failed"); };
  const task = dispatch();
  await driver.flush();
  assert.equal(service.task(task).status, "failed");
  assert.equal(service.task(task).error?.code, "TC_COMPUTE_EXECUTION");
  assert.match(service.task(task).error!.message, /publication failed/);
  assert.deepEqual(driver.resource("values"), before);
  assert.deepEqual(executor.commits, [{ key: before.key, revision: 2 }]);
  assert.deepEqual(executor.discards, [before.key]);
  assert.deepEqual(executor.collections, [[{ key: before.key, revision: 1 }]]);
  assert.equal(cleanupErrors(driver), 0);
  service.writeBuffer(service.resolve("values"), [10, 11]);
});

test("validation: every malformed result is discarded without publication or CPU mutation", async t => {
  let reads = 0;
  const accessor = Object.defineProperty([3, 4], "1", { enumerable: true, get() { reads++; return 4; } });
  for (const result of [null, {}, [3], [3, 4, 5], [, 4], [3, NaN], [3, Infinity], [3, 1e40], [true, 4], [[3], 4], accessor]) {
    const { driver, service, executor, dispatch } = setup(t);
    const before = driver.resource("values");
    executor.implementation = async () => result as GraphValue[];
    const task = dispatch();
    await driver.flush();
    assert.equal(service.task(task).status, "failed");
    assert.equal(service.task(task).error?.code, "TC_COMPUTE_RESULT");
    assert.deepEqual(driver.resource("values"), before);
    assert.deepEqual(executor.commits, []);
    assert.deepEqual(executor.discards, [before.key]);
    assert.deepEqual(executor.collections, [[{ key: before.key, revision: 0 }]]);
  }
  assert.equal(reads, 0);
});

test("commit: same-tick dispatches retain their captured revision until the whole FIFO drains", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const pending = [deferred<readonly GraphValue[]>(), deferred<readonly GraphValue[]>()];
  executor.implementation = () => pending[executor.requests.length - 1].promise;
  const first = dispatch(), second = dispatch(), work = driver.flush();
  assert.equal(driver.flush(), work);
  assert.deepEqual(driver.resource("values").values, [1, 2]);
  pending[0].resolve([3, 4]);
  await turn();
  assert.equal(service.task(first).status, "succeeded");
  assert.equal(service.task(second).status, "running");
  assert.equal(executor.requests[1].inputs.data.revision, 0);
  assert.deepEqual(executor.requests[1].inputs.data.values, [1, 2]);
  assert.deepEqual(executor.collections, []);
  pending[1].resolve([5, 6]);
  await work;
  const key = driver.resource("values").key;
  assert.deepEqual(executor.commits, [{ key, revision: 1 }, { key, revision: 2 }]);
  assert.deepEqual(executor.discards, [key, key]);
  assert.deepEqual(executor.collections, [[{ key, revision: 2 }, { key, revision: 1 }]]);
  service.releaseTask(first);
  assert.deepEqual(executor.collections.at(-1), [{ key, revision: 2 }]);
  assert.deepEqual(driver.resource("values").values, [5, 6]);
});

test("cancel: pending work can release and reuse a generation while a late result cannot commit", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const pending = deferred<readonly GraphValue[]>();
  executor.implementation = () => executor.requests.length === 1 ? pending.promise : Promise.resolve([7, 8]);
  const old = service.resolve("values"), oldKey = driver.resource("values").key;
  const cancelled = dispatch(), work = driver.flush();
  service.cancel(cancelled);
  service.releaseBuffer(old);
  const fresh = service.createBuffer({ id: "values", type: "float", count: 2, data: [5, 6] });
  assert.equal(fresh.index, old.index);
  assert.equal(fresh.generation, old.generation + 1);
  const next = dispatch(), key = driver.resource("values").key;
  await work;
  assert.equal(service.task(cancelled).status, "cancelled");
  assert.equal(service.task(next).status, "succeeded");
  assert.deepEqual(executor.discards, [oldKey, key]);
  assert.deepEqual(executor.commits, [{ key, revision: 1 }]);
  assert.deepEqual(executor.collections, [[{ key, revision: 1 }]]);
  pending.resolve([99, 100]);
  await turn();
  assert.deepEqual(driver.resource("values").values, [7, 8]);
  assert.deepEqual(executor.commits, [{ key, revision: 1 }]);
  assert.deepEqual(executor.discards, [oldKey, key]);
});

test("cancel: queued cancellation makes no candidate and late rejection stays observed", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const pending = deferred<readonly GraphValue[]>();
  executor.implementation = () => pending.promise;
  const running = dispatch(), queued = dispatch(), work = driver.flush();
  service.cancel(queued);
  service.cancel(running);
  await work;
  assert.equal(executor.requests.length, 1);
  assert.deepEqual(executor.commits, []);
  assert.deepEqual(executor.discards, [driver.resource("values").key]);
  pending.reject(new Error("late executor rejection"));
  await turn();
  assert.equal(service.task(running).status, "cancelled");
  assert.equal(service.task(queued).status, "cancelled");
});

test("epoch: executor replacement prevents stale publication and collects using the current executor", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const pending = deferred<readonly GraphValue[]>(), next = new Executor();
  executor.implementation = () => pending.promise;
  const before = driver.resource("values"), task = dispatch(), work = driver.flush();
  driver.replaceExecutor(next);
  await work;
  pending.resolve([90, 91]);
  await turn();
  assert.equal(service.task(task).status, "cancelled");
  assert.deepEqual(driver.resource("values"), before);
  assert.deepEqual(executor.commits, []);
  assert.deepEqual(executor.discards, [before.key]);
  assert.equal(executor.disposed, 1);
  assert.deepEqual(executor.collections, []);
  assert.deepEqual(next.collections, [[{ key: before.key, revision: 0 }]]);
});

test("epoch: disposal during run discards without committing or collecting cleared state", async t => {
  const { driver, executor, dispatch } = setup(t);
  const pending = deferred<readonly GraphValue[]>(), key = driver.resource("values").key;
  executor.implementation = () => pending.promise;
  dispatch();
  const work = driver.flush();
  driver.dispose();
  await work;
  pending.resolve([90, 91]);
  await turn();
  assert.deepEqual(executor.commits, []);
  assert.deepEqual(executor.discards, [key]);
  assert.deepEqual(executor.collections, []);
  assert.equal((driver.inspect() as { buffers: number }).buffers, 0);
});

test("epoch: validation that invalidates the owner cannot reach commit", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  const before = driver.resource("values");
  const result = new Proxy([3, 4], {
    getOwnPropertyDescriptor(target, key) {
      if (key === "0") driver.replaceExecutor();
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  executor.implementation = async () => result;
  const task = dispatch();
  await driver.flush();
  assert.equal(service.task(task).status, "cancelled");
  assert.deepEqual(driver.resource("values"), before);
  assert.deepEqual(executor.commits, []);
  assert.deepEqual(executor.discards, [before.key]);
});

test("collect: empty flush reports every live current revision, including CPU writes and restore", async t => {
  const { driver, service, plugin, executor, dispatch } = setup(t);
  const extra = service.createBuffer({ id: "extra", type: "bool", count: 1, data: [true] });
  service.writeBuffer(service.resolve("values"), [5, 6]);
  service.createBuffer({ id: "gone", type: "vec3", count: 1 });
  service.releaseBuffer(service.resolve("gone"));
  driver.setRenderPins(["future"]);
  await driver.flush();
  const current = () => ["values", "extra"].map(id => { const { key, revision } = driver.resource(id); return { key, revision }; });
  assert.deepEqual(executor.collections, [current()]);
  const task = dispatch();
  await driver.flush();
  assert.equal(service.task(task).status, "succeeded");
  assert.equal(driver.resource("extra").revision, 0);
  assert.deepEqual(executor.collections[1], current());
  service.releaseBuffer(extra);
  plugin.restore(plugin.snapshot());
  await driver.flush();
  const { key, revision } = driver.resource("values");
  assert.deepEqual(executor.collections[2], [{ key, revision }]);
  assert.equal(revision, 0);
});

test("cleanup: discard and collect failures stay diagnostic without undoing committed tasks", async t => {
  const { driver, service, executor, dispatch } = setup(t);
  executor.implementation = async () => [7, 8];
  executor.onDiscard = () => { throw new Error("discard cleanup failed"); };
  executor.onCollect = () => { throw new Error("collect cleanup failed"); };
  const task = dispatch();
  await driver.flush();
  assert.equal(service.task(task).status, "succeeded");
  assert.deepEqual(driver.resource("values").values, [7, 8]);
  assert.equal(driver.resource("values").revision, 1);
  assert.equal(cleanupErrors(driver), 2);
  executor.implementation = async () => [NaN, 9];
  const invalid = dispatch();
  await driver.flush();
  assert.equal(service.task(invalid).error?.code, "TC_COMPUTE_RESULT");
  assert.deepEqual(driver.resource("values").values, [7, 8]);
  assert.equal(cleanupErrors(driver), 4);
  await driver.flush();
  assert.equal(cleanupErrors(driver), 5);
});
