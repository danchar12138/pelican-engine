import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import type { GraphIR } from "../packages/compiler/src/types.ts";
import type { GraphType, GraphValue } from "../packages/sdk/src/index.ts";
import type { ComputeExecutionInput } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeResidentSource } from "../packages/renderer/src/compute-view-contract.ts";
import {
  compileSurfaceGraphs,
  type MaterialGraphBinding,
} from "../packages/renderer/src/material-graphs.ts";
import { SurfaceTracer } from "../packages/renderer/src/surface-tracer.ts";
import type { SurfaceScene } from "../packages/renderer/src/surface.ts";

function descriptor(
  type: GraphType = "float",
  count = 9,
  key = "source",
  revision = 1,
): ComputeExecutionInput {
  // A renderer may inspect count, but reading a CPU result element is a contract violation.
  const values = new Proxy(Array<GraphValue>(count), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property))
        throw Error("Renderer read a CPU compute result");
      return Reflect.get(target, property, receiver);
    },
  });
  return { key, type, revision, values };
}
function bufferGraph(type: GraphType = "float", name = "data"): GraphIR {
  const nodes: GraphIR["nodes"][number][] = [
    { id: "uv", op: "input", name: "uv" },
    { id: "u", op: "swizzle", components: "x", inputs: ["uv"] },
    { id: "scale", op: "float", value: 9 },
    { id: "index", op: "multiply", inputs: ["u", "scale"] },
    { id: "read", op: "readBuffer", buffer: name, inputs: ["index"] },
  ];
  const nodeTypes: GraphIR["nodeTypes"] = {
    uv: "vec2",
    u: "float",
    scale: "float",
    index: "float",
    read: type,
  };
  let output = "read";
  if (type.startsWith("vec")) {
    nodes.push({
      id: "result",
      op: "swizzle",
      components: "x",
      inputs: ["read"],
    });
    nodeTypes.result = "float";
    output = "result";
  } else if (type === "bool") {
    nodes.push(
      { id: "one", op: "float", value: 1 },
      { id: "zero", op: "float", value: 0 },
      { id: "result", op: "select", inputs: ["one", "zero", "read"] },
    );
    Object.assign(nodeTypes, { one: "float", zero: "float", result: "float" });
    output = "result";
  }
  return {
    nodes,
    nodeTypes,
    output,
    outputType: "float",
    bufferTypes: { [name]: type },
  };
}
function binding(
  input = descriptor(),
  graph = bufferGraph(input.type),
): MaterialGraphBinding {
  return {
    id: "test",
    graphs: { roughness: graph },
    buffers: { data: input },
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
function compile(input = descriptor(), graph = bufferGraph(input.type)) {
  const material = new THREE.MeshStandardMaterial();
  return compileSurfaceGraphs(
    snapshot([material]),
    new Map([[material, binding(input, graph)]]),
  );
}

test("fragment plan appends padded slots after every material's parameter rows and deduplicates coverage reads", () => {
  const materials = [
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  ];
  const a = binding(descriptor("float", 9)),
    b = binding(descriptor("float", 1, "other"));
  a.graphs.opacity = a.graphs.roughness;
  b.graphs.roughness = {
    ...b.graphs.roughness!,
    parameters: [{ name: "gain", type: "float", default: 0.5 }],
  };
  const program = compileSurfaceGraphs(
    snapshot(materials),
    new Map([
      [materials[0], a],
      [materials[1], b],
    ]),
  );
  assert.equal(program.bufferCopies.length, 2);
  assert.deepEqual(
    program.bufferCopies.map((copy) => [copy.byteOffset, copy.count]),
    [
      [5 * 128, 9],
      [7 * 128, 1],
    ],
  );
  assert.equal(program.rows.length, (3 + 2 + 1) * 32);
  assert.equal(program.rows[2 * 32], 0.5);
  assert.ok(program.rows.subarray(3 * 32).every((value) => value === 0));
  assert.equal(
    (program.source.match(/fn tcMaterialBuffer0_0\(/g) ?? []).length,
    1,
  );
  assert.match(program.source, /surfaceGraphOpacity/);
  assert.match(program.source, /surfaceMaterials\[5u\+element\/8u\]/);
  assert.match(program.source, /surfaceMaterials\[7u\+element\/8u\]/);
});

test("fragment WGSL guards dynamic indexes before integer conversion, selects all eight fields, and returns typed zero", () => {
  for (const type of ["float", "bool", "vec2", "vec3", "vec4"] as const) {
    const program = compile(descriptor(type));
    const resultType =
      type === "float" ? "f32" : type === "bool" ? "bool" : type + "f";
    const zero = type === "bool" ? "false" : resultType + "(0)";
    assert.ok(
      program.source.includes(
        `fn tcMaterialBuffer0_0(index:f32)->${resultType}`,
      ),
    );
    assert.ok(
      program.source.includes(
        `if ((bitcast<u32>(index)&0x7f800000u)==0x7f800000u){return ${zero};}`,
      ),
    );
    const guard =
      "if (!(index>=0.0 && index<4294967296.0 && floor(index)==index))";
    assert.ok(program.source.includes(guard + `{return ${zero};}`));
    assert.ok(
      program.source.indexOf(guard) <
        program.source.indexOf("let element=u32(index)"),
    );
    assert.ok(program.source.includes(`if(element>=9u){return ${zero};}`));
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
      assert.ok(program.source.includes(`value=row.${field};`));
    const value =
      type === "bool"
        ? "(value.x != 0.0)"
        : type === "float"
          ? "value.x"
          : "value." + "xyzw".slice(0, Number(type.slice(3)));
    assert.ok(program.source.includes(`return ${value};`));
    assert.doesNotMatch(program.source, /@binding|var<storage>/);
  }
});

test("program stays stable for buffer identity, revision and values but rebuilds for count and type", () => {
  const material = new THREE.MeshStandardMaterial(),
    scene = snapshot([material]);
  const program = (input: ComputeExecutionInput) =>
    compileSurfaceGraphs(scene, new Map([[material, binding(input)]]));
  const original = program(descriptor());
  const changed = program(descriptor("float", 9, "rebound", 7));
  assert.equal(original.source, changed.source);
  assert.deepEqual(original.rows, changed.rows);
  assert.notEqual(original.source, program(descriptor("float", 10)).source);
  assert.notEqual(original.source, program(descriptor("vec3", 9)).source);
  assert.notEqual(
    original.rows.length,
    program(descriptor("float", 17)).rows.length,
  );
});

test("only reachable fragment reads reserve slots; vertex bindings and unused buffer declarations reserve none", () => {
  const material = new THREE.MeshStandardMaterial();
  const graph = bufferGraph();
  graph.nodes = [...graph.nodes, { id: "unused", op: "float", value: 0.2 }];
  graph.nodeTypes.unused = "float";
  graph.output = "unused";
  const unused = binding(descriptor(), graph);
  unused.vertex = { position: bufferGraph() } as MaterialGraphBinding["vertex"];
  const program = compileSurfaceGraphs(
    snapshot([material]),
    new Map([[material, unused]]),
  );
  assert.equal(program.bufferCopies.length, 0);
  assert.equal(program.rows.length, 32);
  assert.doesNotMatch(program.source, /tcMaterialBuffer/);
});

test("plan rejects unbound, mismatched, empty and oversized slots deterministically", () => {
  const material = new THREE.MeshStandardMaterial(),
    scene = snapshot([material]);
  const run = (value: MaterialGraphBinding, limit?: number) =>
    compileSurfaceGraphs(scene, new Map([[material, value]]), limit);
  assert.throws(
    () => run({ ...binding(), buffers: {} }),
    /TC_RENDER_BUFFER_UNBOUND/,
  );
  assert.throws(
    () => run(binding(descriptor("vec3"), bufferGraph("float"))),
    /TC_RENDER_BUFFER_TYPE/,
  );
  assert.throws(
    () => run(binding(descriptor("float", 0))),
    /TC_RENDER_BUFFER_COUNT/,
  );
  assert.throws(() => run(binding(), 3 * 128), /TC_RENDER_BUFFER_LIMIT/);
});

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
  ) =>
    tracer.update(
      scene,
      new Set(),
      false,
      new Map([[material, binding(input)]]),
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

test("native update copies resident bytes after CPU placeholders and reuses unchanged slots without CPU result uploads", async (t) => {
  const f = fixture(t);
  const first = await f.update();
  assert.deepEqual(first.materialGraphs.bufferSlots, {
    slots: 1,
    gpuCopies: 1,
    gpuCopyBytes: 144,
    cpuResultUploads: 0,
    bindings: [
      {
        material: "test",
        name: "data",
        type: "float",
        count: 9,
        key: "source",
        revision: 1,
        byteOffset: 256,
      },
    ],
  });
  assert.equal(first.materialGraphs.parameterRows, 1);
  const copy = f.copies[0];
  assert.equal(copy.offset, 256);
  assert.equal(copy.bytes, 9 * 16);
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
  assert.equal(f.residentCalls(), 2);
});

test("key/revision and resident identity changes reset both histories despite identical placeholder tables", async (t) => {
  const f = fixture(t);
  await f.update();
  const writes = f.writes.length;
  for (const input of [
    descriptor("float", 9, "source", 2),
    descriptor("float", 9, "rebound", 2),
  ]) {
    f.settleHistory();
    await f.update(input);
    assert.equal(Reflect.get(f.tracer, "reset"), true);
    assert.equal(Reflect.get(f.tracer, "temporalHistoryReset"), true);
    assert.ok(
      (Reflect.get(f.tracer, "temporalResetReasons") as Set<string>).has(
        "fragment-buffers",
      ),
    );
  }
  f.residents.delete("rebound:2");
  f.settleHistory();
  await f.update(descriptor("float", 9, "rebound", 2));
  assert.equal(Reflect.get(f.tracer, "reset"), true);
  assert.equal(f.copies.length, 4);
  assert.equal(f.writes.length, writes);
  assert.equal(f.programs.length, 1);
});

test("material CPU uploads and destination reallocations force resident recopy; count/type changes rebuild the program", async (t) => {
  const f = fixture(t);
  await f.update();
  f.material.color.setRGB(0.2, 0.3, 0.4);
  await f.update();
  assert.equal(f.copies.length, 2);
  assert.equal(f.programs.length, 1);
  assert.ok(
    f.writes
      .filter((write) => write.buffer.label === "pelican materials")
      .every((write) => write.data.subarray(256).every((value) => value === 0)),
  );
  const previous = f.copies[0].target;
  // Exercise the destination allocation path independently of slot content changes.
  const ensure = Reflect.get(f.tracer, "ensure") as (
    key: string,
    size: number,
  ) => GPUBuffer;
  ensure.call(f.tracer, "materials", previous.size + 256);
  await f.update();
  assert.equal(f.copies.length, 3);
  assert.notEqual(f.copies[2].target, previous);
  assert.equal(previous.destroyed, 1);
  await f.update(descriptor("float", 17, "larger"));
  assert.equal(f.copies.at(-1)!.bytes, 17 * 16);
  assert.equal(f.programs.length, 2);
  await f.update(descriptor("vec3", 17, "vector"));
  assert.equal(f.programs.length, 3);
  assert.equal(
    f.tracer.inspect().materialGraphs.bufferSlots.cpuResultUploads,
    0,
  );
});

test("source is optional without slots and required with slots; invalid later views fail before any upload or copy", async (t) => {
  const f = fixture(t);
  await f.tracer.update(new THREE.Scene());
  const writes = f.writes.length;
  // The material must be present in the captured scene for its slot to be required.
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), f.material));
  t.after(() => (scene.children[0] as THREE.Mesh).geometry.dispose());
  await assert.rejects(
    f.tracer.update(
      scene,
      new Set(),
      false,
      new Map([[f.material, binding()]]),
    ),
    /TC_RENDER_BUFFER_CAPABILITY/,
  );
  const a = binding();
  a.graphs.opacity = bufferGraph("float", "other");
  a.buffers = { ...a.buffers, other: descriptor("float", 9, "other") };
  const invalid: ComputeResidentSource = {
    resident(input) {
      const view = f.source.resident(input);
      return input.key === "other" ? { ...view, count: 8 } : view;
    },
  };
  await assert.rejects(
    f.tracer.update(
      scene,
      new Set(),
      false,
      new Map([[f.material, a]]),
      invalid,
    ),
    /TC_RENDER_BUFFER_RESOURCE/,
  );
  assert.equal(f.copies.length, 0);
  assert.equal(f.writes.length, writes);
  f.device.limits.maxBufferSize = 256;
  await assert.rejects(f.update(), /TC_RENDER_BUFFER_LIMIT/);
  assert.equal(f.copies.length, 0);
});

test("slot removal, clearContent and disposal drop tracking without destroying borrowed compute buffers", async (t) => {
  const f = fixture(t);
  await f.update();
  const source = f.copies[0].source;
  await f.tracer.update(new THREE.Scene());
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.slots, 0);
  await f.update();
  f.tracer.clearContent();
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.slots, 0);
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.gpuCopies, 0);
  await f.update();
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.gpuCopies, 1);
  f.tracer.dispose();
  f.tracer.dispose();
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.slots, 0);
  assert.equal(f.tracer.inspect().materialGraphs.bufferSlots.gpuCopies, 0);
  assert.equal(source.destroyed, 0);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed === 1));
});
