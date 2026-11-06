import assert from "node:assert/strict";
import type { Page } from "playwright";
import { parseGLB } from "../packages/assets/src/glb.ts";
import { InspectionContext } from "../packages/assets/src/errors.ts";

function pack(json: object, bin: Buffer) {
  const raw = Buffer.from(JSON.stringify(json)), text = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32);
  raw.copy(text);
  const glb = Buffer.alloc(28 + text.length + bin.length);
  glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(text.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); text.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + text.length); glb.writeUInt32LE(0x004e4942, 24 + text.length); bin.copy(glb, 28 + text.length);
  return glb;
}

export async function reproduceSparseLoaderLimits(page: Page) {
  const matrixBin = Buffer.alloc(68); matrixBin[0] = 1;
  const matrixValues = Array.from({ length: 16 }, (_, i) => i + 1);
  matrixValues.forEach((value, i) => matrixBin.writeFloatLE(value, 4 + i * 4));
  const common = { asset: { version: "2.0" }, scenes: [{}], scene: 0 };
  const matrix = pack({ ...common, buffers: [{ byteLength: 68 }],
    bufferViews: [{ buffer: 0, byteLength: 1 }, { buffer: 0, byteOffset: 4, byteLength: 64 }],
    accessors: [{ componentType: 5126, count: 2, type: "MAT4", sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }] }, matrixBin);
  const interleavedBin = Buffer.alloc(64);
  [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((v, i) => interleavedBin.writeFloatLE(v, Math.floor(i / 3) * 16 + i % 3 * 4));
  interleavedBin[48] = 1;
  [11, 12, 13].forEach((v, i) => interleavedBin.writeFloatLE(v, 52 + 4 * i));
  const interleaved = pack({ ...common, buffers: [{ byteLength: 64 }],
    bufferViews: [{ buffer: 0, byteLength: 48, byteStride: 16 }, { buffer: 0, byteOffset: 48, byteLength: 1 }, { buffer: 0, byteOffset: 52, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", sparse: { count: 1, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } } }] }, interleavedBin);
  const expectedInterleaved = [1, 2, 3, 11, 12, 13, 7, 8, 9];
  assert.throws(() => parseGLB(matrix, new InspectionContext("matrix.glb")), /TC_ASSET_UNSUPPORTED.*Sparse matrices/);
  assert.throws(() => parseGLB(interleaved, new InspectionContext("interleaved.glb")), /TC_ASSET_UNSUPPORTED.*interleaved/);
  const result = await page.evaluate(async fixtures => {
    const loaderUrl = "/@id/three/examples/jsm/loaders/GLTFLoader.js";
    const { GLTFLoader } = await import(loaderUrl);
    const load = async (bytes: number[]) => {
      const gltf = await new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, "");
      return gltf.parser.getDependency("accessor", 0);
    };
    let matrixError = "";
    try { await load(fixtures.matrix); } catch (error) { matrixError = String(error); }
    const attribute = await load(fixtures.interleaved);
    const interleavedValues = Array.from({ length: 3 }, (_, i) => [attribute.getX(i), attribute.getY(i), attribute.getZ(i)]).flat();
    return { matrixError, interleavedValues };
  }, { matrix: [...matrix], interleaved: [...interleaved] });
  assert.match(result.matrixError, /Unsupported itemSize in sparse BufferAttribute/);
  assert.notDeepEqual(result.interleavedValues, expectedInterleaved);
  return { matrixError: result.matrixError, interleavedExpected: expectedInterleaved, interleavedActual: result.interleavedValues };
}
