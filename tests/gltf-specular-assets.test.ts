import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectModel } from "../packages/assets/src/model.ts";
import { AssetInspectionError, InspectionContext } from "../packages/assets/src/errors.ts";
import { parseGLB } from "../packages/assets/src/glb.ts";

const file = new URL("../examples/specular-material/assets/specular.glb", import.meta.url);
const original = await readFile(file);
const jsonLength = original.readUInt32LE(12);
const source = JSON.parse(original.subarray(20, 20 + jsonLength).toString());
const bin = original.subarray(20 + jsonLength);
function pack(json: unknown, replace?: (text: string) => string) {
  const text = JSON.stringify(json);
  const bytes = Buffer.from(replace ? replace(text) : text);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, 32);
  bytes.copy(padded);
  const result = Buffer.concat([original.subarray(0, 12), Buffer.alloc(8), padded, bin]);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  return result;
}
const inspect = (data: Buffer) => inspectModel(data, new InspectionContext("fixture.glb"));
async function rejects(mutator: (json: any) => void, code: string, resource?: RegExp) {
  const json = structuredClone(source);
  mutator(json);
  await assert.rejects(inspect(pack(json)), (error: unknown) => {
    assert.ok(error instanceof AssetInspectionError);
    assert.equal(error.code, code);
    if (resource) assert.match(error.resource, resource);
    return true;
  });
}

test("generated plane is valid, self-contained, MIT and has requested physical material", async () => {
  const result = await inspect(original);
  assert.equal(result.meshCount, 1);
  assert.equal(result.materialCount, 1);
  assert.equal(result.triangleCount, 2);
  assert.equal(result.textureCount, 0);
  assert.equal(result.animationCount, 0);
  assert.equal(source.extras.license, "MIT");
  assert.match(source.extras.source, /prepare-specular-glb/);
  assert.deepEqual(source.materials[0].extensions.KHR_materials_specular, { specularColorFactor: [1, 0, 0], specularFactor: 1 });
  assert.equal(source.materials[0].extensions.KHR_materials_ior.ior, 2);
  assert.deepEqual(source.materials[0].pbrMetallicRoughness.baseColorFactor, [0, 0, 0, 1]);
  assert.equal(source.materials[0].pbrMetallicRoughness.roughnessFactor, 0.35);
  assert.equal(source.materials[0].pbrMetallicRoughness.metallicFactor, 0);
  const bounds = result.bounds as { min: number[], max: number[] };
  assert.ok(Math.abs(bounds.min[0] + 0.5) < 1e-6 && Math.abs(bounds.max[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(bounds.min[1] + 0.9) < 1e-6 && Math.abs(bounds.max[1] - 0.9) < 1e-6);
  assert.equal(bounds.min[2], 0); assert.equal(bounds.max[2], 0);
  const parsed = parseGLB(original, new InspectionContext("fixture.glb"));
  const primitive = source.meshes[0].primitives[0];
  assert.deepEqual(parsed.accessors[primitive.attributes.NORMAL].values, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(parsed.accessors[primitive.indices].values, [0, 1, 2, 0, 2, 3]);
  const optional = structuredClone(source);
  delete optional.extensionsRequired;
  await inspect(pack(optional));
});

test("extension values and payloads are validated", async () => {
  for (const value of [-1, 1.1, "1", null])
    await rejects(j => { j.materials[0].extensions.KHR_materials_specular.specularFactor = value; }, "TC_ASSET_INVALID");
  for (const value of [[1, 0], [1, 0, 2], [1, "0", 0]])
    await rejects(j => { j.materials[0].extensions.KHR_materials_specular.specularColorFactor = value; }, "TC_ASSET_INVALID");
  for (const value of [0.99, -1, null])
    await rejects(j => { j.materials[0].extensions.KHR_materials_ior.ior = value; }, "TC_ASSET_INVALID");
  await rejects(j => { j.materials[0].extensions.KHR_materials_specular = []; }, "TC_ASSET_INVALID");
  await assert.rejects(inspect(pack(source, t => t.replace('"ior":2', '"ior":1e400'))), (e: unknown) => e instanceof AssetInspectionError && e.code === "TC_ASSET_INVALID");
});

test("invalid textures, transmission, nested extension payloads and misplaced extensions are diagnosed", async () => {
  for (const field of ["specularTexture", "specularColorTexture"])
    await rejects(j => { j.materials[0].extensions.KHR_materials_specular[field] = { index: 0 }; }, "TC_ASSET_INVALID", /Texture/);
  await rejects(j => { j.materials[0].extensions.KHR_materials_specular.extensions = { KHR_materials_ior: { ior: 2 } }; }, "TC_ASSET_UNSUPPORTED");
  const extras = structuredClone(source); extras.materials[0].extras = { nested: { extensions: { arbitraryUserData: {} } } };
  await inspect(pack(extras)); // glTF extras remain opaque application data as before.
  await rejects(j => { j.nodes[0].extensions = { KHR_materials_ior: { ior: 2 } }; }, "TC_ASSET_UNSUPPORTED");
  await rejects(j => { j.materials[0].extensions.KHR_materials_transmission = { transmissionFactor: 1 }; }, "TC_ASSET_UNSUPPORTED");
});

test("extension declarations are unique, supported, required-used and actually present", async () => {
  await rejects(j => { j.extensionsUsed.push(j.extensionsUsed[0]); }, "TC_ASSET_INVALID");
  await rejects(j => { j.extensionsRequired = ["KHR_materials_ior", "KHR_materials_ior"]; }, "TC_ASSET_INVALID");
  await rejects(j => { j.extensionsRequired.push("BAD_extension"); }, "TC_ASSET_UNSUPPORTED");
  await rejects(j => { j.extensionsUsed = ["KHR_materials_specular"]; }, "TC_ASSET_INVALID");
  await rejects(j => { delete j.extensionsUsed; delete j.extensionsRequired; }, "TC_ASSET_INVALID");
  await rejects(j => { delete j.materials; }, "TC_ASSET_INVALID");
  await rejects(j => { j.extensionsUsed.push(123); }, "TC_ASSET_INVALID");
});
