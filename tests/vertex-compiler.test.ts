import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

test("vertex inputs use their own domain and buffer reads require declared slots", () => {
  const raw = { nodes: [{ id: "p", op: "input", name: "positionLocal" }], output: "p" };
  assert.deepEqual(compileGraphDeclaration(raw, "vec3", { domain: "vertex", inputs: ["positionLocal"] }).issues, []);
  for (const domain of ["material", "compute", "postprocess"] as const)
    assert.ok(compileGraphDeclaration(raw, "vec3", { domain, inputs: domain === "material" ? ["positionWorld"] : domain === "compute" ? ["index"] : ["uv"] }).issues.some(item => item.code === "TC_GRAPH_CONTEXT"));
  const unavailable = compileGraphDeclaration({ nodes: [{ id: "i", op: "float", value: 0 }, { id: "value", op: "readBuffer", buffer: "positions", inputs: ["i"] }], output: "value" }, "vec3", { domain: "vertex", buffers: {} });
  assert.ok(unavailable.issues.some(item => item.code === "TC_COMPUTE_BINDING"));
});

test("normal game compilation emits vertex graphs, unified parameters and source-located errors", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "pelican vertex compiler "));
  const code = (vertex: string) => `import{defineGame,defineScene,defineMaterial}from"pelican-engine";
const material=defineMaterial({id:"deformed",vertex:${vertex}});
export default defineGame({id:"vertex",scene:defineScene({id:"main",entities:[{id:"shape",mesh:{geometry:{kind:"box"},material}}]})});`;
  const graph = `{position:{parameters:[{name:"shift",type:"vec3",default:[1,0,0]}],nodes:[{id:"p",op:"input",name:"positionLocal"},{id:"offset",op:"parameter",name:"shift"},{id:"out",op:"add",inputs:["p","offset"]}],output:"out"}}`;
  const compile = async (source: string) => { await writeFile(path.join(directory, "game.ts"), source); return compileProject({ engineRoot: root, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") }); };
  try {
    await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
    const result = await compile(code(graph));
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.equal(result.ir!.materials[0].vertex!.position!.outputType, "vec3");
    assert.deepEqual(result.ir!.materials[0].parameters, [{ name: "shift", type: "vec3", default: [1, 0, 0] }]);
    assert.ok(result.report.modules.includes("vertex-graph-ir"));
    const empty = await compile(code("{}"));
    assert.ok(empty.diagnostics.some(item => item.code === "TC_VERTEX_GRAPH" && item.source?.file === "game.ts" && item.source.line === 2));
    const wrongDomain = await compile(code(graph.replace('name:"positionLocal"', 'name:"positionWorld"')));
    assert.ok(wrongDomain.diagnostics.some(item => item.code === "TC_GRAPH_CONTEXT" && item.source?.line === 2));
    const wrongOutput = await compile(code('{position:{nodes:[{id:"p",op:"float",value:1}],output:"p"}}'));
    assert.ok(wrongOutput.diagnostics.some(item => item.code === "TC_GRAPH_TYPE"));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pelican vertex compiler "));
    await rm(directory, { recursive: true, force: true });
  }
});
