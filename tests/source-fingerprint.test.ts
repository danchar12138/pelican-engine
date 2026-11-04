import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";

test("release identity binds binary game assets and ignores generated evidence and local dependencies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threecat fingerprint "));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("threecat fingerprint "));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "examples/demo/assets"), { recursive: true });
  await mkdir(path.join(root, "evidence/m2"), { recursive: true });
  await writeFile(path.join(root, "examples/demo/game.ts"), "export default 1");
  const asset = path.join(root, "examples/demo/assets/model.glb");
  await writeFile(asset, Buffer.from([0, 1, 2, 3]));
  const a = await sourceFingerprint(root);
  assert.ok(a.files.some((f) => f.path === "examples/demo/assets/model.glb"));
  await writeFile(asset, Buffer.from([0, 1, 2, 4]));
  const b = await sourceFingerprint(root);
  assert.notEqual(a.sha256, b.sha256);
  await writeFile(
    path.join(root, "evidence/m2/frame.png"),
    Buffer.from([1, 2, 3]),
  );
  assert.equal((await sourceFingerprint(root)).sha256, b.sha256);
  await writeFile(
    path.join(root, "examples/demo/assets/opaque.custom"),
    Buffer.from([9, 8, 7]),
  );
  assert.notEqual((await sourceFingerprint(root)).sha256, b.sha256);
});
