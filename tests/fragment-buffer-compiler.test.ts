import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Extractor } from "../packages/compiler/src/extract.ts";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { normalize } from "../packages/compiler/src/normalize.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const constant = (type: "vec3" | "vec4") => ({
  nodes: [
    {
      id: "value",
      op: type,
      value: type === "vec3" ? [1, 1, 1] : [1, 1, 1, 1],
    },
  ],
  output: "value",
});
const read = (
  buffer = "source",
  index = { id: "index", op: "float", value: 0 } as object,
) => ({
  nodes: [index, { id: "value", op: "readBuffer", buffer, inputs: ["index"] }],
  output: "value",
});
const pixelRead = (buffer = "source") => ({
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "u", op: "swizzle", components: "x", inputs: ["uv"] },
    { id: "width", op: "float", value: 2 },
    { id: "scaled", op: "multiply", inputs: ["u", "width"] },
    { id: "index", op: "floor", inputs: ["scaled"] },
    { id: "value", op: "readBuffer", buffer, inputs: ["index"] },
  ],
  output: "value",
});
const initialBuffers = [
  {
    id: "vectors",
    type: "vec3",
    count: 2,
    data: [
      [1, 0, 0],
      [0, 1, 0],
    ],
  },
  {
    id: "colors",
    type: "vec4",
    count: 3,
    data: [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ],
  },
  { id: "scalars", type: "float", count: 2, data: [0.2, 0.8] },
];
function source(
  material: Record<string, unknown> = {},
  post: Record<string, unknown> = {},
) {
  return `import {defineGame,defineScene,defineMaterial,definePostProcess} from "pelican-engine";
const material = defineMaterial(${JSON.stringify({ id: "shared", graph: constant("vec3"), ...material })});
const pass = definePostProcess(${JSON.stringify({ id: "shared", graph: constant("vec4"), ...post })});
export default defineGame({id:"fragmentBuffers",computeBuffers:${JSON.stringify(initialBuffers)},scene:defineScene({id:"main",entities:[{id:"shape",mesh:{geometry:{kind:"box"},material}}]}),postProcesses:[pass]});`;
}

// Exercise extraction and normalization directly so malformed schema cases reach
// engine diagnostics without a TypeScript check or a bundle for each variation.
async function normalizeSource(code: string) {
  const projectRoot = path.join(engineRoot, "fragment-buffer-fixture");
  const entry = path.join(projectRoot, "game.ts");
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const file = ts.createSourceFile(entry, code, ts.ScriptTarget.ESNext, true);
  host.getSourceFile = (name) =>
    path.resolve(name) === entry ? file : undefined;
  const program = ts.createProgram([entry], options, host);
  const extractor = new Extractor(
    program,
    projectRoot,
    path.join(engineRoot, "packages/sdk/src/index.ts"),
  );
  const game = extractor.extract(entry);
  assert.deepEqual(extractor.diagnostics, []);
  assert.ok(game);
  return normalize(game, extractor, projectRoot);
}

for (const domain of ["material", "postprocess"] as const) {
  for (const type of ["float", "bool", "vec2", "vec3", "vec4"] as const) {
    test(`${domain} reads preserve ${type} slots and UV-derived dynamic indices`, () => {
      const result = compileGraphDeclaration(pixelRead(), type, {
        domain,
        inputs: ["uv"],
        buffers: { source: type },
      });
      assert.deepEqual(result.issues, []);
      assert.equal(result.graph.outputType, type);
      assert.equal(result.graph.nodeTypes.value, type);
      assert.deepEqual(result.graph.bufferTypes, { source: type });
      assert.deepEqual(result.graph.requiredInputs, ["uv"]);
      assert.equal(
        result.graph.nodes.find((node) => node.id === "index")?.op,
        "floor",
      );
      assert.deepEqual(result.graph.nodes.at(-1), {
        id: "value",
        op: "readBuffer",
        buffer: "source",
        inputs: ["index"],
      });
    });
  }

  test(`${domain} validates scalar index expressions and preserves invalid numeric indices for rendering`, () => {
    for (const value of [-1, 0.5, 1000]) {
      const result = compileGraphDeclaration(
        read("source", { id: "index", op: "float", value }),
        "vec3",
        { domain, buffers: { source: "vec3" } },
      );
      assert.deepEqual(result.issues, []);
      assert.deepEqual(result.graph.nodes[0], {
        id: "index",
        op: "float",
        value,
      });
    }
    for (const index of [
      { id: "index", op: "bool", value: true },
      { id: "index", op: "vec2", value: [0, 0] },
    ]) {
      const result = compileGraphDeclaration(read("source", index), "vec3", {
        domain,
        buffers: { source: "vec3" },
      });
      assert.ok(
        result.issues.some(
          (issue) => issue.code === "TC_GRAPH_TYPE" && issue.field === "inputs",
        ),
      );
    }
    const wrongOutput = compileGraphDeclaration(read(), "vec3", {
      domain,
      buffers: { source: "float" },
    });
    assert.ok(
      wrongOutput.issues.some(
        (issue) => issue.code === "TC_GRAPH_TYPE" && issue.field === "output",
      ),
    );
  });

  test(`${domain} validates undeclared reads even when dead and binds only reachable slots`, () => {
    const raw = {
      nodes: [
        ...read().nodes,
        { id: "unused", op: "readBuffer", buffer: "unused", inputs: ["index"] },
      ],
      output: "value",
    };
    const result = compileGraphDeclaration(raw, "vec3", {
      domain,
      buffers: { source: "vec3", unused: "vec4" },
    });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.graph.bufferTypes, { source: "vec3" });
    assert.equal(result.graph.nodes.length, 2);
    const missing = compileGraphDeclaration(raw, "vec3", {
      domain,
      buffers: { source: "vec3" },
    });
    assert.ok(
      missing.issues.some(
        (issue) =>
          issue.code === "TC_COMPUTE_BINDING" &&
          issue.owner === raw.nodes[2] &&
          issue.field === "buffer",
      ),
    );
    for (const buffer of ["missing", "toString", "constructor"]) {
      const unbound = compileGraphDeclaration(read(buffer), "float", {
        domain,
        buffers: {},
      });
      assert.ok(
        unbound.issues.some((issue) => issue.code === "TC_COMPUTE_BINDING"),
      );
      assert.equal(unbound.graph.outputType, "float");
      assert.equal(unbound.graph.bufferTypes, undefined);
    }
  });
}

test("material legacy, channel and vertex graphs share slots normalized before compilation", async () => {
  const result = await normalizeSource(
    source({
      buffers: [
        { name: "source", type: "vec3", buffer: "vectors", count: 2 },
        { name: "scalar", type: "float", buffer: "scalars" },
      ],
      graph: pixelRead(),
      graphs: {
        emissive: pixelRead(),
        roughness: read("scalar"),
        metalness: read("scalar"),
        opacity: read("scalar"),
        normalWorld: pixelRead(),
      },
      vertex: { position: read() },
    }),
  );
  assert.deepEqual(result.diagnostics, []);
  const material = result.ir!.materials[0];
  assert.deepEqual(material.buffers, [
    { name: "source", type: "vec3", buffer: "vectors", count: 2 },
    { name: "scalar", type: "float", buffer: "scalars" },
  ]);
  assert.deepEqual(material.graph!.bufferTypes, { source: "vec3" });
  assert.deepEqual(material.vertex!.position!.bufferTypes, { source: "vec3" });
  for (const channel of ["emissive", "normalWorld"] as const)
    assert.deepEqual(material.graphs![channel]!.bufferTypes, {
      source: "vec3",
    });
  for (const channel of ["roughness", "metalness", "opacity"] as const)
    assert.deepEqual(material.graphs![channel]!.bufferTypes, {
      scalar: "float",
    });
  const baseColor = await normalizeSource(
    source({
      graph: undefined,
      buffers: [{ name: "source", type: "vec3" }],
      graphs: { baseColor: pixelRead() },
    }),
  );
  assert.deepEqual(baseColor.diagnostics, []);
  assert.deepEqual(baseColor.ir!.materials[0].graphs!.baseColor!.bufferTypes, {
    source: "vec3",
  });
});

test("postprocess slot namespaces are independent from materials with the same ID and slot name", async () => {
  const result = await normalizeSource(
    source(
      {
        buffers: [
          { name: "source", type: "vec3", buffer: "vectors", count: 2 },
        ],
        graph: pixelRead(),
      },
      {
        buffers: [{ name: "source", type: "vec4", buffer: "colors", count: 3 }],
        graph: pixelRead(),
      },
    ),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ir!.materials[0].id, result.ir!.postProcesses![0].id);
  assert.deepEqual(result.ir!.materials[0].graph!.bufferTypes, {
    source: "vec3",
  });
  assert.deepEqual(result.ir!.postProcesses![0].graph.bufferTypes, {
    source: "vec4",
  });
  assert.deepEqual(result.ir!.postProcesses![0].buffers, [
    { name: "source", type: "vec4", buffer: "colors", count: 3 },
  ]);
  assert.equal(result.ir!.postProcesses![0].enabled, true);
  for (const domain of ["material", "postprocess"] as const) {
    const failed = await normalizeSource(
      source(
        domain === "material"
          ? { graph: read() }
          : { buffers: [{ name: "source", type: "vec3" }] },
        domain === "postprocess"
          ? { graph: read() }
          : { buffers: [{ name: "source", type: "vec4" }] },
      ),
    );
    assert.equal(failed.ir, undefined);
    assert.ok(
      failed.diagnostics.some(
        (issue) =>
          issue.code === "TC_COMPUTE_BINDING" &&
          issue.source?.line === (domain === "material" ? 2 : 3),
      ),
    );
  }
});

for (const domain of ["material", "postprocess"] as const) {
  test(`${domain} slot schema and initial binding failures have deterministic source diagnostics`, async (t) => {
    const valid = {
      name: "source",
      type: domain === "material" ? "vec3" : "vec4",
      buffer: domain === "material" ? "vectors" : "colors",
      count: domain === "material" ? 2 : 3,
    };
    const cases: [string, unknown, string][] = [
      [
        "unknown field",
        [{ ...valid, surprise: true }],
        "TC_RENDER_BUFFER_SLOT",
      ],
      ["invalid name", [{ ...valid, name: "9bad" }], "TC_RENDER_BUFFER_SLOT"],
      ["duplicate name", [valid, valid], "TC_RENDER_BUFFER_SLOT"],
      ["unknown type", [{ ...valid, type: "mat4" }], "TC_GRAPH_TYPE"],
      ["wrong type", [{ ...valid, type: "float" }], "TC_RENDER_BUFFER_TYPE"],
      ["wrong count", [{ ...valid, count: 4 }], "TC_RENDER_BUFFER_TYPE"],
      [
        "fractional count",
        [{ ...valid, count: 1.5 }],
        "TC_RENDER_BUFFER_COUNT",
      ],
      ["zero count", [{ ...valid, count: 0 }], "TC_SCHEMA_RANGE"],
      ["negative count", [{ ...valid, count: -1 }], "TC_SCHEMA_RANGE"],
      [
        "oversized count",
        [{ ...valid, count: 0x100000000 }],
        "TC_SCHEMA_RANGE",
      ],
      ["string count", [{ ...valid, count: "2" }], "TC_SCHEMA_RANGE"],
      [
        "unknown initial ID",
        [{ ...valid, buffer: "absent" }],
        "TC_RENDER_BUFFER_MISSING",
      ],
      ["wrong initial ID type", [{ ...valid, buffer: 7 }], "TC_SCHEMA_TYPE"],
      ["slots object", valid, "TC_SCHEMA_TYPE"],
      ["slot null", [null], "TC_SCHEMA_TYPE"],
    ];
    for (const [name, buffers, code] of cases)
      await t.test(name, async () => {
        const declaration = { buffers, graph: read() };
        const result = await normalizeSource(
          source(
            domain === "material" ? declaration : {},
            domain === "postprocess" ? declaration : {},
          ),
        );
        assert.equal(result.ir, undefined);
        const issue = result.diagnostics.find((issue) => issue.code === code);
        assert.ok(issue, JSON.stringify(result.diagnostics));
        assert.equal(issue.source?.file, "game.ts");
        assert.equal(issue.source?.line, domain === "material" ? 2 : 3);
        assert.ok(issue.suggestion);
      });
    const unbound = await normalizeSource(
      source(
        domain === "material"
          ? { buffers: [{ name: "source", type: "vec3" }], graph: read() }
          : {},
        domain === "postprocess"
          ? { buffers: [{ name: "source", type: "vec4" }], graph: read() }
          : {},
      ),
    );
    assert.deepEqual(unbound.diagnostics, []);
    const absent = await normalizeSource(source());
    assert.equal(absent.ir!.materials[0].buffers, undefined);
    assert.equal(absent.ir!.postProcesses![0].buffers, undefined);
  });
}

test("postprocess buffers coexist with frame reads and preserve unknown-field checks", async () => {
  const graph = {
    nodes: [
      ...pixelRead().nodes,
      {
        id: "frame",
        op: "sampleFrame",
        channel: "scene.color",
        inputs: ["uv"],
      },
      { id: "out", op: "multiply", inputs: ["value", "frame"] },
    ],
    output: "out",
  };
  const result = await normalizeSource(
    source({}, { buffers: [{ name: "source", type: "vec4" }], graph }),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.ir!.postProcesses![0].graph.frameChannels, [
    "scene.color",
  ]);
  assert.deepEqual(result.ir!.postProcesses![0].graph.bufferTypes, {
    source: "vec4",
  });
  const invalid = await normalizeSource(
    source({}, { buffers: [], surprise: true }),
  );
  assert.ok(
    invalid.diagnostics.some(
      (issue) =>
        issue.code === "TC_POSTPROCESS_FIELD" && issue.source?.line === 3,
    ),
  );
});

test("public project compilation emits material channels and postprocess buffer declarations", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pelican fragment buffer compiler "),
  );
  try {
    await writeFile(
      path.join(directory, "pelican.project.json"),
      JSON.stringify({ engineVersion: SDK_VERSION }),
    );
    await writeFile(
      path.join(directory, "game.ts"),
      source(
        {
          graph: undefined,
          buffers: [
            { name: "source", type: "vec3", buffer: "vectors", count: 2 },
          ],
          graphs: { baseColor: pixelRead() },
        },
        {
          buffers: [
            { name: "source", type: "vec4", buffer: "colors", count: 3 },
          ],
          graph: pixelRead(),
        },
      ),
    );
    const result = await compileProject({
      engineRoot,
      projectRoot: directory,
      outDir: path.join(directory, ".pelican/generated"),
    });
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.ir!.materials[0].graphs!.baseColor!.bufferTypes, {
      source: "vec3",
    });
    assert.deepEqual(result.ir!.postProcesses![0].graph.bufferTypes, {
      source: "vec4",
    });
    assert.equal(result.ir!.postProcesses![0].buffers![0].buffer, "colors");
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("pelican fragment buffer compiler "),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
