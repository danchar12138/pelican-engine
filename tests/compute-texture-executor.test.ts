import test from "node:test";
import assert from "node:assert/strict";
import { createComputeExecutor } from "../packages/renderer/src/compute-executor.ts";
import type {
  ComputeExecutionInput,
  ComputeExecutionRequest,
} from "../packages/runtime/src/compute-contract.ts";
import type {
  ComputeTextureBinding,
  Graph,
  GraphType,
  GraphValue,
} from "../packages/sdk/src/index.ts";

// These mocks check GPU ownership, bindings and emitted WGSL, never numerical shader execution.
Object.assign(globalThis, {
  GPUBufferUsage: {
    MAP_READ: 1,
    COPY_SRC: 4,
    COPY_DST: 8,
    UNIFORM: 64,
    STORAGE: 128,
  },
  GPUTextureUsage: {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
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
class MockBuffer {
  destroyed = 0;
  readonly bytes: ArrayBuffer;
  constructor(
    readonly size: number,
    readonly usage: number,
    readonly map: () => Promise<void>,
  ) {
    this.bytes = new ArrayBuffer(size);
  }
  destroy() {
    this.destroyed++;
  }
  unmap() {}
  mapAsync() {
    return this.map();
  }
  getMappedRange() {
    assert.equal(this.destroyed, 0);
    return this.bytes;
  }
}
class MockTexture {
  destroyed = 0;
  readonly views: object[] = [];
  constructor(readonly descriptor: GPUTextureDescriptor) {}
  destroy() {
    this.destroyed++;
  }
  createView() {
    assert.equal(this.destroyed, 0);
    const view = { texture: this };
    this.views.push(view);
    return view;
  }
}
function fixture() {
  const loss = deferred<GPUDeviceLostInfo>();
  const state = {
    buffers: [] as MockBuffer[],
    textures: [] as MockTexture[],
    layouts: [] as GPUBindGroupLayoutDescriptor[],
    groups: [] as GPUBindGroupDescriptor[],
    sources: [] as string[],
    writes: [] as MockBuffer[],
    textureWrites: [] as {
      texture: MockTexture;
      data: number[];
      layout: GPUTexelCopyBufferLayout;
      size: GPUExtent3D;
    }[],
    output: [11, 12, 13, 14, 21, 22, 23, 24],
    fault: 0,
    maps: 0,
    scopes: 0,
    scopeCalls: 0,
    submissions: 0,
    mapGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    compileGate: undefined as
      | ReturnType<typeof deferred<GPUCompilationInfo>>
      | undefined,
    scopeGate: undefined as
      | ReturnType<typeof deferred<GPUError | null>>
      | undefined,
    scopeError: null as GPUError | null,
    failTexture: false,
    failTextureAt: -1,
    failUpload: false,
    failMap: false,
  };
  const binding = (index: number, group = state.groups.at(-1)!) =>
    Array.from(group.entries).find((e) => e.binding === index)!.resource;
  const buffer = (index: number) =>
    (binding(index) as unknown as { buffer: MockBuffer }).buffer;
  const pipeline = { getBindGroupLayout: () => ({}) };
  const raw = {
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
      maxTextureDimension2D: 8192,
      maxSampledTexturesPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 4,
    },
    lost: loss.promise,
    pushErrorScope() {
      state.scopes++;
    },
    popErrorScope() {
      state.scopes--;
      state.scopeCalls++;
      return state.scopeGate?.promise ?? Promise.resolve(state.scopeError);
    },
    createShaderModule({ code }: GPUShaderModuleDescriptor) {
      state.sources.push(code);
      return {
        getCompilationInfo: () =>
          state.compileGate?.promise ?? Promise.resolve({ messages: [] }),
      };
    },
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
      state.layouts.push(descriptor);
      return {};
    },
    createPipelineLayout() {
      return {};
    },
    createComputePipelineAsync() {
      return Promise.resolve(pipeline);
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      state.groups.push(descriptor);
      return {};
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const value = new MockBuffer(
        Number(descriptor.size),
        descriptor.usage,
        async () => {
          state.maps++;
          await state.mapGate?.promise;
          if (state.failMap) throw Error("injected map failure");
        },
      );
      state.buffers.push(value);
      return value;
    },
    createTexture(descriptor: GPUTextureDescriptor) {
      if (state.failTexture || state.textures.length === state.failTextureAt)
        throw Error("injected texture allocation failure");
      const value = new MockTexture(descriptor);
      state.textures.push(value);
      return value;
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
          src: MockBuffer,
          offset: number,
          dst: MockBuffer,
          target: number,
          size: number,
        ) {
          commands.push(() =>
            new Uint8Array(dst.bytes, target, size).set(
              new Uint8Array(src.bytes, offset, size),
            ),
          );
        },
        finish: () => commands,
      };
    },
    queue: {
      writeBuffer(
        value: MockBuffer,
        offset: number,
        data: Float32Array | Uint32Array,
      ) {
        assert.equal(value.destroyed, 0);
        new Uint8Array(value.bytes, offset, data.byteLength).set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
        state.writes.push(value);
      },
      writeTexture(
        destination: { texture: MockTexture },
        data: Float32Array,
        layout: GPUTexelCopyBufferLayout,
        size: GPUExtent3D,
      ) {
        if (state.failUpload) throw Error("injected texture upload failure");
        assert.equal(destination.texture.destroyed, 0);
        assert.ok(
          destination.texture.descriptor.usage & GPUTextureUsage.COPY_DST,
        );
        state.textureWrites.push({
          texture: destination.texture,
          data: Array.from(data),
          layout,
          size,
        });
      },
      submit(commands: (() => void)[][]) {
        state.submissions++;
        new Float32Array(buffer(0).bytes).set(state.output);
        new Uint32Array(buffer(2).bytes)[0] = state.fault;
        commands.flat().forEach((command) => command());
      },
    },
  };
  return Object.assign(state, {
    raw,
    device: raw as unknown as GPUDevice,
    loss,
    binding,
    buffer,
  });
}
const initial: GraphValue[] = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
];
function descriptor(
  revision = 0,
  values: readonly GraphValue[] = initial,
  key = "image",
): ComputeExecutionInput {
  return {
    key,
    type: "vec4",
    revision,
    values,
    texture: { width: 2, height: 1 },
  };
}
function request(
  options: {
    sample?: boolean;
    outputTexture?: boolean;
    retain?: boolean;
    binding?: Partial<ComputeTextureBinding>;
    graph?: Graph;
  } = {},
): ComputeExecutionRequest {
  const sample = options.sample ?? true;
  const graph =
    options.graph ??
    ((sample
      ? {
          nodes: [
            { id: "uv", op: "input", name: "uv" },
            { id: "v", op: "sampleTexture", texture: "source", inputs: ["uv"] },
          ],
          output: "v",
        }
      : {
          nodes: [{ id: "v", op: "vec4", value: [0, 0, 0, 1] }],
          output: "v",
        }) as Graph);
  const compiled = {
    ...graph,
    outputType: "vec4" as const,
    nodeTypes: Object.fromEntries(
      graph.nodes.map((node): [string, GraphType] => [
        node.id,
        node.op === "input" || node.op === "add" ? "vec2" : "vec4",
      ]),
    ),
  };
  return {
    kernel: {
      id: "texture",
      count: 2,
      workgroupSize: 8,
      outputType: "vec4",
      graph: compiled,
      buffers: [],
      textures: sample ? [{ name: "source", ...options.binding }] : [],
      source: { file: "texture.ts", line: 1, column: 1, length: 1 },
    },
    inputs: {},
    textures: sample ? { source: descriptor() } : {},
    output: {
      key: "image",
      type: "vec4",
      count: 2,
      retain: options.retain ?? true,
      ...((options.outputTexture ?? true)
        ? { texture: { width: 2, height: 1 } }
        : {}),
    },
    parameters: {},
    time: 0,
    signal: new AbortController().signal,
  };
}
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.ok(condition(), "Expected asynchronous boundary");
}
function clean(
  gpu: ReturnType<typeof fixture>,
  executor: ReturnType<typeof createComputeExecutor>,
) {
  assert.equal(executor.inspect().liveTextures, 0);
  assert.equal(executor.inspect().liveBuffers, 0);
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(gpu.scopes, 0);
  assert.ok(gpu.buffers.every((value) => value.destroyed === 1));
  assert.ok(gpu.textures.every((value) => value.destroyed === 1));
}
function captured(input: ComputeExecutionInput): ComputeExecutionInput {
  return Object.assign({}, input, { captured: true as const });
}

test("sampled/storage textures have explicit unfilterable layouts and shader writes both outputs", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const values = await executor.run(request());
  assert.deepEqual(values, [
    [11, 12, 13, 14],
    [21, 22, 23, 24],
  ]);
  const source = gpu.sources[0];
  assert.match(source, /var tc_texture_0: texture_2d<f32>/);
  assert.match(source, /textureLoad\(tc_texture_0, coord, 0\)/);
  assert.match(source, /texture_storage_2d<rgba32float, write>/);
  assert.match(source, /tc_output\[tc_id.x\] = tc_value/);
  assert.match(
    source,
    /textureStore\(tc_output_texture, vec2i\(tc_pixel\), tc_value\)/,
  );
  assert.match(source, /tc_id.x % 2u, tc_id.x \/ 2u/);
  assert.match(source, /vec2f\(tc_pixel\) \+ vec2f\(0.5\)/);
  assert.doesNotMatch(source, /textureSample|sampler/);
  assert.match(source, /clamp\(uv.x, 0.0, 1.0\)/);
  assert.match(source, /return mix\(top, bottom, weight.y\)/);
  const entries = Array.from(gpu.layouts[0].entries);
  assert.deepEqual(entries[3].texture, {
    sampleType: "unfilterable-float",
    viewDimension: "2d",
    multisampled: false,
  });
  assert.deepEqual(entries[4].storageTexture, {
    access: "write-only",
    format: "rgba32float",
    viewDimension: "2d",
  });
  assert.equal(
    (gpu.binding(3) as unknown as { texture: MockTexture }).texture,
    gpu.textures[0],
  );
  assert.equal(
    (gpu.binding(4) as unknown as { texture: MockTexture }).texture,
    gpu.textures[1],
  );
  assert.equal(gpu.textures[0].descriptor.format, "rgba32float");
  assert.equal(
    gpu.textures[1].descriptor.usage & GPUTextureUsage.STORAGE_BINDING,
    GPUTextureUsage.STORAGE_BINDING,
  );
  assert.equal(
    gpu.textureWrites.length,
    1,
    "Only the initial checkpoint is uploaded",
  );
  assert.deepEqual(gpu.textureWrites[0].layout, {
    bytesPerRow: 32,
    rowsPerImage: 1,
  });
  assert.equal(executor.inspect().storageTextureDispatches, 1);
  assert.equal(executor.inspect().allocations, 7);
  assert.equal(executor.inspect().pendingCandidates, 1);
  assert.equal(executor.inspect().committedVersions, 0);
  assert.deepEqual(Object.keys(executor.resident(descriptor())).sort(), [
    "buffer",
    "count",
    "revision",
    "type",
  ]);
  const old = executor.textureResident(descriptor());
  assert.equal(old.texture, gpu.textures[0]);
  const writes = gpu.writes.length;
  executor.commit("image", 1);
  assert.equal(executor.inspect().residentBytes, 64);
  assert.equal(executor.inspect().cachedBytes, 32);
  const current = descriptor(1, values);
  assert.equal(executor.textureResident(current).texture, gpu.textures[1]);
  assert.equal(executor.resident(current).buffer, gpu.buffer(0));
  assert.equal(gpu.writes.length, writes, "Commit performs no uploads");
  assert.equal(gpu.textureWrites.length, 1);
  assert.deepEqual(Object.keys(executor.textureResident(current)).sort(), [
    "height",
    "revision",
    "texture",
    "width",
  ]);
  executor.dispose();
  clean(gpu, executor);
});

for (const filter of ["nearest", "linear"] as const)
  for (const wrap of ["clamp", "repeat", "mirror"] as const)
    test(`manual ${filter}/${wrap} handles finite UVs before integer conversion`, async () => {
      const gpu = fixture(),
        executor = createComputeExecutor(gpu.device);
      await executor.run(
        request({ binding: { filter, wrapU: wrap, wrapV: wrap } }),
      );
      const source = gpu.sources[0];
      assert.match(source, /bitcast<vec2u>\(uv\)/);
      assert.match(source, /atomicOr\(&tc_fault, 4u\)/);
      assert.ok(
        source.indexOf("let addressed =") < source.indexOf("vec2i(floor("),
      );
      assert.ok(
        source.indexOf("atomicOr(&tc_fault, 4u)") <
          source.indexOf("let addressed ="),
      );
      if (wrap === "clamp") assert.match(source, /clamp\(uv.x, 0.0, 1.0\)/);
      if (wrap === "repeat") {
        assert.match(source, /uv.x - floor\(uv.x\)/);
        assert.match(source, /% size.x/);
      }
      if (wrap === "mirror") {
        assert.match(source, /uv.x \* 0.5/);
        assert.match(source, /2 \* size.x - 1/);
      }
      if (filter === "linear") {
        assert.match(source, /- vec2f\(0.5\)/);
        assert.match(source, /return mix\(top, bottom, weight.y\)/);
      } else {
        assert.match(source, /floor\(addressed \* vec2f\(size\)\)/);
        assert.doesNotMatch(source, /let weight/);
      }
      executor.dispose();
      clean(gpu, executor);
    });

test("default linear/clamp and actual rectangular output inputs, including buffer count by one", async () => {
  const graph: Graph = {
    nodes: [
      { id: "p", op: "input", name: "pixelCoord" },
      { id: "size", op: "input", name: "outputSize" },
      { id: "uv", op: "input", name: "uv" },
      { id: "a", op: "add", inputs: ["p", "size"] },
      { id: "b", op: "add", inputs: ["a", "uv"] },
      { id: "v", op: "swizzle", inputs: ["b"], components: "xyxy" },
    ],
    output: "v",
  };
  for (const outputTexture of [true, false]) {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    const req = request({ sample: false, outputTexture, graph });
    if (outputTexture) req.output.texture = { width: 1, height: 2 };
    await executor.run(req);
    assert.match(
      gpu.sources[0],
      outputTexture
        ? /tc_id.x % 1u, tc_id.x \/ 1u/
        : /tc_id.x % 2u, tc_id.x \/ 2u/,
    );
    assert.match(
      gpu.sources[0],
      outputTexture ? /vec2f\(1.0, 2.0\)/ : /vec2f\(2.0, 1.0\)/,
    );
    assert.equal(
      gpu.textureWrites.length,
      0,
      "Storage output is never uploaded",
    );
    executor.dispose();
    clean(gpu, executor);
  }
});

test("exact committed feedback and older task results reuse both GPU representations without uploads", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const first = await executor.run(request());
  executor.commit("image", 1);
  const firstTexture = executor.textureResident(descriptor(1, first)).texture;
  const firstBuffer = executor.resident(descriptor(1, first)).buffer;
  gpu.output = [31, 32, 33, 34, 41, 42, 43, 44];
  const feedback = request();
  feedback.textures = { source: descriptor(1, first) };
  const second = await executor.run(feedback);
  executor.commit("image", 2);
  assert.equal(
    (gpu.binding(3) as unknown as { texture: GPUTexture }).texture,
    firstTexture,
  );
  const history = request({ outputTexture: false });
  history.output.key = "buffer";
  history.textures = { source: descriptor(1, first) };
  await executor.run(history);
  executor.commit("buffer", 1);
  assert.equal(
    (gpu.binding(3) as unknown as { texture: GPUTexture }).texture,
    firstTexture,
  );
  assert.equal(executor.resident(descriptor(1, first)).buffer, firstBuffer);
  assert.equal(executor.inspect().uploads, 1);
  assert.equal(executor.inspect().textureUploads, 1);
  assert.equal(executor.inspect().storageTextureDispatches, 2);
  assert.ok(executor.inspect().textureResidentHits >= 3);
  const secondView = executor.textureResident(descriptor(2, second));
  executor.collect([
    { key: "image", revision: 2 },
    { key: "buffer", revision: 1 },
  ]);
  assert.equal((firstTexture as unknown as MockTexture).destroyed, 1);
  assert.equal((firstBuffer as unknown as MockBuffer).destroyed, 1);
  assert.equal(
    executor.textureResident(descriptor(2, second)).texture,
    secondView.texture,
  );
  executor.dispose();
  clean(gpu, executor);
});

test("paired checkpoints replace atomically and failed texture uploads preserve the previous version", () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const first = executor.textureResident(descriptor());
  const mirror = executor.resident(descriptor());
  assert.equal(executor.inspect().checkpointUploads, 1);
  assert.equal(executor.inspect().textureUploads, 1);
  gpu.failUpload = true;
  assert.throws(
    () =>
      executor.textureResident(
        descriptor(1, [
          [9, 8, 7, 6],
          [5, 4, 3, 2],
        ]),
      ),
    /TC_COMPUTE_GPU/,
  );
  gpu.failUpload = false;
  assert.equal(executor.textureResident(descriptor()).texture, first.texture);
  assert.equal(executor.resident(descriptor()).buffer, mirror.buffer);
  assert.equal(gpu.textures.at(-1)!.destroyed, 1);
  const next = executor.textureResident(descriptor(1));
  assert.notEqual(next.texture, first.texture);
  assert.equal((first.texture as unknown as MockTexture).destroyed, 1);
  assert.equal((mirror.buffer as unknown as MockBuffer).destroyed, 1);
  executor.dispose();
  clean(gpu, executor);
});

test("aliases share an initial texture upload and views while descriptor conflicts preflight", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const req = request();
  req.kernel.textures!.push({ name: "alias", filter: "nearest" });
  req.textures = { ...req.textures, alias: descriptor() };
  await executor.run(req);
  assert.equal(gpu.textureWrites.length, 1);
  assert.equal(
    (gpu.binding(3) as unknown as { texture: MockTexture }).texture,
    (gpu.binding(4) as unknown as { texture: MockTexture }).texture,
  );
  assert.equal(executor.inspect().textureResidentHits, 1);
  executor.dispose();
  clean(gpu, executor);
});

for (const [fault, code] of [
  [4, "TEXTURE_COORD"],
  [5, "BOUNDS"],
  [6, "NONFINITE"],
  [7, "BOUNDS"],
  [8, "GPU"],
] as const)
  test(`texture fault ${fault} has stable ${code} priority and publishes neither output`, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    gpu.fault = fault;
    await assert.rejects(
      executor.run(request()),
      new RegExp("TC_COMPUTE_" + code),
    );
    assert.equal(executor.inspect().committedVersions, 0);
    clean(gpu, executor);
    executor.dispose();
  });

const invalid: [
  string,
  (req: ComputeExecutionRequest, gpu: ReturnType<typeof fixture>) => void,
][] = [
  [
    "zero width",
    (req) => {
      req.output.texture = { width: 0, height: 2 };
    },
  ],
  [
    "fractional dimension",
    (req) => {
      req.output.texture = { width: 0.5, height: 4 };
    },
  ],
  [
    "output texel count",
    (req) => {
      req.output.texture = { width: 2, height: 2 };
    },
  ],
  [
    "input texel count",
    (req) => {
      req.textures!.source.texture = { width: 2, height: 2 };
    },
  ],
  [
    "device dimension",
    (_, gpu) => {
      gpu.raw.limits.maxTextureDimension2D = 1;
    },
  ],
  [
    "sampled limit",
    (_, gpu) => {
      gpu.raw.limits.maxSampledTexturesPerShaderStage = 0;
    },
  ],
  [
    "storage limit",
    (_, gpu) => {
      gpu.raw.limits.maxStorageTexturesPerShaderStage = 0;
    },
  ],
  [
    "combined binding limit",
    (_, gpu) => {
      gpu.raw.limits.maxBindingsPerBindGroup = 4;
    },
  ],
  [
    "texture type",
    (req) => {
      req.textures!.source.type = "float";
    },
  ],
  [
    "missing shape",
    (req) => {
      delete req.textures!.source.texture;
    },
  ],
  [
    "unknown slot",
    (req) => {
      req.textures = { unexpected: descriptor() };
    },
  ],
  [
    "unknown filter",
    (req) => {
      Object.assign(req.kernel.textures![0], { filter: "cubic" });
    },
  ],
  [
    "unknown addressing",
    (req) => {
      Object.assign(req.kernel.textures![0], { wrapU: "border" });
    },
  ],
  [
    "duplicate declaration",
    (req) => {
      req.kernel.textures!.push({ name: "source" });
    },
  ],
  [
    "aliased content collision",
    (req) => {
      req.kernel.textures!.push({ name: "other" });
      req.textures = {
        ...req.textures,
        other: descriptor(0, [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ]),
      };
    },
  ],
  [
    "feedback shape",
    (req) => {
      req.output.texture = { width: 1, height: 2 };
    },
  ],
  [
    "texture in buffer slot",
    (req) => {
      req.kernel.buffers = [{ name: "buffer", type: "vec4" }];
      req.inputs = { buffer: descriptor() };
    },
  ],
];
test("texture dimensions, type, shape, declarations, aliasing and actual binding limits preflight before GPU work", async (t) => {
  for (const [name, mutate] of invalid)
    await t.test(name, async () => {
      const gpu = fixture(),
        executor = createComputeExecutor(gpu.device),
        req = request();
      mutate(req, gpu);
      await assert.rejects(executor.run(req), /TC_COMPUTE_/);
      assert.equal(gpu.sources.length, 0);
      assert.equal(gpu.buffers.length, 0);
      assert.equal(gpu.textures.length, 0);
      executor.dispose();
    });
});

for (const action of [
  "abort",
  "discard",
  "release",
  "dispose",
  "loss",
] as const)
  test(`${action} during texture readback destroys both pending halves and blocks late publication`, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device),
      req = request();
    const controller = new AbortController();
    req.signal = controller.signal;
    gpu.mapGate = deferred<void>();
    const run = executor.run(req);
    const rejected = assert.rejects(run, /TC_COMPUTE_(CANCELLED|DEVICE_LOST)/);
    await waitFor(() => gpu.maps === 1);
    if (action === "abort") controller.abort();
    else if (action === "loss") gpu.loss.resolve({} as GPUDeviceLostInfo);
    else if (action === "discard") executor.discard("image");
    else if (action === "release") executor.release("image");
    else executor.dispose();
    await rejected;
    gpu.mapGate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executor.inspect().committedVersions, 0);
    clean(gpu, executor);
    executor.dispose();
  });

test("post-validation abort destroys the candidate pair while preserving the committed history", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const values = await executor.run(request({ sample: false }));
  executor.commit("image", 1);
  const committed = executor.textureResident(descriptor(1, values));
  const req = request({ sample: false });
  const controller = new AbortController();
  req.signal = controller.signal;
  await executor.run(req);
  const candidate = gpu.textures.at(-1)!;
  controller.abort();
  assert.equal(candidate.destroyed, 1);
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(
    executor.textureResident(descriptor(1, values)).texture,
    committed.texture,
  );
  assert.throws(() => executor.commit("image", 2), /TC_COMPUTE_CANDIDATE/);
  executor.dispose();
  clean(gpu, executor);
});

test("texture allocation, map and final validation failures never leak either representation", async (t) => {
  for (const failure of [
    "allocation",
    "output allocation",
    "upload",
    "map",
    "scope",
  ])
    await t.test(failure, async () => {
      const gpu = fixture(),
        executor = createComputeExecutor(gpu.device);
      if (failure === "allocation") gpu.failTexture = true;
      if (failure === "output allocation") gpu.failTextureAt = 1;
      if (failure === "upload") gpu.failUpload = true;
      if (failure === "map") gpu.failMap = true;
      if (failure === "scope")
        gpu.scopeError = { message: "injected scope failure" } as GPUError;
      await assert.rejects(executor.run(request()), /TC_COMPUTE_GPU/);
      clean(gpu, executor);
      executor.dispose();
    });
});

for (const texture of [false, true])
  test(`captured older ${texture ? "texture" : "buffer"} init uploads after pure producer commits; unmarked stale data stays rejected`, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    const producer = request({ sample: false, outputTexture: texture });
    const first = await executor.run(producer);
    executor.commit("image", 1);
    const second = await executor.run(producer);
    executor.commit("image", 2);
    const old = descriptor();
    if (!texture) delete old.texture;
    const consume = request({ sample: texture, outputTexture: false });
    consume.output.key = "consumer";
    if (texture) consume.textures = { source: old };
    else {
      consume.kernel.buffers = [{ name: "initial", type: "vec4" }];
      consume.inputs = { initial: old };
    }
    await assert.rejects(executor.run(consume), /TC_COMPUTE_REVISION/);
    assert.equal(executor.inspect().uploads, 0);
    if (texture) consume.textures = { source: captured(old) };
    else consume.inputs = { initial: captured(old) };
    await executor.run(consume);
    assert.equal(executor.inspect().uploads, 1);
    assert.equal(executor.inspect().textureUploads, texture ? 1 : 0);
    const exact = descriptor(1, first);
    if (!texture) delete exact.texture;
    if (texture) consume.textures = { source: captured(exact) };
    else consume.inputs = { initial: captured(exact) };
    await executor.run(consume);
    assert.equal(
      executor.inspect().uploads,
      1,
      "Even captured descriptors prefer retained exact GPU history",
    );
    const newest = descriptor(2, second);
    if (!texture) delete newest.texture;
    const changed = descriptor(2, [
      [-0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    if (!texture) delete changed.texture;
    assert.throws(
      () => executor.resident(captured(changed)),
      /TC_COMPUTE_REVISION/,
    );
    assert.equal(executor.resident(newest).revision, 2);
    executor.collect([{ key: "image", revision: 2 }]);
    if (texture) consume.textures = { source: exact };
    else consume.inputs = { initial: exact };
    const allocations = gpu.buffers.length;
    await assert.rejects(executor.run(consume), /TC_COMPUTE_REVISION/);
    assert.equal(
      gpu.buffers.length,
      allocations,
      "No CPU fallback for collected unmarked task results",
    );
    executor.dispose();
    clean(gpu, executor);
  });

test("captured older checkpoint cannot erase the newer CPU revision watermark or its packed bits", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  executor.textureResident(descriptor(5));
  const consume = request({ outputTexture: false });
  consume.output.key = "consumer";
  consume.textures = { source: captured(descriptor()) };
  await executor.run(consume);
  const allocations = gpu.buffers.length;
  assert.throws(
    () => executor.textureResident(descriptor(4)),
    /TC_COMPUTE_REVISION/,
  );
  assert.throws(
    () =>
      executor.textureResident(
        captured(
          descriptor(5, [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ]),
        ),
      ),
    /TC_COMPUTE_REVISION/,
  );
  assert.throws(
    () =>
      executor.textureResident({
        ...captured(descriptor()),
        texture: { width: 1, height: 2 },
      }),
    /TC_COMPUTE_BINDING/,
  );
  assert.equal(gpu.buffers.length, allocations);
  executor.textureResident(descriptor(5));
  executor.release("image");
  executor.discard("consumer");
  clean(gpu, executor);
  executor.dispose();
});

test("nonretained storage textures are ephemeral and checkpoint allocation failures preserve prior pairs", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  await executor.run(request({ sample: false, retain: false }));
  assert.equal(executor.inspect().storageTextureDispatches, 1);
  assert.equal(gpu.textureWrites.length, 0);
  clean(gpu, executor);
  const first = executor.textureResident(descriptor());
  const mirror = executor.resident(descriptor());
  gpu.failTexture = true;
  assert.throws(
    () => executor.textureResident(descriptor(1)),
    /TC_COMPUTE_GPU/,
  );
  gpu.failTexture = false;
  assert.equal(executor.textureResident(descriptor()).texture, first.texture);
  assert.equal(executor.resident(descriptor()).buffer, mirror.buffer);
  executor.dispose();
  clean(gpu, executor);
});

test("a texture pair stays unpublished until final validation; cancellation blocks late publication", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const first = await executor.run(request({ sample: false }));
  executor.commit("image", 1);
  const previous = executor.textureResident(descriptor(1, first));
  const req = request({ sample: false }),
    controller = new AbortController();
  req.signal = controller.signal;
  gpu.scopeGate = deferred<GPUError | null>();
  const run = executor.run(req);
  const rejected = assert.rejects(run, /TC_COMPUTE_CANCELLED/);
  await waitFor(() => gpu.maps === 2);
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(executor.inspect().committedVersions, 1);
  assert.equal(executor.inspect().liveTextures, 2);
  controller.abort();
  await rejected;
  gpu.scopeGate.resolve(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executor.inspect().pendingCandidates, 0);
  assert.equal(
    executor.textureResident(descriptor(1, first)).texture,
    previous.texture,
  );
  assert.equal(executor.inspect().liveTextures, 1);
  executor.dispose();
  clean(gpu, executor);
});

test("abort during compilation blocks late texture allocations and snapshots are copied before async work", async () => {
  const gpu = fixture(),
    executor = createComputeExecutor(gpu.device);
  const req = request(),
    controller = new AbortController();
  req.signal = controller.signal;
  gpu.compileGate = deferred<GPUCompilationInfo>();
  const run = executor.run(req);
  const rejected = assert.rejects(run, /TC_COMPUTE_CANCELLED/);
  controller.abort();
  await rejected;
  gpu.compileGate.resolve({ messages: [] } as unknown as GPUCompilationInfo);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gpu.buffers.length, 0);
  assert.equal(gpu.textures.length, 0);
  clean(gpu, executor);
  gpu.compileGate = deferred<GPUCompilationInfo>();
  const active = request();
  const original = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ] as GraphValue[];
  active.textures = { source: descriptor(0, original) };
  const result = executor.run(active);
  active.output.texture = { width: 1, height: 2 };
  active.textures.source.texture = { width: 1, height: 2 };
  original[0] = [9, 9, 9, 9];
  active.kernel.textures![0].filter = "nearest";
  gpu.compileGate.resolve({ messages: [] } as unknown as GPUCompilationInfo);
  await result;
  assert.deepEqual(gpu.textureWrites[0].data, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(gpu.textures.at(-1)!.descriptor.size, {
    width: 2,
    height: 1,
    depthOrArrayLayers: 1,
  });
  assert.match(gpu.sources.at(-1)!, /let weight = fract/);
  executor.dispose();
  clean(gpu, executor);
});

for (const action of ["release", "dispose", "loss"] as const)
  test(`${action} destroys a texture checkpoint, committed history and pending pair exactly once`, async () => {
    const gpu = fixture(),
      executor = createComputeExecutor(gpu.device);
    const first = await executor.run(request());
    executor.commit("image", 1);
    const req = request();
    req.textures = { source: descriptor(1, first) };
    const second = await executor.run(req);
    executor.commit("image", 2);
    req.textures = { source: descriptor(2, second) };
    await executor.run(req);
    assert.equal(executor.inspect().liveTextures, 4);
    assert.equal(executor.inspect().liveBuffers, 4);
    if (action === "release") executor.release("image");
    else if (action === "dispose") executor.dispose();
    else {
      gpu.loss.resolve({} as GPUDeviceLostInfo);
      await Promise.resolve();
    }
    clean(gpu, executor);
    executor.dispose();
    clean(gpu, executor);
  });
