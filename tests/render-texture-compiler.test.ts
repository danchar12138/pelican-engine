import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const sample = (texture: unknown = "field", rgb = false) => ({
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "sample", op: "sampleTexture", texture, inputs: ["uv"] },
    ...(rgb ? [{ id: "rgb", op: "swizzle", components: "xyz", inputs: ["sample"] }] : []),
  ],
  output: rgb ? "rgb" : "sample",
});
const initial = '[{id:"initial",width:2,height:1,data:[[1,0,0,1],[0,1,0,1]]}]';
function source({ material = {}, post = {}, computeTextures = initial } : {
  material?: Record<string, unknown>;
  post?: Record<string, unknown>;
  computeTextures?: string;
} = {}) {
  return `import {defineGame,defineScene,defineMaterial,definePostProcess,defineAsset} from "pelican-engine";
const image=defineAsset({id:"image",type:"texture",path:"height.png",license:"CC0-1.0",colorSpace:"linear"});
const blob=defineAsset({id:"blob",type:"binary",path:"blob.bin",license:"CC0-1.0"});
const material=defineMaterial(${JSON.stringify({ id: "shared", textures: [{ name: "field" }], graph: sample("field", true), ...material })});
const pass=definePostProcess(${JSON.stringify({ id: "shared", textures: [{ name: "field" }], graph: sample(), ...post })});
export default defineGame({id:"renderTextures",assets:[image,blob],computeBuffers:[{id:"buffer",type:"vec4",count:1}],computeTextures:${computeTextures},postProcesses:[pass],scene:defineScene({id:"main",entities:[{id:"shape",mesh:{geometry:{kind:"box"},material}}]})});`;
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican render texture compiler "));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("pelican render texture compiler "));
    await rm(root, { recursive: true, force: true });
  });
  await cp(path.join(engineRoot, "examples/vertex/assets/height.png"), path.join(root, "height.png"));
  await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1]));
  const image = await readFile(path.join(root, "height.png"));
  return { root, width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

// Malformed declarations go through extraction/normalization directly so these
// cases exercise stable engine diagnostics without a project typecheck per case.
async function normalizeSource(code: string, projectRoot: string) {
  const entry = path.join(projectRoot, "game.ts");
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const file = ts.createSourceFile(entry, code, ts.ScriptTarget.ESNext, true);
  host.getSourceFile = name => path.resolve(name) === entry ? file : undefined;
  const extractor = new Extractor(ts.createProgram([entry], options, host), projectRoot, path.join(engineRoot, "packages/sdk/src/index.ts"));
  const game = extractor.extract(entry);
  assert.deepEqual(extractor.diagnostics, []);
  assert.ok(game);
  return normalize(game, extractor, projectRoot);
}

test("public compilation emits managed texture slots in legacy, channel, vertex and postprocess graphs and preserves asset imports", async t => {
  const { root, width, height } = await fixture(t);
  const legacy = sample("field", true);
  legacy.nodes.push({ id: "dead", op: "sampleTexture", texture: "unused", inputs: ["uv"] });
  const postGraph = {
    nodes: [
      { id: "uv", op: "input", name: "uv" },
      { id: "managed", op: "sampleTexture", texture: "field", inputs: ["uv"] },
      { id: "static", op: "sampleTexture", texture: "image", inputs: ["uv"] },
      { id: "out", op: "add", inputs: ["managed", "static"] },
    ], output: "out",
  };
  const code = source({
    computeTextures: initial.slice(0, -1) + ',{id:"imported",asset:image},{id:"byID",asset:"image"}]',
    material: {
      textures: [{ name: "field", texture: "initial", width: 2, height: 1 }, { name: "unused" }],
      graph: legacy,
      graphs: { emissive: sample("field", true) },
      vertex: { position: sample("field", true), normal: sample("image", true) },
    },
    post: {
      textures: [{ name: "field", texture: "imported", width, height, filter: "nearest", wrapU: "repeat", wrapV: "mirror" }],
      graph: postGraph,
    },
  }).replaceAll('"texture":"image"', '"texture":image');
  await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
  await writeFile(path.join(root, "game.ts"), code);
  const result = await compileProject({ engineRoot, projectRoot: root, outDir: path.join(root, "output") });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const ir = result.ir!, material = ir.materials[0], post = ir.postProcesses![0];
  const defaults = { name: "field", filter: "linear", wrapU: "clamp", wrapV: "clamp" };
  const sampler = { name: "field", filter: "nearest", wrapU: "repeat", wrapV: "mirror" };
  assert.deepEqual(ir.computeTextures, [
    { id: "initial", width: 2, height: 1, data: [[1, 0, 0, 1], [0, 1, 0, 1]] },
    { id: "imported", asset: "image" }, { id: "byID", asset: "image" },
  ]);
  assert.deepEqual(material.textures, [{ ...defaults, texture: "initial", width: 2, height: 1 }, { ...defaults, name: "unused" }]);
  for (const graph of [material.graph!, material.graphs!.emissive!, material.vertex!.position!]) {
    assert.deepEqual(graph.textureSlots, { field: defaults });
    assert.deepEqual(graph.textureIds, ["field"]);
  }
  assert.ok(!material.graph!.nodes.some(node => node.id === "dead"));
  assert.equal(material.vertex!.normal!.textureSlots, undefined);
  assert.deepEqual(material.vertex!.normal!.textureIds, ["image"]);
  assert.deepEqual(post.textures, [{ ...sampler, texture: "imported", width, height }]);
  assert.deepEqual(post.graph.textureSlots, { field: sampler });
  assert.deepEqual([...post.graph.textureIds!].sort(), ["field", "image"]);
  assert.equal(ir.assets.find(asset => asset.id === "image")!.colorSpace, "linear");
  assert.ok(result.report.modules.includes("compute-textures"));
});

test("shared render texture normalization rejects invalid slots, ambiguous names, initial resources and dimensions at source", async t => {
  const { root, width, height } = await fixture(t);
  const cases: [unknown, string][] = [
    [[], "TC_GRAPH_TEXTURE"],
    [[{ name: "field" }, { name: "field" }], "TC_RENDER_TEXTURE_SLOT"],
    [[{ name: "1invalid" }], "TC_RENDER_TEXTURE_SLOT"],
    [[{ name: "field", buffer: "buffer" }], "TC_RENDER_TEXTURE_SLOT"],
    [[{ name: "field", filter: "cubic" }], "TC_RENDER_TEXTURE_SAMPLER"],
    [[{ name: "field", filter: null }], "TC_RENDER_TEXTURE_SAMPLER"],
    [[{ name: "field", wrapU: "border" }], "TC_RENDER_TEXTURE_SAMPLER"],
    [[{ name: "field", wrapV: "border" }], "TC_RENDER_TEXTURE_SAMPLER"],
    [[{ name: "image" }], "TC_RENDER_TEXTURE_SLOT"],
    [[{ name: "blob" }], "TC_RENDER_TEXTURE_SLOT"],
    [[{ name: "field", texture: "missing" }], "TC_RENDER_TEXTURE_MISSING"],
    [[{ name: "field", texture: "buffer" }], "TC_RENDER_TEXTURE_MISSING"],
    [[{ name: "field", texture: "image" }], "TC_RENDER_TEXTURE_MISSING"],
    [[{ name: "field", width: 1.5 }], "TC_RENDER_TEXTURE_SIZE"],
    [[{ name: "field", height: 0 }], "TC_RENDER_TEXTURE_SIZE"],
    [[{ name: "field", width: 2 ** 24, height: 2 }], "TC_RENDER_TEXTURE_SIZE"],
    [[{ name: "field", texture: "initial", width: 3 }], "TC_RENDER_TEXTURE_SIZE"],
    [[{ name: "field", texture: "initial", height: 2 }], "TC_RENDER_TEXTURE_SIZE"],
  ];
  for (const domain of ["material", "post"] as const) {
    for (const [textures, expected] of cases) {
      const result = await normalizeSource(source({ [domain]: { textures } }), root);
      const diagnostic = result.diagnostics.find(item => item.code === expected);
      assert.equal(diagnostic?.source?.file, "game.ts", JSON.stringify({ domain, textures, expected, diagnostics: result.diagnostics }));
      assert.equal(diagnostic!.source!.line, domain === "material" ? 4 : 5);
      assert.ok(diagnostic!.suggestion);
    }
    const computeTextures = '[{id:"imported",asset:image}]';
    const valid = await normalizeSource(source({ computeTextures, [domain]: { textures: [{ name: "field", texture: "imported", width, height }] } }), root);
    assert.deepEqual(valid.diagnostics, []);
    for (const dimensions of [{ width: width + 1 }, { height: height + 1 }]) {
      const result = await normalizeSource(source({ computeTextures, [domain]: { textures: [{ name: "field", texture: "imported", ...dimensions }] } }), root);
      assert.ok(result.diagnostics.some(item => item.code === "TC_RENDER_TEXTURE_SIZE" && item.source?.file === "game.ts"), JSON.stringify(result.diagnostics));
    }
  }
});

test("compute texture asset imports enforce declared texture assets, mutually exclusive fields and existing resource/value checks", async t => {
  const { root } = await fixture(t);
  const cases = [
    ['[{id:"imported",asset:"missing"}]', "TC_RESOURCE_MISSING"],
    ['[{id:"imported",asset:blob}]', "TC_ASSET_TYPE"],
    ['[{id:"imported",asset:image,width:1}]', "TC_COMPUTE_TEXTURE"],
    ['[{id:"imported",asset:image,height:1}]', "TC_COMPUTE_TEXTURE"],
    ['[{id:"imported",asset:image,data:[]}]', "TC_COMPUTE_TEXTURE"],
    ['[{id:"imported",asset:image,filter:"linear"}]', "TC_COMPUTE_TEXTURE"],
    ['[{id:"duplicate",asset:image},{id:"duplicate",width:1,height:1}]', "TC_COMPUTE_TEXTURE_NAME"],
    ['[{id:"buffer",asset:image}]', "TC_COMPUTE_TEXTURE_NAME"],
    ['[{id:"data",width:1,height:1,data:[]}]', "TC_COMPUTE_TEXTURE_SIZE"],
    ['[{id:"data",width:1,height:1,data:[[1e40,0,0,1]]}]', "TC_COMPUTE_VALUE"],
  ] as const;
  for (const [computeTextures, expected] of cases) {
    const result = await normalizeSource(source({ computeTextures }), root);
    assert.ok(result.diagnostics.some(item => item.code === expected && item.source?.file === "game.ts" && item.source.line === 6), JSON.stringify({ computeTextures, expected, diagnostics: result.diagnostics }));
  }
});

test("graph slot lookup binds only reachable declared slots, validates dead samples and preserves static asset semantics", () => {
  const field = { name: "field", filter: "nearest", wrapU: "repeat", wrapV: "mirror" } as const;
  const options = { domain: "material", textures: new Set(["image"]), textureSlots: { field, unused: { name: "unused" } } } as const;
  const raw = sample();
  raw.nodes.push({ id: "dead", op: "sampleTexture", texture: "unused", inputs: ["uv"] });
  const good = compileGraphDeclaration(raw, "vec4", options);
  assert.deepEqual(good.issues, []);
  assert.deepEqual(good.graph.textureSlots, { field });
  assert.deepEqual(good.graph.textureIds, ["field"]);
  assert.equal(compileGraphDeclaration(sample("image"), "vec4", options).graph.textureSlots, undefined);
  assert.deepEqual(compileGraphDeclaration(sample({ kind: "asset", id: "image" }), "vec4", options).issues, []);
  assert.deepEqual(compileGraphDeclaration(sample("field"), "vec4", { textureSlots: { field } }).issues, []);
  for (const texture of ["missing", "toString", { kind: "asset", id: "field" }]) {
    const result = compileGraphDeclaration(sample(texture), "vec4", options);
    assert.ok(result.issues.some(item => item.code === "TC_GRAPH_TEXTURE" && item.field === "texture"));
  }
  const deadInvalid = { ...raw, nodes: [...raw.nodes, { id: "bad", op: "sampleTexture", texture: "missing", inputs: ["uv"] }] };
  assert.ok(compileGraphDeclaration(deadInvalid, "vec4", options).issues.some(item => item.code === "TC_GRAPH_TEXTURE"));
  assert.ok(compileGraphDeclaration(sample(), "vec4", { ...options, textures: new Set(["field"]) }).issues.some(item => item.code === "TC_GRAPH_TEXTURE"));
  assert.deepEqual(compileGraphDeclaration(sample("legacy"), "vec4").issues, []);
});
