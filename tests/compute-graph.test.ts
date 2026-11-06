import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { evaluateTypedGraph, lowerGraphWGSL } from "../packages/renderer/src/graph-expressions.ts";
import { SDK_VERSION, type GraphType } from "../packages/sdk/src/index.ts";

const raw = {
  nodes: [
    { id: "index", op: "input", name: "index" },
    { id: "value", op: "readBuffer", buffer: "source", inputs: ["index"] },
  ],
  output: "value",
};

for (const type of ["float", "vec2", "vec3", "vec4", "bool"] as const) {
  test("buffer graph preserves declared " + type + " through CPU oracle and trusted lowering", () => {
    const compiled = compileGraphDeclaration(raw, type, { domain: "compute", inputs: ["index"], buffers: { source: type } });
    assert.deepEqual(compiled.issues, []);
    assert.deepEqual(compiled.graph.bufferTypes, { source: type });
    const value = type === "bool" ? true : type === "float" ? 3 : Array.from({ length: Number(type.slice(3)) }, (_, i) => i + 1);
    assert.deepEqual(evaluateTypedGraph(compiled.graph, { inputs: { index: 2 }, readBuffer(name, index) {
      assert.equal(name, "source"); assert.equal(index, 2); return value as never;
    } }), value);
    const lowered = lowerGraphWGSL(compiled.graph, {
      prefix: "managed", input: () => "f32(id.x)", parameter: () => { throw Error("unexpected parameter"); }, sampleTexture: () => { throw Error("unexpected texture"); },
      readBuffer(name, index, actual) { assert.equal(name, "source"); assert.equal(actual, type); return `engineRead(${index})`; },
    });
    assert.match(lowered.code, /engineRead\(managed_g0\)/);
    assert.equal(lowered.type, type);
    assert.throws(() => evaluateTypedGraph(compiled.graph, { inputs: { index: 0 } }), /TC_GRAPH_CONTEXT/);
  });
}

test("buffer reads validate domain, binding, index type and output before emitting IR", () => {
  assert.deepEqual(compileGraphDeclaration(raw, "float", { domain: "material", buffers: { source: "float" } }).issues, []);
  assert.ok(compileGraphDeclaration(raw, "float", { domain: "compute", buffers: {} }).issues.some(i => i.code === "TC_COMPUTE_BINDING" && i.field === "buffer"));
  const bad = structuredClone(raw);
  (bad.nodes[0] as any) = { id: "index", op: "vec2", value: [0, 0] };
  assert.ok(compileGraphDeclaration(bad, "float", { domain: "compute", buffers: { source: "float" } }).issues.some(i => i.code === "TC_GRAPH_TYPE"));
  const dead = compileGraphDeclaration({ nodes: [...raw.nodes, { id: "zero", op: "float", value: 0 }], output: "zero" }, "float", { domain: "compute", buffers: { source: "vec3" } });
  assert.deepEqual(dead.issues, []);
  assert.equal(dead.graph.bufferTypes, undefined);
  assert.deepEqual(dead.graph.nodes.map(n => n.id), ["zero"]);
});

test("normal compiler emits managed bindings and points malformed declarations to their source", async () => {
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const directory = await mkdtemp(path.join(tmpdir(), "pelican compute graph "));
  const code = (binding: string) => `import{defineCompute,defineGame,defineScene}from"pelican-engine";
const kernel=defineCompute({id:"move",count:4,outputType:"vec3",buffers:[${binding}],graph:{nodes:[{id:"i",op:"input",name:"index"},{id:"p",op:"readBuffer",buffer:"positions",inputs:["i"]}],output:"p"}});
export default defineGame({id:"managed",scene:defineScene({id:"main",entities:[]}),computes:[kernel]});`;
  try {
    await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
    await writeFile(path.join(directory, "game.ts"), code('{name:"positions",type:"vec3"}'));
    const options = { projectRoot: directory, engineRoot: root, outDir: path.join(directory, ".pelican/generated") };
    const compiled = await compileProject(options);
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir!.computes[0].buffers, [{ name: "positions", type: "vec3" }]);
    assert.equal(compiled.ir!.computes[0].graph.bufferTypes?.positions, "vec3");
    await writeFile(path.join(directory, "game.ts"), code('{name:"other",type:"vec3"}'));
    const failed = await compileProject(options);
    assert.equal(failed.success, false);
    const issue = failed.diagnostics.find(item => item.code === "TC_COMPUTE_BINDING");
    assert.ok(issue?.source);
    assert.equal(issue.source.file, "game.ts");
    assert.equal(issue.source.line, 2);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pelican compute graph "));
    await rm(directory, { recursive: true, force: true });
  }
});
