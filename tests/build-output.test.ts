import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBuildOutput, renameBuildDirectory } from "../tools/build-output.ts";

test("repeat build promotion preserves the previous tree and atomically installs the next tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-build-repeat-"));
  try {
    const first = await createBuildOutput(path.join(root, "dist"));
    await writeFile(path.join(first.staging, "index.html"), "first");
    assert.equal((await first.commit()).backup, null);
    const second = await createBuildOutput(path.join(root, "dist"));
    await writeFile(path.join(second.staging, "index.html"), "second");
    const backup = (await second.commit()).backup!;
    assert.equal(await readFile(path.join(backup, "index.html"), "utf8"), "first");
    assert.equal(await readFile(path.join(root, "dist/index.html"), "utf8"), "second");
    await assert.rejects(second.commit(), /TC_BUILD_STATE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rename retries temporary Windows locks without deleting either output", async () => {
  let calls = 0, waits = 0;
  const locked = Object.assign(new Error("temporary lock"), { code: "EPERM" });
  const move: typeof rename = async () => { if (++calls < 3) throw locked; };
  if (process.platform === "win32") {
    await renameBuildDirectory("from", "to", move, async () => { waits++; });
    assert.equal(calls, 3); assert.equal(waits, 2);
  } else await assert.rejects(renameBuildDirectory("from", "to", move), /temporary lock/);
  if (process.platform === "win32") {
    calls = 0; waits = 0;
    await assert.rejects(renameBuildDirectory("from", "to", async () => { calls++; throw locked; }, async () => { waits++; }), /temporary lock/);
    assert.equal(calls, 12); assert.equal(waits, 11);
  }
  calls = 0;
  await assert.rejects(renameBuildDirectory("from", "to", async () => { calls++; throw Object.assign(new Error("not found"), { code: "ENOENT" }); }), /not found/);
  assert.equal(calls, 1);
});
