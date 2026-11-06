import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "fast-png";
import { verifyBackendEvidence } from "../tools/m3-backend-evidence-verifier.ts";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/backend-evidence");
async function fixture(run: (dir: string, report: any, raw: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "backend-evidence-"));
  try {
    await cp(root, dir, { recursive: true });
    for (const name of ["missing-api.png", "missing-api-restored.png", "webgpu/recovered-path.png"]) {
      await cp(path.join(dir, "pixels.png"), path.join(dir, name));
    }
    const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
    const raw = JSON.parse(await readFile(path.join(dir, "webgpu/recovery.json"), "utf8"));
    const source = path.join(dir, "source");
    await mkdir(source);
    await writeFile(path.join(source, "fixture.ts"), "export const fixture = 1;\n");
    report.source = await sourceFingerprint(source);
    report.sourceFinal = structuredClone(report.source);
    await run(dir, report, raw);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(dir).startsWith("backend-evidence-"));
    await rm(dir, { recursive: true, force: true });
  }
}
async function save(dir: string, r: any, g: any) {
  await writeFile(path.join(dir, "report.json"), JSON.stringify(r));
  await writeFile(path.join(dir, "webgpu/recovery.json"), JSON.stringify(g));
}
async function complete(dir: string, report: any, raw: any) {
  const c = report.cases[0]; c.identity.unmasked = true;
  c.adapterRequests = 0;
  c.modeReplies = ["path", "hybrid"].map(mode => ({ mode, reply: { status: "failed", data: null, diagnostics: [{ code: "TC_RENDER_MODE_UNAVAILABLE", severity: "error" }] }, after: structuredClone(c.before) }));
  let previous = structuredClone(c.after);
  c.recoveries = c.recoveries.map((events: any) => {
    const before = previous, after = structuredClone(before); after.rendering.gpuRecovery = events; previous = after;
    return { before, after };
  });
  c.lifecycle.reloads = [1, 2, 3].map(i => {
    const r = structuredClone(c.lifecycle.after); r.counters.disposalsCompleted = c.lifecycle.before.counters.disposalsCompleted + i * 2; return r;
  });
  report.cases = [c, ...["null-adapter", "rejected-adapter"].map(failure => ({ ...structuredClone(c), failure, adapterRequests: 1 })), { failure: "no-graphics-backend", failureDetail: "Error: TC_RENDER_BACKEND_UNAVAILABLE: injected test failure", ready: null, backend: null, webgl2Requests: 1 }];
  for (const failure of ["null-adapter", "rejected-adapter"]) {
    await cp(path.join(dir, "missing-api.png"), path.join(dir, `${failure}.png`));
    await cp(path.join(dir, "missing-api-restored.png"), path.join(dir, `${failure}-restored.png`));
  }
  const adapter = { vendor: "test-hardware", architecture: "test", isFallbackAdapter: false, features: [] };
  const state = (snapshot: any, mode: string, recovery: any) => ({ backend: "WebGPUBackend", ready: true, mode, tick: snapshot.tick, runtime: { records: snapshot.records }, resources: structuredClone(c.lifecycle.before), adapter, rendering: { gpuRecovery: recovery } });
  const start = { active: false, count: 0, events: [] };
  const first = state(raw.before, "path", start), second = state(raw.after, "path", raw.after.recovery);
  raw.pathRecovery = { before: first, after: second };
  const png = decode(await readFile(path.join(dir, "webgpu/recovered-path.png")));
  let nonBlack = 0; const colors = new Set<number>();
  for (let i = 0; i < png.width * png.height; i += 4) {
    const p = i * png.channels, d = png.data;
    if (d[p] + d[p + 1] + d[p + 2] > 12) nonBlack++;
    colors.add((d[p] >> 3) * 1024 + (d[p + 1] >> 3) * 32 + (d[p + 2] >> 3));
  }
  raw.capture = { before: second, after: structuredClone(second), pixels: { width: png.width, height: png.height, colors: colors.size, nonBlack } };
  previous = second;
  raw.repetitions = raw.repetitions.map((item: any) => {
    const before = structuredClone(previous); before.mode = item.mode;
    const after = structuredClone(before); after.rendering.gpuRecovery = item.recovery;
    previous = after; return { ...item, before, after };
  });
  report.webgpu.repetitions = raw.repetitions;
}

test("incomplete historical-format report is rejected for missing observations", async () => fixture(async (dir, report, raw) => {
  await save(dir, report, raw);
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some(s => s.includes("missing mode replies")));
  assert.ok(result.issues.some(s => s.includes("adapter identity")));
}));
test("complete synthetic evidence passes only this slice", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw); await save(dir, report, raw);
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, true);
  assert.equal(result.formalMilestoneAccepted, false);
  assert.equal(result.releaseAllowed, false);
  assert.deepEqual(result.issues, []);
  assert.match(result.limitations, /not independently authenticated/);
}));
for (const failure of ["null-adapter", "rejected-adapter"]) test(`rejects invalid ${failure} observations`, async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw);
  const c = report.cases.find((entry: any) => entry.failure === failure);
  c.adapterRequests = 0;
  c.modeReplies[0].reply.status = "succeeded";
  c.recoveries[0].after.tick++;
  await save(dir, report, raw);
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, false);
  for (const text of ["adapter injection not observed", "path rejection", "state preservation"]) assert.ok(result.issues.some(issue => issue.includes(text)), result.issues.join("\n"));
}));
for (const failure of ["null-adapter", "rejected-adapter"]) test(`requires unique ${failure} evidence and its own image and teardown`, async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw);
  const c = report.cases.find((entry: any) => entry.failure === failure);
  report.cases = report.cases.filter((entry: any) => entry !== c);
  await save(dir, report, raw);
  assert.ok((await verifyBackendEvidence(dir, path.join(dir, "source"))).issues.some(issue => issue.includes(`${failure}: expected exactly one case`)));
  report.cases.push(c, structuredClone(c));
  await save(dir, report, raw);
  assert.ok((await verifyBackendEvidence(dir, path.join(dir, "source"))).issues.some(issue => issue.includes(`${failure}: expected exactly one case`)));
  report.cases.pop();
  c.teardown.contextLost = false;
  await rm(path.join(dir, `${failure}-restored.png`));
  await save(dir, report, raw);
  const issues = (await verifyBackendEvidence(dir, path.join(dir, "source"))).issues;
  assert.ok(issues.some(issue => issue.includes(`${failure}: teardown mismatch`)));
  assert.ok(issues.some(issue => issue.includes(`${failure}-restored.png: missing`)));
}));
test("rejects fabricated, missing, duplicate and inconsistent no-backend observations", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw);
  const valid = report.cases.pop();
  for (const invalid of [undefined, { failure: valid.failure, code: "TC_RENDER_BACKEND_UNAVAILABLE", passed: true }, { ...valid, ready: undefined }, { ...valid, ready: "true" }, { ...valid, backend: "webgl2" }, { ...valid, webgl2Requests: 0 }, { ...valid, failureDetail: "unrelated error" }]) {
    report.cases = report.cases.filter((c: any) => c.failure !== valid.failure);
    if (invalid) report.cases.push(invalid);
    await save(dir, report, raw);
    const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
    assert.equal(result.accepted, false);
    assert.ok(result.issues.some(issue => issue.includes("no-graphics-backend")));
  }
  report.cases.push(valid, structuredClone(valid));
  await save(dir, report, raw);
  assert.ok((await verifyBackendEvidence(dir, path.join(dir, "source"))).issues.some(issue => issue.includes("expected exactly one case")));
}));
test("adapter feature order is irrelevant but missing or duplicate features are rejected", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw);
  const adapters = [raw.pathRecovery.before.adapter, raw.pathRecovery.after.adapter, raw.capture.before.adapter, raw.capture.after.adapter, ...raw.repetitions.flatMap((entry: any) => [entry.before.adapter, entry.after.adapter])];
  adapters.forEach((adapter: any, index: number) => { adapter.features = index % 2 ? ["feature-b", "feature-a"] : ["feature-a", "feature-b"]; });
  report.webgpu.repetitions = raw.repetitions;
  await save(dir, report, raw);
  assert.equal((await verifyBackendEvidence(dir, path.join(dir, "source"))).accepted, true);
  raw.pathRecovery.after.adapter.features = ["feature-a"];
  await save(dir, report, raw);
  assert.equal((await verifyBackendEvidence(dir, path.join(dir, "source"))).accepted, false);
  raw.pathRecovery.after.adapter.features = ["feature-a", "feature-a"];
  await save(dir, report, raw);
  assert.equal((await verifyBackendEvidence(dir, path.join(dir, "source"))).accepted, false);
}));
const mutations: [string, (r: any, g: any) => void, string][] = [
  ["backend", r => { r.cases[0].after.backend = "WebGPUBackend"; }, "backend/mode/tick"],
  ["software renderer", r => { r.cases[0].identity.renderer = "SwiftShader"; }, "renderer identity"],
  ["reply status", r => { r.cases[0].modeReplies[0].reply.status = "succeeded"; }, "path rejection"],
  ["reply code", r => { r.cases[0].modeReplies[1].reply.diagnostics[0].code = "TC_OTHER"; }, "hybrid rejection"],
  ["image", r => { r.cases[0].pixels.nonBlack++; }, "metrics mismatch"],
  ["context state", r => { r.cases[0].recoveries[0].after.tick++; }, "state preservation"],
  ["context event", r => { r.cases[0].recoveries[0].after.rendering.gpuRecovery.events[0] = null; }, "recovery events"],
  ["reload", r => { r.cases[0].lifecycle.reloads[0].counters.disposalsCompleted = 0; }, "ownership/disposal"],
  ["teardown", r => { r.cases[0].teardown.resources.owned.entries = 1; }, "teardown mismatch"],
  ["fallback adapter", (_r, g) => { g.pathRecovery.before.adapter.isFallbackAdapter = true; }, "adapter identity"],
  ["GPU state", (_r, g) => { g.pathRecovery.after.runtime.records = []; }, "state preservation"],
  ["capture", (_r, g) => { g.capture.pixels.nonBlack++; }, "metrics mismatch"],
  ["GPU summary", r => { r.webgpu.pixels.nonBlack = 2; }, "summary disagrees"],
  ["GPU recovery", (r, g) => { g.repetitions[0].after.tick++; r.webgpu.repetitions = g.repetitions; }, "state preservation"],
  ["GPU continuity", (r, g) => { g.repetitions[0].before.tick++; g.repetitions[0].after.tick++; r.webgpu.repetitions = g.repetitions; }, "history/adapter mismatch"],
  ["final source", r => { r.sourceFinal.sha256 = "0".repeat(64); }, "final fingerprint"],
];
for (const [name, mutate, expected] of mutations) test(`rejects ${name}`, async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw); mutate(report, raw); await save(dir, report, raw);
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some(s => s.includes(expected)), result.issues.join("\n"));
}));
test("rejects missing image", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw); await save(dir, report, raw);
  await rm(path.join(dir, "webgpu/recovered-path.png"));
  assert.ok((await verifyBackendEvidence(dir, path.join(dir, "source"))).issues.some(s => s.includes("recovered-path.png: missing")));
}));
test("rejects stale source even if report data are otherwise valid", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw); await save(dir, report, raw);
  await writeFile(path.join(dir, "source/fixture.ts"), "changed\n");
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some(s => s.includes("fingerprint mismatch")));
}));
test("rejects oversized evidence before decoding", async () => fixture(async (dir, report, raw) => {
  await complete(dir, report, raw); await save(dir, report, raw);
  await writeFile(path.join(dir, "missing-api.png"), Buffer.alloc(4 * 1024 * 1024 + 1));
  const result = await verifyBackendEvidence(dir, path.join(dir, "source"));
  assert.equal(result.accepted, false);
  assert.ok(result.issues.some(issue => issue.includes("missing-api.png")));
}));
