import { graphicsLaunchArguments } from "../tools/browser-session.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium, type Browser } from "playwright";
import ts from "typescript";
import { createSurfaceDenoiser } from "../packages/renderer/src/denoiser.ts";

// Recording fakes assert host contracts only. They never execute or validate WGSL.
Object.assign(globalThis, {
  GPUBufferUsage: {
    MAP_READ: 1,
    COPY_SRC: 4,
    COPY_DST: 8,
    UNIFORM: 64,
    STORAGE: 128,
  },
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
    if (this.failMap) throw new Error("fake mapping allocation failure");
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
  let lose!: (value: GPUDeviceLostInfo) => void;
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
      return { descriptor };
    },
    createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor) {
      return { descriptor };
    },
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      state.shader = descriptor.code;
      return {};
    },
    createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) {
      state.pipelines.push(descriptor);
      if (state.pipelineThrow) throw new Error("fake setup failure");
      if (state.pipelineError)
        return Promise.reject(new Error("fake GPU pipeline rejection"));
      if (state.pipelineHang) return new Promise<GPUComputePipeline>(() => {});
      return Promise.resolve({ descriptor });
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
      return { descriptor };
    },
  };
  return {
    state,
    device: device as unknown as GPUDevice,
    lose: () =>
      lose({
        reason: "destroyed",
        message: "test device lost",
      } as GPUDeviceLostInfo),
  };
}

function recordingEncoder() {
  const passes: {
    pipeline?: GPUComputePipeline;
    group?: GPUBindGroup;
    dispatch?: number[];
    ended: boolean;
  }[] = [];
  const encoder = {
    beginComputePass() {
      const record: (typeof passes)[number] = { ended: false };
      passes.push(record);
      return {
        setPipeline(pipeline: GPUComputePipeline) {
          record.pipeline = pipeline;
        },
        setBindGroup(_index: number, group: GPUBindGroup) {
          record.group = group;
        },
        dispatchWorkgroups(...dispatch: number[]) {
          record.dispatch = dispatch;
        },
        end() {
          record.ended = true;
        },
      };
    },
  };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes };
}
function inputs(width = 17, height = 9) {
  return Array.from(
    { length: 3 },
    () =>
      new RecordingBuffer({
        size: width * height * 16,
        usage: GPUBufferUsage.STORAGE,
      }),
  );
}
function resource(group: GPUBindGroupDescriptor, binding: number) {
  return Array.from(group.entries).find((entry) => entry.binding === binding)!
    .resource as GPUBufferBinding;
}

test("denoiser creation awaits async validation with explicit readonly storage ABI", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  assert.deepEqual(state.pushes, ["validation"]);
  assert.equal(state.pops, 1);
  assert.equal(state.pipelines.length, 1);
  assert.deepEqual(
    Array.from(state.layouts[0].entries).map((entry) => entry.buffer?.type),
    [
      "read-only-storage",
      "read-only-storage",
      "read-only-storage",
      "read-only-storage",
      "storage",
      "uniform",
    ],
  );
  assert.match(state.shader, /@workgroup_size\(8,8\)/);
  assert.deepEqual(denoiser.inspect(), {
    entries: 0,
    bytes: 0,
    passes: 0,
    lastPasses: 0,
    dimension: { width: 0, height: 0 },
    disposed: false,
    lost: false,
  });
  denoiser.dispose();
});

test("default three passes bind original/count and immutable aligned a-trous parameters", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder, passes } = recordingEncoder();
  const [input, normal, albedo] = inputs();
  const output = denoiser.encode(
    encoder,
    input.gpu(),
    normal.gpu(),
    albedo.gpu(),
    17,
    9,
  );
  assert.equal(output, state.buffers[0].gpu());
  assert.equal(state.buffers.length, 3);
  assert.equal(
    state.buffers[0].usage,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );
  assert.equal(state.buffers[2].usage, GPUBufferUsage.UNIFORM);
  for (let i = 0; i < 3; i++) {
    const group = state.groups[i];
    assert.equal(
      resource(group, 0).buffer,
      i === 0 ? input.gpu() : state.buffers[(i - 1) % 2].gpu(),
    );
    assert.equal(resource(group, 1).buffer, normal.gpu());
    assert.equal(resource(group, 2).buffer, albedo.gpu());
    assert.equal(resource(group, 3).buffer, input.gpu());
    assert.equal(resource(group, 4).buffer, state.buffers[i % 2].gpu());
    assert.equal(resource(group, 0).size, 17 * 9 * 16);
    assert.equal(resource(group, 5).offset, i * 256);
    assert.equal(resource(group, 5).size, 16);
    assert.deepEqual(
      Array.from(new Uint32Array(state.buffers[2].data, i * 256, 4)),
      [17, 9, 1 << i, 0],
    );
    assert.deepEqual(passes[i].dispatch, [3, 2]);
    assert.equal(passes[i].ended, true);
  }
  assert.equal(denoiser.inspect().bytes, 2 * 17 * 9 * 16 + 5 * 256);
  assert.equal(denoiser.inspect().passes, 3);
  const alternate = inputs();
  assert.equal(
    denoiser.encode(
      encoder,
      alternate[0].gpu(),
      alternate[1].gpu(),
      alternate[2].gpu(),
      17,
      9,
      { iterations: 2 },
    ),
    state.buffers[1].gpu(),
  );
  assert.equal(state.buffers.length, 3);
  assert.equal(resource(state.groups[3], 3).buffer, alternate[0].gpu());
  assert.equal(denoiser.inspect().passes, 5);
  assert.equal(state.pops, 1, "encode must not pop caller error scopes");
  assert.deepEqual(state.pushes, ["validation"]);
  assert.ok(
    [input, normal, albedo, ...alternate].every(
      (buffer) => buffer.destroys === 0,
    ),
  );
  denoiser.dispose();
});

test("disabled and zero iterations return exact input without allocations or passes", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder, passes } = recordingEncoder();
  const [input, normal, albedo] = inputs();
  for (const options of [
    { enabled: false },
    { iterations: 0 },
    { enabled: false, iterations: 5 },
  ])
    assert.equal(
      denoiser.encode(
        encoder,
        input.gpu(),
        normal.gpu(),
        albedo.gpu(),
        17,
        9,
        options,
      ),
      input.gpu(),
    );
  assert.equal(state.buffers.length, 0);
  assert.equal(state.groups.length, 0);
  assert.equal(passes.length, 0);
  assert.equal(denoiser.inspect().passes, 0);
  denoiser.dispose();
});

test("invalid dimensions/options/buffer contracts fail before changing existing state", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder, passes } = recordingEncoder();
  const [input, normal, albedo] = inputs();
  denoiser.encode(encoder, input.gpu(), normal.gpu(), albedo.gpu(), 17, 9);
  const before = JSON.stringify(denoiser.inspect());
  const call = (w: number, h: number, options?: unknown) =>
    denoiser.encode(
      encoder,
      input.gpu(),
      normal.gpu(),
      albedo.gpu(),
      w,
      h,
      options as never,
    );
  for (const [w, h] of [
    [0, 1],
    [-1, 1],
    [1.1, 1],
    [NaN, 1],
    [1, Infinity],
    [Number.MAX_SAFE_INTEGER, 2],
    [524281, 1],
    [65536, 65536],
    [4096, 4096],
  ])
    assert.throws(() => call(w, h), /TC_DENOISER_DIMENSION/);
  for (const iterations of [-1, 6, 1.1, NaN, Infinity, "3", null])
    assert.throws(() => call(17, 9, { iterations }), /TC_DENOISER_OPTIONS/);
  for (const options of [
    null,
    [],
    false,
    { enabled: 1 },
    { enabled: "false" },
    { iterations: 6, enabled: false },
  ])
    assert.throws(() => call(17, 9, options), /TC_DENOISER_OPTIONS/);
  for (let binding = 0; binding < 3; binding++) {
    for (const invalid of [
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
      const buffers = [input.gpu(), normal.gpu(), albedo.gpu()];
      buffers[binding] = invalid.gpu();
      assert.throws(
        () =>
          denoiser.encode(encoder, buffers[0], buffers[1], buffers[2], 17, 9),
        /TC_DENOISER_BUFFER/,
      );
    }
  }
  assert.throws(
    () =>
      denoiser.encode(
        encoder,
        state.buffers[0].gpu(),
        normal.gpu(),
        albedo.gpu(),
        17,
        9,
      ),
    /TC_DENOISER_ALIAS/,
  );
  assert.equal(JSON.stringify(denoiser.inspect()), before);
  assert.equal(state.buffers.length, 3);
  assert.equal(passes.length, 3);
  denoiser.dispose();
});

test("explicit binding sizes allow extra vec4 capacity without reading trailing storage", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder } = recordingEncoder();
  const buffers = inputs(20, 20);
  denoiser.encode(
    encoder,
    buffers[0].gpu(),
    buffers[1].gpu(),
    buffers[2].gpu(),
    1,
    1,
    { iterations: 5 },
  );
  for (const group of state.groups)
    for (let binding = 0; binding < 5; binding++)
      assert.equal(resource(group, binding).size, 16);
  assert.equal(denoiser.inspect().lastPasses, 5);
  denoiser.dispose();
});

test("resize and dispose release only owned resources, shape changes resize too", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder } = recordingEncoder();
  const buffers = inputs(32, 32);
  const encode = (w: number, h: number) =>
    denoiser.encode(
      encoder,
      buffers[0].gpu(),
      buffers[1].gpu(),
      buffers[2].gpu(),
      w,
      h,
    );
  encode(16, 8);
  const old = state.buffers.slice();
  encode(8, 16);
  assert.ok(old.every((buffer) => buffer.destroys === 1));
  assert.deepEqual(denoiser.inspect().dimension, { width: 8, height: 16 });
  encode(32, 32);
  denoiser.dispose();
  denoiser.dispose();
  assert.ok(state.buffers.every((buffer) => buffer.destroys === 1));
  assert.ok(buffers.every((buffer) => buffer.destroys === 0));
  assert.equal(denoiser.inspect().entries, 0);
  assert.equal(denoiser.inspect().bytes, 0);
  assert.equal(denoiser.inspect().disposed, true);
  assert.throws(() => encode(1, 1), /TC_DENOISER_DISPOSED/);
});

test("synchronous allocation, mapping, and bind group resize failures roll back ownership", async () => {
  for (const mode of ["allocation", "mapping", "group"]) {
    const { device, state } = recordingDevice();
    const denoiser = await createSurfaceDenoiser(device);
    const { encoder, passes } = recordingEncoder();
    const buffers = inputs(32, 32);
    const encode = (w: number, h: number) =>
      denoiser.encode(
        encoder,
        buffers[0].gpu(),
        buffers[1].gpu(),
        buffers[2].gpu(),
        w,
        h,
      );
    const output = encode(8, 8);
    const before = denoiser.inspect();
    const old = state.buffers.slice();
    if (mode === "allocation") state.failAllocation = 4;
    if (mode === "mapping") state.failMapping = 4;
    if (mode === "group") state.failGroup = 3;
    assert.throws(() => encode(32, 32), /fake/);
    assert.deepEqual(denoiser.inspect(), before);
    assert.equal(passes.length, 3);
    assert.ok(old.every((buffer) => buffer.destroys === 0));
    assert.ok(state.buffers.slice(3).every((buffer) => buffer.destroys === 1));
    state.failAllocation = state.failMapping = state.failGroup = -1;
    assert.equal(encode(8, 8), output);
    denoiser.dispose();
  }
});

test("encoder exceptions release replacement buffers without replacing prior state", async () => {
  const { device, state } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder } = recordingEncoder();
  const [input, normal, albedo] = inputs(32, 32);
  denoiser.encode(encoder, input.gpu(), normal.gpu(), albedo.gpu(), 8, 8);
  const before = denoiser.inspect();
  const broken = {
    beginComputePass() {
      throw new Error("fake encoder failure");
    },
  } as unknown as GPUCommandEncoder;
  assert.throws(
    () =>
      denoiser.encode(broken, input.gpu(), normal.gpu(), albedo.gpu(), 32, 32),
    /fake encoder/,
  );
  assert.deepEqual(denoiser.inspect(), before);
  assert.ok(state.buffers.slice(0, 3).every((buffer) => buffer.destroys === 0));
  assert.ok(state.buffers.slice(3).every((buffer) => buffer.destroys === 1));
  assert.throws(
    () =>
      denoiser.encode(
        {} as GPUCommandEncoder,
        input.gpu(),
        normal.gpu(),
        albedo.gpu(),
        8,
        8,
      ),
    /TC_DENOISER_ENCODER/,
  );
  assert.equal(
    denoiser.encode(encoder, input.gpu(), normal.gpu(), albedo.gpu(), 32, 32, {
      enabled: false,
    }),
    input.gpu(),
  );
  assert.deepEqual(denoiser.inspect().dimension, before.dimension);
  const detached = denoiser.inspect();
  detached.dimension.width = 999;
  assert.deepEqual(denoiser.inspect().dimension, before.dimension);
  denoiser.dispose();
});

test("pipeline failure balances scopes and allocates no buffers", async () => {
  for (const mode of ["async", "sync", "scope"]) {
    const { device, state } = recordingDevice();
    state.pipelineError = mode === "async";
    state.pipelineThrow = mode === "sync";
    if (mode === "scope")
      state.scopeError = {
        message: "fake shader validation error",
      } as GPUError;
    await assert.rejects(createSurfaceDenoiser(device), /TC_DENOISER_PIPELINE/);
    assert.equal(state.pops, 1);
    assert.equal(state.buffers.length, 0);
  }
});

test("device loss rejects hanging pipeline/scope creation and releases live buffers", async () => {
  for (const hang of ["pipeline", "scope"]) {
    const { device, state, lose } = recordingDevice();
    state.pipelineHang = hang === "pipeline";
    state.scopeHang = hang === "scope";
    const creating = createSurfaceDenoiser(device);
    lose();
    await assert.rejects(
      creating,
      (error: Error & { cause?: Error }) =>
        error.cause?.message.includes("DEVICE_LOST") === true,
    );
  }
  const { device, state, lose } = recordingDevice();
  const denoiser = await createSurfaceDenoiser(device);
  const { encoder } = recordingEncoder();
  const [input, normal, albedo] = inputs();
  denoiser.encode(encoder, input.gpu(), normal.gpu(), albedo.gpu(), 17, 9);
  lose();
  await Promise.resolve();
  assert.equal(denoiser.inspect().lost, true);
  assert.equal(denoiser.inspect().bytes, 0);
  assert.ok(state.buffers.every((buffer) => buffer.destroys === 1));
  assert.throws(
    () =>
      denoiser.encode(encoder, input.gpu(), normal.gpu(), albedo.gpu(), 17, 9),
    /TC_DENOISER_DEVICE_LOST/,
  );
  denoiser.dispose();
});

test("unresponsive creation has a bounded 10s timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { device, state } = recordingDevice();
  state.pipelineHang = true;
  const creating = createSurfaceDenoiser(device);
  const rejected = assert.rejects(
    creating,
    (error: Error & { cause?: Error }) =>
      error.cause?.message.includes("TIMEOUT") === true,
  );
  t.mock.timers.tick(10_001);
  await rejected;
});

// Plain browser JavaScript deliberately avoids tsx/esbuild's Node closure helpers.
const BROWSER_PROBE = String.raw`async () => {
  const { createSurfaceDenoiser } = await import('/denoiser.js');
  const check = (value, message) => { if (!value) throw Error(message); };
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter && adapter.info.isFallbackAdapter === false, 'TC_GPU_HARDWARE_REQUIRED');
  check(!/swiftshader|llvmpipe|software|warp/i.test(JSON.stringify(adapter.info)), 'TC_GPU_SOFTWARE_REJECTED');
  const device = await adapter.requestDevice();
  const owned = new Set();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let denoiser;
  const storage = values => {
    const buffer = device.createBuffer({size: values.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, mappedAtCreation:true});
    owned.add(buffer);
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    buffer.unmap();
    return buffer;
  };
  const staging = size => {
    const buffer = device.createBuffer({size,usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    owned.add(buffer);
    return buffer;
  };
  const read = async buffer => {
    await buffer.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy(); owned.delete(buffer);
    return values;
  };
  const fixture = (width,height,color = 0.6) => {
    const radiance = new Float32Array(width*height*4);
    const normal = new Float32Array(radiance.length);
    const albedo = new Float32Array(radiance.length);
    for (let i=0;i<width*height;i++) {
      radiance.set([color,color,color,1+i%16],i*4);
      normal.set([0,0,1,2],i*4);
      albedo.set([0.5,0.5,0.5,0.8],i*4);
    }
    return {width,height,radiance,normal,albedo};
  };
  const sameBits = (a,b) => {
    const aa = new Uint32Array(a.buffer,a.byteOffset,a.length);
    const bb = new Uint32Array(b.buffer,b.byteOffset,b.length);
    return aa.length === bb.length && aa.every((value,i)=>value === bb[i]);
  };
  const run = async (f, options = {}, inspectInputs = true) => {
    const values = [f.radiance,f.normal,f.albedo];
    const buffers = values.map(storage);
    const encoder = device.createCommandEncoder();
    device.pushErrorScope('validation');
    let output;
    let validation;
    const start = performance.now();
    try {
      output = denoiser.encode(encoder,...buffers,f.width,f.height,options);
      const bypass = options.iterations === 0 || options.enabled === false;
      check((output === buffers[0]) === bypass,'bypass output identity');
      const copies = [staging(f.radiance.byteLength)];
      encoder.copyBufferToBuffer(output,0,copies[0],0,f.radiance.byteLength);
      if (inspectInputs) for (const buffer of buffers) {
        const copy = staging(f.radiance.byteLength); copies.push(copy);
        encoder.copyBufferToBuffer(buffer,0,copy,0,f.radiance.byteLength);
      }
      device.queue.submit([encoder.finish()]);
      const result = await read(copies[0]);
      const elapsed = performance.now()-start;
      for (let i=1;i<copies.length;i++) check(sameBits(await read(copies[i]),values[i-1]),'readonly input changed '+(i-1));
      return {result,elapsed,inspection:denoiser.inspect()};
    } finally {
      validation = await device.popErrorScope();
      for (const buffer of buffers) { buffer.destroy(); owned.delete(buffer); }
      check(!validation, 'GPU validation: '+validation?.message);
    }
  };
  try {
    denoiser = await createSurfaceDenoiser(device);
    const width=96,height=64;
    const f=fixture(width,height);
    const truth=new Float32Array(f.radiance.length);
    let seed=0x12345678;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
      const p=Math.floor(x/24),i=(y*width+x)*4;
      let base=[0.3,0.9,0.45,1.0][p]*(y<32?1:2.8);
      if(p===2 && x>=54 && x<66 && y>=8 && y<24) base=4;
      f.normal.set(p===0?[0,0,1,1]:[0,1,0,p===1?1:4],i);
      f.albedo.set(p===3?[0.1,0.8,0.2,0.8]:[0.6,0.5,0.4,p===2?0.12:0.8],i);
      for(let c=0;c<3;c++) {
        truth[i+c]=base*[0.8,1,1.2][c];
        f.radiance[i+c]=truth[i+c]*(1+(random()-0.5)*0.48);
      }
      truth[i+3]=f.radiance[i+3];
    }
    const noisy = await run(f);
    let before=0,after=0;
    for(let i=0;i<truth.length;i++) {
      if(i%4===3) {check(noisy.result[i]===f.radiance[i],'sample alpha changed');continue;}
      before+=(f.radiance[i]-truth[i])**2;
      after+=(noisy.result[i]-truth[i])**2;
    }
    before/=width*height*3; after/=width*height*3;
    check(after<before*0.65,'noisy multi-plane MSE did not improve: '+JSON.stringify({before,after}));
    const discontinuities={};
    for(const kind of ['normal','depth','albedo','same-material-lighting','rough-specular']) {
      const edge=fixture(48,24);
      for(let y=0;y<24;y++)for(let x=0;x<48;x++) {
        const i=(y*48+x)*4,right=x>=24;
        const value=kind==='same-material-lighting'||kind==='rough-specular'?(right?2:0.25):(right?0.6:0.5);
        edge.radiance.set([value,value,value,8],i);
        if(right && kind==='normal')edge.normal.set([0,1,0,2],i);
        if(right && kind==='depth')edge.normal[i+3]=5;
        if(right && kind==='albedo')edge.albedo.set([0.05,0.95,0.05,0.8],i);
        edge.albedo[i+3]=kind==='rough-specular'?0.9:0.8;
      }
      const filtered=await run(edge,{iterations:5});
      let max=0;
      for(let i=0;i<filtered.result.length;i++)if(i%4!==3)max=Math.max(max,Math.abs(filtered.result[i]-edge.radiance[i]));
      discontinuities[kind]=max;
      check(max<(kind==='normal'||kind==='depth'?2e-6:0.01),kind+' edge leaked: '+max);
    }
    const bad=fixture(9,9,0.7);
    bad.radiance[40*4]=NaN;
    bad.radiance[0]=10;bad.radiance[3]=0;
    bad.normal[10*4]=NaN;
    bad.normal[80*4+3]=-1;bad.radiance.set([3,4,5,7],80*4);
    bad.radiance[72*4+3]=NaN;
    bad.radiance[73*4]=Infinity;
    bad.radiance[74*4+3]=-1;
    const sanitized=(await run(bad,{iterations:5})).result;
    check(sanitized.every(Number.isFinite),'nonfinite propagation');
    check(sanitized[40*4]===0 && sanitized[40*4+3]===bad.radiance[40*4+3],'invalid RGB/count handling');
    check(sanitized[0]===0 && sanitized[3]===0,'zero-count handling');
    check(sanitized[72*4+3]===0 && sanitized[74*4+3]===0,'invalid alpha handling');
    check(sanitized[73*4]===0,'infinity handling');
    check(sanitized[10*4]===bad.radiance[10*4],'invalid guide isolation');
    check(sameBits(sanitized.slice(80*4,81*4),bad.radiance.slice(80*4,81*4)),'miss handling');
    for(let i=0;i<81;i++)if(![0,10,40,72,73,74,80].includes(i))
      check(Math.abs(sanitized[i*4]-0.7)<2e-6,'invalid neighbor contamination');
    const black=fixture(13,7,0);
    check((await run(black)).result.every((v,i)=>i%4===3?v===black.radiance[i]:v===0),'black input');
    for(const options of [{iterations:0},{enabled:false}]) {
      const before=denoiser.inspect();
      const bypass=await run(f,options);
      check(sameBits(bypass.result,f.radiance),'bypass modified data');
      check(bypass.inspection.passes===before.passes && bypass.inspection.bytes===before.bytes,'bypass work');
    }
    const resizeStats=[];
    for(let round=0;round<3;round++)for(const [w,h] of [[1,1],[17,9],[64,32],[9,7],[96,64]]) {
      const flat=fixture(w,h);
      const {result,inspection}=await run(flat,{iterations:1+round},false);
      check(result.every((v,i)=>Math.abs(v-flat.radiance[i])<2e-6),'resize data');
      check(inspection.entries===3 && inspection.dimension.width===w && inspection.dimension.height===h,'resize inspection');
      resizeStats.push(inspection.bytes);
    }
    for(let iterations=1;iterations<=5;iterations++) {
      const flat=fixture(17,9,0.7);
      const result=(await run(flat,{iterations},false)).result;
      check(result.every((v,i)=>Math.abs(v-flat.radiance[i])<2e-6),'iteration range/average ABI');
    }
    // Two encodes recorded before one submit must not share mutable step parameters.
    {
      const first=fixture(17,9,0.4),second=fixture(17,9,1.3);
      const values=[first,second];
      for(let i=0;i<first.radiance.length;i++)if(i%4!==3) {
        first.radiance[i]+=0.02*(i%7);
        second.radiance[i]+=0.07*(i%5);
      }
      const expected=[(await run(first,{iterations:5},false)).result,
        (await run(second,{iterations:2},false)).result];
      const all=values.map(f=>[f.radiance,f.normal,f.albedo].map(storage));
      const copies=values.map(f=>staging(f.radiance.byteLength));
      const encoder=device.createCommandEncoder();
      device.pushErrorScope('validation');
      try {
        for(let i=0;i<2;i++) {
          const output=denoiser.encode(encoder,...all[i],17,9,{iterations:i===0?5:2});
          encoder.copyBufferToBuffer(output,0,copies[i],0,first.radiance.byteLength);
        }
        device.queue.submit([encoder.finish()]);
        for(let i=0;i<2;i++) {
          const result=await read(copies[i]);
          check(result.every((v,j)=>Math.abs(v-expected[i][j])<2e-6),'same encoder parameter/output collision');
        }
      } finally {
        const validation=await device.popErrorScope();
        for(const b of all.flat()){b.destroy();owned.delete(b);}
        check(!validation,'same encoder GPU validation: '+validation?.message);
      }
    }
    // Foreign-device buffers are not synchronously introspectable. Caller scope MUST see validation.
    const otherAdapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    check(otherAdapter && otherAdapter.info.isFallbackAdapter===false,'second hardware adapter');
    const other=await otherAdapter.requestDevice();
    try {
      const foreign=other.createBuffer({size:16,usage:GPUBufferUsage.STORAGE});
      const own=[storage(new Float32Array([0,0,1,2])),storage(new Float32Array([0.5,0.5,0.5,0.8]))];
      device.pushErrorScope('validation');
      try {
        const encoder=device.createCommandEncoder();
        denoiser.encode(encoder,foreign,...own,1,1,{iterations:1});
        device.queue.submit([encoder.finish()]);
      } finally {
        const validation=await device.popErrorScope();
        check(validation && validation.message,'foreign device validation was swallowed');
        for(const b of own){b.destroy();owned.delete(b);}
      }
      foreign.destroy();
    } finally {other.destroy();}
    const final=denoiser.inspect();
    denoiser.dispose();denoiser.dispose();
    check(denoiser.inspect().entries===0 && denoiser.inspect().bytes===0,'dispose leak');
    for(let i=0;i<3;i++) {
      denoiser=await createSurfaceDenoiser(device);
      await run(fixture(17+i,9),{iterations:1},false);
      denoiser.dispose();denoiser.dispose();
    }
    await device.queue.onSubmittedWorkDone();
    check(errors.length===0,'uncaptured GPU errors: '+errors.join(';'));
    return {
      adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,
        description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},
      width,height,iterations:3,kernelTaps:25,nominalTapVisits:width*height*3*25,
      mseBefore:before,mseAfter:after,mseRatio:after/before,discontinuities,
      submitAndReadbackMs:noisy.elapsed,resizeCases:resizeStats.length,resizeBytes:resizeStats,
      final,disposed:denoiser.inspect(),uncapturedErrors:errors
    };
  } finally {
    denoiser?.dispose();
    for(const buffer of owned)buffer.destroy();
    device.destroy();
  }
}`;

/** Opt-in hardware evidence; in-memory server, no main renderer or installed service. */
export async function runDenoiserGpuTest() {
  let browser: Browser | undefined;
  let closing = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let javascript = "";
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type":
        request.url === "/denoiser.js" ? "text/javascript" : "text/html",
    });
    response.end(
      request.url === "/denoiser.js"
        ? javascript
        : '<!doctype html><meta charset="utf-8"><title>Denoiser GPU Test</title>',
    );
  });
  try {
    return await Promise.race([
      (async () => {
        const source = await readFile(
          new URL("../packages/renderer/src/denoiser.ts", import.meta.url),
          "utf8",
        );
        javascript = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
        if (closing) throw new Error("TC_DENOISER_GPU_DEADLINE");
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const attempts: string[] = [];
        for (const headless of [true]) {
          browser = await chromium.launch({
            headless,
            channel: "chromium",
            timeout: 12_000,
            args: [
              ...graphicsLaunchArguments(),
              "--disable-background-timer-throttling",
              "--disable-renderer-backgrounding",
              "--disable-backgrounding-occluded-windows",
              "--disable-features=CalculateNativeWinOcclusion",
            ],
          });
          if (closing) {
            await browser.close();
            throw new Error("TC_DENOISER_GPU_DEADLINE");
          }
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${address.port}`, {
            timeout: 10_000,
          });
          let probeTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const hardware = await Promise.race([
              page.evaluate(async () => {
                const adapter = await navigator.gpu?.requestAdapter({
                  powerPreference: "high-performance",
                });
                if (adapter?.info.isFallbackAdapter !== false) return false;
                const probeDevice = await adapter.requestDevice();
                probeDevice.destroy();
                return true;
              }),
              new Promise<never>((_, reject) => {
                probeTimer = setTimeout(
                  () =>
                    reject(
                      new Error("hardware adapter probe exceeded 8000 ms"),
                    ),
                  8000,
                );
              }),
            ]);
            if (!hardware) throw new Error("TC_GPU_HARDWARE_REQUIRED");
          } catch (error) {
            attempts.push(
              `${headless ? "headless" : "headed"}: ${String(error)}`,
            );
            await browser.close();
            browser = undefined;
            throw new Error(attempts.join("\n"));
          } finally {
            clearTimeout(probeTimer);
          }
          const execute = new Function(
            `return (${BROWSER_PROBE})`,
          )() as () => Promise<Record<string, unknown>>;
          const result = await page.evaluate(execute);
          return {
            ...result,
            mode: "headless-chromium-hardware",
            attempts,
          };
        }
        throw new Error("TC_GPU_HARDWARE_REQUIRED");
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                "TC_DENOISER_GPU_DEADLINE: 60000 ms Node deadline exceeded.",
              ),
            ),
          60_000,
        );
      }),
    ]);
  } finally {
    closing = true;
    clearTimeout(deadline);
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

test(
  "real WebGPU spatial denoiser compiles, executes, improves MSE and preserves edges/lifetimes",
  {
    skip: process.env.PELICAN_DENOISER_GPU !== "1",
  },
  async (t) => {
    const result = await runDenoiserGpuTest();
    t.diagnostic(JSON.stringify(result));
  },
);
