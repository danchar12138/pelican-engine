import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

test("initial compute buffers and typed vertex slots compile through the normal public API", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "pelican compute render compiler "));
  const code = (binding = "offsets", slotType = "vec3", data = "[[0,0,0],[1,0,0]]") => `import{defineGame,defineScene,defineMaterial}from"pelican-engine";
const material=defineMaterial({id:"shape",buffers:[{name:"offset",type:${JSON.stringify(slotType)},buffer:${JSON.stringify(binding)},count:2}],vertex:{position:{nodes:[{id:"p",op:"input",name:"positionLocal"},{id:"i",op:"float",value:0},{id:"offset",op:"readBuffer",buffer:"offset",inputs:["i"]},{id:"out",op:"add",inputs:["p","offset"]}],output:"out"}}});
export default defineGame({id:"bound",computeBuffers:[{id:"offsets",type:"vec3",count:2,data:${data}}],scene:defineScene({id:"main",entities:[{id:"shape",mesh:{geometry:{kind:"box"},material}}]})});`;
  const compile = async (source: string) => { await writeFile(path.join(directory, "game.ts"), source); return compileProject({ engineRoot: root, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") }); };
  try {
    await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
    const result = await compile(code());
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.ir!.computeBuffers, [{ id: "offsets", type: "vec3", count: 2, data: [[0,0,0],[1,0,0]] }]);
    assert.deepEqual(result.ir!.materials[0].vertex!.position!.bufferTypes, { offset: "vec3" });
    assert.ok(result.report.modules.includes("render-buffer-bindings"));
    const missing = await compile(code("absent"));
    assert.ok(missing.diagnostics.some(item => item.code === "TC_RENDER_BUFFER_MISSING" && item.source?.line === 2));
    const wrongType = await compile(code("offsets", "float"));
    assert.ok(wrongType.diagnostics.some(item => item.code === "TC_RENDER_BUFFER_TYPE"));
    const wrongCount = await compile(code("offsets", "vec3", "[[0,0,0]]"));
    assert.ok(wrongCount.diagnostics.some(item => item.code === "TC_COMPUTE_COUNT" && item.source?.line === 3));
    const notDeclared = await compile(code().replace('buffer:"offset",inputs', 'buffer:"other",inputs'));
    assert.ok(notDeclared.diagnostics.some(item => item.code === "TC_COMPUTE_BINDING"));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pelican compute render compiler "));
    await rm(directory, { recursive: true, force: true });
  }
});
