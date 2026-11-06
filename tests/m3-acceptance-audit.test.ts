import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "fast-png";
import { M3_EVIDENCE_REQUIREMENTS } from "../tools/m3-acceptance-contract.ts";
import { auditM3Acceptance } from "../tools/m3-acceptance-audit.ts";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";
import { writeAuditBackend } from "./fixtures/m3-audit-backend.ts";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const colors = [[70,70,70], [0,0,0], [220,30,20], [20,210,30], [70,70,70]];
function screenshot() {
  const data = new Uint8Array(320 * 240 * 4);
  for (let i = 0; i < 320 * 240; i++) data[i * 4 + 3] = 255;
  [73,109,146,182,247].forEach((x, n) => { for (let y = 117; y < 124; y++) for (let px = x - 3; px < x + 4; px++) data.set(colors[n], (y * 320 + px) * 4); });
  return encode({ width: 320, height: 240, data, channels: 4, depth: 8 });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(path.join(tmpdir(), "m3-audit-"));
  t.after(async () => { assert.equal(path.dirname(temp), path.resolve(tmpdir())); assert.ok(path.basename(temp).startsWith("m3-audit-")); await rm(temp, { recursive: true, force: true }); });
  const sourceRoot = path.join(temp, "source"), evidenceRoot = path.join(temp, "evidence");
  await mkdir(sourceRoot); await mkdir(evidenceRoot);
  await writeFile(path.join(sourceRoot, "probe.ts"), "fixture\n");
  const source = (await sourceFingerprint(sourceRoot)).sha256;
  return { temp, sourceRoot, evidenceRoot, source, options: { sourceRoot, evidenceRoot, backendDirectory: "backend", specularDirectory: "specular" } };
}
async function backend(f: Awaited<ReturnType<typeof fixture>>) {
  return writeAuditBackend(path.join(f.evidenceRoot, "backend"), await sourceFingerprint(f.sourceRoot));
}
async function specular(f: Awaited<ReturnType<typeof fixture>>) {
  const dir = path.join(f.evidenceRoot, "specular"); await mkdir(dir);
  const resources = { disposed: false, owned: { entries: 1, pending: 0, loaded: 1, references: 1, scopes: 1, inFlightLoads: 0, inFlightDisposals: 0 }, entries: [{ type: "json", key: "scene", state: "loaded", refCount: 1 }] };
  const before = { tick: 4, mode: "hybrid", records: [{ id: "scene" }], recovery: { active: false, count: 0, events: [] }, resources };
  const after = structuredClone(before); after.recovery.count = 1; after.recovery.events = [{ phase: "lost", tick: 4 }, { phase: "restored", tick: 4 }] as never[];
  const samples = Object.fromEntries(["gray", "zeroAlphaRed", "red", "green", "grayReference"].map((n, i) => [n, colors[i]]));
  const modes = ["initial", "restored", "rejected", "recovered"].flatMap(stage => ["raster", "path", "hybrid"].map(mode => ({ stage, mode, screenshot: `${stage}-${mode}.png`, observation: { before: { tick: 4, mode, records: [{ id: "scene" }] }, after: { tick: 4, mode, records: [{ id: "scene" }] } }, samples, resources: structuredClone(resources), models: { disposed: false, instances: 1, owned: { textures: 2 } }, capabilities: { tracerInitialized: true }, surface: { triangleCount: 4, capture: { textures: { entries: 2, texels: 20 } } } })));
  const report = { scope: "KHR_materials_specular texture game probe", passed: true, compileOnly: false, phase: "complete", sourceIdentity: f.source, errors: [], modes, lifecycle: {
    initialRasterCapabilities: { tracerInitialized: false, tracer: "lazy initialization" }, activatedPathCapabilities: { tracerInitialized: true },
    snapshot: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: { format: "pelican.resources", version: 1, resources: [{ type: "json", key: "scene", state: "loaded" }] } }, steppedTick: 5,
    restore: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: structuredClone(resources) }, invalidRestore: { status: "failed", data: null, diagnostics: [{ code: "TC_BROWSER_SNAPSHOT", severity: "error" }] },
    beforeRejection: { tick: 4, mode: "hybrid", records: [{ id: "scene" }] }, afterRejection: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: structuredClone(resources) }, beforeRecovery: before, recovery: after,
  } };
  for (const entry of modes) await writeFile(path.join(dir, entry.screenshot), screenshot());
  await writeFile(path.join(dir, "specular-textures-game.json"), JSON.stringify(report));
  return { dir, report };
}
test("two distinct structured hardware-shaped semantic slices verify, never formal M3", async t => {
  const f = await fixture(t); await backend(f); await specular(f);
  const result = await auditM3Acceptance(f.options);
  assert.deepEqual(result.checks.map(c => c.status), ["verified", "verified"]);
  assert.equal(result.status, "failed"); assert.equal(result.releaseAllowed, false); assert.equal(result.formalMilestoneAccepted, false);
  assert.equal(result.sourceSha256, f.source);
  assert.deepEqual([...new Set(result.missing.map(m => m.category))].sort(), Object.keys(M3_EVIDENCE_REQUIREMENTS).sort());
  assert.equal(result.missing.length, Object.values(M3_EVIDENCE_REQUIREMENTS).reduce((n, entries) => n + entries.length, 0));
  for (const category of ["independent-ai", "distribution", "verification", "performance", "scene-dynamic", "webgl-fallback"]) assert.ok(result.missing.some(m => m.category === category));
  assert.match(result.errors.join(" "), /registry parity/);
});
test("empty, reused, forged and corrupted evidence cannot unlock release", async t => {
  const f = await fixture(t);
  const empty = await auditM3Acceptance(f.options);
  assert.deepEqual(empty.checks.map(c => c.status), ["failed", "failed"]);
  assert.equal(empty.releaseAllowed, false);
  const b = await backend(f);
  const reused = await auditM3Acceptance({ ...f.options, specularDirectory: "backend" });
  assert.deepEqual(reused.checks.map(c => c.status), ["verified", "failed"]);
  assert.match(reused.checks[1].details.join(" "), /reused/);
  const s = await specular(f);
  s.report.modes[0].observation.before.mode = "hybrid";
  await writeFile(path.join(s.dir, "specular-textures-game.json"), JSON.stringify(s.report));
  let result = await auditM3Acceptance(f.options);
  assert.deepEqual(result.checks.map(c => c.status), ["verified", "failed"]);
  assert.match(result.checks[1].details.join(" "), /actualMode/);
  await writeFile(path.join(s.dir, "specular-textures-game.json"), JSON.stringify({ ...s.report, passed: true, status: "passed" }));
  await writeFile(path.join(b.dir, "webgpu/recovered-path.png"), "not a PNG");
  result = await auditM3Acceptance(f.options);
  assert.deepEqual(result.checks.map(c => c.status), ["failed", "failed"]);
  assert.equal(result.releaseAllowed, false);
  await writeFile(path.join(f.sourceRoot, "probe.ts"), "changed\n");
  result = await auditM3Acceptance(f.options);
  assert.equal(result.checks[0].status, "failed"); assert.equal(result.releaseAllowed, false);
});
test("requires explicit safe directories, rejects traversal and implicit discovery", async t => {
  const f = await fixture(t);
  let result = await auditM3Acceptance({ sourceRoot: f.sourceRoot, evidenceRoot: f.evidenceRoot });
  assert.deepEqual(result.checks.map(c => c.status), ["missing", "missing"]);
  result = await auditM3Acceptance({ ...f.options, backendDirectory: "../outside", specularDirectory: "C:/absolute" });
  assert.deepEqual(result.checks.map(c => c.status), ["failed", "failed"]);
  assert.ok(result.checks.every(c => /safe explicit/.test(c.details.join(" "))));
  result = await auditM3Acceptance({ ...f.options, sourceRoot: "relative" });
  assert.match(result.errors.join(" "), /absolute directory required/);
  result = await auditM3Acceptance({ ...f.options, evidenceRoot: f.sourceRoot });
  assert.match(result.errors.join(" "), /must be disjoint/);
  result = await auditM3Acceptance({ ...f.options, evidenceRoot: f.temp });
  assert.match(result.errors.join(" "), /must be disjoint/);
});
test("backend evidence from another frozen source cannot be rescued by a passed claim", async t => {
  const f = await fixture(t);
  const { dir: backendDir, report } = await backend(f);
  await writeFile(path.join(f.sourceRoot, "probe.ts"), "another frozen source\n");
  await writeFile(path.join(backendDir, "report.json"), JSON.stringify({ ...report, passed: true, status: "passed" }));
  const result = await auditM3Acceptance(f.options);
  assert.equal(result.checks[0].status, "failed");
  assert.match(result.checks[0].details.join(" "), /source: fingerprint mismatch/);
  assert.equal(result.releaseAllowed, false);
});
test("specular screenshots and report from another source remain unaccepted", async t => {
  const f = await fixture(t);
  await specular(f);
  await writeFile(path.join(f.sourceRoot, "probe.ts"), "another frozen source\n");
  const result = await auditM3Acceptance(f.options);
  assert.equal(result.checks[1].status, "failed");
  assert.match(result.checks[1].details.join(" "), /sourceIdentity: mismatch/);
  assert.equal(result.formalMilestoneAccepted, false);
});
test("CLI refuses missing roots and never returns a successful acceptance exit", async t => {
  const f = await fixture(t);
  const runner = path.join(project, "node_modules/tsx/dist/cli.mjs");
  const tool = path.join(project, "tools/m3-acceptance-audit.ts");
  const missing = spawnSync(process.execPath, [runner, tool], { encoding: "utf8", timeout: 15000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /source-root and --evidence-root required/);
  const audit = spawnSync(process.execPath, [runner, tool, "--source-root", f.sourceRoot, "--evidence-root", f.evidenceRoot], { encoding: "utf8", timeout: 15000 });
  assert.equal(audit.status, 1);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.status, "failed"); assert.equal(result.releaseAllowed, false); assert.equal(result.formalMilestoneAccepted, false);
});
