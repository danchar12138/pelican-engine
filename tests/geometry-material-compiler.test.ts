import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as THREE from "three/webgpu";
import ts from "typescript";
import { Extractor } from "../packages/compiler/src/extract.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { normalize } from "../packages/compiler/src/normalize.ts";
import type { ObjectValue } from "../packages/compiler/src/extract.ts";
import {
  SDK_VERSION,
  type BufferGeometryInput,
} from "../packages/sdk/src/index.ts";
import { createManagedGeometry } from "../packages/renderer/src/managed-geometry.ts";
import { setupPBRMaterial } from "../packages/renderer/src/pbr-material.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
} from "../packages/renderer/src/surface-gpu.ts";
const geometry = (): BufferGeometryInput => ({
  kind: "buffer",
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uv: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
  computeBounds: true,
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(base, "pelican-managed-geometry-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith("pelican-managed-geometry-"));
    await rm(root, { recursive: true, force: true });
  });
  await cp("examples/vertex/assets/height.png", path.join(root, "image.png"));
  return root;
}
const source = (
  mode: string,
) => `import {defineGame,defineScene,defineAsset,defineMaterial} from "pelican-engine";
const image=defineAsset({id:"image",type:"texture",path:"image.png",license:"CC0-1.0"});
const material=defineMaterial({id:"pbr",color:"white",roughness:0.8,metalness:0.6,emissive:"white",texture:image,normalMap:image,roughnessMap:"image",metalnessMap:image,aoMap:image,emissiveMap:image,normalScale:[0.5,-1]});
export default defineGame({id:"managed",assets:[image],render:{mode:"${mode}"},scene:defineScene({id:"main",entities:[{id:"shape",mesh:{geometry:${JSON.stringify(geometry())},material}}]})});`;
test("public static and TypeScript compilation accepts managed geometry and PBR assets for raster/path/hybrid and feeds actual Three extraction", async (t) => {
  const root = await fixture(t);
  for (const [mode, content] of [
    ["raster", "typescript"],
    ["path", "typescript"],
    ["hybrid", "typescript"],
    ["raster", "static"],
    ["path", "static"],
    ["hybrid", "static"],
  ]) {
    await writeFile(path.join(root, "game.ts"), source(mode!));
    await writeFile(
      path.join(root, "pelican.project.json"),
      JSON.stringify({ engineVersion: SDK_VERSION, content }),
    );
    const compiled = await compileProject({
      projectRoot: root,
      engineRoot: process.cwd(),
      outDir: path.join(root, "out-" + mode + "-" + content),
    });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    const ir = compiled.ir!;
    assert.deepEqual({ ...ir.scene.entities[0]!.mesh!.geometry }, geometry());
    for (const slot of [
      "texture",
      "normalMap",
      "roughnessMap",
      "metalnessMap",
      "aoMap",
      "emissiveMap",
    ] as const)
      assert.equal(ir.materials[0]![slot], "image");
    assert.deepEqual(ir.materials[0]!.normalScale, [0.5, -1]);
    const g = createManagedGeometry(
        ir.scene.entities[0]!.mesh!.geometry,
        "shape",
      ),
      m = new THREE.MeshStandardNodeMaterial({
        color: ir.materials[0]!.color,
        roughness: ir.materials[0]!.roughness,
        metalness: ir.materials[0]!.metalness,
      });
    const image = new THREE.DataTexture(
      new Uint8Array([128, 128, 255, 255]),
      1,
      1,
    );
    image.colorSpace = THREE.SRGBColorSpace;
    const capture = createSurfaceCapture(),
      scene = new THREE.Scene();
    try {
      setupPBRMaterial(m, ir.materials[0]!, new Map([["image", image]]));
      scene.add(new THREE.Mesh(g, m));
      const snapshot = capture.capture(scene).surface;
      assert.equal(snapshot.triangles.length, 1);
      assert.ok(packSurfaceGeometry(snapshot).length > 0);
      assert.ok(packSurfaceResources(snapshot).materials.length > 0);
    } finally {
      capture.dispose();
      m.dispose();
      g.dispose();
      image.dispose();
    }
  }
});
async function normalized(g: unknown, material: Record<string, unknown> = {}) {
  const mat = { kind: "material", id: "pbr", ...material };
  const game = {
    kind: "game",
    id: "invalid",
    scene: {
      kind: "scene",
      id: "main",
      entities: [{ id: "shape", mesh: { geometry: g, material: "pbr" } }],
    },
  };
  return normalize(
    game as unknown as ObjectValue,
    {
      definitions: [mat] as ObjectValue[],
      source: () => ({ file: "game.ts", line: 7, column: 3, length: 1 }),
    },
    process.cwd(),
  );
}
test("normalization emits stable source diagnostics with repairs for invalid buffer numbers, attribute shapes and indices", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ positions: [] }, "ATTRIBUTE"],
    [{ positions: [0, 0] }, "ATTRIBUTE"],
    [{ positions: [NaN, 0, 0, 1, 0, 0, 0, 1, 0] }, "NUMBER"],
    [{ positions: [Infinity, 0, 0, 1, 0, 0, 0, 1, 0] }, "NUMBER"],
    [{ positions: [1e40, 0, 0, 1, 0, 0, 0, 1, 0] }, "NUMBER"],
    [{ positions: [1e-50, 0, 0, 1, 0, 0, 0, 1, 0] }, "NUMBER"],
    [{ normals: [0, 0, 1] }, "ATTRIBUTE"],
    [{ uv: [0, 0] }, "ATTRIBUTE"],
    [{ normals: [0, 0, 0, 0, 0, 1, 0, 0, 1] }, "NORMAL"],
    [{ indices: [] }, "INDEX"],
    [{ indices: [0, 1] }, "INDEX"],
    ...[-1, 3, 0.5, NaN, Infinity].map(
      (index) =>
        [{ indices: [0, 1, index] }, "INDEX"] as [
          Record<string, unknown>,
          string,
        ],
    ),
    [{ computeBounds: "yes" }, "BOUNDS"],
    [{ unexpected: 1 }, "FIELD"],
  ];
  for (const [patch, code] of cases) {
    const result = await normalized({ ...geometry(), ...patch });
    const error = result.diagnostics.find(
      (d) => d.code === "TC_GEOMETRY_" + code,
    );
    assert.ok(error, JSON.stringify(result.diagnostics));
    assert.equal(result.ir, undefined);
    assert.equal(error.source!.file, "game.ts");
    assert.ok(error.suggestion);
  }
  const nonindexed = geometry();
  delete nonindexed.indices;
  nonindexed.positions = [0, 0, 0, 1, 0, 0];
  assert.ok(
    (await normalized(nonindexed)).diagnostics.some(
      (d) => d.code === "TC_GEOMETRY_INDEX",
    ),
  );
});
test("normalization validates PBR asset IDs and normalScale even when declarations bypass TypeScript", async () => {
  for (const normalScale of [
    [NaN, 1],
    [Infinity, 1],
    [1e40, 1],
    [1e-50, 1],
    [1],
    [1, 2, 3],
    "bad",
    new Array(2),
    null,
  ]) {
    const result = await normalized(geometry(), { normalScale });
    assert.ok(
      result.diagnostics.some((d) => d.code === "TC_MATERIAL_NORMAL_SCALE"),
    );
  }
  for (const slot of [
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
  ]) {
    const result = await normalized(geometry(), { [slot]: "undeclared" });
    assert.ok(result.diagnostics.some((d) => d.code === "TC_ASSET_TYPE"));
    assert.equal(result.ir, undefined);
  }
});

test("buffer materials with maps require primary UVs during normalization", async () => {
  const g = geometry();
  delete g.uv;
  const result = await normalized(g, { normalMap: "image" });
  assert.ok(result.diagnostics.some((d) => d.code === "TC_GEOMETRY_UV"));
});

test("static content extraction normalizes managed geometry and defineAsset map references", async (t) => {
  const root = await fixture(t),
    entry = path.join(root, "game.ts");
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options),
    file = ts.createSourceFile(
      entry,
      source("raster"),
      ts.ScriptTarget.ESNext,
      true,
    );
  host.getSourceFile = (name) =>
    path.resolve(name) === entry ? file : undefined;
  const extractor = new Extractor(
    ts.createProgram([entry], options, host),
    root,
    path.resolve("packages/sdk/src/index.ts"),
  );
  const game = extractor.extract(entry);
  assert.deepEqual(extractor.diagnostics, []);
  assert.ok(game);
  const result = await normalize(game, extractor, root);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.ir);
  assert.deepEqual(
    { ...result.ir.scene.entities[0]!.mesh!.geometry },
    geometry(),
  );
  for (const slot of [
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
  ] as const)
    assert.equal(result.ir.materials[0]![slot], "image");
});
