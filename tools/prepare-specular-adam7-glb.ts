import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsIOR, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "../packages/assets/src/texture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const chunk = (name: string, data: Buffer) => {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(name, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
};
const width = 64, height = 4, passes = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
const rows: number[] = [];
for (const [x0,y0,dx,dy] of passes) {
  const count = Math.max(0, Math.ceil((width - x0) / dx));
  if (!count) continue;
  for (let y = y0; y < height; y += dy) {
    const row = new Uint8Array(Math.ceil(count / 4));
    for (let x = 0; x < count; x++) {
      const band = Math.floor((x0 + x * dx) / 16), index = band === 0 ? 0 : band === 3 ? 2 : 1;
      row[Math.floor(x / 4)] |= index << (6 - (x % 4) * 2);
    }
    rows.push(0, ...row);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 2; header[9] = 3; header[12] = 1;
const image = Buffer.concat([
  Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
  chunk("PLTE", Buffer.from([128,128,128, 255,0,0, 0,255,0])),
  chunk("tRNS", Buffer.from([0,0,0])), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0)),
]);
const io = new NodeIO().registerExtensions([KHRMaterialsIOR, KHRMaterialsSpecular]);
const document = await io.readBinary(await readFile(path.join(root, "examples/specular-textures/assets/specular-textures.glb")));
const texture = document.getRoot().listTextures().find(item => item.getName() === "color-srgb");
if (!texture) throw new Error("Missing fixture color texture");
texture.setImage(image);
const output = path.join(root, "examples/specular-textures-adam7/assets/specular-textures.glb");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, await io.writeBinary(document));
console.log(output);
