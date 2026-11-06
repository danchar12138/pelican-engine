import test from "node:test";
import assert from "node:assert/strict";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";

test("compiler graph resource requirements and IR contain only output dependencies", () => {
  const { graph, issues } = compileGraphDeclaration(
    {
      nodes: [
        { id: "unusedUV", op: "input", name: "uv1" },
        { id: "unusedView", op: "input", name: "viewDirectionWorld" },
        {
          id: "unusedSample",
          op: "sampleTexture",
          texture: "unused",
          inputs: ["unusedUV"],
        },
        { id: "unusedTime", op: "time" },
        { id: "uv", op: "input", name: "uv" },
        { id: "sample", op: "sampleTexture", texture: "used", inputs: ["uv"] },
      ],
      output: "sample",
    },
    "vec4",
    { textures: new Set(["used", "unused"]) },
  );
  assert.deepEqual(issues, []);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["uv", "sample"],
  );
  assert.deepEqual(graph.requiredInputs, ["uv"]);
  assert.deepEqual(graph.textureIds, ["used"]);
  assert.deepEqual(graph.nodeTypes, { uv: "vec2", sample: "vec4" });
});

test("dead nodes still receive declaration validation and cycle diagnostics", () => {
  const { issues } = compileGraphDeclaration(
    {
      nodes: [
        { id: "value", op: "float", value: 1 },
        { id: "a", op: "sin", inputs: ["b"] },
        { id: "b", op: "sin", inputs: ["a"] },
        {
          id: "bad",
          op: "sampleTexture",
          texture: "missing",
          inputs: ["value"],
        },
      ],
      output: "value",
    },
    "float",
    { textures: new Set() },
  );
  assert.ok(issues.some((issue) => issue.code === "TC_GRAPH_CYCLE"));
  assert.ok(issues.some((issue) => issue.code === "TC_GRAPH_TEXTURE"));
  assert.ok(issues.some((issue) => issue.code === "TC_GRAPH_TYPE"));
});

test("declared compute texture sampling binds only reachable slots and rejects unknown slot names", () => {
  const sample = {
    id: "sample",
    op: "sampleTexture",
    texture: "tex",
    inputs: ["uv"],
  };
  const raw = {
    nodes: [{ id: "uv", op: "vec2", value: [0, 0] }, sample],
    output: "sample",
  };
  const result = compileGraphDeclaration(raw, "vec4", {
    domain: "compute",
    textures: new Set(["tex"]),
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.graph.textureIds, ["tex"]);
  const issue = compileGraphDeclaration(raw, "vec4", { domain: "compute", textures: new Set() }).issues.find(issue => issue.code === "TC_GRAPH_TEXTURE");
  assert.equal(issue?.owner, sample);
  assert.equal(issue?.field, "texture");
  assert.deepEqual(
    compileGraphDeclaration(raw, "vec4", { domain: "material" }).issues,
    [],
  );
  const dead = compileGraphDeclaration(
    {
      ...raw,
      nodes: [...raw.nodes, { id: "value", op: "float", value: 2 }],
      output: "value",
    },
    "float",
    { domain: "compute" },
  );
  assert.deepEqual(dead.issues, []);
  assert.equal(dead.graph.textureIds, undefined);
});

test("deep compiler output closure is iterative and keeps dependency order", () => {
  const nodes: unknown[] = [{ id: "n0", op: "float", value: 0 }];
  for (let i = 1; i < 15000; i++)
    nodes.push({ id: "n" + i, op: "sin", inputs: ["n" + (i - 1)] });
  const result = compileGraphDeclaration({ nodes, output: "n14999" }, "float");
  assert.deepEqual(result.issues, []);
  assert.equal(result.graph.nodes.length, 15000);
  assert.equal(result.graph.nodes.at(-1)?.id, "n14999");
});
