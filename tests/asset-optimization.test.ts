import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { optimizeModel } from "../packages/assets/src/optimize.ts";
import { compressDist } from "../tools/compress-dist.ts";
import { serveDist } from "../tools/static-server.ts";
import { NodeIO } from "@gltf-transform/core";
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "threecat optimize "));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("threecat optimize "));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
test("lossless GLB weld/dedup preserves actual triangles, skin, animation and source bytes", async (t) => {
  const root = await temporary(t),
    input = path.resolve("examples/m2/assets/Fox.glb"),
    before = await readFile(input),
    output = path.join(root, "fox.glb");
  const report = await optimizeModel(input, output);
  assert.equal(report.before.triangleCount, report.after.triangleCount);
  assert.equal(report.after.animationCount, 3);
  assert.equal(report.after.jointCount, 24);
  assert.ok(report.bytesSaved > 0);
  assert.deepEqual(await readFile(input), before);
  const io = new NodeIO(),
    a = await io.read(input),
    b = await io.read(output);
  const streams = (doc: typeof a) =>
    doc
      .getRoot()
      .listMeshes()
      .flatMap((mesh) =>
        mesh.listPrimitives().map((primitive) => {
          const positions = primitive.getAttribute("POSITION")!,
            indices = primitive.getIndices();
          return Array.from(
            { length: indices?.getCount() ?? positions.getCount() },
            (_, i) =>
              positions.getElement(indices ? indices.getScalar(i) : i, []),
          );
        }),
      );
  assert.deepEqual(streams(a), streams(b));
  const saved = await readFile(output);
  await assert.rejects(
    optimizeModel(input, output),
    /TC_ASSET_OPTIMIZE_EXISTS/,
  );
  assert.deepEqual(await readFile(output), saved);
  await assert.rejects(optimizeModel(input, input), /TC_ASSET_OPTIMIZE_PATH/);
});
test("lossless static compression negotiates encodings, keeps originals and honors q=0", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "generated"));
  const text =
    "export const repeated=" +
    JSON.stringify("mesh vertex attribute ".repeat(1000)) +
    ";";
  await writeFile(path.join(root, "generated/game.js"), text);
  await writeFile(path.join(root, "index.html"), "<p>game</p>");
  const report = await compressDist(root);
  assert.equal(report.entries.length, 1);
  assert.ok(report.entries[0].encodings.br!.bytes < Buffer.byteLength(text));
  assert.equal(
    await readFile(path.join(root, "generated/game.js"), "utf8"),
    text,
  );
  const server = await serveDist(root, 0, "/nested/");
  t.after(() => server.close());
  for (const [header, expected] of [
    ["br, gzip", "br"],
    ["br;q=0,gzip;q=1", "gzip"],
    ["br;q=0,gzip;q=0", null],
    ["identity", null],
  ] as const) {
    const response = await fetch(server.url + "generated/game.js", {
      headers: { "accept-encoding": header },
    });
    assert.equal(response.headers.get("content-encoding"), expected);
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.equal(await response.text(), text);
  }
  assert.equal((await fetch(server.url + "missing.glb")).status, 404);
});
