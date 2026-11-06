import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import type { GraphIR } from "../packages/compiler/src/types.ts";
import type {
  ComputeTextureBinding,
  GraphValue,
  Vec2,
} from "../packages/sdk/src/index.ts";
import type { ComputeExecutionInput } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeResidentSource } from "../packages/renderer/src/compute-view-contract.ts";
import {
  compileSurfaceGraphs,
  type MaterialGraphBinding,
} from "../packages/renderer/src/material-graphs.ts";
import { SurfaceTracer } from "../packages/renderer/src/surface-tracer.ts";
import type { SurfaceScene } from "../packages/renderer/src/surface.ts";
import {
  createVertexDeformer,
  evaluateVertexGraphs,
} from "../packages/renderer/src/vertex-graphs.ts";
import { createVertexBoundsOwner } from "../packages/renderer/src/vertex-bounds.ts";
import { sampleManagedTexture } from "../packages/renderer/src/managed-texture-sampling.ts";

function descriptor(
  width = 3,
  height = 3,
  key = "texture",
  revision = 1,
): ComputeExecutionInput {
  // Length is public metadata. Native rendering must never inspect any CPU texel.
  const values = new Proxy(Array<GraphValue>(width * height), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property))
        throw Error("Native renderer read a CPU texel");
      return Reflect.get(target, property, receiver);
    },
  });
  return { key, revision, type: "vec4", texture: { width, height }, values };
}
function textureGraph(
  sampler: ComputeTextureBinding = { name: "data" },
  vertex = false,
): GraphIR {
  const nodes: GraphIR["nodes"] = [
    { id: "uv", op: "input", name: "uv" },
    {
      id: "sample",
      op: "sampleTexture",
      texture: sampler.name,
      inputs: ["uv"],
    },
    {
      id: "value",
      op: "swizzle",
      components: vertex ? "xyz" : "x",
      inputs: ["sample"],
    },
  ];
  const nodeTypes: GraphIR["nodeTypes"] = {
    uv: "vec2",
    sample: "vec4",
    value: vertex ? "vec3" : "float",
  };
  if (vertex) {
    (nodes as import("../packages/sdk/src/index.ts").GraphNode[]).push(
      { id: "p", op: "input", name: "positionLocal" },
      { id: "out", op: "add", inputs: ["p", "value"] },
    );
    Object.assign(nodeTypes, { p: "vec3", out: "vec3" });
  }
  return {
    nodes,
    nodeTypes,
    output: vertex ? "out" : "value",
    outputType: vertex ? "vec3" : "float",
    requiredInputs: vertex ? ["uv", "positionLocal"] : ["uv"],
    textureSlots: { [sampler.name]: sampler },
  };
}
function binding(
  input = descriptor(),
  graph = textureGraph(),
): MaterialGraphBinding {
  return {
    id: "test",
    graphs: { roughness: graph },
    managedTextures: { data: input },
    time: 0,
    parameters: {},
    textures: new Map(),
  };
}
function snapshot(materials: THREE.Material[]): SurfaceScene {
  return {
    materials: materials.map((material) => ({ uuid: material.uuid })),
    textures: [],
  } as unknown as SurfaceScene;
}
function compile(
  input = descriptor(),
  graph = textureGraph(),
  limit = Number.MAX_SAFE_INTEGER,
) {
  const material = new THREE.MeshStandardMaterial();
  try {
    return compileSurfaceGraphs(
      snapshot([material]),
      new Map([[material, binding(input, graph)]]),
      limit,
    );
  } finally {
    material.dispose();
  }
}

class BufferFixture {
  readonly data: Uint8Array;
  readonly mapState = "unmapped";
  destroyed = 0;
  constructor(
    readonly size: number,
    readonly usage: number,
    readonly label = "",
  ) {
    this.data = new Uint8Array(size);
  }
  destroy() {
    this.destroyed++;
  }
}
type Copy = {
  source: BufferFixture;
  target: BufferFixture;
  offset: number;
  bytes: number;
};
function fixture(t: TestContext) {
  const globals = {
    GPUBufferUsage: { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64 },
    GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 },
    navigator: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, key, previous)
        : Reflect.deleteProperty(globalThis, key),
    );
  }
  const writes: { buffer: BufferFixture; data: Uint8Array }[] = [],
    copies: Copy[] = [],
    programs: string[] = [];
  const events: string[] = [],
    buffers: BufferFixture[] = [];
  const device = {
    limits: {
      maxTextureDimension2D: 4096,
      maxStorageBufferBindingSize: 1 << 20,
      maxBufferSize: 1 << 20,
    },
    features: new Set(),
    lost: new Promise(() => {}),
    createBuffer({ size, usage, label }: GPUBufferDescriptor) {
      const value = new BufferFixture(size, usage, label);
      buffers.push(value);
      return value;
    },
    createTexture: () => ({ destroy() {} }),
    queue: {
      writeBuffer(
        buffer: BufferFixture,
        offset: number,
        data: ArrayBufferView,
      ) {
        const values = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ).slice();
        writes.push({ buffer, data: values });
        buffer.data.set(values, offset);
        events.push("write:" + buffer.label);
      },
      submit(commands: Copy[][]) {
        for (const command of commands)
          for (const copy of command) {
            assert.equal(copy.source.destroyed, 0);
            assert.equal(copy.target.destroyed, 0);
            copy.target.data.set(
              copy.source.data.subarray(0, copy.bytes),
              copy.offset,
            );
            copies.push(copy);
            events.push("copy");
          }
      },
    },
    createCommandEncoder() {
      const pending: Copy[] = [];
      return {
        copyBufferToBuffer(
          source: BufferFixture,
          sourceOffset: number,
          target: BufferFixture,
          offset: number,
          bytes: number,
        ) {
          assert.equal(sourceOffset, 0);
          pending.push({ source, target, offset, bytes });
        },
        finish: () => pending,
      };
    },
  };
  const canvas = { getContext: () => ({ configure() {}, unconfigure() {} }) };
  // Invoke the private constructor without initializing real shader pipelines or a GPU.
  const tracer = Reflect.construct(SurfaceTracer, [
    device,
    canvas,
    2,
    2,
  ]) as SurfaceTracer;
  Reflect.set(tracer, "createSurfacePipelines", async (code: string) => {
    programs.push(code);
    Reflect.set(tracer, "surfaceShader", code);
  });
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial();
  const geometry = new THREE.PlaneGeometry();
  scene.add(new THREE.Mesh(geometry, material));
  const residents = new Map<string, BufferFixture>();
  let residentCalls = 0;
  const source: ComputeResidentSource = {
    resident(input) {
      residentCalls++;
      const key = input.key + ":" + input.revision;
      let buffer = residents.get(key);
      if (!buffer) {
        buffer = new BufferFixture(
          input.values.length * 16,
          GPUBufferUsage.COPY_SRC,
          "compute source",
        );
        new Float32Array(buffer.data.buffer).fill(0.625);
        residents.set(key, buffer);
      }
      return {
        buffer: buffer as unknown as GPUBuffer,
        type: input.type,
        count: input.values.length,
        revision: input.revision,
      };
    },
  };
  const update = (
    input = descriptor(),
    sourceOverride: ComputeResidentSource | undefined = source,
    graphBinding = binding(input),
  ) =>
    tracer.update(
      scene,
      new Set(),
      false,
      new Map([[material, graphBinding]]),
      sourceOverride,
    );
  const settleHistory = () => {
    Reflect.set(tracer, "reset", false);
    Reflect.set(tracer, "temporalHistoryReset", false);
    (Reflect.get(tracer, "temporalResetReasons") as Set<string>).clear();
  };
  t.after(() => {
    tracer.dispose();
    geometry.dispose();
    material.dispose();
  });
  return {
    tracer,
    device,
    material,
    scene,
    geometry,
    source,
    update,
    writes,
    copies,
    programs,
    events,
    buffers,
    residents,
    settleHistory,
    residentCalls: () => residentCalls,
  };
}

test("texture plans deduplicate channels/coverage, pad rows after all parameters, and allow buffer/texture name overlap", () => {
  const materials = [
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  ];
  try {
    const a = binding(),
      b = binding(descriptor(1, 1, "other"));
    const graph = textureGraph();
    (graph.nodes as import("../packages/sdk/src/index.ts").GraphNode[]).push(
      { id: "index", op: "float", value: 0 },
      { id: "buffer", op: "readBuffer", buffer: "data", inputs: ["index"] },
      { id: "sum", op: "add", inputs: ["value", "buffer"] },
    );
    Object.assign(graph.nodeTypes, {
      index: "float",
      buffer: "float",
      sum: "float",
    });
    graph.output = "sum";
    graph.bufferTypes = { data: "float" };
    a.graphs = { roughness: graph, opacity: graph };
    a.buffers = {
      data: { key: "buffer", revision: 1, type: "float", values: Array(9) },
    };
    b.graphs.roughness!.parameters = [
      { name: "gain", type: "float", default: 0.25 },
    ];
    const program = compileSurfaceGraphs(
      snapshot(materials),
      new Map([
        [materials[0], a],
        [materials[1], b],
      ]),
    );
    assert.deepEqual(
      program.bufferCopies.map((copy) => [
        copy.byteOffset,
        copy.count,
        !!copy.texture,
      ]),
      [
        [5 * 128, 9, true],
        [7 * 128, 9, false],
        [9 * 128, 1, true],
      ],
    );
    assert.equal(program.rows.length, (3 + 2 + 2 + 1) * 32);
    assert.equal(program.rows[2 * 32], 0.25);
    assert.ok(program.rows.subarray(3 * 32).every((value) => value === 0));
    assert.equal(
      (program.source.match(/fn tcMaterialTexture0_0\(uv/g) ?? []).length,
      1,
    );
    assert.match(program.source, /surfaceGraphOpacity/);
    assert.match(program.source, /surfaceMaterials\[5u\+element\/8u\]/);
    assert.match(program.source, /tcMaterialBuffer0_0/);
  } finally {
    materials.forEach((material) => material.dispose());
  }
});

test("texture WGSL loads row-major vec4 fields with finite UV guard, default bilinear and clamp", () => {
  const { source, bufferCopies } = compile();
  assert.equal(bufferCopies[0].descriptor.texture?.width, 3);
  for (const field of [
    "base",
    "factors",
    "emission",
    "maps0",
    "maps1",
    "normal",
    "physical",
    "attenuation",
  ])
    assert.ok(source.includes("return row." + field));
  assert.match(source, /let element=u32\(y\)\*3u\+u32\(x\)/);
  assert.match(source, /bitcast<vec2u>\(uv\).*0x7f800000u.*return vec4f\(0\)/);
  assert.ok(
    source.indexOf("bitcast<vec2u>(uv)") < source.indexOf("let coord="),
  );
  assert.match(source, /clamp\(cell.x,0,2\)/);
  assert.match(source, /clamp\(cell.y,0,2\)/);
  assert.match(source, /pixel=coord-vec2f\(0.5\)/);
  assert.match(source, /base\+vec2i\(1,1\)/);
  assert.match(source, /top\*\(1.0-weight.y\)\+bottom\*weight.y/);
  assert.doesNotMatch(source, /@binding|textureSample|textureLoad|var<storage/);
});

test("nearest/repeat/mirror compile explicit coordinate normalization and signed edge addressing", () => {
  const { source } = compile(
    descriptor(3, 2),
    textureGraph({
      name: "data",
      filter: "nearest",
      wrapU: "repeat",
      wrapV: "mirror",
    }),
  );
  assert.match(source, /uv.x-floor\(uv.x\)/);
  assert.match(source, /1.0-abs\(\(uv.y-2.0\*floor\(uv.y\*0.5\)\)-1.0\)/);
  assert.match(source, /\(\(cell.x%3\)\+3\)%3/);
  assert.match(source, /\(\(cell.y%4\)\+4\)%4/);
  assert.match(source, /min\(yWrapped,3-yWrapped\)/);
  assert.match(source, /Load\(vec2i\(floor\(coord\)\)\)/);
  assert.doesNotMatch(source, /let pixel=/);
});

test("samplers may share one texture copy while compiling distinct helpers", () => {
  const material = new THREE.MeshStandardMaterial(),
    value = binding();
  value.graphs.opacity = textureGraph({ name: "data", filter: "nearest" });
  try {
    const program = compileSurfaceGraphs(
      snapshot([material]),
      new Map([[material, value]]),
    );
    assert.equal(program.bufferCopies.length, 1);
    assert.match(program.source, /fn tcMaterialTexture0_0\(uv/);
    assert.match(program.source, /fn tcMaterialTexture0_1\(uv/);
  } finally {
    material.dispose();
  }
});

test("source changes with sampler/count/shape but remains stable across key/revision changes", () => {
  const original = compile().source;
  assert.equal(compile(descriptor(3, 3, "rebound", 8)).source, original);
  assert.notEqual(compile(descriptor(1, 9)).source, original);
  assert.notEqual(compile(descriptor(4, 3)).source, original);
  for (const sampler of [
    { name: "data", filter: "nearest" },
    { name: "data", wrapU: "repeat" },
    { name: "data", wrapV: "mirror" },
  ] as ComputeTextureBinding[])
    assert.notEqual(
      compile(descriptor(), textureGraph(sampler)).source,
      original,
    );
});

test("managed texture validation rejects unbound, non-texture, invalid shapes and table limits without reading values", () => {
  const material = new THREE.MeshStandardMaterial(),
    value = binding();
  const run = () =>
    compileSurfaceGraphs(snapshot([material]), new Map([[material, value]]));
  try {
    value.managedTextures = {};
    assert.throws(run, /TC_RENDER_TEXTURE_UNBOUND/);
    for (const bad of [
      { ...descriptor(), texture: undefined },
      { ...descriptor(), type: "vec3" as const },
      { ...descriptor(), texture: { width: 0, height: 9 } },
      { ...descriptor(), texture: { width: 3.5, height: 3 } },
      { ...descriptor(), texture: { width: 1, height: 8 } },
    ]) {
      value.managedTextures = { data: bad };
      assert.throws(run, /TC_RENDER_TEXTURE_RESOURCE/);
    }
    assert.throws(
      () => compile(descriptor(), textureGraph(), 3 * 128),
      /TC_RENDER_TEXTURE_LIMIT/,
    );
  } finally {
    material.dispose();
  }
});

test("only graph.textureSlots selects managed descriptors; static texture sampling is preserved", () => {
  const material = new THREE.MeshStandardMaterial(),
    texture = new THREE.Texture(),
    value = binding();
  const scene = snapshot([material]);
  try {
    value.textures = new Map([["data", texture]]);
    (scene as any).textures = [{ uuid: texture.uuid }];
    const managed = compileSurfaceGraphs(scene, new Map([[material, value]]));
    assert.equal(managed.bufferCopies.length, 1);
    value.graphs.roughness = {
      ...textureGraph(),
      textureSlots: undefined,
      textureIds: ["data"],
    };
    const asset = compileSurfaceGraphs(scene, new Map([[material, value]]));
    assert.equal(asset.bufferCopies.length, 0);
    assert.match(asset.source, /surfaceMap\(0.0/);
    assert.doesNotMatch(asset.source, /fn tcMaterialTexture/);
  } finally {
    material.dispose();
    texture.dispose();
  }
});

test("native update copies packed mirrors after zero placeholders, classifies counters, and skips stable copies/uploads", async (t) => {
  const f = fixture(t);
  const first = await f.update();
  assert.deepEqual(first.materialGraphs.bufferSlots, {
    slots: 0,
    gpuCopies: 0,
    gpuCopyBytes: 0,
    cpuResultUploads: 0,
    bindings: [],
  });
  assert.deepEqual(first.materialGraphs.textureSlots, {
    slots: 1,
    gpuCopies: 1,
    gpuCopyBytes: 144,
    cpuResultUploads: 0,
    bindings: [
      {
        material: "test",
        name: "data",
        type: "vec4",
        count: 9,
        key: "texture",
        revision: 1,
        byteOffset: 256,
        width: 3,
        height: 3,
      },
    ],
  });
  assert.equal(first.materialGraphs.parameterRows, 1);
  const copy = f.copies[0];
  assert.equal(copy.offset, 256);
  assert.ok(
    new Float32Array(copy.target.data.buffer, copy.offset, 36).every(
      (value) => value === 0.625,
    ),
  );
  const tableWrites = f.writes.filter((write) => write.buffer === copy.target);
  assert.equal(tableWrites.length, 1);
  assert.ok(
    tableWrites[0].data.subarray(copy.offset).every((value) => value === 0),
  );
  assert.ok(
    f.events.indexOf("write:pelican materials") < f.events.indexOf("copy"),
  );
  const writes = f.writes.length;
  f.settleHistory();
  const second = await f.update();
  assert.equal(f.copies.length, 1);
  assert.equal(f.writes.length, writes);
  assert.equal(second.uploadBytes, 0);
  assert.equal(f.programs.length, 1);
  assert.equal(Reflect.get(f.tracer, "reset"), false);
  assert.equal(Reflect.get(f.tracer, "temporalHistoryReset"), false);
});

test("key/revision/resident identity changes invalidate accumulation and temporal without rebuilding shaders", async (t) => {
  const f = fixture(t);
  await f.update();
  const writes = f.writes.length;
  for (const input of [
    descriptor(3, 3, "texture", 2),
    descriptor(3, 3, "rebound", 2),
  ]) {
    f.settleHistory();
    await f.update(input);
    assert.equal(Reflect.get(f.tracer, "reset"), true);
    assert.equal(Reflect.get(f.tracer, "temporalHistoryReset"), true);
    assert.ok(
      (Reflect.get(f.tracer, "temporalResetReasons") as Set<string>).has(
        "fragment-textures",
      ),
    );
  }
  f.residents.delete("rebound:2");
  f.settleHistory();
  await f.update(descriptor(3, 3, "rebound", 2));
  assert.equal(Reflect.get(f.tracer, "reset"), true);
  assert.equal(f.copies.length, 4);
  assert.equal(f.writes.length, writes);
  assert.equal(f.programs.length, 1);
});

test("sampler and shape/count changes rebuild source, while CPU material writes force resident recopy", async (t) => {
  const f = fixture(t);
  await f.update();
  f.settleHistory();
  await f.update(
    descriptor(),
    f.source,
    binding(descriptor(), textureGraph({ name: "data", filter: "nearest" })),
  );
  assert.equal(f.programs.length, 2);
  assert.equal(f.copies.length, 1);
  assert.equal(Reflect.get(f.tracer, "reset"), true);
  assert.equal(Reflect.get(f.tracer, "temporalHistoryReset"), true);
  f.settleHistory();
  await f.update(descriptor(1, 9));
  assert.equal(f.programs.length, 3);
  assert.equal(f.copies.length, 2);
  assert.equal(Reflect.get(f.tracer, "reset"), true);
  await f.update(descriptor(4, 3, "texture", 2));
  assert.equal(f.programs.length, 4);
  assert.equal(f.copies.length, 3);
  f.material.color.setRGB(0.2, 0.3, 0.4);
  await f.update(descriptor(4, 3, "texture", 2));
  assert.equal(f.copies.length, 4);
  assert.ok(
    f.writes
      .filter((write) => write.buffer.label === "pelican materials")
      .every((write) => write.data.subarray(256).every((value) => value === 0)),
  );
});

test("native texture preflight rejects missing source and mismatched resident before copying", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.tracer.update(
      f.scene,
      new Set(),
      false,
      new Map([[f.material, binding()]]),
    ),
    /TC_RENDER_TEXTURE_CAPABILITY/,
  );
  for (const field of [
    "type",
    "count",
    "revision",
    "usage",
    "size",
    "mapState",
  ] as const) {
    const source: ComputeResidentSource = {
      resident(input) {
        const view = f.source.resident(input);
        if (field === "type") return { ...view, type: "float" };
        if (field === "count") return { ...view, count: 1 };
        if (field === "revision") return { ...view, revision: 99 };
        return {
          ...view,
          buffer: {
            ...view.buffer,
            [field]: field === "mapState" ? "mapped" : 0,
          } as GPUBuffer,
        };
      },
    };
    await assert.rejects(
      f.update(descriptor(), source),
      /TC_RENDER_TEXTURE_RESOURCE/,
    );
    assert.equal(f.copies.length, 0);
  }
  f.device.limits.maxBufferSize = 256;
  await assert.rejects(f.update(), /TC_RENDER_TEXTURE_LIMIT/);
});

test("texture removal, clear and disposal release tracking but never destroy borrowed mirrors", async (t) => {
  const f = fixture(t);
  await f.update();
  const source = f.copies[0].source;
  await f.tracer.update(new THREE.Scene());
  assert.equal(f.tracer.inspect().materialGraphs.textureSlots.slots, 0);
  await f.update();
  f.tracer.clearContent();
  assert.equal(f.tracer.inspect().materialGraphs.textureSlots.gpuCopies, 0);
  await f.update();
  assert.equal(f.tracer.inspect().materialGraphs.textureSlots.gpuCopies, 1);
  f.tracer.dispose();
  f.tracer.dispose();
  assert.equal(f.tracer.inspect().materialGraphs.textureSlots.slots, 0);
  assert.equal(f.tracer.inspect().materialGraphs.textureSlots.gpuCopies, 0);
  assert.equal(source.destroyed, 0);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
});
function cpuDescriptor(
  values: readonly GraphValue[] = [
    [0, 0, 0, 1],
    [2, 0, 0, 1],
    [4, 0, 0, 1],
    [6, 0, 0, 1],
  ],
): ComputeExecutionInput {
  return {
    key: "cpu-texture",
    revision: 1,
    type: "vec4",
    texture: { width: 2, height: 2 },
    values,
  };
}
const vertexInput = {
  positionLocal: [0, 0, 0] as const,
  normalLocal: [0, 0, 1] as const,
  vertexIndex: 0,
  instanceIndex: 0,
  uv: [0.25, 0.25] as Vec2,
};
const unexpectedAsset = (): never => {
  throw Error("Managed texture resolved as a static asset");
};
function vertexBinding(
  input = cpuDescriptor(),
  sampler: ComputeTextureBinding = { name: "data" },
): MaterialGraphBinding {
  return {
    ...binding(input),
    graphs: {},
    vertex: { position: textureGraph(sampler, true) },
  };
}

test("vertex evaluation selects each graph's managed sampler and matches row order, filtering and negative wrapping", () => {
  const cases: [ComputeTextureBinding, Vec2, number][] = [
    [{ name: "data", filter: "nearest" }, [0.75, 0.75], 6],
    [{ name: "data" }, [0.5, 0.5], 3],
    [{ name: "data", filter: "nearest" }, [-1, -1], 0],
    [{ name: "data", filter: "nearest", wrapU: "repeat" }, [-0.25, 0.25], 2],
    [{ name: "data", filter: "nearest", wrapU: "mirror" }, [-0.25, 0.25], 0],
    [{ name: "data", filter: "nearest" }, [1, 1], 6],
    [
      { name: "data", filter: "nearest", wrapU: "repeat", wrapV: "repeat" },
      [1, 1],
      0,
    ],
    [
      { name: "data", filter: "nearest", wrapU: "mirror", wrapV: "mirror" },
      [1, 1],
      6,
    ],
    [{ name: "data", wrapU: "repeat", wrapV: "repeat" }, [0, 0], 3],
    [{ name: "data" }, [0, 0], 0],
  ];
  for (const [sampler, uv, expected] of cases) {
    assert.deepEqual(
      evaluateVertexGraphs(
        vertexBinding(cpuDescriptor(), sampler),
        { ...vertexInput, uv },
        unexpectedAsset,
      ).position,
      [expected, 0, 0],
    );
  }
  const value = vertexBinding();
  const normal = textureGraph({ name: "data", filter: "nearest" }, true);
  normal.nodes = normal.nodes.slice(0, 3);
  normal.output = "value";
  value.vertex!.normal = normal;
  assert.deepEqual(
    evaluateVertexGraphs(
      value,
      { ...vertexInput, uv: [0.5, 0.5] },
      unexpectedAsset,
    ),
    { position: [3, 0, 0], normal: [1, 0, 0] },
  );
});

test("managed CPU sampler returns zero for nonfinite render UV without reading CPU texels", () => {
  for (const uv of [
    [NaN, 0],
    [0, Infinity],
    [-Infinity, 0],
    [Number.MAX_VALUE, 0],
  ] as Vec2[])
    assert.deepEqual(
      sampleManagedTexture(descriptor(), uv, { name: "data" }),
      [0, 0, 0, 0],
    );
});

test("managed vertex path preserves f32 output, normal normalization/fallback and static sampling", () => {
  const input = cpuDescriptor(
    Array.from({ length: 4 }, () => [0.1, 0.2, 0.3, 1]),
  );
  const value = vertexBinding(input);
  const normal = textureGraph({ name: "data" }, true);
  normal.nodes = normal.nodes.slice(0, 3);
  normal.output = "value";
  value.vertex!.normal = normal;
  const output = evaluateVertexGraphs(
    value,
    { ...vertexInput, positionLocal: [0.2, 0.3, 0.4] },
    unexpectedAsset,
  );
  assert.deepEqual(
    output.position,
    [0.2, 0.3, 0.4].map((v, i) =>
      Math.fround(Math.fround(v) + Math.fround([0.1, 0.2, 0.3][i])),
    ),
  );
  assert.ok(Math.abs(Math.hypot(...output.normal!) - 1) < 1e-7);
  value.managedTextures = {
    data: cpuDescriptor(Array.from({ length: 4 }, () => [0, 0, 0, 1])),
  };
  assert.deepEqual(
    evaluateVertexGraphs(value, vertexInput, unexpectedAsset).normal,
    [0, 0, 1],
  );
  value.vertex!.position = {
    ...textureGraph({ name: "data" }, true),
    textureSlots: undefined,
  };
  assert.deepEqual(
    evaluateVertexGraphs(value, vertexInput, () => [5, 0, 0, 1]).position,
    [5, 0, 0],
  );
  value.vertex!.position = textureGraph({ name: "data" }, true);
  value.managedTextures = {};
  assert.throws(
    () => evaluateVertexGraphs(value, vertexInput, unexpectedAsset),
    /TC_RENDER_TEXTURE_UNBOUND/,
  );
  value.managedTextures = { data: { ...cpuDescriptor(), texture: undefined } };
  assert.throws(
    () => evaluateVertexGraphs(value, vertexInput, unexpectedAsset),
    /TC_RENDER_TEXTURE_RESOURCE/,
  );
});

test("vertex signatures track texture key/revision/dimensions/sampler and exclude managed names from asset lookup", () => {
  const material = new THREE.MeshStandardMaterial(),
    geometry = new THREE.PlaneGeometry(),
    mesh = new THREE.Mesh(geometry, material),
    staticTexture = new THREE.Texture();
  const value = vertexBinding();
  // Be tolerant of metadata that also lists a managed name among textureIds.
  value.vertex!.position!.textureIds = ["data", "asset"];
  value.textures = new Map([["asset", staticTexture]]);
  const deformer = createVertexDeformer(
    new Map([[material, value]]),
    unexpectedAsset,
  );
  try {
    const first = deformer.signature(mesh);
    value.managedTextures = { data: cpuDescriptor() };
    assert.deepEqual(deformer.signature(mesh), first);
    for (const resource of [
      { ...cpuDescriptor(), key: "rebound" },
      { ...cpuDescriptor(), revision: 2 },
      { ...cpuDescriptor(), texture: { width: 1, height: 4 } },
    ]) {
      value.managedTextures = { data: resource };
      assert.notDeepEqual(deformer.signature(mesh), first);
    }
    value.managedTextures = { data: cpuDescriptor() };
    for (const sampler of [
      { name: "data", filter: "nearest" },
      { name: "data", wrapU: "repeat" },
      { name: "data", wrapV: "mirror" },
    ] as ComputeTextureBinding[]) {
      value.vertex!.position!.textureSlots = { data: sampler };
      assert.notDeepEqual(deformer.signature(mesh), first);
    }
    value.vertex!.position!.textureSlots = { data: { name: "data" } };
    staticTexture.needsUpdate = true;
    assert.notDeepEqual(deformer.signature(mesh), first);
    value.managedTextures = {};
    assert.throws(() => deformer.signature(mesh), /missing managed texture/);
  } finally {
    geometry.dispose();
    material.dispose();
    staticTexture.dispose();
  }
});

test("managed texture revisions update cached bounds/BVH/raycast and disposal restores mesh hooks", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial(),
    geometry = new THREE.PlaneGeometry(),
    mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const value = vertexBinding(
    cpuDescriptor(Array.from({ length: 4 }, () => [2, 0, 0, 1])),
  );
  const graphs = new Map([[material, value]]),
    owner = createVertexBoundsOwner(),
    originalRaycast = mesh.raycast;
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(2, 0, 3),
    new THREE.Vector3(0, 0, -1),
  );
  try {
    owner.update(scene, graphs);
    assert.equal((mesh as any).boundingSphere.center.x, 2);
    assert.ok(raycaster.intersectObject(mesh).length > 0);
    const first = owner.inspect();
    owner.update(scene, graphs);
    assert.ok(owner.inspect().capture.meshes.hits > first.capture.meshes.hits);
    value.managedTextures = {
      data: {
        ...cpuDescriptor(Array.from({ length: 4 }, () => [-2, 0, 0, 1])),
        revision: 2,
      },
    };
    owner.update(scene, graphs);
    assert.equal((mesh as any).boundingSphere.center.x, -2);
    assert.equal(raycaster.intersectObject(mesh).length, 0);
    raycaster.ray.origin.x = -2;
    assert.ok(raycaster.intersectObject(mesh).length > 0);
    assert.ok(owner.inspect().accelerations[0].refits > 0);
  } finally {
    owner.dispose();
    geometry.dispose();
    material.dispose();
  }
  assert.equal(mesh.raycast, originalRaycast);
  assert.equal(Object.hasOwn(mesh, "boundingSphere"), false);
});
