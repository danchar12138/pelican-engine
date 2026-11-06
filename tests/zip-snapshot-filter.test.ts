import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { includeZipSnapshotPath } from "../tools/zip-snapshot-filter.ts";

test("ZIP validation snapshot excludes local caches and credential-shaped files", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pelican-zip-filter-"));
  const root = path.join(temp, "source"), out = path.join(temp, "output");
  try {
    for (const name of ["packages/sdk/src", "examples/assets", ".threecat/cache", ".pelican", ".ssh", ".env.private", "node_modules/dep"]) await mkdir(path.join(root, name), { recursive: true });
    for (const [name, contents] of Object.entries({
      "packages/sdk/src/index.ts": "export const sdk = 1;", "examples/assets/model.glb": "fixture",
      ".threecat/cache/private.json": "cached data", ".pelican/run.json": "cache",
      ".ssh/id_ed25519": "not a real key", ".env.private/data.txt": "local settings", "node_modules/dep/index.js": "dependency",
      ".npmrc": "local configuration", ".env.local": "local settings", "api-token.json": "local secret",
      "debug.log": "local log", "server.key": "not a real key",
    })) await writeFile(path.join(root, name), contents);
    await cp(root, out, { recursive: true, filter: source => includeZipSnapshotPath(root, source) });
    assert.equal(await readFile(path.join(out, "packages/sdk/src/index.ts"), "utf8"), "export const sdk = 1;");
    assert.equal(await readFile(path.join(out, "examples/assets/model.glb"), "utf8"), "fixture");
    for (const name of [".threecat", ".pelican", ".ssh", ".env.private", "node_modules", ".npmrc", ".env.local", "api-token.json", "debug.log", "server.key"])
      await assert.rejects(readFile(path.join(out, name)), { code: "ENOENT" }, name);
    await assert.rejects(includeZipSnapshotPath(root, temp), /TC_ZIP_SOURCE_PATH/);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith("pelican-zip-filter-"));
    await rm(temp, { recursive: true, force: true });
  }
});
