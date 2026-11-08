import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGLB } from "../packages/assets/src/glb.ts";
import { InspectionContext, AssetInspectionError } from "../packages/assets/src/errors.ts";
import { optimizeModel } from "../packages/assets/src/optimize.ts";

function fixture(base = true) {
  const bin = Buffer.alloc(76);
  [0, 0, 0, 9, 9, 9, 8, 8, 8].forEach((v, i) => bin.writeFloatLE(v, Math.floor(i / 3) * 16 + (i % 3) * 4));
  bin[48] = 1; bin[49] = 2;
  [2, 0, 0, 0, 3, 0].forEach((v, i) => bin.writeFloatLE(v, 52 + i * 4));
  const json: any = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 48, byteLength: 2 },
      { buffer: 0, byteOffset: 52, byteLength: 24 },
    ],
    accessors: [{ ...(base ? { bufferView: 0 } : {}), componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [2, 3, 0],
      sparse: { count: 2, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  return { json, bin };
}
function glb(json: unknown, bin: Buffer) {
  const raw = Buffer.from(JSON.stringify(json));
  const text = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20); raw.copy(text);
  const data = Buffer.alloc(12 + 8 + text.length + 8 + bin.length);
  data.write("glTF"); data.writeUInt32LE(2, 4); data.writeUInt32LE(data.length, 8);
  data.writeUInt32LE(text.length, 12); data.writeUInt32LE(0x4e4f534a, 16); text.copy(data, 20);
  data.writeUInt32LE(bin.length, 20 + text.length); data.writeUInt32LE(0x004e4942, 24 + text.length); bin.copy(data, 28 + text.length);
  return data;
}
function parse(f: ReturnType<typeof fixture>) { return parseGLB(glb(f.json, f.bin), new InspectionContext("fixture.glb")); }

test("sparse overlays packed and zero bases before bounds validation", () => {
  for (const base of [true, false]) {
    const a = parse(fixture(base)).accessors[0];
    assert.deepEqual(a.values, [0, 0, 0, 2, 0, 0, 0, 3, 0]);
    assert.deepEqual(a.max, [2, 3, 0]);
  }
});
test("reads supported interleaved sparse vectors and rejects truncated matrix payloads", () => {
  const interleaved = fixture();
  interleaved.json.bufferViews[0].byteStride = 16;
  interleaved.json.bufferViews[0].byteLength = 48;
  assert.equal(parse(interleaved).accessors[0].values.length, 9);
  const matrix = fixture(false);
  matrix.json.accessors[0].type = "MAT4";
  delete matrix.json.accessors[0].min;
  delete matrix.json.accessors[0].max;
  assert.throws(() => parse(matrix), /TC_ASSET_INVALID.*boundary/);
});
test("sparse unsigned index widths and normalized integer values retain raw components", () => {
  for (const [type, width] of [[5121, 1], [5123, 2], [5125, 4]] as const) {
    const f = fixture(false);
    f.json.accessors[0] = { componentType: 5121, normalized: true, count: 3, type: "VEC2", min: [0, 0], max: [255, 128],
      sparse: { count: 2, indices: { bufferView: 1, componentType: type }, values: { bufferView: 2 } } };
    f.json.bufferViews[1].byteLength = 2 * width;
    f.bin.fill(0, 48, 56);
    f.bin.writeUIntLE(1, 48, width); f.bin.writeUIntLE(2, 48 + width, width);
    f.json.bufferViews[2].byteOffset = 56; f.json.bufferViews[2].byteLength = 4;
    f.bin.set([255, 0, 0, 128], 56);
    assert.deepEqual(parse(f).accessors[0].values, [0, 0, 255, 0, 0, 128]);
  }
});
test("rejects malformed sparse metadata and data with asset diagnostics", () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.json.accessors[0].sparse = null; },
    f => { f.json.accessors[0].sparse.count = 4; },
    f => { f.json.accessors[0].sparse.indices.componentType = 5122; },
    f => { f.bin[49] = 1; },
    f => { f.bin[49] = 3; },
    f => { f.json.accessors[0].sparse.values.byteOffset = 1; },
    f => { f.json.bufferViews[2].byteLength = 20; },
    f => { f.json.bufferViews[1].byteStride = 4; },
    f => { f.json.bufferViews[2].target = 34962; },
    f => { f.bin.writeFloatLE(NaN, 52); },
    f => { f.json.accessors[0].max = [9, 9, 9]; },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f);
    assert.throws(() => parse(f), (e: unknown) => e instanceof AssetInspectionError && e.code === "TC_ASSET_INVALID");
  }
});
test("optimizer preserves sparse triangle positions as actual decoded geometry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sparse-glb-"));
  try {
    const input = path.join(dir, "input.glb"), output = path.join(dir, "output.glb");
    const f = fixture(false); await writeFile(input, glb(f.json, f.bin));
    const report = await optimizeModel(input, output);
    assert.equal(report.before.triangleCount, 1);
    assert.deepEqual(report.after.bounds, report.before.bounds);
    const optimized = parseGLB(await readFile(output), new InspectionContext(output));
    const primitive = optimized.json.meshes![0].primitives[0];
    const positions = optimized.accessors[primitive.attributes.POSITION].values;
    const indices = primitive.indices === undefined ? [0, 1, 2] : optimized.accessors[primitive.indices].values;
    assert.deepEqual(indices.flatMap(i => positions.slice(i * 3, i * 3 + 3)), [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
