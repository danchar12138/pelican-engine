import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { evaluateTypedGraph, lowerGraphWGSL } from "../packages/renderer/src/graph-expressions.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

const graph = {
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "now", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] },
    { id: "old", op: "sampleHistory", channel: "echo", inputs: ["uv"] },
    { id: "weight", op: "float", value: 0.5 },
    { id: "out", op: "mix", inputs: ["now", "old", "weight"] },
  ], output: "out",
};
const options = { domain: "postprocess" as const, inputs: ["uv", "screenSize", "texelSize"] as const, frameChannels: new Set(["scene.color", "scene.normal", "scene.depth"]), historyChannels: new Set(["echo"]) };

test("frame and history sampling keep separate typed dependencies and trusted lowering", () => {
  const compiled = compileGraphDeclaration(graph, "vec4", options);
  assert.deepEqual(compiled.issues, []);
  assert.deepEqual(compiled.graph.frameChannels, ["scene.color"]);
  assert.deepEqual(compiled.graph.historyChannels, ["echo"]);
  assert.deepEqual(evaluateTypedGraph(compiled.graph, {
    inputs: { uv: [0.5, 0.5] },
    sampleFrame(channel, uv) { assert.equal(channel, "scene.color"); assert.deepEqual(uv, [0.5, 0.5]); return [4, 2, 1, 1]; },
    sampleHistory(channel) { assert.equal(channel, "echo"); return [2, 4, 1, 1]; },
  }), [3, 3, 1, 1]);
  const lowered = lowerGraphWGSL(compiled.graph, { prefix: "fx", input: () => "uv", parameter: () => "unused", sampleTexture: () => "unused", sampleFrame: (_channel, uv) => `current(${uv})`, sampleHistory: (_channel, uv) => `previous(${uv})` });
  assert.match(lowered.code, /current\(fx_g0\)/);
  assert.match(lowered.code, /previous\(fx_g0\)/);
  assert.throws(() => evaluateTypedGraph(compiled.graph, { inputs: { uv: [0, 0] } }), /TC_GRAPH_CONTEXT/);
});

test("domains, forward channels, index types and forbidden inputs are diagnosed before rendering", () => {
  for (const domain of ["material", "compute"] as const)
    assert.ok(compileGraphDeclaration(graph, "vec4", { ...options, domain }).issues.some(issue => issue.code === "TC_GRAPH_CONTEXT"));
  const missing = compileGraphDeclaration(graph, "vec4", { ...options, frameChannels: new Set(), historyChannels: new Set() });
  assert.equal(missing.issues.filter(issue => issue.code === "TC_POSTPROCESS_CHANNEL").length, 2);
  const raw = structuredClone(graph);
  (raw.nodes[0] as any) = { id: "uv", op: "float", value: 0 };
  assert.ok(compileGraphDeclaration(raw, "vec4", options).issues.some(issue => issue.code === "TC_GRAPH_TYPE"));
  const wrongInput = compileGraphDeclaration({ nodes: [{ id: "v", op: "input", name: "positionWorld" }], output: "v" }, "vec3", options);
  assert.ok(wrongInput.issues.some(issue => issue.code === "TC_GRAPH_CONTEXT"));
});

test("normal compiler preserves ordered passes and reports pass references at original source locations", async () => {
  const engineRoot = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "pelican postprocess graph "));
  const code = (firstChannel = "scene.color", secondID = "echo", enabled = "true") => `import{defineGame,defineScene,definePostProcess}from"pelican-engine";
const first=definePostProcess({id:"grade",graph:{nodes:[{id:"uv",op:"input",name:"uv"},{id:"sample",op:"sampleFrame",channel:${JSON.stringify(firstChannel)},inputs:["uv"]}],output:"sample"}});
const second=definePostProcess({id:${JSON.stringify(secondID)},enabled:${enabled},graph:${JSON.stringify(graph)}});
export default defineGame({id:"effects",scene:defineScene({id:"main",entities:[]}),postProcesses:[first,second]});`;
  const compile = async (text: string) => {
    await writeFile(path.join(directory, "game.ts"), text);
    return compileProject({ engineRoot, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") });
  };
  try {
    await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
    const result = await compile(code());
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.ir!.postProcesses!.map(pass => pass.id), ["grade", "echo"]);
    assert.ok(result.report.modules.includes("postprocess-graph-ir"));
    assert.equal(result.ir!.postProcesses![1].enabled, true);
    const allowed = await compile(code("scene.depth"));
    assert.equal(allowed.success, true, JSON.stringify(allowed.diagnostics));
    const forward = await compile(code("echo"));
    const issue = forward.diagnostics.find(item => item.code === "TC_POSTPROCESS_CHANNEL");
    assert.equal(forward.success, false);
    assert.equal(issue?.source?.file, "game.ts");
    assert.equal(issue?.source?.line, 2);
    const duplicate = await compile(code("scene.color", "grade"));
    assert.ok(duplicate.diagnostics.some(item => item.code === "TC_POSTPROCESS_ID"));
    const reserved = await compile(code("scene.color", "scene.depth"));
    assert.ok(reserved.diagnostics.some(item => item.code === "TC_POSTPROCESS_ID"));
    const invalid = await compile(code("scene.color", "echo", "42"));
    assert.equal(invalid.success, false);
    assert.ok(invalid.diagnostics.some(item => item.code === "TC_POSTPROCESS_SETTINGS" || item.code === "TC_TS_2322"));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pelican postprocess graph "));
    await rm(directory, { recursive: true, force: true });
  }
});
