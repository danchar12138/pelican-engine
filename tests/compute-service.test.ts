import assert from "node:assert/strict";
import test from "node:test";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import type { ComputeDriverOptions, ComputeExecutionRequest, ComputeExecutor } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeBufferInput, ComputeDefinition, ComputeDispatchInput, ComputeService, ComputeTaskHandle, ComputeTaskState, GraphType, GraphValue, RenderCapabilities } from "../packages/sdk/src/index.ts";
import type { RuntimePlugin, RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

type Kernel = ComputeExecutionRequest["kernel"];
type ListedService = ComputeService & { tasks(): readonly { handle: ComputeTaskHandle; state: ComputeTaskState }[] };
type Snapshot = { version: number; kernels: Kernel[]; buffers: { id: string; type: GraphType; count: number; data: GraphValue[] }[] };
const capabilities = (): RenderCapabilities => ({ backend: "webgpu", compute: true, availableModes: ["raster", "path", "hybrid"] });
const kernel = (type: GraphType = "float", id = "step"): Kernel => ({
  id, count: 2, workgroupSize: 64, outputType: type,
  source: { file: "game.ts", line: 1, column: 1, length: 1 },
  buffers: [{ name: "data", type }],
  graph: { nodes: [{ id: "index", op: "input", name: "index" }, { id: "read", op: "readBuffer", inputs: ["index"], buffer: "data" }], output: "read", outputType: type, nodeTypes: { index: "float", read: type }, bufferTypes: { data: type }, parameters: [{ name: "amount", type: "float", default: 1 }] },
});
const zero = (type: GraphType): GraphValue => type === "bool" ? false : type === "float" ? 0 : Array(Number(type.slice(3))).fill(0) as unknown as GraphValue;
const example = (type: GraphType): GraphValue => type === "bool" ? true : type === "float" ? 2 : Array(Number(type.slice(3))).fill(2) as unknown as GraphValue;
class Executor implements ComputeExecutor {
  requests: ComputeExecutionRequest[] = [];
  released: string[] = [];
  disposed = 0;
  constructor(public implementation: (r: ComputeExecutionRequest) => Promise<readonly GraphValue[]> = async r => r.inputs.data.values) {}
  run(r: ComputeExecutionRequest) { this.requests.push(r); return this.implementation(r); }
  release(key: string) { this.released.push(key); }
  dispose() { this.disposed++; }
}
function setup(options: Partial<ComputeDriverOptions> = {}) {
  const executor = new Executor();
  const driver = createComputeDriver({ kernels: [kernel()], capabilities, executor, ...options });
  const service = driver.service as ListedService;
  const plugin = driver.factory({} as RuntimePluginContext) as RuntimePlugin & { settle(): Promise<void> };
  const input = (id = "values", type: GraphType = "float", data?: readonly GraphValue[]) => service.createBuffer({ id, type, count: 2, data });
  const dispatch = (output: ReturnType<typeof input>, bindings = { data: output }, parameters?: Record<string, GraphValue>) => service.dispatch("step", { output, bindings, parameters });
  return { driver, service, plugin, executor, input, dispatch };
}
const snapshot = (plugin: RuntimePlugin) => plugin.snapshot() as Snapshot;
const error = (code: string) => (e: unknown) => {
  assert(e instanceof Error);
  assert.match(e.message, new RegExp(`^${code}:`));
  assert.match(e.message, /Repair:/);
  return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("empty plugin: no kernels/executor supports settle, snapshots, restore and disposal without capability queries", async () => {
  let queries = 0;
  const { driver, plugin, service } = setup({ kernels: [], executor: undefined, capabilities: () => { queries++; throw new Error("not initialized"); } });
  assert.equal(plugin.id, "$engine.compute");
  assert.equal(plugin.services?.compute, service);
  assert.deepEqual(snapshot(plugin), { version: 1, kernels: [], buffers: [] });
  await plugin.settle();
  plugin.restore(snapshot(plugin));
  assert.deepEqual(service.tasks(), []);
  assert.equal((driver.inspect() as { executor: boolean }).executor, false);
  assert.equal(queries, 0);
  plugin.dispose();
  driver.dispose();
  assert.equal((driver.inspect() as { disposed: boolean }).disposed, true);
});

test("tasks: detached registry, terminal-only release, foreign/released handles", async () => {
  const { input, dispatch, service, driver } = setup();
  const h = input(), a = dispatch(h), b = dispatch(h);
  assert.throws(() => service.releaseTask(a), error("TC_COMPUTE_BUSY"));
  const list = service.tasks();
  assert.deepEqual(list, [{ handle: a, state: { status: "queued" } }, { handle: b, state: { status: "queued" } }]);
  (list[0].handle as { owner: number }).owner = -1;
  list[0].state.status = "failed";
  assert.equal(service.task(a).status, "queued");
  assert.throws(() => setup().service.task(a), error("TC_COMPUTE_TASK_HANDLE"));
  service.cancel(b);
  service.cancel(b);
  service.releaseTask(b);
  await driver.flush();
  service.cancel(a);
  assert.equal(service.task(a).status, "succeeded");
  service.releaseTask(a);
  assert.deepEqual(service.tasks(), []);
  assert.throws(() => service.task(a), error("TC_COMPUTE_TASK_HANDLE"));
});

test("cancel: queued tasks never reach executor and running abort unblocks flush", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const executor = new Executor(() => pending.promise);
  const { input, dispatch, service, driver } = setup({ executor });
  const h = input("v", "float", [1, 2]), queued = dispatch(h);
  service.cancel(queued);
  await driver.flush();
  assert.equal(executor.requests.length, 0);
  const running = dispatch(h), work = driver.flush();
  service.cancel(running);
  assert.equal(executor.requests[0].signal.aborted, true);
  await work;
  service.writeBuffer(h, [7, 8]);
  pending.resolve([90, 91]);
  await turn();
  assert.deepEqual(service.readBuffer(h), [7, 8]);
  assert.equal(service.task(running).status, "cancelled");
});

test("cancel: late executor rejection is observed after release/restore", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const { input, dispatch, driver, service, plugin } = setup({ executor: new Executor(() => pending.promise) });
  const h = input(), t = dispatch(h), work = driver.flush();
  service.cancel(t);
  service.releaseTask(t);
  plugin.restore(snapshot(plugin));
  await work;
  pending.reject(new Error("late device rejection"));
  await turn();
  assert.deepEqual(service.readBuffer(service.resolve("values")), [0, 0]);
});

test("replace executor: cancels pending work, preserves buffers/handles and ignores stale success", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const old = new Executor(() => pending.promise), next = new Executor(async () => [6, 7]);
  const { input, dispatch, driver, service } = setup({ executor: old });
  const h = input("v", "float", [1, 2]), a = dispatch(h), b = dispatch(h), work = driver.flush();
  driver.replaceExecutor(next);
  assert.equal(old.disposed, 1);
  assert.equal(old.requests[0].signal.aborted, true);
  assert.equal(service.task(a).status, "cancelled");
  assert.equal(service.task(b).status, "cancelled");
  assert.deepEqual(service.readBuffer(h), [1, 2]);
  const c = dispatch(h);
  await driver.flush();
  await work;
  assert.equal(service.task(c).status, "succeeded");
  pending.resolve([90, 91]);
  await turn();
  assert.deepEqual(service.readBuffer(h), [6, 7]);
  assert.equal(old.requests[0].output.key, next.requests[0].output.key);
  driver.replaceExecutor();
  assert.equal(next.disposed, 1);
  assert.throws(() => dispatch(h), error("TC_COMPUTE_CAPABILITY"));
});

test("dispose: idempotent, signals work, clears registries and blocks service entry points", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const executor = new Executor(() => pending.promise);
  const { input, dispatch, driver, service, plugin } = setup({ executor });
  const h = input(), t = dispatch(h), work = driver.flush();
  plugin.dispose();
  driver.dispose();
  await work;
  assert.equal(executor.disposed, 1);
  assert.equal(executor.requests[0].signal.aborted, true);
  pending.resolve([4, 5]);
  await turn();
  for (const call of [() => input(), () => service.resolve("v"), () => service.describeBuffer(h), () => service.readBuffer(h), () => service.writeBuffer(h, [1]), () => service.releaseBuffer(h), () => dispatch(h), () => service.task(t), () => service.tasks(), () => service.cancel(t), () => service.releaseTask(t), () => driver.flush(), () => driver.replaceExecutor(), () => plugin.snapshot(), () => plugin.validateSnapshot({}), () => plugin.restore({})])
    assert.throws(call, error("TC_COMPUTE_DISPOSED"));
  assert.equal((driver.inspect() as { buffers: number }).buffers, 0);
  assert.equal((driver.inspect() as { tasks: number }).tasks, 0);
});

test("resource keys: unique across slot reuse, owners and restores; caches explicitly released", async () => {
  const { input, dispatch, service, driver, executor, plugin } = setup();
  const keys: string[] = [];
  let h = input("v");
  dispatch(h); await driver.flush();
  keys.push(executor.requests.at(-1)!.output.key);
  service.releaseBuffer(h);
  h = input("v");
  dispatch(h); await driver.flush();
  keys.push(executor.requests.at(-1)!.output.key);
  const snap = snapshot(plugin);
  plugin.restore(snap);
  h = service.resolve("v");
  dispatch(h); await driver.flush();
  keys.push(executor.requests.at(-1)!.output.key);
  const other = setup();
  other.dispatch(other.input()); await other.driver.flush();
  keys.push(other.executor.requests[0].output.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(executor.released, keys.slice(0, 2));
  driver.replaceExecutor(executor);
  assert.equal(executor.disposed, 0);
  assert.deepEqual(executor.released, keys.slice(0, 3));
});

test("snapshots: unfinished tasks prohibit snapshot/validation/restore, including running tasks", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const { input, dispatch, plugin, service, driver } = setup({ executor: new Executor(() => pending.promise) });
  const h = input(), snap = snapshot(plugin), t = dispatch(h);
  const check = () => {
    for (const call of [() => plugin.snapshot(), () => plugin.validateSnapshot(snap), () => plugin.restore(snap)])
      assert.throws(call, error("TC_COMPUTE_BUSY"));
  };
  check();
  const work = driver.flush();
  check();
  service.cancel(t);
  await work;
  assert.doesNotThrow(() => plugin.validateSnapshot(snap));
});

test("snapshots: restore invalidates handles, clears terminal tasks and preserves canonical buffers", async () => {
  const { input, dispatch, service, driver, plugin } = setup();
  const z = input("z", "float", [1, 2]), a = input("a");
  service.writeBuffer(z, [8], 1);
  const t = dispatch(z);
  await driver.flush();
  const snap = snapshot(plugin);
  assert.deepEqual(Object.keys(snap).sort(), ["buffers", "kernels", "version"]);
  assert.deepEqual(snap.buffers.map(b => b.id), ["a", "z"]);
  assert.equal("revision" in snap.buffers[1], false);
  plugin.restore(snap);
  for (const h of [z, a]) assert.throws(() => service.readBuffer(h), error("TC_COMPUTE_BUFFER_HANDLE"));
  assert.throws(() => service.task(t), error("TC_COMPUTE_TASK_HANDLE"));
  assert.deepEqual(service.tasks(), []);
  assert.deepEqual(service.readBuffer(service.resolve("z")), [1, 8]);
  assert.equal(service.describeBuffer(service.resolve("z")).revision, 0);
  assert.deepEqual(snapshot(plugin), snap);
});

test("snapshots: complete preflight rejects malformed late entries without mutation/cleanup", () => {
  const { input, service, plugin, executor } = setup();
  const h = input("a", "float", [1, 2]);
  input("z", "vec2", [[1, 2], [3, 4]]);
  const initial = snapshot(plugin);
  const mutations: ((s: Snapshot) => unknown)[] = [
    s => { s.version = 2; }, s => { s.buffers[1].data[1] = [9, NaN]; },
    s => { s.buffers[1].count = 3; }, s => { s.buffers[1].type = "int" as GraphType; },
    s => { s.buffers[1].id = "a"; }, s => { s.buffers[1].data = new Array(2); },
    s => { s.kernels[0].graph.nodes = []; }, s => { s.kernels[0].count = 9; },
    s => { (s as unknown as Record<string, unknown>).extra = true; },
    s => { (s.buffers[1] as unknown as Record<string, unknown>).revision = 0; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(initial);
    mutate(bad);
    assert.throws(() => plugin.validateSnapshot(bad), error("TC_COMPUTE_SNAPSHOT"));
    assert.throws(() => plugin.restore(bad), error("TC_COMPUTE_SNAPSHOT"));
    assert.deepEqual(snapshot(plugin), initial);
    assert.deepEqual(service.readBuffer(h), [1, 2]);
    assert.deepEqual(executor.released, []);
  }
});

test("snapshots: independent histories and restored vectors never alias the live owner", () => {
  const { input, service, plugin } = setup();
  const h = input("v", "vec2", [[1, 2], [3, 4]]);
  const older = snapshot(plugin);
  service.writeBuffer(h, [[8, 9]], 0);
  const newer = snapshot(plugin);
  plugin.restore(older);
  (older.buffers[0].data[0] as unknown as number[])[0] = 99;
  assert.deepEqual(service.readBuffer(service.resolve("v")), [[1, 2], [3, 4]]);
  plugin.restore(newer);
  (newer.buffers[0].data[0] as unknown as number[])[0] = 77;
  assert.deepEqual(service.readBuffer(service.resolve("v")), [[8, 9], [3, 4]]);
  older.kernels[0].count = 88;
  assert.equal(snapshot(plugin).kernels[0].count, 2);
});

test("snapshots: compatible definitions ignore key order, kernel order and source locations", () => {
  const first = kernel("float", "a"), second = kernel("bool", "b");
  const a = setup({ kernels: [second, first] });
  a.input("constructor", "float", [1, 2]);
  const snap = snapshot(a.plugin);
  const moved = structuredClone(first);
  moved.source.file = "moved.ts";
  const b = setup({ kernels: [moved, second] });
  b.plugin.restore(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(snapshot(b.plugin), snap);
  assert.deepEqual(b.service.readBuffer(b.service.resolve("constructor")), [1, 2]);
});

test("limits: CPU owner accepts counts above legacy 65536; adapter limits belong to executor", () => {
  const k = kernel();
  k.count = 65537;
  const { service } = setup({ kernels: [k] });
  const h = service.createBuffer({ id: "large", type: "bool", count: 65537 });
  assert.equal(service.describeBuffer(h).count, 65537);
});

test("kernels: malformed declarations fail early with stable diagnostics", () => {
  for (const mutate of [
    (k: Kernel) => { k.count = 0; }, (k: Kernel) => { k.workgroupSize = 0; },
    (k: Kernel) => { k.graph.outputType = "bool"; },
    (k: Kernel) => { k.buffers!.push({ ...k.buffers![0] }); },
    (k: Kernel) => { k.graph.parameters = [{ name: "p", type: "float", default: NaN }]; },
    (k: Kernel) => { k.graph.parameters = [{ name: "p", type: "float", default: 1 }, { name: "p", type: "bool", default: true }]; },
  ]) {
    const k = kernel(); mutate(k);
    assert.throws(() => setup({ kernels: [k] }), error("TC_COMPUTE_KERNEL"));
  }
  assert.throws(() => setup({ kernels: [kernel(), kernel()] }), error("TC_COMPUTE_KERNEL"));
});

test("dispatch: validates all declarations before queuing or locking", () => {
  const { service, input, driver } = setup();
  const h = input(), wrong = input("bool", "bool"), short = service.createBuffer({ id: "short", type: "float", count: 1 });
  const cases: [string, string, unknown][] = [
    ["TC_COMPUTE_KERNEL", "absent", { output: h, bindings: { data: h } }],
    ["TC_COMPUTE_DISPATCH", "step", null],
    ["TC_COMPUTE_TYPE", "step", { output: wrong, bindings: { data: h } }],
    ["TC_COMPUTE_COUNT", "step", { output: short, bindings: { data: h } }],
    ["TC_COMPUTE_BINDING", "step", { output: h }],
    ["TC_COMPUTE_BINDING", "step", { output: h, bindings: { data: h, extra: h } }],
    ["TC_COMPUTE_TYPE", "step", { output: h, bindings: { data: wrong } }],
    ["TC_COMPUTE_BUFFER_HANDLE", "step", { output: h, bindings: { data: null } }],
    ["TC_COMPUTE_PARAMETER", "step", { output: h, bindings: { data: h }, parameters: { nope: 1 } }],
    ["TC_COMPUTE_PARAMETER", "step", { output: h, bindings: { data: h }, parameters: { amount: true } }],
    ["TC_COMPUTE_PARAMETER", "step", { output: h, bindings: { data: h }, parameters: { amount: 1e39 } }],
  ];
  for (const [code, name, request] of cases) assert.throws(() => service.dispatch(name, request as ComputeDispatchInput), error(code));
  for (const time of [NaN, Infinity, 1e39, null, "now"])
    assert.throws(() => service.dispatch("step", { output: h, bindings: { data: h }, time } as ComputeDispatchInput), error("TC_COMPUTE_TIME"));
  assert.deepEqual(service.tasks(), []);
  assert.equal((driver.inspect() as { busyBuffers: number }).busyBuffers, 0);
  service.writeBuffer(h, [3, 4]);
});

test("dispatch: WebGL2/uninitialized/missing executor explicitly refuse without CPU fallback", () => {
  for (const options of [
    { capabilities: () => ({ ...capabilities(), backend: "webgl2" as const }) },
    { capabilities: () => ({ ...capabilities(), backend: "uninitialized" as const }) },
    { capabilities: () => ({ ...capabilities(), compute: false }) },
    { executor: undefined },
    { capabilities: () => { throw new Error("device missing"); } },
  ]) {
    const { input, dispatch, executor, service } = setup(options);
    assert.throws(() => dispatch(input()), error("TC_COMPUTE_CAPABILITY"));
    assert.equal(executor.requests.length, 0);
    assert.deepEqual(service.tasks(), []);
  }
  const badTime = setup({ time: () => { throw new Error("clock missing"); } });
  assert.throws(() => badTime.dispatch(badTime.input()), error("TC_COMPUTE_TIME"));
});

test("dispatch/settle: starts only on flush, captures time/defaults and commits feedback per tick", async () => {
  let clock = 4;
  const executor = new Executor(async r => r.inputs.data.values.map(v => (v as number) + (r.parameters.amount as number)));
  const { service, input, dispatch, driver, plugin } = setup({ executor, time: () => clock });
  const h = input("v", "float", [1, 2]);
  const task = dispatch(h);
  clock = 9;
  await turn();
  assert.equal(executor.requests.length, 0);
  assert.deepEqual(service.task(task), { status: "queued" });
  assert.deepEqual(service.readBuffer(h), [1, 2]);
  await plugin.settle();
  assert.equal(executor.requests[0].time, 4);
  assert.deepEqual(executor.requests[0].parameters, { amount: 1 });
  assert.deepEqual(executor.requests[0].inputs.data, { key: executor.requests[0].output.key, type: "float", revision: 0, values: [1, 2], captured: true });
  assert.deepEqual(service.readBuffer(h), [2, 3]);
  assert.equal(service.task(task).status, "succeeded");
  dispatch(h, { data: h }, { amount: 2 });
  await driver.flush();
  assert.equal(executor.requests[1].inputs.data.revision, 1);
  assert.deepEqual(service.readBuffer(h), [4, 5]);
});

test("dispatch: immutable snapshots, same-tick queued reads and serial FIFO commits", async () => {
  const pending = [deferred<readonly GraphValue[]>(), deferred<readonly GraphValue[]>()];
  let index = 0;
  const executor = new Executor(() => pending[index++].promise);
  const { input, service, dispatch, driver } = setup({ executor });
  const h = input("v", "float", [1, 2]);
  const a = dispatch(h), b = dispatch(h);
  const work = driver.flush();
  assert.equal(driver.flush(), work);
  assert.equal(executor.requests.length, 1);
  assert.equal(service.task(a).status, "running");
  assert.equal(service.task(b).status, "queued");
  assert.throws(() => { (executor.requests[0].inputs.data.values as number[])[0] = 88; }, TypeError);
  pending[0].resolve([10, 11]);
  await turn();
  assert.equal(executor.requests.length, 2);
  assert.deepEqual(service.readBuffer(h), [10, 11]);
  assert.deepEqual(executor.requests[1].inputs.data.values, [1, 2]);
  assert.equal(executor.requests[1].inputs.data.revision, 0);
  pending[1].resolve([20, 21]);
  await work;
  assert.deepEqual(service.readBuffer(h), [20, 21]);
  assert.equal(service.describeBuffer(h).revision, 2);
});

test("dispatch: definition resolves by ID, caller mutations cannot change compiled kernel/parameters", async () => {
  const k = kernel("vec2");
  k.graph.parameters = [{ name: "offset", type: "vec2", default: [1, 2] }];
  const { service, input, driver, executor } = setup({ kernels: [k] });
  const h = input("v", "vec2");
  const parameters = { offset: [3, 4] as unknown as GraphValue };
  service.dispatch({ kind: "compute", id: "step" } as ComputeDefinition, { output: h, bindings: { data: h }, parameters, time: 7 });
  (parameters.offset as unknown as number[])[0] = 55;
  k.count = 90;
  (k.graph.nodes as unknown[]).length = 0;
  await driver.flush();
  assert.deepEqual(executor.requests[0].parameters, { offset: [3, 4] });
  assert.equal(executor.requests[0].kernel.count, 2);
  assert.equal(executor.requests[0].kernel.graph.nodes.length, 2);
  assert.equal(executor.requests[0].time, 7);
});

test("busy buffers: all inputs/output stay locked until every referencing task terminates", async () => {
  const pending = deferred<readonly GraphValue[]>();
  const { input, dispatch, service, driver } = setup({ executor: new Executor(() => pending.promise) });
  const a = input("a"), b = input("b");
  const first = dispatch(b, { data: a }), second = dispatch(b, { data: a });
  const locked = () => {
    for (const h of [a, b]) {
      assert.throws(() => service.writeBuffer(h, [1]), error("TC_COMPUTE_BUSY"));
      assert.throws(() => service.releaseBuffer(h), error("TC_COMPUTE_BUSY"));
    }
  };
  locked();
  const work = driver.flush();
  service.cancel(second);
  locked();
  pending.resolve([2, 3]);
  await work;
  assert.equal(service.task(first).status, "succeeded");
  for (const h of [a, b]) service.releaseBuffer(h);
});

for (const type of ["float", "vec2", "vec3", "vec4", "bool"] as const) {
  test(`executor: ${type} output validated, detached and committed atomically`, async () => {
    const result = [example(type), example(type)];
    const { input, dispatch, driver, service } = setup({ kernels: [kernel(type)], executor: new Executor(async () => result) });
    const h = input("v", type);
    const t = dispatch(h);
    await driver.flush();
    if (Array.isArray(result[0])) (result[0] as number[])[0] = 44;
    else result[0] = zero(type);
    assert.deepEqual(service.readBuffer(h), [example(type), example(type)]);
    assert.equal(service.task(t).status, "succeeded");
    assert.equal(service.describeBuffer(h).revision, 1);
  });
}

test("executor: malformed, sparse, non-finite, wrong type/count outputs fail without partial commit", async () => {
  for (const result of [[], [3], [3, 4, 5], [3, NaN], [3, Infinity], [3, 1e39], [3, true], [[1, 2], 3], new Array(2), new Float32Array([3, 4]), null]) {
    const { input, dispatch, driver, service } = setup({ executor: new Executor(async () => result as readonly GraphValue[]) });
    const h = input("v", "float", [1, 2]);
    const t = dispatch(h);
    await driver.flush();
    assert.equal(service.task(t).status, "failed");
    assert.equal(service.task(t).error?.code, "TC_COMPUTE_RESULT");
    assert.match(service.task(t).error!.remediation, /finite f32/);
    assert.deepEqual(service.readBuffer(h), [1, 2]);
    assert.equal(service.describeBuffer(h).revision, 0);
    service.releaseBuffer(h);
  }
});

test("executor: thrown/rejected failures are terminal, diagnosable and do not stop the queue", async () => {
  let calls = 0;
  const executor = new Executor(r => {
    calls++;
    if (calls === 1) throw new Error("TC_COMPUTE_BOUNDS: out of range");
    if (calls === 2) return Promise.reject(new Error("device lost"));
    return Promise.resolve(r.inputs.data.values);
  });
  const { input, dispatch, service, driver } = setup({ executor });
  const h = input();
  const a = dispatch(h), b = dispatch(h), c = dispatch(h);
  await driver.flush();
  assert.equal(service.task(a).error?.code, "TC_COMPUTE_BOUNDS");
  assert.equal(service.task(b).error?.code, "TC_COMPUTE_EXECUTION");
  assert.equal(service.task(c).status, "succeeded");
  const state = service.task(a);
  state.error!.message = "tamper";
  assert.notEqual(service.task(a).error?.message, "tamper");
});

for (const type of ["float", "vec2", "vec3", "vec4", "bool"] as const) {
  test(`buffers: ${type} defaults and detached create/write/read data`, () => {
    const { service, input } = setup();
    const h = input("zero", type);
    assert.deepEqual(service.readBuffer(h), [zero(type), zero(type)]);
    const data = [example(type), example(type)];
    const b = input("typed", type, data);
    if (Array.isArray(data[0])) (data[0] as number[])[0] = 19;
    else data[0] = zero(type);
    assert.deepEqual(service.readBuffer(b), [example(type), example(type)]);
    const read = service.readBuffer(b) as GraphValue[];
    if (Array.isArray(read[0])) (read[0] as number[])[0] = 33;
    else read[0] = zero(type);
    assert.deepEqual(service.readBuffer(b), [example(type), example(type)]);
    const update = [example(type)];
    service.writeBuffer(h, update, 1);
    if (Array.isArray(update[0])) (update[0] as number[])[0] = 77;
    assert.deepEqual(service.readBuffer(h), [zero(type), example(type)]);
    assert.deepEqual(service.describeBuffer(h), { id: "zero", type, count: 2, revision: 1 });
  });
}

test("buffers: invalid definitions and non-finite/incorrect values never allocate", () => {
  const { service } = setup();
  for (const patch of [{ id: "" }, { id: " " }, { type: "int" }, { count: 0 }, { count: -1 }, { count: 1.5 }, { count: Infinity }, { count: 2 ** 32 }])
    assert.throws(() => service.createBuffer({ id: "bad", type: "float", count: 2, ...patch } as ComputeBufferInput), error("TC_COMPUTE_BUFFER"));
  for (const data of [[0, NaN], [0, Infinity], [0, 1e39], [0, true], [0, [1]], new Array(2), new Float32Array(2)])
    assert.throws(() => service.createBuffer({ id: "bad", type: "float", count: 2, data: data as GraphValue[] }), error("TC_COMPUTE_VALUE"));
  assert.throws(() => service.createBuffer({ id: "bad", type: "float", count: 2, data: [1] }), error("TC_COMPUTE_COUNT"));
  for (const [type, value] of [["vec2", [1]], ["vec3", [1, 2, NaN]], ["vec4", [1, 2, 3, 1e39]], ["bool", 1]] as const)
    assert.throws(() => service.createBuffer({ id: "bad", type, count: 1, data: [value as GraphValue] }), error("TC_COMPUTE_VALUE"));
  assert.deepEqual(service.tasks(), []);
});

test("buffers: unique names, foreign/stale handles and slot reuse", () => {
  const a = setup(), b = setup();
  const h = a.input("__proto__");
  assert.deepEqual(a.service.resolve("__proto__"), h);
  assert.throws(() => a.input("__proto__"), error("TC_COMPUTE_BUFFER_NAME"));
  assert.throws(() => b.service.readBuffer(h), error("TC_COMPUTE_BUFFER_HANDLE"));
  a.service.releaseBuffer(h);
  assert.throws(() => a.service.resolve("__proto__"), error("TC_COMPUTE_BUFFER_NAME"));
  const fresh = a.input("__proto__");
  assert.equal(fresh.index, h.index);
  assert.notEqual(fresh.generation, h.generation);
  for (const old of [h, { ...fresh, generation: 0 }, { ...fresh, index: NaN }, null])
    assert.throws(() => a.service.readBuffer(old as typeof h), error("TC_COMPUTE_BUFFER_HANDLE"));
});

test("buffers: writes validate the whole range and value batch atomically", () => {
  const { service, input } = setup();
  const h = input("v", "float", [1, 2]);
  for (const offset of [-1, 0.5, NaN, Infinity, 3, Number.MAX_SAFE_INTEGER])
    assert.throws(() => service.writeBuffer(h, [9], offset), error("TC_COMPUTE_RANGE"));
  assert.throws(() => service.writeBuffer(h, [8, 9], 1), error("TC_COMPUTE_RANGE"));
  assert.throws(() => service.writeBuffer(h, [8, NaN]), error("TC_COMPUTE_VALUE"));
  assert.deepEqual(service.readBuffer(h), [1, 2]);
  assert.equal(service.describeBuffer(h).revision, 0);
  service.writeBuffer(h, [], 2);
  assert.equal(service.describeBuffer(h).revision, 0);
  service.writeBuffer(h, [9], 1);
  assert.deepEqual(service.readBuffer(h), [1, 9]);
  assert.equal(service.describeBuffer(h).revision, 1);
});

test("validation: sparse/accessor arrays and records do not execute getters", () => {
  const { service, input, dispatch, plugin } = setup();
  const h = input();
  let reads = 0;
  const bad = [0, 0];
  Object.defineProperty(bad, "1", { get() { reads++; return 1; }, enumerable: true });
  assert.throws(() => service.writeBuffer(h, bad), error("TC_COMPUTE_VALUE"));
  const record = Object.defineProperty({}, "data", { get() { reads++; return h; }, enumerable: true });
  assert.throws(() => dispatch(h, record as { data: typeof h }), error("TC_COMPUTE_BINDING"));
  const snap = snapshot(plugin);
  Object.defineProperty(snap.buffers[0], "data", { get() { reads++; return [0, 0]; }, enumerable: true });
  assert.throws(() => plugin.restore(snap), error("TC_COMPUTE_SNAPSHOT"));
  assert.equal(reads, 0);
});
