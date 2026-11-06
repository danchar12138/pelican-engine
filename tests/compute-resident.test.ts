import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createComputeExecutor } from "../packages/renderer/src/compute-executor.ts";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import type {
  ComputeExecutionInput,
  ComputeExecutionRequest,
} from "../packages/runtime/src/compute-contract.ts";
import type { GraphType, GraphValue } from "../packages/sdk/src/index.ts";

// Ownership and injected readback only: this fixture does not execute WGSL.
Object.assign(globalThis, {
  GPUBufferUsage: {
    MAP_READ: 1,
    COPY_SRC: 4,
    COPY_DST: 8,
    UNIFORM: 64,
    STORAGE: 128,
  },
  GPUMapMode: { READ: 1 },
  GPUShaderStage: { COMPUTE: 4 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class BufferFixture {
  readonly bytes: ArrayBuffer;
  destroyed = 0;
  constructor(
    readonly size: number,
    readonly usage: number,
    readonly mapping: () => Promise<void>,
  ) {
    this.bytes = new ArrayBuffer(size);
  }
  destroy() {
    this.destroyed++;
  }
  unmap() {}
  getMappedRange() {
    assert.equal(this.destroyed, 0);
    return this.bytes;
  }
  mapAsync() {
    return this.mapping();
  }
}
function fixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const state = {
    buffers: [] as BufferFixture[],
    writes: [] as { buffer: BufferFixture; data: number[] }[],
    groups: [] as GPUBindGroupDescriptor[],
    output: [11, 0, 0, 0, 21, 0, 0, 0],
    fault: 0,
    mapping: 0,
    copies: 0,
    submissions: 0,
    scopes: 0,
    popped: 0,
    compileGate: undefined as
      | ReturnType<typeof deferred<GPUCompilationInfo>>
      | undefined,
    pipelineGate: undefined as
      | ReturnType<typeof deferred<GPUComputePipeline>>
      | undefined,
    mapGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    scopeGate: undefined as
      | ReturnType<typeof deferred<GPUError | null>>
      | undefined,
    scopeError: null as GPUError | null,
    shaderError: false,
    mapError: false,
    failWrite: false,
  };
  const binding = (index: number, group = state.groups.at(-1)!) =>
    (
      Array.from(group.entries).find((entry) => entry.binding === index)!
        .resource as GPUBufferBinding
    ).buffer as unknown as BufferFixture;
  const pipeline = {
    getBindGroupLayout: () => ({}),
  } as unknown as GPUComputePipeline;
  const device = {
    limits: {
      maxBufferSize: 2 ** 28,
      maxStorageBufferBindingSize: 2 ** 27,
      maxUniformBufferBindingSize: 65536,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBuffersPerShaderStage: 12,
    },
    lost: loss.promise,
    pushErrorScope() {
      state.scopes++;
    },
    popErrorScope() {
      state.scopes--;
      state.popped++;
      return state.scopeGate?.promise ?? Promise.resolve(state.scopeError);
    },
    createShaderModule() {
      return {
        getCompilationInfo: () =>
          state.compileGate?.promise ??
          Promise.resolve({
            messages: state.shaderError
              ? [{ type: "error", message: "injected shader failure" }]
              : [],
          }),
      };
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipelineAsync: () =>
      state.pipelineGate?.promise ?? Promise.resolve(pipeline),
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      state.groups.push(descriptor);
      return descriptor;
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const buffer = new BufferFixture(
        Number(descriptor.size),
        descriptor.usage,
        async () => {
          state.mapping++;
          await state.mapGate?.promise;
          if (state.mapError) throw Error("injected mapping failure");
        },
      );
      state.buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder() {
      const commands: (() => void)[] = [];
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          end() {},
        }),
        copyBufferToBuffer(
          src: BufferFixture,
          offset: number,
          dst: BufferFixture,
          target: number,
          size: number,
        ) {
          state.copies++;
          commands.push(() => {
            assert.equal(src.destroyed, 0);
            assert.equal(dst.destroyed, 0);
            assert.ok(src.usage & GPUBufferUsage.COPY_SRC);
            new Uint8Array(dst.bytes, target, size).set(
              new Uint8Array(src.bytes, offset, size),
            );
          });
        },
        finish: () => commands,
      };
    },
    queue: {
      writeBuffer(
        buffer: BufferFixture,
        offset: number,
        data: Float32Array | Uint32Array,
      ) {
        if (state.failWrite) throw Error("injected upload failure");
        assert.equal(buffer.destroyed, 0);
        new Uint8Array(buffer.bytes, offset, data.byteLength).set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
        state.writes.push({ buffer, data: Array.from(data) });
      },
      submit(commands: (() => void)[][]) {
        state.submissions++;
        new Float32Array(binding(0).bytes).set(state.output);
        new Uint32Array(binding(2).bytes)[0] = state.fault;
        commands.flat().forEach((command) => command());
      },
    },
  };
  return Object.assign(state, {
    device: device as unknown as GPUDevice,
    loss,
    pipeline,
    binding,
  });
}
function input(
  revision = 0,
  values: readonly GraphValue[] = [0, 0],
  key = "state",
  type: GraphType = "float",
): ComputeExecutionInput {
  return { key, type, revision, values };
}
function request(
  snapshot?: ComputeExecutionInput,
  retain: boolean | undefined = true,
  key = "state",
  type: GraphType = snapshot?.type ?? "float",
): ComputeExecutionRequest {
  const compiled = compileGraphDeclaration(
    snapshot
      ? {
          nodes: [
            { id: "i", op: "input", name: "index" },
            { id: "v", op: "readBuffer", buffer: "state", inputs: ["i"] },
          ],
          output: "v",
        }
      : {
          nodes: [{ id: "v", op: "float", value: 0 }],
          output: "v",
        },
    type,
    { domain: "compute", inputs: ["index"], buffers: { state: type } },
  );
  assert.deepEqual(compiled.issues, []);
  return {
    kernel: {
      id: "resident",
      count: 2,
      workgroupSize: 8,
      outputType: type,
      graph: compiled.graph,
      buffers: snapshot ? [{ name: "state", type }] : [],
      source: { file: "resident-fixture.ts", line: 1, column: 1, length: 1 },
    },
    inputs: snapshot ? { state: snapshot } : {},
    output: { key, type, count: 2, retain },
    parameters: {},
    time: 0,
    signal: new AbortController().signal,
  };
}
function setup(t: TestContext) {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  t.after(() => executor.dispose());
  return { gpu, executor };
}
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 80 && !condition(); i++) await Promise.resolve();
  assert.ok(condition(), "Fixture did not reach the expected async boundary.");
}
function clean(
  gpu: ReturnType<typeof fixture>,
  executor: ReturnType<typeof createComputeExecutor>,
) {
  assert.equal(executor.inspect().liveBuffers, 0);
  assert.equal(executor.inspect().cachedInputs, 0);
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(executor.inspect().committedVersions, 0);
  assert.equal(gpu.scopes, 0);
  assert.ok(gpu.buffers.every((buffer) => buffer.destroyed === 1));
}
function gpuCalls(gpu: ReturnType<typeof fixture>) {
  return [
    gpu.buffers.length,
    gpu.writes.length,
    gpu.copies,
    gpu.submissions,
    gpu.popped,
  ];
}

test("retain defaults to ephemeral outputs and rejects malformed optional retain before allocation", async (t) => {
  const { gpu, executor } = setup(t);
  for (const retain of [undefined, false]) {
    const req = request();
    if (retain === undefined) delete req.output.retain;
    else req.output.retain = retain;
    assert.deepEqual(await executor.run(req), [11, 21]);
    assert.equal(executor.inspect().retentions, 0);
    clean(gpu, executor);
  }
  const before = gpuCalls(gpu);
  for (const retain of [null, 0, "true", {}]) {
    const req = request();
    Object.assign(req.output, { retain });
    await assert.rejects(executor.run(req), /TC_COMPUTE_REQUEST/);
  }
  assert.deepEqual(gpuCalls(gpu), before);
});

test("a retained output is invisible until metadata-only commit; discard and abort afterward preserve it", async (t) => {
  const { gpu, executor } = setup(t);
  const initial = input(),
    checkpoint = executor.resident(initial);
  const controller = new AbortController(),
    req = request(initial);
  req.signal = controller.signal;
  const values = await executor.run(req);
  const output = gpu.binding(0);
  assert.equal(output.destroyed, 0);
  assert.equal(executor.inspect().pendingCandidates, 1);
  assert.equal(executor.inspect().committedVersions, 0);
  assert.equal(executor.resident(initial).buffer, checkpoint.buffer);
  assert.notEqual(output, checkpoint.buffer);
  assert.equal(executor.inspect().liveBuffers, 2);
  const before = gpuCalls(gpu);
  executor.commit("state", 1);
  assert.deepEqual(gpuCalls(gpu), before);
  const view = executor.resident(input(1, values));
  assert.equal(view.buffer, output);
  assert.equal(view.type, "float");
  assert.equal(view.count, 2);
  assert.equal(view.revision, 1);
  assert.equal(executor.inspect().uploads, 1);
  assert.equal(executor.inspect().checkpointUploads, 1);
  assert.equal(executor.inspect().retentions, 1);
  assert.equal(executor.inspect().commits, 1);
  executor.discard("state");
  executor.discard("state");
  controller.abort();
  assert.equal(executor.resident(input(1, values)).buffer, output);
  assert.equal(output.destroyed, 0);
  assert.throws(() => executor.commit("state", 2), /TC_COMPUTE_CANDIDATE/);
});

test("rejected commits preserve candidates and the previous visible version", async (t) => {
  const { gpu, executor } = setup(t);
  const values = await executor.run(request());
  executor.commit("state", 1);
  const first = executor.resident(input(1, values));
  gpu.output = [30, 0, 0, 0, 40, 0, 0, 0];
  const next = await executor.run(request(input(1, values)));
  const candidate = gpu.binding(0),
    before = gpuCalls(gpu);
  assert.throws(() => executor.commit("other", 2), /TC_COMPUTE_CANDIDATE/);
  for (const revision of [
    -1,
    0,
    1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => executor.commit("state", revision),
      /TC_COMPUTE_REVISION/,
    );
  assert.deepEqual(gpuCalls(gpu), before);
  assert.equal(executor.inspect().pendingCandidates, 1);
  assert.equal(executor.resident(input(1, values)).buffer, first.buffer);
  assert.equal(candidate.destroyed, 0);
  executor.commit("state", 2);
  assert.equal(executor.resident(input(2, next)).buffer, candidate);
  assert.equal(executor.inspect().committedVersions, 2);
});

for (const changed of [
  input(0, [0]),
  input(0, [false, false], "state", "bool"),
])
  test(
    "commit validates candidate type and count against the CPU checkpoint: " +
      changed.type +
      "/" +
      changed.values.length,
    async (t) => {
      const { gpu, executor } = setup(t);
      await executor.run(request());
      executor.resident(changed);
      assert.throws(() => executor.commit("state", 1), /TC_COMPUTE_TYPE/);
      assert.equal(executor.inspect().pendingCandidates, 1);
      executor.discard("state");
      executor.discard("state");
      assert.equal(gpu.binding(0).destroyed, 1);
      assert.equal(executor.inspect().committedVersions, 0);
    },
  );

test("captured committed history feeds dispatches without CPU uploads or overwriting the old buffer", async (t) => {
  const { gpu, executor } = setup(t);
  const values1 = await executor.run(request());
  executor.commit("state", 1);
  const captured = input(1, values1),
    first = executor.resident(captured);
  gpu.output = [31, 0, 0, 0, 41, 0, 0, 0];
  const values2 = await executor.run(request(captured));
  executor.commit("state", 2);
  const second = executor.resident(input(2, values2));
  assert.equal(gpu.binding(3), first.buffer);
  assert.notEqual(second.buffer, first.buffer);
  assert.deepEqual(
    Array.from(
      new Float32Array((first.buffer as unknown as BufferFixture).bytes),
    ),
    [11, 0, 0, 0, 21, 0, 0, 0],
  );
  executor.collect([
    { key: "state", revision: 1 },
    { key: "state", revision: 2 },
  ]);
  const req = request(captured);
  delete req.output.retain;
  await executor.run(req);
  assert.equal(gpu.binding(3), first.buffer);
  assert.equal(executor.inspect().uploads, 0);
  assert.equal(executor.inspect().residentHits, 4);
  assert.equal(executor.inspect().committedVersions, 2);
  executor.collect([{ key: "state", revision: 2 }]);
  assert.equal((first.buffer as unknown as BufferFixture).destroyed, 1);
  assert.equal(executor.inspect().committedVersions, 1);
  assert.equal(executor.resident(input(2, values2)).buffer, second.buffer);
  const before = gpuCalls(gpu);
  await assert.rejects(executor.run(request(captured)), /TC_COMPUTE_REVISION/);
  assert.deepEqual(gpuCalls(gpu), before);
});

test("an initial CPU snapshot remains readable after commit until collect; collect keeps current cached inputs", async (t) => {
  const { gpu, executor } = setup(t);
  const initial = input(),
    independent = input(7, [5, 6], "checkpoint");
  const checkpoint = executor.resident(independent);
  const first = await executor.run(request(initial));
  executor.commit("state", 1);
  const originalInput = gpu.binding(3);
  await executor.run(request(initial));
  executor.commit("state", 2);
  assert.equal(gpu.binding(3), originalInput);
  assert.equal(executor.inspect().uploads, 2);
  executor.collect([
    { key: "state", revision: 2 },
    { key: "checkpoint", revision: 7 },
  ]);
  assert.equal(originalInput.destroyed, 1);
  assert.equal(executor.inspect().cachedInputs, 1);
  assert.equal(executor.resident(independent).buffer, checkpoint.buffer);
  executor.resident(input(2, first));
  assert.equal(executor.inspect().uploads, 2);
  assert.equal(executor.inspect().inputUploads, 1);
  assert.equal(executor.inspect().checkpointUploads, 1);
  executor.collect([]);
  clean(gpu, executor);
});

test("checkpoint and explicit CPU writes upload once, remain copyable, and survive collection at the current revision", async (t) => {
  const { gpu, executor } = setup(t);
  const initial = executor.resident(input(4, [2, 3]));
  assert.equal(
    initial.buffer.usage &
      (GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  );
  // The fixture's native buffer exposes usage, just as GPUBuffer does.
  assert.equal(executor.resident(input(4, [2, 3])).buffer, initial.buffer);
  executor.collect([{ key: "state", revision: 4 }]);
  assert.equal(executor.resident(input(4, [2, 3])).buffer, initial.buffer);
  const next = executor.resident(input(5, [7, 8]));
  assert.notEqual(next.buffer, initial.buffer);
  assert.equal((initial.buffer as unknown as BufferFixture).destroyed, 1);
  const req = request(input(5, [7, 8]), false);
  await executor.run(req);
  assert.equal(gpu.binding(3), next.buffer);
  executor.collect([{ key: "state", revision: 5 }]);
  assert.equal(executor.resident(input(5, [7, 8])).buffer, next.buffer);
  assert.equal(executor.inspect().uploads, 2);
  assert.equal(executor.inspect().checkpointUploads, 2);
  assert.equal(executor.inspect().inputUploads, 0);
  const rebuilt = createComputeExecutor(gpu.device);
  rebuilt.resident(input(5, [7, 8]));
  assert.equal(rebuilt.inspect().checkpointUploads, 1);
  rebuilt.dispose();
});

test("failed checkpoint uploads leave the previous visible CPU snapshot intact", (t) => {
  const { gpu, executor } = setup(t);
  const first = executor.resident(input());
  gpu.failWrite = true;
  assert.throws(() => executor.resident(input(1, [3, 4])), /TC_COMPUTE_GPU/);
  gpu.failWrite = false;
  assert.equal(executor.resident(input()).buffer, first.buffer);
  assert.equal(executor.inspect().uploads, 1);
  assert.equal(gpu.buffers.at(-1)!.destroyed, 1);
});

test("resident and run validate packed bits, including signed zero, and allow identical f32 rounding", async (t) => {
  const { gpu, executor } = setup(t);
  const checkpoint = executor.resident(input(0, [1, 0]));
  assert.equal(
    executor.resident(input(0, [1 + 2 ** -25, 0])).buffer,
    checkpoint.buffer,
  );
  const before = gpuCalls(gpu);
  assert.throws(
    () => executor.resident(input(0, [1, -0])),
    /TC_COMPUTE_REVISION/,
  );
  await assert.rejects(
    executor.run(request(input(0, [1, -0]))),
    /TC_COMPUTE_REVISION/,
  );
  assert.deepEqual(gpuCalls(gpu), before);
  gpu.output = [-0, 0, 0, 0, 2, 0, 0, 0];
  const values = await executor.run(request(input(0, [1, 0])));
  executor.commit("state", 1);
  assert.equal(executor.resident(input(1, values)).buffer, gpu.binding(0));
  const committedCalls = gpuCalls(gpu);
  assert.throws(
    () => executor.resident(input(1, [0, 2])),
    /TC_COMPUTE_REVISION/,
  );
  await assert.rejects(
    executor.run(request(input(1, [0, 2]))),
    /TC_COMPUTE_REVISION/,
  );
  assert.deepEqual(gpuCalls(gpu), committedCalls);
});

test("resident validates descriptors and actual device limits before allocation", (t) => {
  const { gpu, executor } = setup(t);
  const bad = [
    null,
    {},
    input(-1),
    input(0.5),
    input(0, []),
    input(0, [NaN]),
    input(0, [Infinity]),
    input(0, [1e100]),
    input(0, [false]),
    input(0, [0], ""),
    { ...input(), type: "mat4" },
  ];
  for (const descriptor of bad)
    assert.throws(
      () => executor.resident(descriptor as ComputeExecutionInput),
      /TC_COMPUTE_(BINDING|VALUE)/,
    );
  for (const limit of [
    "maxBufferSize",
    "maxStorageBufferBindingSize",
  ] as const) {
    const limits = gpu.device.limits as unknown as Record<string, number>,
      previous = limits[limit];
    limits[limit] = 16;
    assert.throws(() => executor.resident(input()), /TC_COMPUTE_LIMIT/);
    limits[limit] = previous;
  }
  assert.equal(gpu.buffers.length, 0);
});

test("aborting a completed candidate or discarding it twice keeps committed output visible", async (t) => {
  const { gpu, executor } = setup(t);
  const values = await executor.run(request());
  executor.commit("state", 1);
  const visible = executor.resident(input(1, values));
  for (const action of ["abort", "discard"] as const) {
    const req = request(input(1, values)),
      controller = new AbortController();
    req.signal = controller.signal;
    await executor.run(req);
    const candidate = gpu.binding(0);
    if (action === "abort") controller.abort();
    else {
      executor.discard("state");
      executor.discard("state");
    }
    assert.equal(candidate.destroyed, 1);
    assert.equal(executor.inspect().pendingCandidates, 0);
    assert.throws(() => executor.commit("state", 2), /TC_COMPUTE_CANDIDATE/);
    assert.equal(executor.resident(input(1, values)).buffer, visible.buffer);
  }
});

for (const action of [
  "abort",
  "discard",
  "release",
  "dispose",
  "loss",
  "timeout",
] as const)
  test(
    action +
      " cancels retained mapping, releases buffers, and blocks late candidate publication",
    async (t) => {
      const { gpu, executor } = setup(t);
      if (action === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const controller = new AbortController(),
        req = request(input());
      req.signal = controller.signal;
      gpu.mapGate = deferred<void>();
      const running = executor.run(req),
        rejected = assert.rejects(
          running,
          action === "loss"
            ? /TC_COMPUTE_DEVICE_LOST/
            : action === "timeout"
              ? /TC_COMPUTE_TIMEOUT/
              : /TC_COMPUTE_CANCELLED/,
        );
      await waitFor(() => gpu.mapping > 0);
      assert.equal(executor.inspect().pendingCandidates, 0);
      assert.throws(() => executor.commit("state", 1), /TC_COMPUTE_BUSY/);
      assert.throws(() => executor.collect([]), /TC_COMPUTE_BUSY/);
      if (action === "abort") controller.abort();
      if (action === "discard") executor.discard("state");
      if (action === "release") executor.release("state");
      if (action === "dispose") executor.dispose();
      if (action === "loss")
        gpu.loss.resolve({ reason: "destroyed" } as GPUDeviceLostInfo);
      if (action === "timeout") t.mock.timers.tick(10_001);
      await rejected;
      clean(gpu, executor);
      const allocations = executor.inspect().allocations;
      gpu.mapGate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(executor.inspect().allocations, allocations);
      clean(gpu, executor);
    },
  );

for (const stage of ["compile", "pipeline", "scope"] as const)
  test(
    "retained timeout during " + stage + " never publishes a late candidate",
    async (t) => {
      const { gpu, executor } = setup(t);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      if (stage === "compile") gpu.compileGate = deferred<GPUCompilationInfo>();
      if (stage === "pipeline")
        gpu.pipelineGate = deferred<GPUComputePipeline>();
      if (stage === "scope") gpu.scopeGate = deferred<GPUError | null>();
      const running = executor.run(request()),
        rejected = assert.rejects(running, /TC_COMPUTE_TIMEOUT/);
      if (stage !== "compile") await waitFor(() => gpu.popped >= 6);
      t.mock.timers.tick(10_001);
      await rejected;
      gpu.compileGate?.resolve({
        messages: [],
      } as unknown as GPUCompilationInfo);
      gpu.pipelineGate?.resolve(gpu.pipeline);
      gpu.scopeGate?.resolve(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      clean(gpu, executor);
      assert.equal(executor.inspect().retentions, 0);
    },
  );

test("all final dispatch error scopes must succeed before a pending candidate exists", async (t) => {
  const { gpu, executor } = setup(t);
  const values = await executor.run(request());
  executor.commit("state", 1);
  gpu.scopeGate = deferred<GPUError | null>();
  const pending = executor.run(request());
  await waitFor(() => gpu.mapping === 2);
  assert.equal(executor.inspect().pendingCandidates, 0);
  gpu.scopeGate.resolve(null);
  await pending;
  assert.equal(executor.inspect().pendingCandidates, 1);
  assert.equal(executor.resident(input(1, values)).revision, 1);
});

for (const failure of [
  "shader",
  "fault",
  "nonfinite",
  "bool",
  "map",
  "scope",
  "upload",
] as const)
  test(
    "retained " +
      failure +
      " failure preserves the previously committed output",
    async (t) => {
      const { gpu, executor } = setup(t);
      const values = await executor.run(request());
      executor.commit("state", 1);
      const visible = executor.resident(input(1, values));
      // A different input layout forces compilation when injecting a shader error.
      const req = request(input(1, values), true, "other");
      if (failure === "shader") gpu.shaderError = true;
      if (failure === "fault") gpu.fault = 1;
      if (failure === "nonfinite") gpu.output[0] = NaN;
      if (failure === "bool") {
        req.kernel.outputType =
          req.kernel.graph.outputType =
          req.output.type =
            "bool";
        const compiled = compileGraphDeclaration(
          {
            nodes: [{ id: "v", op: "bool", value: false }],
            output: "v",
          },
          "bool",
          { domain: "compute", inputs: ["index"] },
        );
        assert.deepEqual(compiled.issues, []);
        req.kernel.graph = compiled.graph;
        req.kernel.buffers = [];
        req.inputs = {};
        gpu.output[0] = 2;
      }
      if (failure === "map") gpu.mapError = true;
      if (failure === "scope")
        gpu.scopeError = { message: "injected scope failure" };
      if (failure === "upload") gpu.failWrite = true;
      await assert.rejects(
        executor.run(req),
        /TC_COMPUTE_(SHADER|BOUNDS|NONFINITE|GPU)/,
      );
      assert.equal(executor.inspect().pendingCandidates, 0);
      assert.equal(executor.inspect().committedVersions, 1);
      assert.equal(executor.resident(input(1, values)).buffer, visible.buffer);
      assert.equal((visible.buffer as unknown as BufferFixture).destroyed, 0);
    },
  );

for (const action of ["release", "dispose", "loss"] as const)
  test(
    action +
      " destroys pending, committed history, and CPU input buffers exactly once",
    async (t) => {
      const { gpu, executor } = setup(t);
      executor.resident(input());
      const first = await executor.run(request(input()));
      executor.commit("state", 1);
      await executor.run(request(input(1, first)));
      executor.commit("state", 2);
      await executor.run(request());
      assert.equal(executor.inspect().committedVersions, 2);
      assert.equal(executor.inspect().pendingCandidates, 1);
      assert.equal(executor.inspect().cachedInputs, 1);
      if (action === "release") {
        executor.release("state");
        executor.release("state");
      }
      if (action === "dispose") {
        executor.dispose();
        executor.dispose();
      }
      if (action === "loss") {
        gpu.loss.resolve({ reason: "destroyed" } as GPUDeviceLostInfo);
        await waitFor(() => executor.inspect().deviceLost);
      }
      clean(gpu, executor);
      if (action !== "release") {
        const code =
          action === "dispose"
            ? /TC_COMPUTE_DISPOSED/
            : /TC_COMPUTE_DEVICE_LOST/;
        assert.throws(() => executor.resident(input()), code);
        assert.throws(() => executor.commit("state", 3), code);
        await assert.rejects(executor.run(request()), code);
      }
    },
  );

test("collect validates the entire live list before freeing versions and never touches pending candidates", async (t) => {
  const { gpu, executor } = setup(t);
  await executor.run(request());
  executor.commit("state", 1);
  await executor.run(request());
  executor.commit("state", 2);
  await executor.run(request());
  const before = executor.inspect();
  assert.throws(
    () =>
      executor.collect([
        { key: "state", revision: 2 },
        { key: "state", revision: 2 },
      ]),
    /TC_COMPUTE_REVISION/,
  );
  assert.equal(executor.inspect().liveBuffers, before.liveBuffers);
  executor.collect([
    { key: "state", revision: 2 },
    { key: "state", revision: 1 },
  ]);
  assert.equal(executor.inspect().committedVersions, 2);
  assert.equal(executor.inspect().liveBuffers, before.liveBuffers);
  assert.equal(executor.inspect().pendingCandidates, 1);
  executor.collect([{ key: "state", revision: 2 }]);
  assert.equal(executor.inspect().committedVersions, 1);
  assert.equal(executor.inspect().pendingCandidates, 1);
  assert.equal(gpu.binding(0).destroyed, 0);
  executor.commit("state", 3);
});

for (const [type, initial, output, expected] of [
  ["bool", [false, false], [1, 0, 0, 0, 0, 0, 0, 0], [true, false]],
  [
    "vec2",
    [
      [0, 0],
      [0, 0],
    ],
    [1, 2, 0, 0, 3, 4, 0, 0],
    [
      [1, 2],
      [3, 4],
    ],
  ],
  [
    "vec3",
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [1, 2, 3, 0, 4, 5, 6, 0],
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  ],
  [
    "vec4",
    [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    [1, 2, 3, 4, 5, 6, 7, 8],
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ],
  ],
] as const)
  test(
    type + " commits and feeds back exactly packed vec4 storage",
    async (t) => {
      const { gpu, executor } = setup(t);
      gpu.output = [...output];
      const snapshot = input(0, initial, "state", type);
      const values = await executor.run(request(snapshot));
      assert.deepEqual(values, expected);
      executor.commit("state", 1);
      const committed = input(1, values, "state", type),
        view = executor.resident(committed);
      assert.equal(view.buffer, gpu.binding(0));
      assert.equal(view.type, type);
      assert.equal(view.count, 2);
      assert.ok(gpu.binding(3).usage & GPUBufferUsage.COPY_SRC);
      await executor.run(request(committed));
      assert.equal(gpu.binding(3), view.buffer);
      assert.equal(executor.inspect().uploads, 1);
      executor.discard("state");
      executor.collect([{ key: "state", revision: 1 }]);
      assert.equal(executor.resident(committed).buffer, view.buffer);
    },
  );

test("retained results validate padding bits before becoming candidates", async (t) => {
  const { gpu, executor } = setup(t);
  gpu.output[1] = 9;
  await assert.rejects(
    executor.run(request()),
    /TC_COMPUTE_GPU: Invalid packed result encoding/,
  );
  clean(gpu, executor);
  assert.equal(executor.inspect().retentions, 0);
  // The established unretained decoding contract still ignores finite padding.
  assert.deepEqual(await executor.run(request(undefined, false)), [11, 21]);
  clean(gpu, executor);
});

test("retention and candidate contents are captured before asynchronous work", async (t) => {
  const { gpu, executor } = setup(t);
  const req = request(input());
  gpu.compileGate = deferred<GPUCompilationInfo>();
  const running = executor.run(req);
  req.output.retain = false;
  req.output.key = "changed";
  req.output.count = 99;
  gpu.compileGate.resolve({ messages: [] } as unknown as GPUCompilationInfo);
  const values = await running;
  assert.equal(executor.inspect().pendingCandidates, 1);
  executor.commit("state", 1);
  // Mutating the returned CPU array cannot alter the resident bit-match record.
  (values as GraphValue[])[0] = 999;
  const before = gpuCalls(gpu);
  assert.throws(
    () => executor.resident(input(1, values)),
    /TC_COMPUTE_REVISION/,
  );
  assert.equal(executor.resident(input(1, [11, 21])).buffer, gpu.binding(0));
  assert.deepEqual(gpuCalls(gpu), before);
});

for (const action of ["dispose", "loss"] as const)
  test(
    action +
      " clears every resource while another retained dispatch is in flight",
    async (t) => {
      const { gpu, executor } = setup(t);
      executor.resident(input());
      const first = await executor.run(request(input()));
      executor.commit("state", 1);
      await executor.run(request(input(1, first)));
      executor.commit("state", 2);
      await executor.run(request(undefined, true, "pending-other"));
      gpu.mapGate = deferred<void>();
      const mapping = gpu.mapping;
      const running = executor.run(request(input(1, first)));
      const rejected = assert.rejects(
        running,
        action === "loss" ? /TC_COMPUTE_DEVICE_LOST/ : /TC_COMPUTE_CANCELLED/,
      );
      await waitFor(() => gpu.mapping > mapping);
      assert.equal(executor.inspect().pendingCandidates, 1);
      assert.equal(executor.inspect().committedVersions, 2);
      if (action === "dispose") executor.dispose();
      else gpu.loss.resolve({ reason: "destroyed" } as GPUDeviceLostInfo);
      await rejected;
      clean(gpu, executor);
      gpu.mapGate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      clean(gpu, executor);
    },
  );

test("replacing a pending candidate detaches its abort listener and release is isolated by key", async (t) => {
  const { gpu, executor } = setup(t);
  const oldController = new AbortController(),
    firstRequest = request();
  firstRequest.signal = oldController.signal;
  await executor.run(firstRequest);
  const previousCandidate = gpu.binding(0);
  const values = await executor.run(request());
  const replacement = gpu.binding(0);
  assert.equal(previousCandidate.destroyed, 1);
  oldController.abort();
  assert.equal(replacement.destroyed, 0);
  assert.equal(executor.inspect().pendingCandidates, 1);
  executor.commit("state", 1);
  executor.resident(input(0, [4, 5], "other"));
  await executor.run(request(undefined, true, "other"));
  executor.release("other");
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(executor.inspect().committedVersions, 1);
  assert.equal(executor.resident(input(1, values)).buffer, replacement);
});

for (const action of ["abort", "timeout"] as const)
  test(
    action +
      " while final scopes are pending blocks late retention and preserves the visible version",
    async (t) => {
      const { gpu, executor } = setup(t);
      const values = await executor.run(request());
      executor.commit("state", 1);
      const visible = executor.resident(input(1, values));
      if (action === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const controller = new AbortController(),
        req = request();
      req.signal = controller.signal;
      gpu.scopeGate = deferred<GPUError | null>();
      const pending = executor.run(req);
      const rejected = assert.rejects(
        pending,
        action === "timeout" ? /TC_COMPUTE_TIMEOUT/ : /TC_COMPUTE_CANCELLED/,
      );
      await waitFor(() => gpu.mapping === 2);
      assert.equal(executor.inspect().pendingCandidates, 0);
      if (action === "timeout") t.mock.timers.tick(10_001);
      else controller.abort();
      await rejected;
      gpu.scopeGate.resolve(null);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(executor.inspect().pendingCandidates, 0);
      assert.equal(executor.inspect().retentions, 1);
      assert.equal(executor.resident(input(1, values)).buffer, visible.buffer);
      assert.equal(gpu.binding(0).destroyed, 1);
    },
  );
