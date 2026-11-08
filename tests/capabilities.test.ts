import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { engineCapabilities } from "../packages/sdk/src/index.ts";
import { recipeIds } from "../tools/npm/recipes.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("capability catalog exhausts actual service entries, public symbols, recipes and every alias", async () => {
  const source = await readFile(path.join(root, "packages/sdk/src/index.ts"), "utf8");
  const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const exported = new Set<string>();
  for (const node of sf.statements) {
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) exported.add(declaration.name.getText(sf));
    else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) exported.add(node.name.text);
  }
  const features = engineCapabilities();
  assert.equal(new Set(features.map(feature => feature.id)).size, features.length);
  for (const feature of features) {
    assert.equal(engineCapabilities(feature.id)[0].id, feature.id);
    assert.ok(feature.description?.trim(), feature.id);
    assert.ok(feature.aliases?.length, feature.id);
    assert.ok(feature.limits.length, feature.id);
    assert.ok(feature.symbols.length, feature.id);
    assert.ok(feature.backends.length, feature.id);
    assert.ok(["implemented", "partial"].includes(feature.implementation));
    for (const symbol of feature.symbols) {
      assert.ok(exported.has(symbol), `${feature.id}: nonexistent public symbol ${symbol}`);
      assert.ok(engineCapabilities(symbol).some(item => item.id === feature.id), symbol);
    }
    for (const alias of feature.aliases!) assert.ok(engineCapabilities(alias).some(item => item.id === feature.id), `${feature.id}: ${alias}`);
    for (const recipe of feature.recipes) assert.ok(recipeIds.includes(recipe), `${feature.id}: ${recipe}`);
  }
  const context = sf.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "SystemContext") as ts.InterfaceDeclaration;
  for (const member of context.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type)) continue;
    const service = member.type.typeName.getText(sf);
    if (!service.endsWith("Service")) continue;
    assert.ok(features.some(feature => feature.symbols.includes(service)), `Missing SystemContext service ${service}`);
  }
});

test("discovery covers bilingual synonyms, dependency boundaries and detached metadata", () => {
  for (const [query, id] of [
    ["音效", "audio.playback"], ["混响", "audio.mixer"], ["heightmap", "world.terrain"],
    ["地形", "world.terrain"], ["GPGPU", "compute.managed"], ["计算着色器", "compute.managed"],
    ["post-process", "render.postprocess"], ["后处理", "render.postprocess"],
    ["2D physics", "physics.rigid2d"], ["二维物理", "physics.rigid2d"],
    ["persistence", "storage.save"], ["存档", "storage.save"], ["几何", "render.geometry"],
    ["算法", "content.libraries"], ["browser-only", "content.libraries"], ["per-instance lazy load", "content.libraries"],
    ["渲染私有对象", "render.material"],
  ]) assert.ok(engineCapabilities(query).some(feature => feature.id === id), query);
  const libraries = engineCapabilities("content.libraries")[0];
  assert.match(libraries.description!, /算法类 npm 可直接复用/);
  assert.match(libraries.description!, /runtime\.create/);
  assert.match(libraries.description!, /own\/defer/);
  assert.match(libraries.limits.join(" "), /not a stable plugin contract/);
  assert.deepEqual(engineCapabilities("compute")[0].backends, ["webgpu"]);
  assert.deepEqual(engineCapabilities("physics2d")[0].backends, ["cpu"]);
  assert.equal(engineCapabilities("render.path")[0].implementation, "partial");
  const audio = engineCapabilities("audio.playback")[0];
  for (const values of [audio.symbols, audio.aliases!, audio.backends, audio.limits, audio.recipes]) (values as string[]).push("mutated");
  assert.ok(!JSON.stringify(engineCapabilities("audio.playback")).includes("mutated"));
  assert.throws(() => engineCapabilities("unknownFeatureXYZ"), /TC_CAPABILITY_UNKNOWN.*does not establish/);
  for (const query of ["硬件光追", "hardware ray tracing", "multiplayer", "异步资产流送"])
    assert.throws(() => engineCapabilities(query), /TC_CAPABILITY_UNSUPPORTED/);
});

test("real capabilities CLI returns every feature and explicit query failures", () => {
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "tools/cli.ts", "capabilities", ...args], {
      cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, output: JSON.parse(result.stdout) };
  };
  const catalog = run();
  assert.equal(catalog.status, 0);
  assert.deepEqual(catalog.output.data.features, engineCapabilities());
  assert.equal(catalog.output.data.total, engineCapabilities().length);
  assert.equal(catalog.output.data.truncated, false);
  for (const feature of engineCapabilities()) {
    const found = run("--feature", feature.id);
    assert.equal(found.status, 0, feature.id);
    assert.equal(found.output.data.features[0].id, feature.id);
  }
  const chinese = run("--feature", "音效");
  assert.equal(chinese.status, 0);
  assert.equal(chinese.output.data.features[0].id, "audio.playback");
  for (const [args, code] of [
    [["--feature"], "TC_CAPABILITY_QUERY"],
    [["--feature", "--unused"], "TC_CAPABILITY_QUERY"],
    [["--feature", " "], "TC_CAPABILITY_QUERY"],
    [["--feature", "audio", "--feature", "terrain"], "TC_CAPABILITY_QUERY"],
    [["--featuer", "audio"], "TC_CAPABILITY_QUERY"],
    [["--feature", "unknownFeatureXYZ"], "TC_CAPABILITY_UNKNOWN"],
    [["--feature", "硬件光追"], "TC_CAPABILITY_UNSUPPORTED"],
  ] as const) {
    const failed = run(...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.output.status, "failed");
    assert.equal(failed.output.diagnostics[0].code, code);
    assert.equal(failed.output.data, null);
  }
});
