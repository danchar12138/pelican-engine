import assert from "node:assert/strict";
import test from "node:test";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import type { ComputeExecutionRequest, ComputeExecutor } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeBufferHandle, ComputeDispatchInput, ComputeTaskHandle, GraphValue } from "../packages/sdk/src/index.ts";
import type { RuntimePlugin, RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

type Kernel = ComputeExecutionRequest["kernel"];
const kernel = (id = "step", names = ["data"], count = 2): Kernel => ({
  id, count, workgroupSize: 64, outputType: "float",
  source: { file: "dependencies.ts", line: 1, column: 1, length: 1 },
  buffers: names.map(name => ({ name, type: "float" })),
  graph: { nodes: [{ id: "value", op: "float", value: 0 }], output: "value", outputType: "float", nodeTypes: { value: "float" }, parameters: [{ name: "amount", type: "float", default: 1 }] },
});
class Executor implements ComputeExecutor {
  requests: ComputeExecutionRequest[] = [];
  collections: { key: string; revision: number }[][] = [];
  commits: { key: string; revision: number }[] = [];
  released: string[] = [];
  disposed = 0;
  implementation = async (r: ComputeExecutionRequest): Promise<readonly GraphValue[]> =>
    Array.from({ length: r.output.count }, (_, i) => Object.values(r.inputs).reduce((sum, input) => sum + Number(input.values[i] ?? 0), Number(r.parameters.amount)));
  run(r: ComputeExecutionRequest) { this.requests.push(r); return this.implementation(r); }
  collect(live: readonly { key: string; revision: number }[]) { this.collections.push(structuredClone([...live])); }
  commit(key: string, revision: number) { this.commits.push({ key, revision }); }
  release(key: string) { this.released.push(key); }
  dispose() { this.disposed++; }
}
function setup() {
  const executor = new Executor();
  const driver = createComputeDriver({ kernels: [kernel(), kernel("join", ["left", "right"]), kernel("short", ["data"], 1)], executor,
    capabilities: () => ({ backend: "webgpu", compute: true, availableModes: ["raster", "path", "hybrid"] }) });
  const service = driver.service;
  const plugin = driver.factory({} as RuntimePluginContext) as RuntimePlugin;
  const buffer = (id: string, data = [1, 2]) => service.createBuffer({ id, type: "float", count: data.length, data });
  const step = (output: ComputeBufferHandle, input: ComputeBufferHandle | { task: ComputeTaskHandle } = output, after?: readonly ComputeTaskHandle[]) => service.dispatch("step", { output, bindings: { data: input }, after });
  return { driver, service, plugin, executor, buffer, step };
}
const error = (code: string, at?: string) => (e: unknown) => {
  assert(e instanceof Error);
  assert.equal((e as Error & { code: string }).code, code);
  if (at) assert(e.message.includes(at), e.message);
  assert.match(e.message, /Repair:/);
  return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("dependencies: diamond fanout resolves exact predecessor inputs and releases each consumer reference", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b"), c = buffer("c"), d = buffer("d");
  const root = step(a), left = step(b, { task: root }, [root, root]), right = step(c, { task: root });
  const join = service.dispatch("join", { output: d, bindings: { left: { task: left }, right: { task: right } }, after: [root, left, right, root] });
  assert.throws(() => service.releaseTask(root), error("TC_COMPUTE_TASK_IN_USE"));
  await driver.flush();
  assert.deepEqual(service.readBuffer(d), [7, 9]);
  for (const h of [root, left, right, join]) { assert.deepEqual(service.task(h), { status: "succeeded" }); service.releaseTask(h); }
  assert.equal(executor.requests.length, 4);
  for (const r of executor.requests) for (const input of Object.values(r.inputs)) {
    assert.deepEqual(Object.keys(input).sort(), [...(r === executor.requests[0] ? ["captured"] : []), "key", "revision", "type", "values"]);
    assert.equal(input.captured, r === executor.requests[0] ? true : undefined);
    assert(Object.isFrozen(input)); assert(Object.isFrozen(input.values));
  }
  assert.deepEqual(service.tasks(), []);
});

test("dependencies: after orders work without refreshing ordinary buffer/parameter/time snapshots", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b"), root = step(a);
  const input: ComputeDispatchInput = { output: b, bindings: { data: a }, after: [root, root], parameters: { amount: 5 }, time: 7 };
  const consumer = service.dispatch("step", input);
  (input.parameters as Record<string, GraphValue>).amount = 99; input.time = 99;
  await driver.flush();
  assert.deepEqual(service.readBuffer(a), [2, 3]);
  assert.deepEqual(service.readBuffer(b), [6, 7]);
  assert.equal(executor.requests[1].inputs.data.revision, 0);
  assert.equal(executor.requests[1].time, 7);
  service.releaseTask(root); service.releaseTask(consumer);
});

test("dependencies: overwrites and CPU writes preserve an earlier task's exact immutable result", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b");
  const first = step(a), second = step(a), consumer = step(b, { task: first });
  await driver.flush();
  assert.equal(service.describeBuffer(a).revision, 2);
  assert.equal(executor.requests[2].inputs.data.revision, 1);
  assert.deepEqual(service.readBuffer(b), [3, 4]);
  service.writeBuffer(a, [90, 91]);
  const next = step(b, { task: first });
  const state = service.task(first); (state as { status: string }).status = "failed";
  const listed = service.tasks(); (listed[0].state as { result?: unknown }).result = [999];
  assert.deepEqual(service.task(first), { status: "succeeded" });
  await driver.flush();
  assert.equal(executor.requests[3].inputs.data.revision, 1);
  assert.deepEqual(executor.requests[3].inputs.data.values, [2, 3]);
  for (const h of [first, second, consumer, next]) service.releaseTask(h);
});

test("dependencies: collect retains distinct live result revisions, deduplicates pairs and evicts on release without dispatch", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), key = driver.resource("a").key;
  const first = step(a), second = step(a);
  await driver.flush();
  assert.deepEqual(executor.collections.at(-1), [{ key, revision: 2 }, { key, revision: 1 }]);
  service.releaseTask(first);
  assert.deepEqual(executor.collections.at(-1), [{ key, revision: 2 }]);
  service.writeBuffer(a, [7, 8]);
  await driver.flush();
  assert.deepEqual(executor.collections.at(-1), [{ key, revision: 3 }, { key, revision: 2 }]);
  service.releaseTask(second);
  assert.deepEqual(executor.collections.at(-1), [{ key, revision: 3 }]);
});

test("dependencies: queued/running consumers pin producer output and task release until terminal", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b"), root = step(a), pending = deferred<readonly GraphValue[]>();
  executor.implementation = () => pending.promise;
  const work = driver.flush(), consumer = step(b, { task: root }, [root, root]);
  assert.equal(service.task(root).status, "running");
  assert.throws(() => service.releaseBuffer(a), error("TC_COMPUTE_BUSY"));
  assert.throws(() => service.writeBuffer(a, [7]), error("TC_COMPUTE_BUSY"));
  service.cancel(root);
  assert.throws(() => service.releaseTask(root), error("TC_COMPUTE_TASK_IN_USE"));
  assert.throws(() => service.releaseBuffer(a), error("TC_COMPUTE_BUSY"));
  await work;
  assert.equal(service.task(consumer).error?.code, "TC_COMPUTE_DEPENDENCY_FAILED");
  assert.equal(executor.requests.length, 1);
  service.releaseTask(root); service.releaseTask(consumer); service.releaseBuffer(a);
  pending.resolve([100, 200]); await turn();
});

for (const mode of ["throw", "reject", "bad-result", "cancel-queued", "cancel-running"] as const) {
  test("dependencies: " + mode + " fails downstream before executor and independent tasks continue", async t => {
    const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
    const a = buffer("a"), b = buffer("b"), c = buffer("c"), d = buffer("d"), gate = deferred<readonly GraphValue[]>();
    const root = step(a), child = step(b, { task: root }), leaf = step(c, { task: child }), independent = step(d);
    executor.implementation = r => {
      if (r.output.key !== driver.resource("a").key) return Promise.resolve([8, 9]);
      if (mode === "throw") throw Error("sync failure");
      if (mode === "reject") return Promise.reject(Error("async failure"));
      if (mode === "bad-result") return Promise.resolve([NaN, 1]);
      return gate.promise;
    };
    if (mode === "cancel-queued") service.cancel(root);
    const work = driver.flush();
    if (mode === "cancel-running") service.cancel(root);
    await work;
    for (const h of [child, leaf]) assert.equal(service.task(h).error?.code, "TC_COMPUTE_DEPENDENCY_FAILED");
    assert.equal(service.task(independent).status, "succeeded");
    assert.deepEqual(service.readBuffer(b), [1, 2]); assert.equal(service.describeBuffer(b).revision, 0);
    assert.equal(executor.requests.length, mode === "cancel-queued" ? 1 : 2);
    const alreadyFailed = step(b, { task: root }), afterFailed = step(c, c, [root]);
    assert.equal(service.task(alreadyFailed).status, "queued");
    await driver.flush();
    for (const h of [alreadyFailed, afterFailed]) assert.equal(service.task(h).error?.code, "TC_COMPUTE_DEPENDENCY_FAILED");
    for (const h of [root, child, leaf, independent, alreadyFailed, afterFailed]) service.releaseTask(h);
    if (mode === "cancel-running") gate.reject(Error("late executor failure"));
    await turn();
  });
}

test("dependencies: task input count may differ; input type and output type/count keep existing validation", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), short = buffer("short", [0]), root = step(a);
  const consumer = service.dispatch("short", { output: short, bindings: { data: { task: root } } });
  await driver.flush();
  assert.equal(service.task(consumer).status, "succeeded");
  assert.equal(executor.requests[1].inputs.data.values.length, 2);
  assert.deepEqual(service.readBuffer(short), [3]);
  const vector = service.createBuffer({ id: "vector", type: "vec2", count: 2 });
  assert.throws(() => step(vector), error("TC_COMPUTE_TYPE"));
  assert.throws(() => step(short, { task: root }), error("TC_COMPUTE_COUNT"));
});

test("dependencies: malformed, foreign, released, self and forward references never allocate or pin", t => {
  const { driver, service, buffer, step } = setup(), foreign = setup();
  t.after(() => { driver.dispose(); foreign.driver.dispose(); });
  const a = buffer("a"), root = step(a); service.cancel(root); service.releaseTask(root);
  const other = foreign.step(foreign.buffer("foreign"));
  const invalid: unknown[] = [root, other, null, {}, { owner: root.owner, id: 0 }, { owner: root.owner, id: 2 }, { owner: root.owner, id: 999 }, { owner: root.owner, id: 1.5 }, { owner: root.owner, id: 1, extra: 1 }];
  for (const h of invalid) {
    assert.throws(() => step(a, { task: h as ComputeTaskHandle }), error("TC_COMPUTE_DEPENDENCY", "step:data"));
    assert.throws(() => step(a, a, [h as ComputeTaskHandle]), error("TC_COMPUTE_DEPENDENCY", "step:after[0]"));
    assert.deepEqual(service.tasks(), []);
    service.writeBuffer(a, [4]);
  }
  const valid = step(a); assert.equal(valid.id, 2);
});

test("dependencies: after rejects sparse/accessor/extra-property/subclass arrays without invoking getters", t => {
  const { driver, service, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), root = step(a); service.cancel(root);
  let reads = 0;
  const accessor = [root]; Object.defineProperty(accessor, "0", { enumerable: true, get() { reads++; return root; } });
  const extra = Object.assign([root], { extra: 1 });
  class Handles extends Array<ComputeTaskHandle> {}
  for (const after of [null, {}, [root, , root], accessor, extra, new Handles(root)]) {
    assert.throws(() => service.dispatch("step", { output: a, bindings: { data: a }, after } as unknown as ComputeDispatchInput), error("TC_COMPUTE_DEPENDENCY", "step:after"));
    assert.equal(service.tasks().length, 1);
    service.writeBuffer(a, [5]);
  }
  assert.equal(reads, 0);
});

test("dependencies: cancelled consumers release deduplicated refs once and allow terminal task/source release", async t => {
  const { driver, service, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b"), root = step(a), consumer = step(b, { task: root }, [root, root]);
  service.cancel(consumer); service.cancel(consumer);
  await driver.flush();
  service.releaseTask(root); service.releaseTask(consumer);
  service.writeBuffer(a, [9]); service.releaseBuffer(a);
  assert.equal((driver.inspect() as { busyBuffers: number }).busyBuffers, 0);
});

test("dependencies: terminal source release invalidates future reads without changing task status or accepting reused slots", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), b = buffer("b"), root = step(a);
  await driver.flush(); service.releaseBuffer(a);
  const fresh = buffer("a", [90, 91]); assert.equal(fresh.index, a.index); assert.notEqual(fresh.generation, a.generation);
  assert.deepEqual(service.task(root), { status: "succeeded" });
  assert.throws(() => step(b, { task: root }), error("TC_COMPUTE_DEPENDENCY_RESOURCE", "step:data"));
  assert.equal(service.tasks().length, 1);
  service.writeBuffer(b, [7]);
  const ordered = step(b, b, [root]); await driver.flush();
  assert.equal(service.task(ordered).status, "succeeded"); assert.equal(executor.requests.length, 2);
  service.releaseTask(root);
  assert(!executor.collections.at(-1)!.some(v => v.key === executor.released[0]));
});

for (const action of ["restore", "replace", "dispose"] as const) {
  test("dependencies: " + action + " releases an entire chain and ignores late success/rejection", async t => {
    for (const late of ["resolve", "reject"] as const) {
      const { driver, service, plugin, executor, buffer, step } = setup(); t.after(() => driver.dispose());
      const a = buffer("a"), b = buffer("b"), c = buffer("c"), gate = deferred<readonly GraphValue[]>();
      const snapshot = plugin.snapshot();
      executor.implementation = () => gate.promise;
      const root = step(a), child = step(b, { task: root }), leaf = step(c, { task: child });
      const work = driver.flush();
      if (action === "dispose") driver.dispose();
      else if (action === "replace") driver.replaceExecutor(new Executor());
      else {
        service.cancel(root); service.cancel(child); service.cancel(leaf);
        plugin.restore(snapshot);
        assert.deepEqual(service.tasks(), []);
        assert.throws(() => step(service.resolve("b"), { task: root }), error("TC_COMPUTE_DEPENDENCY"));
      }
      await work;
      if (late === "resolve") gate.resolve([999, 999]); else gate.reject(Error("late failure"));
      await turn();
      assert.deepEqual(executor.commits, []);
      if (action !== "dispose") {
        for (const id of ["a", "b", "c"]) assert.deepEqual(service.readBuffer(service.resolve(id)), [1, 2]);
        assert.equal((driver.inspect() as { busyBuffers: number }).busyBuffers, 0);
        if (action === "replace") {
          for (const h of [root, child, leaf]) { assert.equal(service.task(h).status, "cancelled"); service.releaseTask(h); }
        }
      }
    }
  });
}

test("dependencies: idle snapshot omits tasks; restore clears result versions and preserves logical render pins", async t => {
  const { driver, service, plugin, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), first = step(a); await driver.flush(); step(a); await driver.flush();
  driver.setRenderPins(["a"]);
  const snapshot = plugin.snapshot(); assert.deepEqual(Object.keys(snapshot as object).sort(), ["buffers", "kernels", "version"]);
  const oldKey = driver.resource("a").key;
  plugin.restore(snapshot); await driver.flush();
  assert.deepEqual(service.tasks(), []);
  assert.throws(() => step(service.resolve("a"), { task: first }), error("TC_COMPUTE_DEPENDENCY"));
  assert.throws(() => service.releaseBuffer(service.resolve("a")), error("TC_COMPUTE_BUFFER_IN_USE"));
  assert(executor.released.includes(oldKey));
  assert.deepEqual(executor.collections.at(-1), [{ key: driver.resource("a").key, revision: 0 }]);
});

for (const mode of ["different", "same", "removed"] as const) {
  test("dependencies: replacing executor " + mode + " invalidates terminal results while keeping statuses and buffers", async t => {
    const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
    const a = buffer("a"), b = buffer("b"), first = step(a); await driver.flush();
    const second = step(a); await driver.flush();
    const key = driver.resource("a").key;
    const next = mode === "same" ? executor : new Executor();
    driver.replaceExecutor(mode === "removed" ? undefined : next);
    if (mode === "removed") driver.replaceExecutor(next);
    assert.deepEqual(service.task(first), { status: "succeeded" });
    assert.deepEqual(service.task(second), { status: "succeeded" });
    assert.deepEqual(service.readBuffer(a), [3, 4]);
    for (const h of [first, second]) assert.throws(() => step(b, { task: h }), error("TC_COMPUTE_DEPENDENCY_RESOURCE"));
    await driver.flush();
    assert.deepEqual(next.collections.at(-1), [{ key, revision: 2 }, { key: driver.resource("b").key, revision: 0 }]);
    const ordinary = step(b, a, [first]); await driver.flush();
    assert.deepEqual(service.readBuffer(b), [4, 5]);
    for (const h of [first, second, ordinary]) service.releaseTask(h);
  });
}

test("dependencies: releasing an old result during a flush defers collect until the queue drains", async t => {
  const { driver, service, executor, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), first = step(a), second = step(a), gate = deferred<readonly GraphValue[]>();
  executor.implementation = r => executor.requests.length === 1 ? Promise.resolve([3, 4]) : gate.promise;
  const work = driver.flush(); await turn();
  assert.equal(service.task(first).status, "succeeded"); assert.equal(service.task(second).status, "running");
  service.releaseTask(first); assert.deepEqual(executor.collections, []);
  gate.resolve([5, 6]); await work;
  assert.deepEqual(executor.collections, [[{ key: driver.resource("a").key, revision: 2 }]]);
});

test("dependencies: malformed task-result wrappers reject contextually without running accessors or pinning", t => {
  const { driver, service, buffer, step } = setup(); t.after(() => driver.dispose());
  const a = buffer("a"), root = step(a); service.cancel(root);
  let reads = 0;
  const accessor = Object.defineProperty({}, "task", { enumerable: true, get() { reads++; return root; } });
  class Wrapped { task = root; }
  for (const binding of [accessor, new Wrapped(), { task: root, extra: 1 }, root, { task: undefined }]) {
    assert.throws(() => step(a, binding as { task: ComputeTaskHandle }), error("TC_COMPUTE_DEPENDENCY", "step:data"));
    service.writeBuffer(a, [1]);
  }
  assert.equal(reads, 0); assert.equal(service.tasks().length, 1);
});
