import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as THREE from "three/webgpu";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import { packSurfaceMaterialTable } from "../packages/renderer/src/surface-gpu.ts";

test("public specular declarations compile, validate ranges and reject unimplemented transmissive mixture", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url)), directory = await mkdtemp(path.join(tmpdir(), "pelican specular compiler "));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith("pelican specular compiler ")); await rm(directory, { recursive: true, force: true }); });
  await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
  const compile = async (fields: string) => {
    await writeFile(path.join(directory, "game.ts"), `import{defineGame,defineScene,defineMaterial}from"pelican-engine";const m=defineMaterial({id:"m",${fields}});export default defineGame({id:"specular",materials:[m],scene:defineScene({id:"scene",entities:[]})});`);
    return compileProject({ engineRoot: root, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") });
  };
  const good = await compile('ior:2,specularIntensity:0.4,specularColor:"red"'); assert.equal(good.success, true, JSON.stringify(good.diagnostics));
  assert.equal(good.ir!.materials[0].specularIntensity, 0.4); assert.equal(good.ir!.materials[0].specularColor, "red");
  for (const [fields, code] of [
    ['specularIntensity:-0.1', "TC_SCHEMA_RANGE"], ['specularIntensity:1.1', "TC_SCHEMA_RANGE"],
    ['specularColor:"not-a-color"', "TC_MATERIAL_SPECULAR_COLOR"],
    ['transmission:0.5,metalness:0,specularIntensity:0.5', "TC_MATERIAL_SPECULAR_TRANSMISSION"],
    ['transmission:0.5,metalness:0,specularColor:"#ff0000"', "TC_MATERIAL_SPECULAR_TRANSMISSION"],
  ] as const) { const bad = await compile(fields); assert.equal(bad.success, false, fields); assert.ok(bad.diagnostics.some(d => d.code === code), JSON.stringify(bad.diagnostics)); }
  const defaultTransmission = await compile('transmission:0.5,metalness:0,specularColor:"#fff",specularIntensity:1'); assert.equal(defaultTransmission.success, true, JSON.stringify(defaultTransmission.diagnostics));
});

test("material capture and GPU ABI preserve dielectric specular separately from volume attenuation", () => {
  const capture = createSurfaceCapture(), scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry();
  const opaque = new THREE.MeshPhysicalMaterial({ color: "#000000", ior: 2, specularIntensity: 0.4, specularColor: "#ff0000" });
  const volume = new THREE.MeshPhysicalMaterial({ color: "#ffffff", transmission: 0.5, attenuationColor: "#00ff00", attenuationDistance: 2 });
  scene.add(new THREE.Mesh(geometry, opaque), new THREE.Mesh(geometry, volume));
  try {
    const snapshot = capture.capture(scene).surface, first = snapshot.materials.findIndex(m => m.uuid === opaque.uuid), second = snapshot.materials.findIndex(m => m.uuid === volume.uuid);
    const table = packSurfaceMaterialTable(snapshot);
    assert.ok(first >= 0 && second >= 0); assert.ok(Math.abs(table[first * 32 + 27] - 0.6) < 1e-6);
    assert.deepEqual(Array.from(table.slice(first * 32 + 28, first * 32 + 31)), [1,0,0]);
    assert.deepEqual(Array.from(table.slice(second * 32 + 28, second * 32 + 31)), [0,1,0]);
    opaque.specularIntensity = 0.8; opaque.specularColor.set("#00ff00");
    const changed = capture.capture(scene).surface, updated = packSurfaceMaterialTable(changed);
    assert.ok(Math.abs(updated[first * 32 + 27] - 0.2) < 1e-6); assert.deepEqual(Array.from(updated.slice(first * 32 + 28, first * 32 + 31)), [0,1,0]);
    volume.specularIntensity = 0.5; assert.throws(() => capture.capture(scene), /SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED/);
  } finally { capture.dispose(); geometry.dispose(); opaque.dispose(); volume.dispose(); }
});
