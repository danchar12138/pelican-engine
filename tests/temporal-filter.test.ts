import test from "node:test";
import assert from "node:assert/strict";
import {
  createTemporalFilter,
  temporalFilterReference,
  type TemporalFilterOptions,
  type TemporalReferenceInput,
} from "../packages/renderer/src/temporal-filter.ts";

function fixture(width = 3, height = 3): TemporalReferenceInput {
  const count = width * height;
  const fill = (p: number[]) =>
    new Float32Array(Array.from({ length: count }, () => p).flat());
  const input: TemporalReferenceInput = {
    width,
    height,
    inputRadiance: fill([1, 1, 1, 2]),
    normalDepth: fill([0, 0, 1, 2]),
    albedoRoughness: fill([0.5, 0.5, 0.5, 0.5]),
    reprojection: new Float32Array(count * 4),
    previousRadiance: fill([0.5, 0.5, 0.5, 8]),
    previousNormalDepth: fill([0, 0, 1, 2]),
    previousAlbedoRoughness: fill([0.5, 0.5, 0.5, 0.5]),
  };
  for (let i = 0; i < count; i++) {
    (input.reprojection as Float32Array).set(
      [
        ((i % width) + 0.5) / width,
        (Math.floor(i / width) + 0.5) / height,
        2,
        1,
      ],
      i * 4,
    );
  }
  (input.inputRadiance as Float32Array).set([0, 0, 0, 2], 0);
  if (count > 1) (input.inputRadiance as Float32Array).set([2, 2, 2, 2], 4);
  return input;
}

function near(actual: number, expected: number, epsilon = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test("CPU missing/reset/disabled/progressive history copies exact current including invalid values", () => {
  const f = fixture();
  (f.inputRadiance as Float32Array).set([NaN, Infinity, -Infinity, 0], 0);
  for (const patch of [
    { previousRadiance: undefined },
    { previousNormalDepth: undefined },
    { previousAlbedoRoughness: undefined },
    { reset: true },
    { enabled: false },
    { progressive: true },
  ]) {
    const before = new Float32Array(f.inputRadiance);
    const output = temporalFilterReference({ ...f, ...patch });
    assert.deepEqual(output, before);
    assert.notEqual(output, f.inputRadiance);
    assert.deepEqual(f.inputRadiance, before, "reference never mutates inputs");
  }
});

test("CPU combines independent 2-spp frames, caps prior count at 32, never infers progressive", () => {
  const f = fixture();
  const output = temporalFilterReference(f);
  near(output[4 * 4], 0.6);
  near(output[4 * 4 + 3], 10);
  (f.previousRadiance as Float32Array).set([0.5, 0.5, 0.5, 1000], 4 * 4);
  const capped = temporalFilterReference(f);
  near(capped[4 * 4], 18 / 34);
  near(capped[4 * 4 + 3], 34);
  assert.deepEqual(
    temporalFilterReference({ ...f, progressive: true }),
    f.inputRadiance,
  );
});

test("CPU stable reprojection reduces deterministic independent noise without changing constant color", () => {
  const f = fixture(16, 16);
  for (let i = 0; i < 256; i++) {
    const value = (i + Math.floor(i / 16)) % 2 ? 1.4 : 0.6;
    (f.inputRadiance as Float32Array).set([value, value, value, 2], i * 4);
    (f.previousRadiance as Float32Array).set([1, 1, 1, 8], i * 4);
  }
  const output = temporalFilterReference(f);
  let before = 0,
    after = 0;
  for (let i = 0; i < 256; i++) {
    before += (f.inputRadiance[i * 4] - 1) ** 2;
    after += (output[i * 4] - 1) ** 2;
    near(output[i * 4 + 3], 10);
  }
  assert.ok(after < before * 0.05);
  for (let i = 0; i < 256; i++)
    (f.inputRadiance as Float32Array).set([0.2, 0.4, 0.6, 2], i * 4);
  const constant = temporalFilterReference(f);
  near(constant[0], 0.2);
  near(constant[1], 0.4);
  near(constant[2], 0.6);
});

test("CPU YCoCg clamp bounds stale lighting and guided neighborhood excludes material edges", () => {
  const f = fixture();
  (f.previousRadiance as Float32Array).fill(100);
  const clipped = temporalFilterReference(f);
  near(clipped[16], (2 + 2 * 32) / 34);
  // A black center cannot use a white neighbor with another material to widen its clamp.
  const one = fixture(2, 1);
  (one.albedoRoughness as Float32Array).set([0.9, 0.9, 0.9, 0.5], 4);
  const edge = temporalFilterReference(one);
  near(edge[0], 0);
  near(edge[3], 10);
});

test("CPU validates every bilinear tap and renormalizes surviving support", () => {
  const f = fixture(2, 2);
  (f.reprojection as Float32Array).set([0.5, 0.5, 2, 1], 0);
  (f.previousRadiance as Float32Array).set([NaN, 1, 1, 8], 4);
  (f.previousNormalDepth as Float32Array)[11] = 4;
  (f.previousAlbedoRoughness as Float32Array)[12] = 0.9;
  const output = temporalFilterReference(f);
  near(output[0], 0.4);
  near(output[3], 10);
  // Only the top-left tap remains valid, but now contributes almost zero support.
  (f.reprojection as Float32Array).set([0.74975, 0.74975, 2, 1], 0);
  assert.deepEqual(
    temporalFilterReference(f).slice(0, 4),
    new Float32Array(f.inputRadiance).slice(0, 4),
  );
  // UV at the image boundary retains valid in-bounds support, not clamped duplicate taps.
  (f.reprojection as Float32Array).set([0, 0, 2, 1], 0);
  const boundary = temporalFilterReference(f);
  near(boundary[0], 0.4);
  near(boundary[3], 10);
});

test("CPU compares previous depth with motion expected depth, not current camera distance", () => {
  const f = fixture();
  for (let i = 0; i < 9; i++) (f.normalDepth as Float32Array)[i * 4 + 3] = 10;
  near(temporalFilterReference(f)[19], 10);
  (f.reprojection as Float32Array)[18] = 10;
  near(temporalFilterReference(f)[19], 2);
  for (const [depth, accepted] of [
    [2.041, true],
    [2.043, false],
  ] as const) {
    const g = fixture();
    (g.previousNormalDepth as Float32Array)[19] = depth;
    near(temporalFilterReference(g)[19], accepted ? 10 : 2);
  }
  for (const [depth, accepted] of [
    [0.0019, true],
    [0.0021, false],
  ] as const) {
    const g = fixture();
    (g.reprojection as Float32Array)[18] = 0;
    (g.previousNormalDepth as Float32Array)[19] = depth;
    near(temporalFilterReference(g)[19], accepted ? 10 : 2);
  }
});

test("CPU disocclusion, misses, invalid motion/history/current, normal and material rejection", () => {
  for (const mutate of [
    (f: TemporalReferenceInput) => {
      (f.reprojection as Float32Array)[19] = 0;
    },
    (f: TemporalReferenceInput) => {
      (f.reprojection as Float32Array)[16] = -0.001;
    },
    (f: TemporalReferenceInput) => {
      (f.reprojection as Float32Array)[17] = 1;
    },
    (f: TemporalReferenceInput) => {
      (f.reprojection as Float32Array)[18] = NaN;
    },
    (f: TemporalReferenceInput) => {
      (f.reprojection as Float32Array)[18] = -1;
    },
    (f: TemporalReferenceInput) => {
      (f.normalDepth as Float32Array)[19] = -1;
    },
    (f: TemporalReferenceInput) => {
      (f.previousNormalDepth as Float32Array)[19] = -1;
    },
    (f: TemporalReferenceInput) => {
      (f.previousRadiance as Float32Array)[16] = Infinity;
    },
    (f: TemporalReferenceInput) => {
      (f.previousRadiance as Float32Array)[19] = 0;
    },
    (f: TemporalReferenceInput) => {
      (f.previousNormalDepth as Float32Array).set([1, 0, 0, 2], 16);
    },
    (f: TemporalReferenceInput) => {
      (f.previousNormalDepth as Float32Array).set([0, 0, 0, 2], 16);
    },
    (f: TemporalReferenceInput) => {
      (f.previousAlbedoRoughness as Float32Array)[16] = 0.61;
    },
    (f: TemporalReferenceInput) => {
      (f.previousAlbedoRoughness as Float32Array)[19] = 0.61;
    },
    (f: TemporalReferenceInput) => {
      (f.inputRadiance as Float32Array)[17] = NaN;
    },
    (f: TemporalReferenceInput) => {
      (f.inputRadiance as Float32Array)[19] = -1;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.deepEqual(
      temporalFilterReference(f).slice(16, 20),
      new Float32Array(f.inputRadiance).slice(16, 20),
    );
  }
  for (const [cosine, accepted] of [
    [0.91, true],
    [0.89, false],
  ] as const) {
    const f = fixture();
    (f.previousNormalDepth as Float32Array).set(
      [Math.sqrt(1 - cosine ** 2), 0, cosine, 2],
      16,
    );
    near(temporalFilterReference(f)[19], accepted ? 10 : 2);
  }
  const f = fixture();
  (f.previousAlbedoRoughness as Float32Array).set([0.59, 0.41, 0.5, 0.59], 16);
  near(temporalFilterReference(f)[19], 10);
});

test("CPU interpolates all four history taps and their capped counts before current combination", () => {
  const f = fixture(2, 2);
  (f.reprojection as Float32Array).set([0.5, 0.5, 2, 1], 0);
  (f.previousRadiance as Float32Array).set([
    0, 0, 0, 4, 0.5, 0.5, 0.5, 8, 1, 1, 1, 12, 1.5, 1.5, 1.5, 100,
  ]);
  const output = temporalFilterReference(f);
  // Bilinear RGB is 0.75; effective count is (4 + 8 + 12 + 32) / 4 = 14.
  near(output[0], (0 * 2 + 0.75 * 14) / 16);
  near(output[3], 16);
  // Motion selecting the bottom-right previous center uses that tap, not current XY.
  (f.reprojection as Float32Array).set([0.75, 0.75, 2, 1], 0);
  const moved = temporalFilterReference(f);
  near(moved[0], (1.5 * 32) / 34);
  near(moved[3], 34);
});

test("CPU progressive counts across frames are retained exactly without repeated history", () => {
  const f = fixture();
  f.progressive = true;
  for (const samples of [2, 4, 8, 64]) {
    for (let i = 0; i < 9; i++)
      (f.inputRadiance as Float32Array)[i * 4 + 3] = samples;
    const output = temporalFilterReference(f);
    assert.deepEqual(output, f.inputRadiance);
    f.previousRadiance = output;
  }
});

test("CPU rejects malformed dimensions and array capacity", () => {
  assert.throws(
    () => temporalFilterReference({ ...fixture(), width: 0 }),
    /TC_TEMPORAL_DIMENSION/,
  );
  assert.throws(
    () => temporalFilterReference({ ...fixture(), reprojection: [] }),
    /TC_TEMPORAL_BUFFER/,
  );
  assert.throws(
    () => temporalFilterReference({ ...fixture(), previousRadiance: [] }),
    /TC_TEMPORAL_BUFFER/,
  );
});

// These recording fakes validate host contracts only; they do not execute WGSL.
Object.assign(globalThis, {
  GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
  GPUShaderStage: { COMPUTE: 4 },
});

class RecordingBuffer {
  readonly size: number;
  readonly usage: number;
  readonly data: ArrayBuffer;
  mapState: GPUBufferMapState;
  destroys = 0;
  failMap = false;
  constructor(descriptor: GPUBufferDescriptor) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.data = new ArrayBuffer(this.size);
    this.mapState = descriptor.mappedAtCreation ? "mapped" : "unmapped";
  }
  getMappedRange() {
    if (this.failMap) throw new Error("fake mapping failure");
    return this.data;
  }
  unmap() {
    this.mapState = "unmapped";
  }
  destroy() {
    this.destroys++;
  }
  gpu() {
    return this as unknown as GPUBuffer;
  }
}

function recordingDevice() {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    lose = resolve;
  });
  const state = {
    buffers: [] as RecordingBuffer[],
    layouts: [] as GPUBindGroupLayoutDescriptor[],
    groups: [] as GPUBindGroupDescriptor[],
    pipelines: [] as GPUComputePipelineDescriptor[],
    shader: "",
    pushes: [] as GPUErrorFilter[],
    pops: 0,
    failAllocation: -1,
    failMapping: -1,
    failGroup: -1,
    pipelineError: false,
    pipelineThrow: false,
    pipelineHang: false,
    scopeError: null as GPUError | null,
    scopeHang: false,
  };
  const device = {
    lost,
    limits: {
      minUniformBufferOffsetAlignment: 256,
      maxBufferSize: 256 * 1024 * 1024,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    pushErrorScope(filter: GPUErrorFilter) {
      state.pushes.push(filter);
    },
    popErrorScope() {
      state.pops++;
      return state.scopeHang
        ? new Promise<GPUError | null>(() => {})
        : Promise.resolve(state.scopeError);
    },
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
      state.layouts.push(descriptor);
      return {};
    },
    createPipelineLayout() {
      return {};
    },
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      state.shader = descriptor.code;
      return {};
    },
    createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) {
      state.pipelines.push(descriptor);
      if (state.pipelineThrow) throw new Error("fake pipeline setup failure");
      if (state.pipelineError)
        return Promise.reject(new Error("fake pipeline rejection"));
      if (state.pipelineHang) return new Promise<GPUComputePipeline>(() => {});
      return Promise.resolve({});
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      if (state.buffers.length === state.failAllocation)
        throw new Error("fake allocation failure");
      const buffer = new RecordingBuffer(descriptor);
      buffer.failMap = state.buffers.length === state.failMapping;
      state.buffers.push(buffer);
      return buffer.gpu();
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      if (state.groups.length === state.failGroup)
        throw new Error("fake bind group failure");
      state.groups.push(descriptor);
      return {};
    },
  };
  return {
    device: device as unknown as GPUDevice,
    state,
    limits: device.limits,
    lose: () =>
      lose({
        reason: "destroyed",
        message: "fake device lost",
      } as GPUDeviceLostInfo),
  };
}

function recordingEncoder(failure?: "begin" | "dispatch" | "copy") {
  const events: string[] = [];
  const dispatches: number[][] = [];
  const copies: [GPUBuffer, number, GPUBuffer, number, number][] = [];
  const encoder = {
    beginComputePass() {
      if (failure === "begin") throw new Error("fake encoder failure");
      events.push("begin");
      return {
        setPipeline() {
          events.push("pipeline");
        },
        setBindGroup() {
          events.push("group");
        },
        dispatchWorkgroups(...values: number[]) {
          if (failure === "dispatch") throw new Error("fake dispatch failure");
          dispatches.push(values);
          events.push("dispatch");
        },
        end() {
          events.push("end");
        },
      };
    },
    copyBufferToBuffer(
      ...copy: [GPUBuffer, number, GPUBuffer, number, number]
    ) {
      if (failure === "copy") throw new Error("fake copy failure");
      copies.push(copy);
      events.push("copy");
    },
  };
  return {
    encoder: encoder as unknown as GPUCommandEncoder,
    events,
    dispatches,
    copies,
  };
}

function buffers(width = 17, height = 9) {
  return Array.from(
    { length: 4 },
    () =>
      new RecordingBuffer({
        size: width * height * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
  );
}
function resource(group: GPUBindGroupDescriptor, binding: number) {
  return Array.from(group.entries).find((entry) => entry.binding === binding)!
    .resource as GPUBufferBinding;
}

test("host awaits pipeline validation and declares exactly eight storage bindings plus uniform", async () => {
  const { device, state } = recordingDevice();
  const filter = await createTemporalFilter(device);
  assert.deepEqual(state.pushes, ["validation"]);
  assert.equal(state.pops, 1);
  assert.equal(state.pipelines.length, 1);
  assert.deepEqual(
    Array.from(state.layouts[0].entries).map((e) => e.buffer?.type),
    [...Array(7).fill("read-only-storage"), "storage", "uniform"],
  );
  assert.equal((state.shader.match(/var<storage,/g) ?? []).length, 8);
  assert.match(state.shader, /@workgroup_size\(8,8\)/);
  assert.deepEqual(filter.inspect(), {
    entries: 0,
    bytes: 0,
    passes: 0,
    lastPasses: 0,
    dimension: { width: 0, height: 0 },
    historyValid: false,
    disposed: false,
    lost: false,
  });
  filter.dispose();
});

test("host binds exact ranges, pingpongs history, copies guides after dispatch, and uses immutable flags", async () => {
  const { device, state } = recordingDevice();
  const filter = await createTemporalFilter(device);
  const input = buffers();
  const recording = recordingEncoder();
  const encode = (options?: TemporalFilterOptions) =>
    filter.encode(
      recording.encoder,
      input[0].gpu(),
      input[1].gpu(),
      input[2].gpu(),
      input[3].gpu(),
      17,
      9,
      options,
    );
  assert.equal(encode(), state.buffers[0].gpu());
  assert.equal(state.buffers.length, 5);
  assert.deepEqual(recording.events, [
    "begin",
    "pipeline",
    "group",
    "dispatch",
    "end",
    "copy",
    "copy",
  ]);
  assert.deepEqual(recording.dispatches, [[3, 2]]);
  for (let binding = 0; binding < 8; binding++)
    assert.equal(resource(state.groups[0], binding).size, 17 * 9 * 16);
  for (let binding = 0; binding < 4; binding++)
    assert.equal(
      resource(state.groups[0], binding).buffer,
      input[binding].gpu(),
    );
  assert.equal(resource(state.groups[0], 4).buffer, state.buffers[1].gpu());
  assert.equal(resource(state.groups[0], 5).buffer, state.buffers[2].gpu());
  assert.equal(resource(state.groups[0], 6).buffer, state.buffers[3].gpu());
  assert.equal(resource(state.groups[0], 7).buffer, state.buffers[0].gpu());
  assert.deepEqual(recording.copies, [
    [input[1].gpu(), 0, state.buffers[2].gpu(), 0, 17 * 9 * 16],
    [input[2].gpu(), 0, state.buffers[3].gpu(), 0, 17 * 9 * 16],
  ]);
  assert.deepEqual(
    Array.from(new Uint32Array(state.buffers[4].data, 0, 4)),
    [17, 9, 0, 0],
  );
  assert.deepEqual(
    Array.from(new Uint32Array(state.buffers[4].data, 256, 4)),
    [17, 9, 1, 0],
  );
  assert.equal(encode(), state.buffers[1].gpu());
  assert.equal(resource(state.groups[1], 4).buffer, state.buffers[0].gpu());
  assert.equal(resource(state.groups[1], 8).offset, 256);
  encode({ reset: true });
  encode();
  encode({ progressive: true });
  encode();
  filter.reset();
  encode();
  assert.deepEqual(
    state.groups.map((g) => resource(g, 8).offset),
    [0, 256, 0, 256, 0, 256, 0],
  );
  assert.equal(filter.inspect().bytes, 4 * 17 * 9 * 16 + 768);
  assert.equal(filter.inspect().passes, 7);
  assert.equal(filter.inspect().historyValid, true);
  assert.equal(
    state.buffers[0].usage,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  assert.equal(
    state.buffers[2].usage,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  );
  assert.equal(state.buffers[4].usage, GPUBufferUsage.UNIFORM);
  assert.equal(state.pops, 1, "encode does not consume caller scopes");
  assert.ok(input.every((b) => b.destroys === 0));
  filter.dispose();
});

test("host disabled mode allocates/encodes nothing and invalidates prior history", async () => {
  const { device, state } = recordingDevice();
  const filter = await createTemporalFilter(device);
  const input = buffers();
  const recording = recordingEncoder();
  const encode = (options?: TemporalFilterOptions) =>
    filter.encode(
      recording.encoder,
      input[0].gpu(),
      input[1].gpu(),
      input[2].gpu(),
      input[3].gpu(),
      17,
      9,
      options,
    );
  assert.equal(encode({ enabled: false }), input[0].gpu());
  assert.equal(state.buffers.length, 0);
  assert.equal(recording.events.length, 0);
  encode();
  encode();
  const groups = state.groups.length,
    events = recording.events.length;
  assert.equal(encode({ enabled: false }), input[0].gpu());
  assert.equal(filter.inspect().historyValid, false);
  assert.equal(filter.inspect().lastPasses, 0);
  assert.equal(state.groups.length, groups);
  assert.equal(recording.events.length, events);
  encode();
  assert.equal(resource(state.groups.at(-1)!, 8).offset, 0);
  assert.equal(state.buffers.length, 5);
  filter.dispose();
});

test("host validates actual buffers, usage, mapping, aliases, options, dimensions and budgets before mutation", async () => {
  const { device, state, limits } = recordingDevice();
  const filter = await createTemporalFilter(device);
  const input = buffers();
  const recording = recordingEncoder();
  const encode = (
    w = 17,
    h = 9,
    options?: unknown,
    b = input.map((p) => p.gpu()),
    encoder = recording.encoder,
  ) =>
    filter.encode(
      encoder,
      b[0],
      b[1],
      b[2],
      b[3],
      w,
      h,
      options as TemporalFilterOptions,
    );
  const output = encode();
  const before = filter.inspect();
  for (const options of [
    null,
    [],
    4,
    { enabled: 1 },
    { reset: "true" },
    { progressive: 2 },
  ])
    assert.throws(() => encode(17, 9, options), /TC_TEMPORAL_OPTIONS/);
  for (const [w, h] of [
    [0, 1],
    [1, -1],
    [1.5, 2],
    [NaN, 1],
    [Infinity, 1],
    [65536, 65536],
  ])
    assert.throws(() => encode(w, h), /TC_TEMPORAL_DIMENSION/);
  for (let binding = 0; binding < 4; binding++) {
    for (const bad of [
      new RecordingBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }),
      new RecordingBuffer({
        size: 17 * 9 * 16 + 4,
        usage: GPUBufferUsage.STORAGE,
      }),
      new RecordingBuffer({
        size: 17 * 9 * 16,
        usage: GPUBufferUsage.COPY_SRC,
      }),
      new RecordingBuffer({
        size: 17 * 9 * 16,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      }),
    ]) {
      const b = input.map((p) => p.gpu());
      b[binding] = bad.gpu();
      assert.throws(() => encode(17, 9, {}, b), /TC_TEMPORAL_BUFFER/);
    }
    const b = input.map((p) => p.gpu());
    b[binding] = output;
    assert.throws(() => encode(17, 9, {}, b), /TC_TEMPORAL_ALIAS/);
  }
  for (const binding of [1, 2]) {
    const b = input.map((p) => p.gpu());
    b[binding] = new RecordingBuffer({
      size: 17 * 9 * 16,
      usage: GPUBufferUsage.STORAGE,
    }).gpu();
    assert.throws(() => encode(17, 9, {}, b), /TC_TEMPORAL_BUFFER/);
  }
  assert.throws(
    () => encode(17, 9, {}, undefined, {} as GPUCommandEncoder),
    /TC_TEMPORAL_ENCODER/,
  );
  limits.maxComputeWorkgroupsPerDimension = 1;
  assert.throws(() => encode(), /TC_TEMPORAL_DIMENSION/);
  limits.maxComputeWorkgroupsPerDimension = 65535;
  limits.maxBufferSize = limits.maxStorageBufferBindingSize =
    1024 * 1024 * 1024;
  assert.throws(() => encode(4096, 4096), /TC_TEMPORAL_BUDGET/);
  assert.deepEqual(filter.inspect(), before);
  assert.equal(state.buffers.length, 5);
  assert.equal(recording.dispatches.length, 1);
  filter.dispose();
});

test("host accepts excess readonly capacity, resizes on shape changes, snapshots inspection and disposes once", async () => {
  const { device, state } = recordingDevice();
  const filter = await createTemporalFilter(device);
  const input = buffers(32, 32);
  const { encoder } = recordingEncoder();
  const encode = (w: number, h: number) =>
    filter.encode(
      encoder,
      input[0].gpu(),
      input[1].gpu(),
      input[2].gpu(),
      input[3].gpu(),
      w,
      h,
    );
  encode(16, 8);
  const old = state.buffers.slice();
  for (let i = 0; i < 8; i++)
    assert.equal(resource(state.groups[0], i).size, 16 * 8 * 16);
  encode(8, 16);
  assert.ok(old.every((b) => b.destroys === 1));
  assert.equal(
    resource(state.groups.at(-1)!, 8).offset,
    0,
    "shape change invalidates history",
  );
  const detached = filter.inspect();
  detached.dimension.width = 900;
  assert.deepEqual(filter.inspect().dimension, { width: 8, height: 16 });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(filter.inspect())));
  encode(32, 32);
  filter.dispose();
  filter.dispose();
  filter.reset();
  assert.ok(state.buffers.every((b) => b.destroys === 1));
  assert.ok(input.every((b) => b.destroys === 0));
  assert.equal(filter.inspect().entries, 0);
  assert.equal(filter.inspect().bytes, 0);
  assert.equal(filter.inspect().historyValid, false);
  assert.equal(filter.inspect().disposed, true);
  assert.throws(() => encode(1, 1), /TC_TEMPORAL_DISPOSED/);
});

test("host allocation/mapping/group failures clean replacements and preserve prior ownership/history", async () => {
  for (const mode of ["allocation", "mapping", "group"]) {
    const { device, state } = recordingDevice();
    const filter = await createTemporalFilter(device);
    const input = buffers(32, 32);
    const { encoder } = recordingEncoder();
    const encode = (w: number, h: number) =>
      filter.encode(
        encoder,
        input[0].gpu(),
        input[1].gpu(),
        input[2].gpu(),
        input[3].gpu(),
        w,
        h,
      );
    encode(8, 8);
    const old = state.buffers.slice();
    const before = filter.inspect();
    if (mode === "allocation") state.failAllocation = 7;
    if (mode === "mapping") state.failMapping = 7;
    if (mode === "group") state.failGroup = 1;
    assert.throws(() => encode(32, 32), /fake/);
    assert.deepEqual(filter.inspect(), before);
    assert.ok(old.every((b) => b.destroys === 0));
    assert.ok(state.buffers.slice(5).every((b) => b.destroys === 1));
    state.failAllocation = state.failMapping = state.failGroup = -1;
    assert.equal(
      encode(8, 8),
      old[1].gpu(),
      "failed encode did not swap previous radiance",
    );
    filter.dispose();
    assert.ok(state.buffers.every((b) => b.destroys === 1));
  }
});

test("host encoder exceptions release replacements; caller must discard failed encoder", async () => {
  for (const failure of ["begin", "dispatch", "copy"] as const) {
    const { device, state } = recordingDevice();
    const filter = await createTemporalFilter(device);
    const input = buffers(32, 32);
    const recording = recordingEncoder();
    const encode = (encoder: GPUCommandEncoder, w: number, h: number) =>
      filter.encode(
        encoder,
        input[0].gpu(),
        input[1].gpu(),
        input[2].gpu(),
        input[3].gpu(),
        w,
        h,
      );
    encode(recording.encoder, 8, 8);
    const before = filter.inspect();
    assert.throws(
      () => encode(recordingEncoder(failure).encoder, 32, 32),
      /fake/,
    );
    assert.deepEqual(filter.inspect(), before);
    assert.ok(state.buffers.slice(0, 5).every((b) => b.destroys === 0));
    assert.ok(state.buffers.slice(5).every((b) => b.destroys === 1));
    encode(recording.encoder, 8, 8);
    filter.dispose();
  }
});

test("host creation failures balance scopes and allocate no buffers", async () => {
  for (const mode of ["async", "sync", "scope"]) {
    const { device, state } = recordingDevice();
    state.pipelineError = mode === "async";
    state.pipelineThrow = mode === "sync";
    if (mode === "scope")
      state.scopeError = { message: "fake validation failure" } as GPUError;
    await assert.rejects(createTemporalFilter(device), /TC_TEMPORAL_PIPELINE/);
    assert.equal(state.pops, 1);
    assert.equal(state.buffers.length, 0);
  }
});

test("host device loss interrupts hanging creation and releases live owned buffers", async () => {
  for (const hang of ["pipeline", "scope"]) {
    const { device, state, lose } = recordingDevice();
    state.pipelineHang = hang === "pipeline";
    state.scopeHang = hang === "scope";
    const creating = createTemporalFilter(device);
    lose();
    await assert.rejects(
      creating,
      (error: Error & { cause?: Error }) =>
        error.cause?.message.includes("DEVICE_LOST") === true,
    );
    assert.equal(state.pops, 1);
    assert.equal(state.buffers.length, 0);
  }
  const { device, state, lose } = recordingDevice();
  const filter = await createTemporalFilter(device);
  const input = buffers();
  const { encoder } = recordingEncoder();
  const encode = () =>
    filter.encode(
      encoder,
      input[0].gpu(),
      input[1].gpu(),
      input[2].gpu(),
      input[3].gpu(),
      17,
      9,
    );
  encode();
  lose();
  await Promise.resolve();
  assert.equal(filter.inspect().lost, true);
  assert.equal(filter.inspect().bytes, 0);
  assert.equal(filter.inspect().historyValid, false);
  assert.ok(state.buffers.every((b) => b.destroys === 1));
  assert.throws(encode, /TC_TEMPORAL_DEVICE_LOST/);
  filter.dispose();
  assert.ok(state.buffers.every((b) => b.destroys === 1));
  assert.ok(input.every((b) => b.destroys === 0));
});

test("host hanging pipeline or validation scope has bounded 10-second creation deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const hang of ["pipeline", "scope"]) {
    const { device, state } = recordingDevice();
    state.pipelineHang = hang === "pipeline";
    state.scopeHang = hang === "scope";
    const creating = createTemporalFilter(device);
    const rejected = assert.rejects(
      creating,
      (error: Error & { cause?: Error }) =>
        error.cause?.message.includes("TIMEOUT") === true,
    );
    t.mock.timers.tick(10_001);
    await rejected;
    assert.equal(state.pops, 1);
    assert.equal(state.buffers.length, 0);
  }
});
