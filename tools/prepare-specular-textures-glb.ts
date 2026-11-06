import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsIOR, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let value = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, crc]);
}

function png(bands: number[][]): Buffer {
  const width = 64, height = 4, header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    rows.set(bands[Math.floor(x / 16)], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export async function prepareSpecularTexturesGLB() {
  const doc = new Document();
  doc.getRoot().setExtras({ source: "Original procedural geometry and pixels, tools/prepare-specular-textures-glb.ts", license: "MIT" });
  const buffer = doc.createBuffer();
  const accessor = (name: string, type: Parameters<Accessor["setType"]>[0], array: Parameters<Accessor["setArray"]>[0]) => doc.createAccessor(name, buffer).setType(type).setArray(array);
  const positions = accessor("positions", Accessor.Type.VEC3, new Float32Array([-2,-0.9,0, 2,-0.9,0, 2,0.9,0, -2,0.9,0]));
  const normals = accessor("normals", Accessor.Type.VEC3, new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]));
  const uv = accessor("uv", Accessor.Type.VEC2, new Float32Array([0,0, 1,0, 1,1, 0,1]));
  const indices = accessor("indices", Accessor.Type.SCALAR, new Uint16Array([0,1,2, 0,2,3]));
  // Strength uses alpha only; color uses sRGB RGB only. Unused channels disagree.
  const strength = doc.createTexture("strength-alpha").setMimeType("image/png").setImage(png([[0,0,0,255],[0,0,0,0],[0,0,0,255],[0,0,0,255]]));
  const color = doc.createTexture("color-srgb").setMimeType("image/png").setImage(png([[128,128,128,0],[255,0,0,0],[255,0,0,0],[0,255,0,0]]));
  const spec = doc.createExtension(KHRMaterialsSpecular).setRequired(true);
  const ior = doc.createExtension(KHRMaterialsIOR).setRequired(true);
  const material = doc.createMaterial("textured dielectric").setBaseColorFactor([0,0,0,1]).setMetallicFactor(0).setRoughnessFactor(0.35)
    .setExtension("KHR_materials_specular", spec.createSpecular().setSpecularFactor(1).setSpecularColorFactor([1,1,1]).setSpecularTexture(strength).setSpecularColorTexture(color))
    .setExtension("KHR_materials_ior", ior.createIOR().setIOR(2));
  const primitive = doc.createPrimitive().setAttribute("POSITION", positions).setAttribute("NORMAL", normals).setAttribute("TEXCOORD_0", uv).setIndices(indices).setMaterial(material);
  doc.createScene("scene").addChild(doc.createNode("plane").setMesh(doc.createMesh("plane").addPrimitive(primitive)));
  const destination = fileURLToPath(new URL("../examples/specular-textures/assets/specular-textures.glb", import.meta.url));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(await new NodeIO().registerExtensions([KHRMaterialsIOR, KHRMaterialsSpecular]).writeBinary(doc)));
  return destination;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareSpecularTexturesGLB().then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
