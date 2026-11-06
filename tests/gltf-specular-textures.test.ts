import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { inspectModel } from "../packages/assets/src/model.ts";
import { InspectionContext, AssetInspectionError } from "../packages/assets/src/errors.ts";
import { optimizeModel } from "../packages/assets/src/optimize.ts";
import { parseGLB } from "../packages/assets/src/glb.ts";
import { crc32 } from "../packages/assets/src/texture.ts";
import { decodeEmbeddedPng } from "../packages/renderer/src/embedded-image-pixels.ts";

async function fixture(shared = true) {
  const doc = new Document(), buffer = doc.createBuffer();
  const position = doc.createAccessor("position", buffer).setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor("uv", buffer).setType(Accessor.Type.VEC2)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const png = await readFile(new URL("../examples/vertex/assets/height.png", import.meta.url));
  const texture = doc.createTexture("specular-image").setMimeType("image/png").setImage(png);
  const text = Buffer.from("Comment\0color", "latin1"), chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0); chunk.write("tEXt", 4); text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)), 8 + text.length);
  const colorTexture = shared ? texture : doc.createTexture("color-image").setMimeType("image/png")
    .setImage(Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]));
  const extension = doc.createExtension(KHRMaterialsSpecular).setRequired(true);
  const specular = extension.createSpecular().setSpecularFactor(0.7).setSpecularColorFactor([0.2, 0.4, 0.8])
    .setSpecularTexture(texture).setSpecularColorTexture(colorTexture);
  if (!shared) specular.getSpecularColorTextureInfo()!.setWrapS(33071).setMagFilter(9728);
  const material = doc.createMaterial("surface").setExtension("KHR_materials_specular", specular);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(material));
  const scene = doc.createScene().addChild(doc.createNode().setMesh(mesh));
  doc.getRoot().setDefaultScene(scene);
  return Buffer.from(await new NodeIO().registerExtensions([KHRMaterialsSpecular]).writeBinary(doc));
}

function mutate(bytes: Buffer, change: (json: any) => void) {
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  change(json);
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const result = Buffer.concat([bytes.subarray(0, 12), Buffer.alloc(8), padded, bytes.subarray(20 + length)]);
  result.writeUInt32LE(result.length, 8); result.writeUInt32LE(padded.length, 12); result.writeUInt32LE(0x4e4f534a, 16);
  return result;
}
const inspect = (bytes: Buffer) => inspectModel(bytes, new InspectionContext("fixture.glb"));

for (const name of ["specular-textures-16", "specular-textures-16-metadata"]) test(`${name} retains 16-bit transparent color and strength alpha`, async () => {
  const bytes = await readFile(new URL(`../examples/${name}/assets/specular-textures.glb`, import.meta.url));
  await inspect(bytes);
  const { json, bin } = parseGLB(bytes, new InspectionContext("fixture.glb"));
  const ext = json.materials![0].extensions!.KHR_materials_specular as { specularTexture: { index: number }; specularColorTexture: { index: number } };
  const pixels = (index: number) => {
    const texture = json.textures![index], image = json.images![texture.source!], view = json.bufferViews![image.bufferView!];
    const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    assert.equal(png[24], 16);
    if (name.endsWith("metadata")) for (const type of ["gAMA", "cHRM", "sRGB"]) assert.ok(png.includes(Buffer.from(type)), type);
    return decodeEmbeddedPng(png).data;
  };
  const intensity = pixels(ext.specularTexture.index), color = pixels(ext.specularColorTexture.index);
  assert.deepEqual(Array.from(color.slice(0, 4)), [128, 128, 128, 0]);
  assert.deepEqual(Array.from(color.slice(16 * 4, 17 * 4)), [255, 0, 0, 0]);
  assert.equal(intensity[3], 255);
  assert.equal(intensity[16 * 4 + 3], 0);
});

test("specular texture slots retain distinct alpha and sRGB color bindings", async () => {
  const result = await inspect(await fixture());
  const material = (result.materials as any[])[0];
  assert.equal(material.textures.specular, 0);
  assert.equal(material.textures.specularColor, 0);
  assert.equal(material.specular.specularTexture.index, 0);
  assert.equal(material.specular.specularColorTexture.index, 0);
  assert.equal(material.specular.specularFactor, 0.7);
  assert.deepEqual(material.specular.specularColorFactor, [0.2, 0.4, 0.8]);
});

test("Adam7 specular fixture retains 2-bit indexed transparent colors", async () => {
  const bytes = await readFile(new URL("../examples/specular-textures-adam7/assets/specular-textures.glb", import.meta.url));
  await inspect(bytes);
  const { json, bin } = parseGLB(bytes, new InspectionContext("fixture.glb"));
  const ext = json.materials![0].extensions!.KHR_materials_specular as { specularColorTexture: { index: number } };
  const texture = json.textures![ext.specularColorTexture.index], image = json.images![texture.source!], view = json.bufferViews![image.bufferView!];
  const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  assert.deepEqual([png[24], png[25], png[28]], [2, 3, 1]);
  const data = decodeEmbeddedPng(png).data;
  assert.deepEqual(Array.from(data.slice(0, 4)), [128, 128, 128, 0]);
  assert.deepEqual(Array.from(data.slice(16 * 4, 17 * 4)), [255, 0, 0, 0]);
  assert.deepEqual(Array.from(data.slice(48 * 4, 49 * 4)), [0, 255, 0, 0]);
});

test("specular bindings reject malformed references, missing UVs, alternate UVs and extensions", async () => {
  const bytes = await fixture();
  for (const field of ["specularTexture", "specularColorTexture"]) {
    const cases: [unknown, string, RegExp][] = [
      [null, "TC_ASSET_INVALID", new RegExp(field)],
      [{ index: 99 }, "TC_ASSET_INVALID", /index/],
      [{ index: 0, texCoord: -1 }, "TC_ASSET_INVALID", /texCoord/],
      [{ index: 0, texCoord: 1 }, "TC_ASSET_UNSUPPORTED", /texCoord/],
      [{ index: 0, extensions: { KHR_texture_transform: { offset: [1, 0] } } }, "TC_ASSET_UNSUPPORTED", /KHR_texture_transform/],
    ];
    for (const [value, code, resource] of cases) {
      await assert.rejects(inspect(mutate(bytes, j => { j.materials[0].extensions.KHR_materials_specular[field] = value; })), (e: unknown) => {
        assert.ok(e instanceof AssetInspectionError); assert.equal(e.code, code); assert.match(e.resource, resource); return true;
      });
    }
    await assert.rejects(inspect(mutate(bytes, j => { delete j.meshes[0].primitives[0].attributes.TEXCOORD_0; })), (e: unknown) => {
      assert.ok(e instanceof AssetInspectionError); assert.equal(e.code, "TC_ASSET_INVALID"); assert.match(e.resource, /material/); return true;
    });
  }
});

test("optimization preserves specular texture payloads, factors and shared binding", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "specular-textures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "in.glb"), output = path.join(root, "out.glb"), bytes = await fixture();
  await writeFile(input, bytes);
  const report = await optimizeModel(input, output);
  const before = (report.before.materials as any[])[0], after = (report.after.materials as any[])[0];
  assert.equal(after.specular.specularFactor, before.specular.specularFactor);
  assert.deepEqual(after.specular.specularColorFactor, before.specular.specularColorFactor);
  assert.equal(after.textures.specular, after.textures.specularColor);
  const parsed = parseGLB(await readFile(output), new InspectionContext(output));
  assert.ok(parsed.json.extensionsUsed?.includes("KHR_materials_specular"));
  assert.ok(parsed.json.extensionsRequired?.includes("KHR_materials_specular"));
  assert.deepEqual(await readFile(input), bytes);
});

test("optimization preserves separate images and sampler settings in their respective slots", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "specular-distinct-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "in.glb"), output = path.join(root, "out.glb"), bytes = await fixture(false);
  await writeFile(input, bytes);
  await optimizeModel(input, output);
  const bindings = (data: Buffer) => {
    const { json, bin } = parseGLB(data, new InspectionContext("fixture.glb"));
    const ext = json.materials![0].extensions!.KHR_materials_specular as any;
    return [ext.specularTexture, ext.specularColorTexture].map(info => {
      const texture = json.textures![info.index], image = json.images![texture.source!];
      const view = json.bufferViews![image.bufferView!], start = view.byteOffset ?? 0;
      return { bytes: bin.subarray(start, start + view.byteLength), sampler: json.samplers?.[texture.sampler!] ?? {} };
    });
  };
  const before = bindings(bytes), after = bindings(await readFile(output));
  assert.notDeepEqual(before[0].bytes, before[1].bytes);
  assert.deepEqual(after, before);
  assert.equal(after[1].sampler.wrapS, 33071);
  assert.equal(after[1].sampler.magFilter, 9728);
});

test("either specular texture slot may be used independently", async () => {
  const bytes = await fixture();
  for (const field of ["specularTexture", "specularColorTexture"]) {
    const result = await inspect(mutate(bytes, j => { delete j.materials[0].extensions.KHR_materials_specular[field]; }));
    const slots = (result.materials as any[])[0].textures;
    assert.equal(slots[field === "specularTexture" ? "specular" : "specularColor"], null);
    assert.equal(slots[field === "specularTexture" ? "specularColor" : "specular"], 0);
  }
});
