import test from "node:test";
import assert from "node:assert/strict";
import { createComputeExecutor } from "../packages/renderer/src/compute-executor.ts";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import type { ComputeExecutionRequest } from "../packages/runtime/src/compute-contract.ts";
import type {
  Graph,
  GraphType,
  GraphValue,
} from "../packages/sdk/src/index.ts";

// These fixtures model API ownership and injected readback, not WGSL evaluation.
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
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const limits: Record<string, number> = {
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
};
class BufferFixture {
  bytes: ArrayBuffer;
  destroyed = 0;
  unmapped = 0;
  constructor(
    readonly size: number,
    readonly usage: number,
    readonly owner: ReturnType<typeof fixture>,
  ) {
    this.bytes = new ArrayBuffer(size);
  }
  destroy() {
    this.destroyed++;
  }
  unmap() {
    this.unmapped++;
  }
  getMappedRange() {
    assert.equal(this.destroyed, 0);
    return this.bytes;
  }
  async mapAsync() {
    this.owner.mapping++;
    await this.owner.mapGate?.promise;
    if (this.owner.mapError) throw this.owner.mapError;
  }
}
function fixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const state = {
    buffers: [] as BufferFixture[],
    sources: [] as string[],
    writes: [] as { buffer: BufferFixture; data: number[] }[],
    groups: [] as GPUBindGroupDescriptor[],
    scopes: [] as GPUErrorFilter[],
    popped: 0,
    pipelines: 0,
    bindGroupLayouts: 0,
    pipelineLayouts: 0,
    dispatches: [] as number[],
    mapping: 0,
    submissions: 0,
    output: [11, 12, 13, 14, 21, 22, 23, 24],
    fault: 0,
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
    mapError: undefined as Error | undefined,
    compilationErrors: [] as GPUCompilationMessage[],
    failWrite: false,
    loss,
  };
  const pipeline = {
    getBindGroupLayout: () => ({}),
  } as unknown as GPUComputePipeline;
  const device = {
    limits: { ...limits },
    lost: loss.promise,
    pushErrorScope(filter: GPUErrorFilter) {
      state.scopes.push(filter);
    },
    popErrorScope() {
      state.popped++;
      state.scopes.pop();
      return state.scopeGate?.promise ?? Promise.resolve(state.scopeError);
    },
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      state.sources.push(descriptor.code);
      return {
        getCompilationInfo: () =>
          state.compileGate?.promise ??
          Promise.resolve({ messages: state.compilationErrors }),
      };
    },
    createBindGroupLayout: (descriptor: unknown) => {
      state.bindGroupLayouts++;
      return descriptor;
    },
    createPipelineLayout: (descriptor: unknown) => {
      state.pipelineLayouts++;
      return descriptor;
    },
    createComputePipelineAsync: () => {
      state.pipelines++;
      return state.pipelineGate?.promise ?? Promise.resolve(pipeline);
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const buffer = new BufferFixture(
        Number(descriptor.size),
        descriptor.usage,
        state as ReturnType<typeof fixture>,
      );
      state.buffers.push(buffer);
      return buffer;
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      state.groups.push(descriptor);
      return descriptor;
    },
    createCommandEncoder() {
      const copies: (() => void)[] = [];
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          end() {},
          dispatchWorkgroups: (count: number) => state.dispatches.push(count),
        }),
        copyBufferToBuffer(
          src: BufferFixture,
          offset: number,
          dst: BufferFixture,
          targetOffset: number,
          size: number,
        ) {
          copies.push(() =>
            new Uint8Array(dst.bytes, targetOffset, size).set(
              new Uint8Array(src.bytes, offset, size),
            ),
          );
        },
        finish: () => copies,
      };
    },
    queue: {
      writeBuffer(
        buffer: BufferFixture,
        offset: number,
        data: Float32Array | Uint32Array,
      ) {
        if (state.failWrite) throw Error("injected write failure");
        new Uint8Array(buffer.bytes, offset, data.byteLength).set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
        state.writes.push({ buffer, data: Array.from(data) });
      },
      submit(commands: (() => void)[][]) {
        state.submissions++;
        const entries = Array.from(state.groups.at(-1)!.entries);
        const output = (
          entries.find((e) => e.binding === 0)!.resource as { buffer: unknown }
        ).buffer as BufferFixture;
        const fault = (
          entries.find((e) => e.binding === 2)!.resource as { buffer: unknown }
        ).buffer as BufferFixture;
        new Float32Array(output.bytes).set(
          state.output.slice(0, output.size / 4),
        );
        new Uint32Array(fault.bytes)[0] = state.fault;
        commands.flat().forEach((copy) => copy());
      },
    },
  };
  return Object.assign(state, {
    device: device as unknown as GPUDevice,
    rawDevice: device,
    pipeline,
  });
}
function request(
  type: GraphType = "float",
  feedback = false,
): ComputeExecutionRequest {
  const fallback: GraphValue =
    type === "bool"
      ? false
      : type === "float"
        ? 0
        : (Array.from(
            { length: Number(type[3]) },
            () => 0,
          ) as unknown as GraphValue);
  const graph: Graph = feedback
    ? {
        nodes: [
          { id: "i", op: "input", name: "index" },
          { id: "v", op: "readBuffer", inputs: ["i"], buffer: "state" },
        ],
        output: "v",
      }
    : {
        nodes: [
          { id: "v", op: type, value: fallback } as Graph["nodes"][number],
        ],
        output: "v",
      };
  const compiled = compileGraphDeclaration(graph, type, {
    domain: "compute",
    inputs: ["index"],
    buffers: { state: type },
  });
  assert.deepEqual(compiled.issues, []);
  return {
    kernel: {
      id: "test",
      count: 2,
      workgroupSize: 8,
      outputType: type,
      graph: compiled.graph,
      buffers: feedback ? [{ name: "state", type }] : [],
      source: { file: "fixture.ts", line: 1, column: 1, length: 1 },
    },
    inputs: feedback
      ? {
          state: {
            key: "state-key",
            type,
            revision: 0,
            values: [fallback, fallback],
          },
        }
      : {},
    output: { key: "state-key", type, count: 2 },
    parameters: {},
    time: 3,
    signal: new AbortController().signal,
  };
}
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 60; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.ok(condition(), "Fixture did not reach expected async boundary.");
}
function assertClean(
  gpu: ReturnType<typeof fixture>,
  executor: ReturnType<typeof createComputeExecutor>,
) {
  assert.equal(executor.inspect().liveBuffers, 0);
  assert.equal(executor.inspect().cachedInputs, 0);
  assert.ok(gpu.buffers.every((buffer) => buffer.destroyed === 1));
  assert.deepEqual(gpu.scopes, []);
}

for (const [type, expected] of [
  ["float", [11, 21]],
  [
    "vec2",
    [
      [11, 12],
      [21, 22],
    ],
  ],
  [
    "vec3",
    [
      [11, 12, 13],
      [21, 22, 23],
    ],
  ],
  [
    "vec4",
    [
      [11, 12, 13, 14],
      [21, 22, 23, 24],
    ],
  ],
  ["bool", [true, false]],
] as const)
  test("GPU readback decoding, exact count and padding: " + type, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    if (type === "bool") gpu.output = [1, 0, 0, 0, 0, 0, 0, 0];
    const values = await executor.run(request(type));
    assert.deepEqual(values, expected);
    assert.deepEqual(gpu.dispatches, [1]);
    assert.equal(gpu.submissions, 1);
    assert.equal(gpu.popped, 9);
    assert.match(gpu.sources[0], /atomicOr\(&tc_fault, 2u\)/);
    assertClean(gpu, executor);
  });

test("input storage is reused; revisions upload; output is always a separate temporary buffer", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  await executor.run(req);
  const firstGroup = Array.from(gpu.groups[0].entries);
  const input = (
    firstGroup.find((e) => e.binding === 3)!.resource as GPUBufferBinding
  ).buffer;
  assert.notEqual(
    input,
    (firstGroup.find((e) => e.binding === 0)!.resource as GPUBufferBinding)
      .buffer,
  );
  assert.equal(executor.inspect().cachedInputs, 1);
  assert.equal(executor.inspect().liveBuffers, 1);
  assert.equal(executor.inspect().uploads, 1);
  await executor.run(req);
  assert.equal(
    (Array.from(gpu.groups[1].entries)[3].resource as GPUBufferBinding).buffer,
    input,
  );
  assert.equal(executor.inspect().uploads, 1);
  assert.equal(executor.inspect().allocations, 9);
  await executor.run({
    ...req,
    inputs: { state: { ...req.inputs.state, revision: 1, values: [5, 6] } },
  });
  assert.equal(executor.inspect().uploads, 2);
  assert.deepEqual(
    gpu.writes
      .filter((write) => write.buffer === (input as unknown))
      .map((write) => write.data),
    [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [5, 0, 0, 0, 6, 0, 0, 0],
    ],
  );
  assert.match(gpu.sources[0], /index < 0\.0 \|\| index != floor\(index\)/);
  assert.match(gpu.sources[0], /arrayLength\(&tc_input_0\)/);
  assert.match(gpu.sources[0], /atomicOr\(&tc_fault, 1u\)/);
  executor.release("state-key");
  executor.release("state-key");
  assertClean(gpu, executor);
  executor.dispose();
  executor.dispose();
  await assert.rejects(executor.run(req), /TC_COMPUTE_DISPOSED/);
});

for (const type of ["float", "vec2", "vec3", "vec4", "bool"] as const)
  test("input and parameter packing: " + type, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device),
      req = request(type, true);
    const value: GraphValue =
      type === "bool"
        ? true
        : type === "float"
          ? 2
          : (Array.from(
              { length: Number(type[3]) },
              (_, i) => i + 2,
            ) as unknown as GraphValue);
    req.kernel.graph.parameters = [{ name: "gain", type, default: value }];
    req.parameters = { gain: value };
    req.inputs = { state: { ...req.inputs.state, values: [value, value] } };
    if (type === "bool") gpu.output = [1, 0, 0, 0, 0, 0, 0, 0];
    await executor.run(req);
    const packed =
      typeof value === "boolean"
        ? [1]
        : typeof value === "number"
          ? [value]
          : [...value];
    while (packed.length < 4) packed.push(0);
    assert.deepEqual(gpu.writes[0].data, [...packed, ...packed]);
    assert.deepEqual(gpu.writes[1].data, [3, 0, 0, 0, ...packed]);
    executor.dispose();
    assertClean(gpu, executor);
  });

test("revision and identity violations fail before another shader or GPU allocation", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  await executor.run(req);
  const attempts = [
    { ...req.inputs.state, values: [9, 9] },
    { ...req.inputs.state, revision: -1 },
    { ...req.inputs.state, values: [0] },
    { ...req.inputs.state, type: "bool" as const },
  ];
  for (const input of attempts)
    await assert.rejects(
      executor.run({ ...req, inputs: { state: input } }),
      /TC_COMPUTE_(REVISION|BINDING|TYPE)/,
    );
  assert.equal(gpu.sources.length, 1);
  assert.equal(executor.inspect().allocations, 5);
  executor.dispose();
  assertClean(gpu, executor);
});

test("aliases share one upload and must have identical snapshots", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  req.kernel.buffers!.push({ name: "other", type: "float" });
  req.inputs = { ...req.inputs, other: req.inputs.state };
  await executor.run(req);
  assert.equal(executor.inspect().cachedInputs, 1);
  assert.equal(executor.inspect().uploads, 1);
  const entries = Array.from(gpu.groups[0].entries);
  assert.equal(
    (entries[3].resource as GPUBufferBinding).buffer,
    (entries[4].resource as GPUBufferBinding).buffer,
  );
  await assert.rejects(
    executor.run({
      ...req,
      inputs: {
        ...req.inputs,
        other: { ...req.inputs.state, revision: 1, values: [7, 8] },
      },
    }),
    /TC_COMPUTE_REVISION/,
  );
  executor.dispose();
  assertClean(gpu, executor);
});

for (const [fault, pattern] of [
  [1, /TC_COMPUTE_BOUNDS/],
  [2, /TC_COMPUTE_NONFINITE/],
  [3, /TC_COMPUTE_BOUNDS/],
  [4, /TC_COMPUTE_GPU/],
] as const)
  test("atomic fault readback rejects transaction: " + fault, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device),
      req = request("float", true);
    gpu.fault = fault;
    await assert.rejects(executor.run(req), pattern);
    assert.deepEqual(req.inputs.state.values, [0, 0]);
    assertClean(gpu, executor);
  });

test("CPU decoded nonfinite and invalid bool encodings cannot succeed", async () => {
  for (const [type, value, pattern] of [
    ["float", Infinity, /TC_COMPUTE_NONFINITE/],
    ["vec3", NaN, /TC_COMPUTE_NONFINITE/],
    ["bool", 2, /TC_COMPUTE_GPU/],
  ] as const) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    gpu.output[0] = value;
    await assert.rejects(executor.run(request(type)), pattern);
    assertClean(gpu, executor);
  }
});

test("time, index, dynamic parameter and readBuffer hooks produce trusted bindings", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  const result = compileGraphDeclaration(
    {
      parameters: [{ name: "delta", type: "float", default: 1 }],
      nodes: [
        { id: "i", op: "input", name: "index" },
        { id: "v", op: "readBuffer", buffer: "state", inputs: ["i"] },
        { id: "t", op: "time" },
        { id: "p", op: "parameter", name: "delta" },
        { id: "step", op: "add", inputs: ["t", "p"] },
        { id: "out", op: "add", inputs: ["v", "step"] },
      ],
      output: "out",
    },
    "float",
    { domain: "compute", inputs: ["index"], buffers: { state: "float" } },
  );
  assert.deepEqual(result.issues, []);
  req.kernel.graph = result.graph;
  req.parameters = { delta: 7 };
  await executor.run(req);
  assert.match(gpu.sources[0], /f32\(tc_id\.x\)/);
  assert.match(gpu.sources[0], /tc_params\[0\]\.x/);
  assert.match(gpu.sources[0], /tc_params\[1\]\.x/);
  assert.match(gpu.sources[0], /tc_read_0\(tc_g0\)\.x/);
  executor.dispose();
  assertClean(gpu, executor);
});

test("request shape, count, workgroup, bindings, types and parameters fail before GPU work", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const mutations: ((req: ComputeExecutionRequest) => void)[] = [
    (r) => {
      r.kernel.count = 0;
    },
    (r) => {
      r.output.count++;
    },
    (r) => {
      r.kernel.workgroupSize = 0;
    },
    (r) => {
      r.kernel.workgroupSize = 1.5;
    },
    (r) => {
      r.time = Infinity;
    },
    (r) => {
      r.parameters = { unknown: 1 };
    },
    (r) => {
      r.inputs = {};
    },
    (r) => {
      r.inputs = { ...r.inputs, extra: r.inputs.state };
    },
    (r) => {
      r.inputs = { state: { ...r.inputs.state, values: [NaN, 0] } };
    },
    (r) => {
      r.inputs = { state: { ...r.inputs.state, revision: 0.5 } };
    },
    (r) => {
      r.output.type = "vec3";
    },
    (r) => {
      r.kernel.graph.outputType = "vec3";
    },
    (r) => {
      r.kernel.graph.bufferTypes = { state: "vec3" };
    },
    (r) => {
      r.kernel.buffers!.push({ name: "state", type: "float" });
    },
    (r) => {
      r.kernel.graph.parameters = [
        { name: "p", type: "float", default: Infinity },
      ];
    },
    (r) => {
      r.kernel.graph.parameters = [{ name: "p", type: "bool", default: false }];
      r.parameters = { p: 0 };
    },
  ];
  for (const mutate of mutations) {
    const req = request("float", true);
    mutate(req);
    await assert.rejects(executor.run(req), /TC_COMPUTE_/);
  }
  for (const malformed of [
    null,
    {},
    { ...request(), signal: null },
    { ...request(), kernel: null },
    { ...request(), inputs: [] },
    { ...request(), parameters: [] },
  ])
    await assert.rejects(
      executor.run(malformed as unknown as ComputeExecutionRequest),
      /TC_COMPUTE_REQUEST/,
    );
  assert.equal(gpu.sources.length, 0);
  assert.equal(gpu.buffers.length, 0);
});

test("every used actual device limit is preflighted", async () => {
  for (const [name, amount] of Object.entries({
    maxBufferSize: 35,
    maxStorageBufferBindingSize: 31,
    maxUniformBufferBindingSize: 15,
    maxComputeWorkgroupSizeX: 7,
    maxComputeInvocationsPerWorkgroup: 7,
    maxComputeWorkgroupsPerDimension: 0,
    maxBindGroups: 0,
    maxBindingsPerBindGroup: 3,
    maxStorageBuffersPerShaderStage: 2,
    maxUniformBuffersPerShaderStage: 0,
  })) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    gpu.rawDevice.limits[name] = amount;
    await assert.rejects(
      executor.run(request("float", true)),
      /TC_COMPUTE_LIMIT/,
      name,
    );
    assert.equal(gpu.sources.length, 0, name);
    assert.equal(gpu.buffers.length, 0, name);
  }
});

test("texture nodes and material-domain inputs are explicitly unsupported even when unreachable", async () => {
  for (const node of [
    {
      id: "unused",
      op: "sampleTexture",
      inputs: ["missing"],
      texture: "asset",
    },
    { id: "unused", op: "input", name: "normalWorld" },
  ] as const) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device),
      req = request();
    req.kernel.graph.nodes = [...req.kernel.graph.nodes, node];
    await assert.rejects(executor.run(req), /TC_COMPUTE_(TEXTURE|DOMAIN)/);
    assert.equal(gpu.sources.length, 0);
  }
});

for (const stage of ["compile", "pipeline", "map", "scope"] as const)
  test(
    "abort at " + stage + " blocks late allocations and results",
    async () => {
      const gpu = fixture(),
        executor = createComputeExecutor(gpu.device),
        controller = new AbortController();
      const compile = deferred<GPUCompilationInfo>(),
        pipeline = deferred<GPUComputePipeline>();
      const map = deferred<void>(),
        scope = deferred<GPUError | null>();
      if (stage === "compile") gpu.compileGate = compile;
      if (stage === "pipeline") gpu.pipelineGate = pipeline;
      if (stage === "map") gpu.mapGate = map;
      if (stage === "scope") gpu.scopeGate = scope;
      const req = { ...request("float", true), signal: controller.signal };
      const pending = executor.run(req);
      const rejected = assert.rejects(pending, /TC_COMPUTE_CANCELLED/);
      if (stage === "pipeline" || stage === "scope")
        await waitFor(() => gpu.popped >= 6);
      if (stage === "map") await waitFor(() => gpu.mapping > 0);
      controller.abort();
      await rejected;
      assertClean(gpu, executor);
      const allocations = executor.inspect().allocations;
      compile.resolve({ messages: [] } as unknown as GPUCompilationInfo);
      pipeline.resolve(gpu.pipeline);
      map.resolve();
      scope.resolve(null);
      await waitFor(() => !executor.inspect().active);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(executor.inspect().allocations, allocations);
      assert.equal(executor.inspect().cachedPipelines, stage === "map" ? 1 : 0);
      assertClean(gpu, executor);
    },
  );

test("already aborted signals never allocate; concurrent run is explicit BUSY", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executor.run({ ...request(), signal: controller.signal }),
    /TC_COMPUTE_CANCELLED/,
  );
  assert.equal(gpu.sources.length, 0);
  gpu.compileGate = deferred<GPUCompilationInfo>();
  const pending = executor.run(request());
  const rejected = assert.rejects(pending, /TC_COMPUTE_CANCELLED/);
  await assert.rejects(executor.run(request()), /TC_COMPUTE_BUSY/);
  executor.dispose();
  await rejected;
  gpu.compileGate.resolve({ messages: [] } as unknown as GPUCompilationInfo);
  await Promise.resolve();
  assertClean(gpu, executor);
});

for (const action of ["release", "dispose", "loss"] as const)
  test(
    action + " cancels mapped work and destroys every owned buffer once",
    async () => {
      const gpu = fixture(),
        executor = createComputeExecutor(gpu.device),
        req = request("float", true);
      gpu.mapGate = deferred<void>();
      const pending = executor.run(req);
      const rejected = assert.rejects(
        pending,
        action === "loss" ? /TC_COMPUTE_DEVICE_LOST/ : /TC_COMPUTE_CANCELLED/,
      );
      await waitFor(() => gpu.mapping === 1);
      if (action === "release") executor.release("state-key");
      if (action === "dispose") executor.dispose();
      if (action === "loss")
        gpu.loss.resolve({
          reason: "destroyed",
          message: "injected device loss",
        } as unknown as GPUDeviceLostInfo);
      await rejected;
      assertClean(gpu, executor);
      gpu.mapGate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assertClean(gpu, executor);
      if (action !== "release")
        assert.equal(executor.inspect().cachedPipelines, 0);
      if (action === "loss")
        await assert.rejects(executor.run(req), /TC_COMPUTE_DEVICE_LOST/);
    },
  );

test("timeout destroys readback, never waits for mapping, and permits a subsequent dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  gpu.mapGate = deferred<void>();
  const pending = executor.run(request("float", true));
  const rejected = assert.rejects(pending, /TC_COMPUTE_TIMEOUT/);
  await waitFor(() => gpu.mapping === 1);
  t.mock.timers.tick(10_001);
  await rejected;
  assertClean(gpu, executor);
  const allocations = executor.inspect().allocations;
  gpu.mapGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(executor.inspect().allocations, allocations);
  gpu.mapGate = undefined;
  await executor.run(request());
  assertClean(gpu, executor);
});

test("timeout also bounds stuck compilation and error scope promises", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["compile", "scope"] as const) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    if (stage === "compile") gpu.compileGate = deferred<GPUCompilationInfo>();
    else gpu.scopeGate = deferred<GPUError | null>();
    const pending = executor.run(request("float", true));
    const rejected = assert.rejects(pending, /TC_COMPUTE_TIMEOUT/);
    if (stage === "scope") await waitFor(() => gpu.popped >= 6);
    t.mock.timers.tick(10_001);
    await rejected;
    assertClean(gpu, executor);
    gpu.compileGate?.resolve({ messages: [] } as unknown as GPUCompilationInfo);
    gpu.scopeGate?.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    assertClean(gpu, executor);
    assert.equal(executor.inspect().cachedPipelines, 0);
  }
});

test("trusted source cache reuses one pipeline across parameter, time and input data changes", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  const compiled = compileGraphDeclaration(
    {
      parameters: [{ name: "delta", type: "float", default: 1 }],
      nodes: [
        { id: "i", op: "input", name: "index" },
        { id: "old", op: "readBuffer", buffer: "state", inputs: ["i"] },
        { id: "delta", op: "parameter", name: "delta" },
        { id: "out", op: "add", inputs: ["old", "delta"] },
      ],
      output: "out",
    },
    "float",
    { domain: "compute", inputs: ["index"], buffers: { state: "float" } },
  );
  assert.deepEqual(compiled.issues, []);
  req.kernel.graph = compiled.graph;
  await executor.run(req);
  await executor.run({ ...req, parameters: { delta: 7 } });
  await executor.run({
    ...req,
    time: 99,
    parameters: { delta: -2 },
    inputs: { state: { ...req.inputs.state, revision: 1, values: [5, 6] } },
  });
  assert.equal(gpu.sources.length, 1);
  assert.equal(gpu.pipelines, 1);
  assert.equal(gpu.bindGroupLayouts, 1);
  assert.equal(gpu.pipelineLayouts, 1);
  assert.equal(executor.inspect().cachedPipelines, 1);
  const uniforms = gpu.writes.filter(
    (write) =>
      write.buffer.usage === (GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
  );
  assert.deepEqual(
    uniforms.map((write) => [write.data[0], write.data[4]]),
    [
      [3, 1],
      [3, 7],
      [99, -2],
    ],
  );
  executor.dispose();
  assert.equal(executor.inspect().cachedPipelines, 0);
  assertClean(gpu, executor);
});

test("request data and signal are snapshotted before asynchronous GPU work", async (t) => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device),
    req = request("float", true);
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const values = [1, 2];
  req.signal = controller.signal;
  req.inputs = { state: { ...req.inputs.state, values } };
  req.kernel.graph.parameters = [{ name: "gain", type: "float", default: 1 }];
  req.parameters = { gain: 4 };
  gpu.compileGate = deferred<GPUCompilationInfo>();
  const pending = executor.run(req);
  values[0] = 999;
  req.time = 500;
  req.parameters = { gain: 9 };
  req.signal = new AbortController().signal;
  gpu.compileGate.resolve({ messages: [] } as unknown as GPUCompilationInfo);
  await pending;
  assert.deepEqual(gpu.writes[0].data, [1, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepEqual(gpu.writes[1].data, [3, 0, 0, 0, 4, 0, 0, 0]);
  assert.equal(remove.mock.callCount(), 1);
  executor.dispose();
  assertClean(gpu, executor);
});

test("shader, pipeline, upload, map, and scope errors all clean ownership", async () => {
  for (const stage of [
    "shader",
    "pipeline",
    "upload",
    "map",
    "scope",
  ] as const) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    if (stage === "shader")
      gpu.compilationErrors = [
        {
          type: "error",
          message: "injected shader error",
        } as GPUCompilationMessage,
      ];
    if (stage === "pipeline") {
      gpu.pipelineGate = deferred<GPUComputePipeline>();
    }
    if (stage === "upload") gpu.failWrite = true;
    if (stage === "map") gpu.mapError = Error("injected map failure");
    if (stage === "scope")
      gpu.scopeError = { message: "injected validation failure" };
    const pending = executor.run(request("float", true));
    const rejected = assert.rejects(pending, /injected/);
    if (stage === "pipeline")
      gpu.pipelineGate!.reject(Error("injected pipeline failure"));
    await rejected;
    assertClean(gpu, executor);
  }
});
