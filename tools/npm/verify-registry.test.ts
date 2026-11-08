import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyRegistryInstallLock, verifyRegistryPackage } from "./verify-registry.ts";

const version = "0.3.32", bytes = new TextEncoder().encode("synthetic package bytes");
const hash = (algorithm: string, encoding: "hex" | "base64") => createHash(algorithm).update(bytes).digest(encoding);
const metadata = () => ({ name: "pelican-engine", version, dist: {
  tarball: `https://registry.npmjs.org/pelican-engine/-/pelican-engine-${version}.tgz`,
  integrity: `sha512-${hash("sha512", "base64")}`, shasum: hash("sha1", "hex"),
} });
async function fixture(run: (tarball: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "pelican-registry-"));
  try { const file = path.join(dir, "package.tgz"); await writeFile(file, bytes); await run(file); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(dir).startsWith("pelican-registry-"));
    await rm(dir, { recursive: true, force: true });
  }
}
const fetchWith = (record = metadata(), data = bytes): typeof fetch => async (url) =>
  String(url).endsWith(".tgz") ? new Response(data) : Response.json(record);

test("post-publication check compares exact registry metadata and downloaded bytes", async () => fixture(async tarball => {
  const result = await verifyRegistryPackage({ version, tarball, fetcher: fetchWith() });
  assert.equal(result.status, "verified");
  assert.equal(result.version, version);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, hash("sha256", "hex"));
  assert.equal(result.formalMilestoneAccepted, false);
}));

test("registry installation lock rejects local aliases, version drift and different bytes", () => {
  const entry = { version, integrity: `sha512-${hash("sha512", "base64")}`, resolved: metadata().dist.tarball };
  const lock = (value: unknown) => ({ packages: { "node_modules/pelican-engine": value } });
  assert.doesNotThrow(() => verifyRegistryInstallLock(lock(entry), version, bytes));
  for (const invalid of [null, { ...entry, version: "1.0.0" }, { ...entry, integrity: "sha512-bad" }, { ...entry, resolved: "file:engine.tgz" }])
    assert.throws(() => verifyRegistryInstallLock(lock(invalid), version, bytes), /TC_NPM_REGISTRY_INSTALL_MISMATCH/);
});

test("rejects wrong metadata, tarball location and substituted bytes", async () => fixture(async tarball => {
  for (const change of [
    { ...metadata(), version: "1.0.0" },
    { ...metadata(), name: "other" },
    { ...metadata(), dist: { ...metadata().dist, shasum: "0".repeat(40) } },
    { ...metadata(), dist: { ...metadata().dist, integrity: "sha512-invalid" } },
  ]) await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher: fetchWith(change) }), /TC_NPM_REGISTRY_MISMATCH/);
  for (const url of ["https://example.test/a.tgz", "https://registry.npmjs.org/other.tgz", metadata().dist.tarball + "?other=1"])
    await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher: fetchWith({ ...metadata(), dist: { ...metadata().dist, tarball: url } }) }), /TC_NPM_REGISTRY_METADATA/);
  await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher: fetchWith(metadata(), new TextEncoder().encode("synthetic package bytEz")) }), /TC_NPM_REGISTRY_MISMATCH/);
  await assert.rejects(verifyRegistryPackage({ version: "../bad", tarball, fetcher: fetchWith() }), /TC_NPM_REGISTRY_VERSION/);
}));

test("retries temporary unpublished responses but never claims success on absence", async () => fixture(async tarball => {
  let calls = 0, waits = 0;
  const delayed: typeof fetch = async url => {
    if (String(url).endsWith(".tgz")) return new Response(bytes);
    return ++calls < 3 ? new Response("missing", { status: 404 }) : Response.json(metadata());
  };
  assert.equal((await verifyRegistryPackage({ version, tarball, fetcher: delayed, wait: async () => { waits++; } })).status, "verified");
  assert.equal(calls, 3); assert.equal(waits, 2);
  calls = 0;
  await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher: async () => { calls++; return new Response("missing", { status: 404 }); }, wait: async () => {} }), /TC_NPM_REGISTRY_UNAVAILABLE.*may already be published/);
  assert.equal(calls, 16);
}));

test("rejects oversized registry metadata before buffering without requesting a tarball", async () => fixture(async tarball => {
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return new Response(new Uint8Array(1024 * 1024 + 1)); };
  await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher }), /TC_NPM_REGISTRY_METADATA.*too large/);
  assert.equal(requests, 1);
}));

test("retries tarball propagation without weakening byte comparison", async () => fixture(async tarball => {
  let downloads = 0, waits = 0;
  const delayed: typeof fetch = async url => {
    if (!String(url).endsWith(".tgz")) return Response.json(metadata());
    return ++downloads < 3 ? new Response("not ready", { status: 404 }) : new Response(bytes);
  };
  assert.equal((await verifyRegistryPackage({ version, tarball, fetcher: delayed, wait: async () => { waits++; } })).status, "verified");
  assert.equal(downloads, 3); assert.equal(waits, 2);
  downloads = 0;
  const missing: typeof fetch = async url => String(url).endsWith(".tgz") ? (downloads++, new Response("missing", { status: 404 })) : Response.json(metadata());
  await assert.rejects(verifyRegistryPackage({ version, tarball, fetcher: missing, wait: async () => {} }), /TC_NPM_REGISTRY_DOWNLOAD.*do not republish blindly/);
  assert.equal(downloads, 16);
}));

test("workflow tests before publish, verifies registry afterwards and uses no long-lived token", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/npm-publish.yml"), "utf8");
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  const ci = await readFile(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run verify/);
  assert.match(ci, /ubuntu-latest, windows-latest, macos-latest/);
  assert.ok(workflow.indexOf("npm publish") < workflow.indexOf("distribution:verify-registry"));
  assert.equal((workflow.match(/NODE_AUTH_TOKEN:/g) ?? []).length, 0);
  assert.match(workflow, /id-token: write/);
});

test("registry propagation may take more than 100 seconds without requiring a second publication", async () => fixture(async tarball => {
  let elapsed = 0;
  const slow: typeof fetch = async url => String(url).endsWith(".tgz") ? new Response(bytes) : elapsed < 100000 ? new Response("processing", { status: 404 }) : Response.json(metadata());
  const result = await verifyRegistryPackage({ version, tarball, fetcher: slow, wait: async ms => { elapsed += ms; } });
  assert.equal(result.status, "verified");
  assert.ok(elapsed >= 100000 && elapsed <= 361000);
}));
