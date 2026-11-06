import assert from "node:assert/strict";
import test from "node:test";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import type { ComputeDriverOptions, ComputeExecutionInput, ComputeExecutionRequest, ComputeExecutor } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeBufferHandle, ComputeDispatchInput, ComputeTextureHandle, GraphValue, Vec4 } from "../packages/sdk/src/index.ts";
import type { RuntimePlugin, RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

type Kernel = ComputeExecutionRequest["kernel"];
type Snapshot = { version: number; kernels: Kernel[]; buffers: { id: string; type: string; count: number; data: GraphValue[]; texture?: { width: number; height: number } }[] };
type MutableVec4 = [number, number, number, number];
const pixel = (n: number): MutableVec4 => [n, n + 0.25, -n, 1];
const pixels = (...ns: number[]): MutableVec4[] => ns.map(pixel);
const kernel = (id: string, textures?: Kernel["textures"], buffers: Kernel["buffers"] = [], count = 2, outputType: Kernel["outputType"] = "vec4"): Kernel => ({
  id, count, outputType, workgroupSize: 64, buffers, ...(textures === undefined ? {} : { textures }),
  source: { file: "texture-owner.ts", line: 1, column: 1, length: 1 },
  graph: { nodes: [{ id: "value", op: "vec4", value: [0, 0, 0, 0] }], output: "value", outputType, nodeTypes: { value: outputType }, parameters: [{ name: "amount", type: "float", default: 5 }] },
});
class Executor implements ComputeExecutor {
  requests: ComputeExecutionRequest[] = [];
  collections: { key: string; revision: number }[][] = [];
  commits: { key: string; revision: number }[] = [];
  discarded: string[] = [];
  released: string[] = [];
  disposed = 0;
  implementation = async (r: ComputeExecutionRequest): Promise<readonly GraphValue[]> => {
    const source = Object.values(r.textures ?? {})[0] ?? Object.values(r.inputs)[0];
    return source?.values ?? Array.from({ length: r.output.count }, () => pixel(Number(r.parameters.amount)));
  };
  run(r: ComputeExecutionRequest) { this.requests.push(r); return this.implementation(r); }
  collect(live: readonly { key: string; revision: number }[]) { this.collections.push(structuredClone([...live])); }
  commit(key: string, revision: number) { this.commits.push({ key, revision }); }
  discard(key: string) { this.discarded.push(key); }
  release(key: string) { this.released.push(key); }
  dispose() { this.disposed++; }
}
function setup(overrides: Partial<ComputeDriverOptions> = {}) {
  const executor = new Executor();
  const driver = createComputeDriver({ kernels: [kernel("seed"), kernel("sample", [{ name: "image" }]), kernel("buffer", undefined, [{ name: "data", type: "vec4" }]), kernel("mixed", [{ name: "data" }], [{ name: "data", type: "vec4" }])], executor,
    capabilities: () => ({ backend: "webgpu", compute: true, availableModes: ["raster", "path", "hybrid"] }), ...overrides });
  const service = driver.service;
  const plugin = driver.factory({} as RuntimePluginContext) as RuntimePlugin;
  const texture = (id: string, data = pixels(1, 2)) => service.createTexture({ id, width: 2, height: 1, data });
  const buffer = (id: string, data = pixels(3, 4)) => service.createBuffer({ id, type: "vec4", count: data.length, data });
  const snapshot = () => plugin.snapshot() as Snapshot;
  return { driver, service, plugin, executor, texture, buffer, snapshot };
}
const error = (code: string) => (e: unknown) => {
  assert(e instanceof Error);
  assert.equal((e as Error & { code: string }).code, code);
  assert.match(e.message, /Repair:/);
  return true;
};
const marker = (input: ComputeExecutionInput) => (input as ComputeExecutionInput & { captured?: true }).captured;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("textures: initial rgba32float resources own detached row-major f32 data and share unique IDs", t => {
  const data = pixels(0.1, 2);
  const { driver, service, buffer, snapshot } = setup({ textures: [{ id: "image", width: 1, height: 2, data }] }); t.after(() => driver.dispose());
  data[0][0] = 99;
  const image = service.resolveTexture("image");
  assert.deepEqual(Object.keys(image).sort(), ["generation", "index", "kind", "owner"]);
  assert.equal(image.kind, "texture"); assert(Object.isFrozen(image));
  assert.deepEqual(service.describeTexture(image), { id: "image", width: 1, height: 2, format: "rgba32float", revision: 0 });
  assert(Object.isFrozen(service.describeTexture(image)));
  assert.equal(service.readTexture(image)[0][0], 0.1);
  const read = service.readTexture(image) as MutableVec4[]; read[0][0] = 999;
  assert.equal(service.readTexture(image)[0][0], 0.1);
  const zero = service.createTexture({ id: "zero", width: 2, height: 2 });
  assert.deepEqual(service.readTexture(zero), Array.from({ length: 4 }, () => [0, 0, 0, 0]));
  assert.throws(() => buffer("image"), error("TC_COMPUTE_BUFFER_NAME"));
  buffer("buffer");
  assert.throws(() => service.createTexture({ id: "buffer", width: 1, height: 1 }), error("TC_COMPUTE_TEXTURE_NAME"));
  const resource = driver.textureResource("image");
  assert.deepEqual(resource.texture, { width: 1, height: 2 });
  assert.equal(resource.type, "vec4"); assert.equal(marker(resource), undefined);
  assert(Object.isFrozen(resource)); assert(Object.isFrozen(resource.texture)); assert(Object.isFrozen(resource.values[0]));
  assert.notEqual(driver.textureResource("image").values, resource.values);
  assert.equal(snapshot().version, 1);
});

test("textures: dimensions, initialization and constructor preflight reject malformed data without allocation", t => {
  const { driver, service, snapshot } = setup(); t.after(() => driver.dispose());
  for (const [width, height] of [[0, 1], [-1, 1], [1.5, 2], [NaN, 1], [Infinity, 1], [2 ** 24, 2], [2 ** 24 + 1, 1], [1, 0]])
    assert.throws(() => service.createTexture({ id: "bad", width, height }), error("TC_COMPUTE_TEXTURE"));
  for (const data of [[[1, 2, 3]], [[1, 2, 3, Infinity]], [pixel(1), pixel(2)], new Array(1), [false]])
    assert.throws(() => service.createTexture({ id: "bad", width: 1, height: 1, data } as never));
  assert.deepEqual(snapshot().buffers, []);
  for (const textures of [new Array(1), [{ id: "ok", width: 1, height: 1 }, { id: "bad", width: 0, height: 1 }], [{ id: "same", width: 1, height: 1 }]]) {
    const executor = new Executor();
    assert.throws(() => setup({ executor, buffers: [{ id: "same", type: "float", count: 1 }], textures } as never));
    assert.equal(executor.disposed, 1); assert.equal(executor.requests.length, 0);
  }
  let calls = 0;
  const hostile = { id: "hostile", width: 1, get height() { calls++; return 1; } };
  assert.throws(() => service.createTexture(hostile), error("TC_COMPUTE_TEXTURE"));
  assert.equal(calls, 0);
});

test("textures: rectangular writes use row-major Vec4 data and publish one revision after complete preflight", t => {
  const { driver, service } = setup(); t.after(() => driver.dispose());
  const image = service.createTexture({ id: "image", width: 3, height: 2, data: pixels(0, 1, 2, 3, 4, 5) });
  const data = pixels(10, 11, 12, 13);
  service.writeTexture(image, data, { x: 1, y: 0, width: 2, height: 2 }); data[0][0] = 99;
  assert.deepEqual(service.readTexture(image), pixels(0, 10, 11, 3, 12, 13));
  assert.equal(service.describeTexture(image).revision, 1);
  const before = service.readTexture(image);
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 3, y: 0, width: 1, height: 1 }, { x: 0, y: 1, width: 1, height: 2 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: 1, extra: true }, { width: 1, height: 1 }, null])
    assert.throws(() => service.writeTexture(image, pixels(7), region as never), error("TC_COMPUTE_RANGE"));
  assert.throws(() => service.writeTexture(image, pixels(7)), error("TC_COMPUTE_COUNT"));
  assert.throws(() => service.writeTexture(image, [pixel(7), [0, 0, 0, NaN]], { x: 1, y: 1, width: 2, height: 1 }), error("TC_COMPUTE_VALUE"));
  let calls = 0;
  const rect = { x: 0, y: 0, width: 1, get height() { calls++; return 1; } };
  assert.throws(() => service.writeTexture(image, pixels(7), rect), error("TC_COMPUTE_RANGE"));
  assert.throws(() => service.writeTexture(image, new Array<Vec4>(6)), error("TC_COMPUTE_VALUE"));
  assert.equal(calls, 0); assert.equal(service.describeTexture(image).revision, 1);
  assert.deepEqual(service.readTexture(image), before);
  service.writeTexture(image, pixels(20, 21, 22, 23, 24, 25));
  assert.deepEqual(service.readTexture(image), pixels(20, 21, 22, 23, 24, 25));
  assert.equal(service.describeTexture(image).revision, 2);
});

test("textures: every public API and private renderer accessor enforces resource kinds and generations", t => {
  const { driver, service, texture, buffer, executor } = setup(); t.after(() => driver.dispose());
  const image = texture("image"), data = buffer("data");
  for (const h of [image as ComputeBufferHandle, { owner: image.owner, index: image.index, generation: image.generation }]) {
    assert.throws(() => service.describeBuffer(h), error("TC_COMPUTE_BUFFER_HANDLE"));
    assert.throws(() => service.readBuffer(h), error("TC_COMPUTE_BUFFER_HANDLE"));
    assert.throws(() => service.writeBuffer(h, pixels(1, 2)), error("TC_COMPUTE_BUFFER_HANDLE"));
    assert.throws(() => service.releaseBuffer(h), error("TC_COMPUTE_BUFFER_HANDLE"));
  }
  for (const h of [data, { ...data, kind: "texture" }, { ...image, kind: "buffer" }, { ...image, extra: 1 }]) {
    assert.throws(() => service.describeTexture(h as ComputeTextureHandle), error("TC_COMPUTE_TEXTURE_HANDLE"));
    assert.throws(() => service.readTexture(h as ComputeTextureHandle), error("TC_COMPUTE_TEXTURE_HANDLE"));
    assert.throws(() => service.writeTexture(h as ComputeTextureHandle, pixels(1, 2)), error("TC_COMPUTE_TEXTURE_HANDLE"));
    assert.throws(() => service.releaseTexture(h as ComputeTextureHandle), error("TC_COMPUTE_TEXTURE_HANDLE"));
  }
  assert.throws(() => service.resolve("image"), error("TC_COMPUTE_BUFFER_NAME"));
  assert.throws(() => service.resolveTexture("data"), error("TC_COMPUTE_TEXTURE_NAME"));
  assert.throws(() => driver.resource("image"), error("TC_COMPUTE_BUFFER_NAME"));
  assert.throws(() => driver.textureResource("data"), error("TC_COMPUTE_TEXTURE_NAME"));
  const foreign = setup(); t.after(() => foreign.driver.dispose());
  assert.throws(() => service.readTexture(foreign.texture("foreign")), error("TC_COMPUTE_TEXTURE_HANDLE"));
  const oldKey = driver.textureResource("image").key;
  service.releaseTexture(image);
  assert.deepEqual(executor.released, [oldKey]);
  const replacement = buffer("image");
  assert.equal(replacement.index, image.index); assert(replacement.generation > image.generation);
  assert.throws(() => service.readTexture(image), error("TC_COMPUTE_TEXTURE_HANDLE"));
  service.releaseBuffer(replacement);
  const replacementTexture = texture("image");
  assert.notEqual(driver.textureResource("image").key, oldKey);
  assert(replacementTexture.generation > replacement.generation);
});

test("textures: kernel declarations normalize sampling defaults, sort canonically and detach caller data", t => {
  const compiled = kernel("sample", [{ name: "z", filter: "nearest", wrapU: "repeat", wrapV: "mirror" }, { name: "a" }]);
  const { driver, service, texture, snapshot, executor } = setup({ kernels: [compiled] }); t.after(() => driver.dispose());
  compiled.textures![0].name = "mutated";
  const image = texture("image");
  const pending = service.dispatch("sample", { output: image, textures: { z: image, a: image } }); service.cancel(pending);
  assert.deepEqual(snapshot().kernels[0].textures, [{ name: "a", filter: "linear", wrapU: "clamp", wrapV: "clamp" }, { name: "z", filter: "nearest", wrapU: "repeat", wrapV: "mirror" }]);
  const other = setup({ kernels: [kernel("sample", [{ name: "a", filter: "linear", wrapU: "clamp", wrapV: "clamp" }, { wrapV: "mirror", name: "z", wrapU: "repeat", filter: "nearest" }])] }); t.after(() => other.driver.dispose());
  assert.doesNotThrow(() => other.plugin.validateSnapshot!(snapshot()));
  assert.equal(executor.requests.length, 0);
  const legacy = setup({ kernels: [kernel("seed")] }); t.after(() => legacy.driver.dispose());
  assert.equal(Object.hasOwn(legacy.snapshot().kernels[0], "textures"), false);
});

test("textures: malformed sampling declarations fail before executor work", () => {
  for (const textures of [[{ name: "" }], [{ name: "a" }, { name: "a" }], [{ name: "a", filter: "cubic" }], [{ name: "a", wrapU: "edge" }], [{ name: "a", wrapV: "edge" }], [{ name: "a", unknown: 1 }], new Array(1), [null], {}]) {
    const executor = new Executor();
    assert.throws(() => setup({ kernels: [kernel("bad", textures as never)], executor }), error("TC_COMPUTE_KERNEL"));
    assert.equal(executor.disposed, 1); assert.equal(executor.requests.length, 0);
  }
});

test("textures: dispatch validates output shape, named slots, raw handles and task result kinds before pinning", async t => {
  const { driver, service, texture, buffer, executor } = setup({ kernels: [kernel("seed"), kernel("sample", [{ name: "image" }]), kernel("buffer", undefined, [{ name: "data", type: "vec4" }]), kernel("float", undefined, [], 2, "float")] }); t.after(() => driver.dispose());
  const image = texture("image"), data = buffer("data");
  const textureTask = service.dispatch("seed", { output: image }), bufferTask = service.dispatch("seed", { output: data });
  await driver.flush();
  const invalid: [string, ComputeDispatchInput, string][] = [
    ["buffer", { output: data, bindings: { data: image } }, "TC_COMPUTE_BUFFER_HANDLE"],
    ["buffer", { output: data, bindings: { data: { task: textureTask } } }, "TC_COMPUTE_TYPE"],
    ["sample", { output: image, textures: { image: data as ComputeTextureHandle } }, "TC_COMPUTE_TEXTURE_HANDLE"],
    ["sample", { output: image, textures: { image: { task: bufferTask } } }, "TC_COMPUTE_TYPE"],
    ["sample", { output: image }, "TC_COMPUTE_BINDING"],
    ["sample", { output: image, textures: { wrong: image } }, "TC_COMPUTE_BINDING"],
    ["seed", { output: image, textures: { image } }, "TC_COMPUTE_BINDING"],
    ["sample", { output: image, textures: { image: { task: textureTask, extra: true } } } as never, "TC_COMPUTE_DEPENDENCY"],
    ["float", { output: image }, "TC_COMPUTE_TYPE"],
    ["seed", { output: service.createTexture({ id: "short", width: 1, height: 1 }) }, "TC_COMPUTE_COUNT"],
  ];
  for (const [name, input, code] of invalid) assert.throws(() => service.dispatch(name, input), error(code));
  let calls = 0;
  assert.throws(() => service.dispatch("sample", { output: image, textures: { get image() { calls++; return image; } } }), error("TC_COMPUTE_BINDING"));
  assert.equal(calls, 0); assert.equal(service.tasks().length, 2);
  assert.equal((driver.inspect() as { busyBuffers: number }).busyBuffers, 0);
  assert.equal(executor.requests.length, 2);
  service.releaseTask(textureTask); service.releaseTask(bufferTask);
  service.writeTexture(image, pixels(8, 9)); service.writeBuffer(data, pixels(8, 9));
});

test("textures: ordinary bindings capture CPU revisions while task bindings resolve exact retained texture results", async t => {
  const { driver, service, texture, buffer, executor } = setup(); t.after(() => driver.dispose());
  const source = texture("source"), ordinary = buffer("ordinary"), exact = texture("exact"), later = texture("later");
  const first = service.dispatch("seed", { output: source, parameters: { amount: 5 } });
  const second = service.dispatch("seed", { output: source, parameters: { amount: 9 } });
  service.dispatch("sample", { output: ordinary, textures: { image: source }, after: [first, second] });
  const consumer = service.dispatch("sample", { output: exact, textures: { image: { task: first } }, after: [second] });
  assert.throws(() => service.releaseTask(first), error("TC_COMPUTE_TASK_IN_USE"));
  await driver.flush();
  assert.deepEqual(service.readTexture(source), pixels(9, 9));
  assert.deepEqual(service.readBuffer(ordinary), pixels(1, 2));
  assert.deepEqual(service.readTexture(exact), pixels(5, 5));
  assert.deepEqual(executor.requests[0].output.texture, { width: 2, height: 1 });
  assert.equal(Object.hasOwn(executor.requests[2].output, "texture"), false);
  const captured = executor.requests[2].textures!.image, result = executor.requests[3].textures!.image;
  assert.equal(captured.revision, 0); assert.equal(marker(captured), true);
  assert.equal(result.revision, 1); assert.equal(marker(result), undefined);
  assert.deepEqual(result.texture, { width: 2, height: 1 }); assert(Object.isFrozen(result.texture));
  assert.equal(Object.keys(executor.requests[3].inputs).length, 0);
  service.writeTexture(source, pixels(99, 100));
  service.dispatch("sample", { output: later, textures: { image: { task: first } } }); await driver.flush();
  assert.deepEqual(service.readTexture(later), pixels(5, 5));
  assert.equal(executor.requests.at(-1)!.textures!.image, result);
  assert.equal(service.task(consumer).status, "succeeded");
  const key = driver.textureResource("source").key;
  assert.deepEqual(executor.collections.at(-1)!.filter(v => v.key === key).map(v => v.revision).sort(), [1, 2, 3]);
  service.releaseTask(first);
  assert.deepEqual(executor.collections.at(-1)!.filter(v => v.key === key).map(v => v.revision).sort(), [2, 3]);
  service.releaseTask(second);
  assert.deepEqual(executor.collections.at(-1)!.filter(v => v.key === key).map(v => v.revision), [3]);
});

test("textures: captured marker is private and limited to ordinary buffer and texture dispatch checkpoints", async t => {
  const { driver, service, texture, buffer, executor, snapshot } = setup(); t.after(() => driver.dispose());
  const image = texture("image"), data = buffer("data"), target = texture("target");
  const a = service.dispatch("seed", { output: image }), b = service.dispatch("seed", { output: data });
  service.dispatch("mixed", { output: target, bindings: { data }, textures: { data: image }, after: [a, b] });
  service.dispatch("mixed", { output: target, bindings: { data: { task: b } }, textures: { data: { task: a } } }); await driver.flush();
  const ordinary = executor.requests[2], exact = executor.requests[3];
  assert.equal(marker(ordinary.inputs.data), true); assert.equal(marker(ordinary.textures!.data), true);
  assert.equal(ordinary.inputs.data.revision, 0); assert.equal(ordinary.textures!.data.revision, 0);
  assert.deepEqual(ordinary.inputs.data.values, pixels(3, 4)); assert.deepEqual(ordinary.textures!.data.values, pixels(1, 2));
  assert.equal(marker(exact.inputs.data), undefined); assert.equal(marker(exact.textures!.data), undefined);
  assert.equal(exact.inputs.data.revision, 1); assert.equal(exact.textures!.data.revision, 1);
  assert.equal(marker(driver.resource("data")), undefined); assert.equal(marker(driver.textureResource("image")), undefined);
  assert.equal(JSON.stringify(snapshot()).includes("captured"), false);
  assert.equal(Object.hasOwn(service.describeTexture(image), "captured"), false);
  assert.equal(Object.hasOwn(service.describeBuffer(data), "captured"), false);
  assert.equal(Object.hasOwn(exact.output, "captured"), false);
  assert(Object.isFrozen(ordinary.textures)); assert(Object.isFrozen(ordinary.inputs.data));
  service.writeBuffer(data, pixels(11, 12)); service.writeTexture(image, pixels(13, 14));
  service.dispatch("mixed", { output: target, bindings: { data }, textures: { data: image } }); await driver.flush();
  assert.equal(marker(executor.requests.at(-1)!.inputs.data), true);
  assert.equal(marker(executor.requests.at(-1)!.textures!.data), true);
  assert.equal(executor.requests.at(-1)!.inputs.data.revision, 2);
  assert.equal(executor.requests.at(-1)!.textures!.data.revision, 2);
});

test("textures: queued and running consumers pin source resources and deduplicate dependency refcounts", async t => {
  const { driver, service, texture, executor } = setup({ kernels: [kernel("seed"), kernel("join", [{ name: "left" }, { name: "right" }])] }); t.after(() => driver.dispose());
  const image = texture("image"), target = texture("target"), wait = deferred<readonly GraphValue[]>();
  const root = service.dispatch("seed", { output: image }); await driver.flush();
  const child = service.dispatch("join", { output: target, textures: { left: { task: root }, right: { task: root } }, after: [root, root] });
  assert.throws(() => service.writeTexture(image, pixels(1, 2)), error("TC_COMPUTE_BUSY"));
  assert.throws(() => service.releaseTexture(image), error("TC_COMPUTE_BUSY"));
  executor.implementation = () => wait.promise;
  const flushing = driver.flush(); await turn();
  assert.equal(service.task(child).status, "running");
  assert.throws(() => service.releaseTexture(image), error("TC_COMPUTE_BUSY"));
  assert.throws(() => service.releaseTask(root), error("TC_COMPUTE_TASK_IN_USE"));
  service.cancel(child); service.cancel(child); service.releaseTask(root);
  service.writeTexture(image, pixels(7, 8)); service.releaseTexture(image); service.releaseTexture(target);
  await flushing; wait.resolve(pixels(99, 100)); await turn();
  assert.equal(service.task(child).status, "cancelled"); assert.equal(executor.commits.length, 1);
});

for (const mode of ["throw", "bad-result", "cancel"] as const) test(`textures: ${mode} propagates through dependencies and leaves independent tasks runnable`, async t => {
  const { driver, service, texture, executor } = setup(); t.after(() => driver.dispose());
  const source = texture("source"), target = texture("target"), independent = texture("independent");
  const root = service.dispatch("seed", { output: source });
  const child = service.dispatch("sample", { output: target, textures: { image: { task: root } } });
  const final = service.dispatch("seed", { output: independent });
  const normal = executor.implementation;
  executor.implementation = r => {
    if (r.output.key === driver.textureResource("source").key) {
      if (mode === "throw") throw new Error("TC_COMPUTE_TEST: rejected texture");
      return Promise.resolve([[1, 2, 3, Infinity]] as readonly GraphValue[]);
    }
    return normal(r);
  };
  if (mode === "cancel") service.cancel(root);
  await driver.flush();
  assert.equal(service.task(root).status, mode === "cancel" ? "cancelled" : "failed");
  assert.equal(service.task(child).error?.code, "TC_COMPUTE_DEPENDENCY_FAILED");
  assert.equal(service.task(final).status, "succeeded");
  assert.deepEqual(service.readTexture(source), pixels(1, 2)); assert.deepEqual(service.readTexture(target), pixels(1, 2));
  assert.equal(service.describeTexture(source).revision, 0); assert.equal(service.describeTexture(target).revision, 0);
  assert.equal(executor.requests.length, mode === "cancel" ? 1 : 2);
  service.releaseTask(root); service.releaseTexture(source); service.releaseTexture(target);
});

test("textures: failed publication and malformed GPU results never change CPU mirrors or revisions", async t => {
  for (const mode of ["wrong-count", "nonfinite", "wrong-vector", "commit-throws"] as const) {
    const { driver, service, texture, executor } = setup(); t.after(() => driver.dispose());
    const image = texture("image");
    executor.implementation = async () => mode === "wrong-count" ? pixels(9) : mode === "nonfinite" ? [pixel(9), [1, 2, NaN, 1]] : mode === "wrong-vector" ? [pixel(9), [1, 2, 3]] as never : pixels(9, 10);
    if (mode === "commit-throws") executor.commit = () => { throw new Error("TC_COMPUTE_TEST: publication failed"); };
    const task = service.dispatch("seed", { output: image }); await driver.flush();
    assert.equal(service.task(task).status, "failed"); assert.deepEqual(service.readTexture(image), pixels(1, 2));
    assert.equal(service.describeTexture(image).revision, 0); assert.equal(executor.discarded.length, 1);
  }
});

test("textures: successful results publish metadata at the same revision as the CPU mirror", async t => {
  const { driver, service, texture, executor } = setup(); t.after(() => driver.dispose());
  const image = texture("image");
  const commit = executor.commit.bind(executor);
  executor.commit = (key, revision) => {
    assert.equal(service.describeTexture(image).revision, revision - 1);
    assert.deepEqual(service.readTexture(image), pixels(1, 2)); commit(key, revision);
  };
  service.dispatch("seed", { output: image }); await driver.flush();
  assert.equal(service.describeTexture(image).revision, 1); assert.deepEqual(service.readTexture(image), pixels(5, 5));
  assert.deepEqual(executor.requests[0].output, { key: driver.textureResource("image").key, type: "vec4", count: 2, texture: { width: 2, height: 1 }, retain: true });
});

test("textures: released task sources invalidate exact results even when slots and logical IDs are reused", async t => {
  const { driver, service, texture, executor } = setup(); t.after(() => driver.dispose());
  const source = texture("source"), target = texture("target");
  const root = service.dispatch("seed", { output: source }); await driver.flush();
  const oldKey = driver.textureResource("source").key;
  service.releaseTexture(source); const replacement = texture("source");
  assert.equal(replacement.index, source.index); assert.notEqual(driver.textureResource("source").key, oldKey);
  assert.throws(() => service.dispatch("sample", { output: target, textures: { image: { task: root } } }), error("TC_COMPUTE_DEPENDENCY_RESOURCE"));
  assert.equal(service.task(root).status, "succeeded"); assert.deepEqual(executor.released, [oldKey]);
  service.releaseTask(root);
});

test("textures: version1 snapshots mix legacy buffers and optional texture metadata, restore invalidates both handles", async t => {
  const { driver, service, plugin, texture, buffer, snapshot, executor } = setup(); t.after(() => driver.dispose());
  const image = texture("z-image"), data = buffer("a-buffer");
  service.writeTexture(image, pixels(7, 8));
  const task = service.dispatch("seed", { output: image }); await driver.flush();
  const state = snapshot();
  assert.equal(state.version, 1); assert.deepEqual(state.buffers.map(b => b.id), ["a-buffer", "z-image"]);
  assert.deepEqual(Object.keys(state.buffers[0]).sort(), ["count", "data", "id", "type"]);
  assert.deepEqual(state.buffers[1].texture, { width: 2, height: 1 });
  assert.equal(state.buffers[1].type, "vec4"); assert.equal(state.buffers[1].count, 2);
  const independent = snapshot(); state.buffers[1].texture!.width = 99; (state.buffers[1].data[0] as MutableVec4)[0] = 99;
  assert.deepEqual(service.readTexture(image), pixels(5, 5)); assert.equal(service.describeTexture(image).width, 2);
  const oldKey = driver.textureResource("z-image").key;
  plugin.restore!(independent);
  assert.throws(() => service.readTexture(image), error("TC_COMPUTE_TEXTURE_HANDLE"));
  assert.throws(() => service.readBuffer(data), error("TC_COMPUTE_BUFFER_HANDLE"));
  assert.throws(() => service.task(task), error("TC_COMPUTE_TASK_HANDLE"));
  const restored = service.resolveTexture("z-image");
  assert.deepEqual(service.readTexture(restored), pixels(5, 5)); assert.equal(service.describeTexture(restored).revision, 0);
  assert.notEqual(driver.textureResource("z-image").key, oldKey); assert(executor.released.includes(oldKey));
  independent.buffers[1].texture!.height = 100; (independent.buffers[1].data[0] as MutableVec4)[0] = 100;
  assert.deepEqual(service.readTexture(restored), pixels(5, 5)); assert.equal(service.describeTexture(restored).height, 1);
  assert.throws(() => driver.resource("z-image"), error("TC_COMPUTE_BUFFER_NAME"));
  await driver.flush();
  assert.deepEqual(executor.collections.at(-1)!.map(v => v.revision), [0, 0]);
});

test("textures: snapshot texture preflight is complete and atomic", t => {
  const { driver, service, plugin, texture, buffer, snapshot, executor } = setup(); t.after(() => driver.dispose());
  const image = texture("z-image"), data = buffer("a-buffer"), original = snapshot();
  const variants: ((s: Snapshot) => void)[] = [
    s => { s.buffers[1].texture = { width: 0, height: 1 }; },
    s => { s.buffers[1].texture = { width: 2 ** 24, height: 2 }; },
    s => { s.buffers[1].texture = { width: 1, height: 1 }; },
    s => { s.buffers[1].type = "float"; s.buffers[1].data = [1, 2]; },
    s => { s.buffers[1].texture = { width: 2, height: 1, extra: true } as never; },
    s => { s.buffers[1].texture = undefined; },
    s => { s.buffers[1].id = "a-buffer"; },
    s => { s.buffers[1].data[1] = [1, 2, 3, NaN]; },
  ];
  for (const mutate of variants) {
    const candidate = structuredClone(original); mutate(candidate);
    assert.throws(() => plugin.validateSnapshot!(candidate), error("TC_COMPUTE_SNAPSHOT"));
    assert.throws(() => plugin.restore!(candidate), error("TC_COMPUTE_SNAPSHOT"));
    assert.deepEqual(snapshot(), original); assert.equal(executor.released.length, 0);
    assert.deepEqual(service.readTexture(image), pixels(1, 2)); assert.deepEqual(service.readBuffer(data), pixels(3, 4));
  }
});

for (const action of ["restore", "replace", "same-executor", "dispose"] as const) for (const late of ["success", "rejection"] as const)
  test(`textures: ${action} invalidates pending chains and ignores late executor ${late}`, async t => {
    const { driver, service, plugin, texture, executor, snapshot } = setup(); t.after(() => driver.dispose());
    const image = texture("image"), target = texture("target"), wait = deferred<readonly GraphValue[]>(), saved = snapshot();
    executor.implementation = () => wait.promise;
    const root = service.dispatch("seed", { output: image });
    const child = service.dispatch("sample", { output: target, textures: { image: { task: root } } });
    const flushing = driver.flush(); await turn();
    assert.throws(() => snapshot(), error("TC_COMPUTE_BUSY"));
    assert.throws(() => plugin.restore!(saved), error("TC_COMPUTE_BUSY"));
    if (action === "restore") { service.cancel(child); service.cancel(root); plugin.restore!(saved); }
    else if (action === "replace") driver.replaceExecutor(new Executor());
    else if (action === "same-executor") driver.replaceExecutor(executor);
    else driver.dispose();
    await flushing;
    if (late === "success") wait.resolve(pixels(99, 100)); else wait.reject(new Error("late texture rejection"));
    await turn();
    assert.equal(executor.commits.length, 0); assert.equal(executor.discarded.length, 1);
    if (action === "dispose") {
      assert.equal(executor.disposed, 1);
      assert.throws(() => service.resolveTexture("image"), error("TC_COMPUTE_DISPOSED"));
      assert.throws(() => driver.textureResource("image"), error("TC_COMPUTE_DISPOSED"));
    } else {
      const live = service.resolveTexture("image");
      assert.deepEqual(service.readTexture(live), pixels(1, 2)); assert.equal(service.describeTexture(live).revision, 0);
      if (action === "restore") assert.throws(() => service.task(root), error("TC_COMPUTE_TASK_HANDLE"));
      else {
        assert.equal(service.task(root).status, "cancelled"); assert.equal(service.task(child).status, "cancelled");
        assert.throws(() => service.dispatch("sample", { output: target, textures: { image: { task: root } } }), error("TC_COMPUTE_DEPENDENCY_RESOURCE"));
        service.writeTexture(image, pixels(7, 8));
      }
    }
  });

test("textures: idle executor replacement preserves CPU textures but invalidates retained task results", async t => {
  const { driver, service, texture, executor } = setup(); t.after(() => driver.dispose());
  const image = texture("image"), target = texture("target");
  const root = service.dispatch("seed", { output: image }); await driver.flush();
  const next = new Executor(); driver.replaceExecutor(next);
  assert.equal(executor.disposed, 1); assert.equal(service.task(root).status, "succeeded");
  assert.deepEqual(service.readTexture(image), pixels(5, 5)); assert.equal(service.describeTexture(image).revision, 1);
  assert.throws(() => service.dispatch("sample", { output: target, textures: { image: { task: root } } }), error("TC_COMPUTE_DEPENDENCY_RESOURCE"));
  service.dispatch("sample", { output: target, textures: { image } }); await driver.flush();
  assert.equal(marker(next.requests[0].textures!.image), true); assert.equal(next.requests[0].textures!.image.revision, 1);
  assert.deepEqual(service.readTexture(target), pixels(5, 5));
});
