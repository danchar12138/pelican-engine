import { Accessor, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsIOR, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { decode, encode } from "fast-png";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "../packages/assets/src/texture.ts";

// Regenerate the same authored PNG pixels in 16-bit, including transparent RGB.
const root = fileURLToPath(new URL("../", import.meta.url));
const io = new NodeIO().registerExtensions([KHRMaterialsIOR, KHRMaterialsSpecular]);
const document = await io.readBinary(await readFile(path.join(root, "examples/specular-textures/assets/specular-textures.glb")));
const metadata = process.argv.includes("--metadata");
const chunk = (name: string, data: Buffer) => {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(name, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
};
for (const texture of document.getRoot().listTextures()) {
  const image = decode(texture.getImage()!);
  if (image.depth !== 8 || image.channels !== 4) throw new Error("Expected original 8-bit RGBA fixture");
  const data = new Uint16Array(Array.from(image.data, value => value * 257));
  const png = encode({ width: image.width, height: image.height, channels: 4, depth: 16, data });
  const chroma = Buffer.alloc(32);
  [31270,32900,64000,33000,30000,60000,15000,6000].forEach((value, i) => chroma.writeUInt32BE(value, i * 4));
  texture.setImage(metadata ? Buffer.concat([png.subarray(0, 33), chunk("gAMA", Buffer.from([0, 0, 177, 143])), chunk("cHRM", chroma), chunk("sRGB", Buffer.from([0])), png.subarray(33)]) : png);
}
if (!document.getRoot().listAccessors().some(accessor => accessor.getType() === Accessor.Type.VEC2)) throw new Error("Fixture requires UVs");
const destination = path.join(root, metadata ? "examples/specular-textures-16-metadata/assets/specular-textures.glb" : "examples/specular-textures-16/assets/specular-textures.glb");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, await io.writeBinary(document));
console.log(destination);
