import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

test("compute textures compile initial resources, sampled slots and output pixel inputs through the public API", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url)), directory = await mkdtemp(path.join(tmpdir(), "pelican texture compiler "));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith("pelican texture compiler ")); await rm(directory, { recursive: true, force: true }); });
  await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
  const code = `import{defineGame,defineScene,defineCompute}from"pelican-engine";
const sample=defineCompute({id:"sample",count:4,outputType:"vec4",textures:[{name:"field"}],graph:{nodes:[{id:"uv",op:"input",name:"uv"},{id:"out",op:"sampleTexture",texture:"field",inputs:["uv"]}],output:"out"}});
const coordinate=defineCompute({id:"coordinate",count:4,outputType:"vec2",graph:{nodes:[{id:"pixel",op:"input",name:"pixelCoord"},{id:"size",op:"input",name:"outputSize"},{id:"out",op:"safeDivide",inputs:["pixel","size"]}],output:"out"}});
export default defineGame({id:"textures",computes:[sample,coordinate],computeTextures:[{id:"initial",width:2,height:1,data:[[1,0,0,1],[0,1,0,1]]}],scene:defineScene({id:"main",entities:[]})});`;
  const compile = async (source: string) => { await writeFile(path.join(directory, "game.ts"), source); return compileProject({ engineRoot: root, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") }); };
  const good = await compile(code); assert.equal(good.success, true, JSON.stringify(good.diagnostics));
  assert.deepEqual(good.ir!.computeTextures, [{ id: "initial", width: 2, height: 1, data: [[1,0,0,1],[0,1,0,1]] }]);
  assert.deepEqual(good.ir!.computes[0].textures, [{ name: "field", filter: "linear", wrapU: "clamp", wrapV: "clamp" }]);
  assert.deepEqual(good.ir!.computes[0].graph.textureIds, ["field"]);
  assert.deepEqual([...good.ir!.computes[1].graph.requiredInputs!].sort(), ["outputSize", "pixelCoord"]);
  assert.ok(good.report.modules.includes("compute-textures"));
  for (const [source, expected] of [
    [code.replace('width:2', 'width:1.5'), "TC_COMPUTE_TEXTURE_SIZE"],
    [code.replace('width:2', 'width:16777216'), "TC_COMPUTE_TEXTURE_SIZE"],
    [code.replace('height:1', 'height:2'), "TC_COMPUTE_TEXTURE_SIZE"],
    [code.replace('[1,0,0,1]', '[1e40,0,0,1]'), "TC_COMPUTE_VALUE"],
    [code.replace('computes:[sample,coordinate]', 'computeBuffers:[{id:"initial",type:"float",count:1}],computes:[sample,coordinate]'), "TC_COMPUTE_TEXTURE_NAME"],
    [code.replace('textures:[{name:"field"}]', 'textures:[{name:"field",filter:"cubic" as any}]'), "TC_COMPUTE_TEXTURE_SAMPLER"],
    [code.replace('textures:[{name:"field"}]', 'textures:[{name:"field",wrapU:"border" as any}]'), "TC_COMPUTE_TEXTURE_SAMPLER"],
    [code.replace('textures:[{name:"field"}]', 'textures:[{name:"field"},{name:"field"}]'), "TC_COMPUTE_TEXTURE_BINDING"],
    [code.replace('texture:"field"', 'texture:"missing"'), "TC_GRAPH_TEXTURE"],
  ] as const) {
    const failed = await compile(source); assert.equal(failed.success, false); assert.ok(failed.diagnostics.some(d => d.code === expected && d.source), JSON.stringify({ expected, diagnostics: failed.diagnostics }));
  }
  const sampler = await compile(code.replace('name:"field"}', 'name:"field",filter:"nearest",wrapU:"repeat",wrapV:"mirror"}'));
  assert.equal(sampler.success, true); assert.deepEqual(sampler.ir!.computes[0].textures![0], { name: "field", filter: "nearest", wrapU: "repeat", wrapV: "mirror" });
});
