import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { uniform } from "three/tsl";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import {
  evaluateGraph,
  graphToTSL,
  runComputeGraph,
  withGraphGPUDeadline,
} from "../packages/renderer/src/graph.ts";
import { SurfaceTracer } from "../packages/renderer/src/surface-tracer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function deviceFixture() {
  const lost = deferred<GPUDeviceLostInfo>();
  const state = {
    pushes: 0,
    pops: 0,
    buffers: [] as { destroyed: boolean; destroy(): void }[],
    reads: 0,
  };
  const pipeline = { getBindGroupLayout: () => ({}) };
  const device = {
    lost: lost.promise,
    limits: {
      maxStorageBufferBindingSize: 1e6,
      maxBufferSize: 1e6,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    pushErrorScope: () => {
      state.pushes++;
    },
    popErrorScope: async () => {
      state.pops++;
      return null as GPUError | null;
    },
    createShaderModule: () => ({
      getCompilationInfo: async () => ({ messages: [] }),
    }),
    createComputePipelineAsync: async () => pipeline,
    createRenderPipelineAsync: async () => pipeline,
    createBuffer: () => {
      const buffer = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        mapAsync: async () => {},
        getMappedRange: () => {
          state.reads++;
          return new Float32Array([2, 0, 0, 1]).buffer;
        },
        unmap: () => {},
      };
      state.buffers.push(buffer);
      return buffer;
    },
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {}, submit: () => {} },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        dispatchWorkgroups: () => {},
        end: () => {},
      }),
      copyBufferToBuffer: () => {},
      finish: () => ({}),
    }),
  };
  return {
    device: device as unknown as GPUDevice,
    mock: device,
    lost,
    state,
    pipeline,
  };
}
const graph = compileGraphDeclaration(
  { nodes: [{ id: "n", op: "float", value: 2 }], output: "n" },
  "float",
).graph;

test("legacy reference graphs without nodeTypes retain CPU and TSL entry-point compatibility", () => {
  const legacy = {
    nodes: [
      { id: "base", op: "vec3", value: [0.1, 0.4, 0.8] },
      { id: "time", op: "time" },
      { id: "sin", op: "sin", inputs: ["time"] },
      { id: "out", op: "multiply", inputs: ["base", "sin"] },
    ],
    output: "out",
    outputType: "vec3",
  } as const;
  const before = JSON.stringify(legacy);
  assert.deepEqual(evaluateGraph(legacy, Math.PI / 2), [0.1, 0.4, 0.8]);
  assert.ok(graphToTSL(legacy, uniform(0)).isNode);
  assert.equal(JSON.stringify(legacy), before);
  assert.throws(
    () => evaluateGraph({ ...graph, nodeTypes: {} }, 0),
    /TC_GRAPH_TYPE:n/,
  );
});

test("graph GPU deadline closes its validation scope once on success and validation failure", async () => {
  const { device, mock, state } = deviceFixture();
  assert.equal(
    await withGraphGPUDeadline(device, "TC_TEST", async (active) => {
      active();
      return 7;
    }),
    7,
  );
  assert.equal(state.pops, 1);
  mock.popErrorScope = async () => {
    state.pops++;
    return { message: "bad binding" } as GPUError;
  };
  await assert.rejects(
    withGraphGPUDeadline(device, "TC_TEST", async () => 7),
    /TC_TEST_GPU: bad binding/,
  );
  assert.equal(state.pops, 2);
});

test("timeout covers shader/validation waits and prevents late side effects", async () => {
  const { device, state } = deviceFixture(),
    late = deferred<void>();
  let sideEffects = 0;
  const work = withGraphGPUDeadline(
    device,
    "TC_TEST",
    async (active) => {
      await late.promise;
      active();
      sideEffects++;
    },
    5,
  );
  await assert.rejects(work, /TC_TEST_TIMEOUT/);
  assert.equal(state.pops, 1);
  late.resolve();
  await turn();
  assert.equal(sideEffects, 0);
  const stuck = deviceFixture();
  stuck.mock.popErrorScope = () => new Promise(() => {});
  await assert.rejects(
    withGraphGPUDeadline(stuck.device, "TC_TEST", async () => 1, 5),
    /TC_TEST_TIMEOUT/,
  );
});

test("compute device loss during pipeline creation cannot allocate buffers afterward", async () => {
  const { device, mock, lost, state, pipeline } = deviceFixture(),
    late = deferred<typeof pipeline>();
  mock.createComputePipelineAsync = () => late.promise;
  const work = runComputeGraph(device, graph, 1, 1, 0);
  await turn();
  lost.resolve({ reason: "destroyed", message: "test" } as GPUDeviceLostInfo);
  await assert.rejects(work, /TC_COMPUTE_DEVICE_LOST/);
  late.resolve(pipeline);
  await turn();
  assert.equal(state.buffers.length, 0);
  assert.equal(state.pops, 1);
});

test("compute buffers are destroyed on success and timeout without late mapped reads", async (t) => {
  const globals = ["GPUBufferUsage", "GPUMapMode"] as const;
  const previous = globals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  Object.assign(globalThis, {
    GPUBufferUsage: {
      STORAGE: 1,
      COPY_SRC: 2,
      UNIFORM: 4,
      COPY_DST: 8,
      MAP_READ: 16,
    },
    GPUMapMode: { READ: 1 },
  });
  t.after(() =>
    globals.forEach((key, i) => {
      const value = previous[i];
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  const success = deviceFixture();
  assert.deepEqual(
    (await runComputeGraph(success.device, graph, 1, 1, 0)).values,
    [2, 0, 0, 1],
  );
  assert.equal(success.state.buffers.length, 3);
  assert.ok(success.state.buffers.every((buffer) => buffer.destroyed));
  assert.equal(success.state.pops, 1);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deviceFixture(),
    mapped = deferred<void>();
  const create = pending.mock.createBuffer;
  pending.mock.createBuffer = () => {
    const buffer = create();
    buffer.mapAsync = () => mapped.promise;
    return buffer;
  };
  const work = runComputeGraph(pending.device, graph, 1, 1, 0);
  await turn();
  assert.equal(pending.state.buffers.length, 3);
  t.mock.timers.tick(10001);
  await assert.rejects(work, /TC_COMPUTE_TIMEOUT/);
  assert.ok(pending.state.buffers.every((buffer) => buffer.destroyed));
  mapped.resolve();
  await turn();
  assert.equal(pending.state.reads, 0);
  assert.equal(pending.state.pops, 1);
});

test("compute rejects texture graphs before evaluation or GPU allocation", async () => {
  const sampled = compileGraphDeclaration(
    {
      nodes: [
        { id: "uv", op: "vec2", value: [0, 0] },
        { id: "s", op: "sampleTexture", texture: "tex", inputs: ["uv"] },
      ],
      output: "s",
    },
    "vec4",
  ).graph;
  const { device, state } = deviceFixture();
  await assert.rejects(
    runComputeGraph(device, sampled, 1, 1, 0),
    /TC_COMPUTE_TEXTURE/,
  );
  assert.equal(state.pushes, 0);
});

test("surface graph pipeline replacement is atomic and rejects stale generations", async () => {
  const { device, mock, state, pipeline } = deviceFixture(),
    late = deferred<typeof pipeline>();
  mock.createComputePipelineAsync = () => late.promise;
  const previous = { old: true };
  const owner = {
    device,
    contentGeneration: 1,
    captureFaults: false,
    compute: previous,
    raster: previous,
    surfaceShader: "old",
    active: () => {},
  };
  const create = (
    SurfaceTracer.prototype as unknown as {
      createSurfacePipelines: (source: string) => Promise<void>;
    }
  ).createSurfacePipelines;
  const pending = create.call(owner, "new source");
  await turn();
  owner.contentGeneration++;
  late.resolve(pipeline);
  await assert.rejects(pending, /TC_TRACE_CAPTURE_STALE/);
  assert.equal(owner.compute, previous);
  assert.equal(owner.raster, previous);
  assert.equal(owner.surfaceShader, "old");
  assert.equal(state.pops, 1);
});

test("surface graph pipeline shader failures preserve the installed pipelines and close scope", async () => {
  const { device, mock, state } = deviceFixture();
  mock.createShaderModule = () =>
    ({
      getCompilationInfo: async () => ({
        messages: [{ type: "error", message: "bad shader" }],
      }),
    }) as never;
  const owner = {
    device,
    contentGeneration: 1,
    captureFaults: false,
    compute: "old",
    surfaceShader: "old",
    active: () => {},
  };
  const create = (
    SurfaceTracer.prototype as unknown as {
      createSurfacePipelines: (source: string) => Promise<void>;
    }
  ).createSurfacePipelines;
  await assert.rejects(create.call(owner, "bad source"), /TC_TRACE_SHADER/);
  assert.equal(owner.compute, "old");
  assert.equal(owner.surfaceShader, "old");
  assert.equal(state.pops, 1);
});
