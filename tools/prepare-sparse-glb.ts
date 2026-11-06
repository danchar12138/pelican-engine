import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optimizeModel } from "../packages/assets/src/optimize.ts";

export async function prepareSparseAssets(dir: string) {
  const bin = Buffer.alloc(28);
  bin[0] = 1; bin[1] = 2;
  [1, -1, 0, 0, 1, 0].forEach((value, i) => bin.writeFloatLE(value, 4 + 4 * i));
  const json = { asset: { version: "2.0", generator: "Pelican sparse triangle" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }, { buffer: 0, byteOffset: 4, byteLength: 24 }],
    accessors: [{ componentType: 5126, count: 3, type: "VEC3", min: [0, -1, 0], max: [1, 1, 0],
      sparse: { count: 2, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }],
    materials: [{ name: "red", doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0.08, 0.02, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0, translation: [-0.5, 0, 0] }], scenes: [{ nodes: [0] }], scene: 0 };
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(padded);
  const glb = Buffer.alloc(28 + padded.length + bin.length);
  glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(glb, 28 + padded.length);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, "sparse.glb"), output = path.join(dir, "optimized.glb");
  await writeFile(input, glb, { flag: "wx" });
  await optimizeModel(input, output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSparseAssets(fileURLToPath(new URL("../examples/sparse-glb/assets", import.meta.url))).catch(error => { console.error(error); process.exitCode = 1; });
}
