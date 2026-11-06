import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { assertMaterialSlotPixels, materialSlotsAllowedRequest, materialSlotsInstalledIdentity, runMaterialSlotsGameProbe, verifyMaterialSlotsProject } from "../tools/material-slots-game-probe.ts";
import { prepareMaterialSlotsGLB } from "../tools/prepare-material-slots-glb.ts";

test("pixel oracle rejects no change, incorrect replacement and changed preserved slot", () => {
  const before = { paint: [180, 4, 4] as [number, number, number], trim: [4, 4, 180] as [number, number, number] };
  const after = { paint: [4, 180, 4] as [number, number, number], trim: [5, 5, 182] as [number, number, number] };
  assert.doesNotThrow(() => assertMaterialSlotPixels(before, after));
  assert.throws(() => assertMaterialSlotPixels(before, before));
  assert.throws(() => assertMaterialSlotPixels(before, { ...after, trim: [180, 4, 4] }));
  assert.throws(() => assertMaterialSlotPixels(before, { ...after, trim: [4, 4, 80] }));
});

test("installed channel rejects any different or missing game, manifest or asset before launching", async () => {
  const project = fileURLToPath(new URL("../examples/material-slots/", import.meta.url));
  const temp = await mkdtemp(path.join(tmpdir(), "pelican-slots-identity-"));
  const installed = path.join(temp, "installed"), output = path.join(temp, "output");
  try {
    await cp(project, installed, { recursive: true });
    const identity = await verifyMaterialSlotsProject(project, installed);
    assert.deepEqual(identity.gameIdentity, identity.installedGameIdentity);
    for (const name of ["game.ts", "pelican.project.json", "assets/panels.glb"]) {
      const file = path.join(installed, name), original = await readFile(file);
      await writeFile(file, Buffer.concat([original, Buffer.from("changed")]));
      await assert.rejects(verifyMaterialSlotsProject(project, installed), /exact example game, manifest and asset/);
      await assert.rejects(runMaterialSlotsGameProbe(output, installed), /exact example game, manifest and asset/);
      const report = JSON.parse(await readFile(path.join(output, "material-slots-game.json"), "utf8"));
      assert.equal(report.passed, false);
      assert.equal(report.dev, undefined);
      await writeFile(file, original);
    }
    await rm(path.join(installed, "assets/panels.glb"));
    await assert.rejects(verifyMaterialSlotsProject(project, installed), { code: "ENOENT" });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("installed package identity records package, SDK and lock provenance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pelican-slots-package-"));
  try {
    const pkg = path.join(dir, "node_modules/pelican-engine");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "pelican-engine": "file:engine.tgz" } }));
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/pelican-engine": { version: "1.2.3", resolved: "file:engine.tgz", integrity: "sha512-test" } } }));
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "pelican-engine", version: "1.2.3", exports: { ".": { import: "./sdk.mjs" } }, bin: { pelican: "cli.mjs" } }));
    await writeFile(path.join(pkg, "sdk.mjs"), 'export const SDK_VERSION = "4.5.6";');
    await writeFile(path.join(pkg, "distribution.json"), JSON.stringify({ version: "1.2.3" }));
    const identity = await materialSlotsInstalledIdentity(dir);
    assert.equal(identity.packageVersion, "1.2.3");
    assert.equal(identity.sdkVersion, "4.5.6");
    assert.match(identity.sdkEntrySha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.distributionVersion, "1.2.3");
    assert.deepEqual(identity.tarball, { version: "1.2.3", resolved: "file:engine.tgz", integrity: "sha512-test" });
    assert.equal(identity.declared, "file:engine.tgz");
    assert.equal(identity.bin, path.join(pkg, "cli.mjs"));
    await cp(fileURLToPath(new URL("../examples/material-slots/", import.meta.url)), dir, { recursive: true });
    await assert.rejects(runMaterialSlotsGameProbe(path.join(dir, "output"), dir), /Installed package must match/);
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "pelican-engine", version: SDK_VERSION, exports: { ".": { import: "./sdk.mjs" } }, bin: { pelican: "cli.mjs" } }));
    await assert.rejects(runMaterialSlotsGameProbe(path.join(dir, "output"), dir), /Installed SDK must match/);
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "wrong", version: "1.2.3" }));
    await assert.rejects(materialSlotsInstalledIdentity(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("network policy only allows the exact local server origin", () => {
  const origin = "http://127.0.0.1:1234";
  assert.equal(materialSlotsAllowedRequest(`${origin}/assets/panels.glb`, origin), true);
  for (const url of ["http://127.0.0.1:1235/", "http://localhost:1234/", "https://127.0.0.1:1234/", "https://example.com/", "data:text/plain,x", "invalid"])
    assert.equal(materialSlotsAllowedRequest(url, origin), false, url);
});

test("public game compiles its reproducible two-slot GLB and switches models on input", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.join(root, "examples/material-slots");
  const temp = await mkdtemp(path.join(tmpdir(), "pelican-slots-test-"));
  let host: RuntimeHost | undefined;
  try {
    const regenerated = path.join(temp, "panels.glb");
    await prepareMaterialSlotsGLB(regenerated);
    const fixture = path.join(project, "assets/panels.glb");
    assert.deepEqual(await readFile(regenerated), await readFile(fixture));
    const document = await new NodeIO().read(fixture);
    assert.deepEqual(document.getRoot().listMaterials().map(material => material.getName()), ["Paint", "Trim"]);
    const result = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(temp, "generated") });
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.ir!.scene.entities.find(entity => entity.id === "after")!.model!.materialSlots, { Paint: "green" });
    const compiled = await import(pathToFileURL(path.join(temp, "generated/game.js")).href);
    host = new RuntimeHost(result.ir!);
    host.attach(compiled.createGame(host.facade));
    const tap = (key: string) => { host!.input(key, true); host!.input(key, false); host!.step(); };
    tap("a");
    assert.deepEqual(host.facade.getTransform("before").position, [100, 0, 0]);
    assert.deepEqual(host.facade.getTransform("after").position, [0, 0, 0]);
    tap("b");
    assert.deepEqual(host.facade.getTransform("before").position, [0, 0, 0]);
    assert.deepEqual(host.facade.getTransform("after").position, [100, 0, 0]);
    assert.equal(host.inspect().scheduler.fault, null);
  } finally {
    host?.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
