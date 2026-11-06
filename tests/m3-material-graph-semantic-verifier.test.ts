import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyM3MaterialGraphEvidence } from "../tools/m3-material-graph-semantic-verifier.ts";

// Construct the independent fixture rather than trusting the report's expected[] field.
const identity = (content: string) => {
  const bytes = Buffer.from(content);
  const file = { path: "tools/probe.ts", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  return createHash("sha256").update(JSON.stringify([file])).digest("hex");
};
const oracle = (times: number[]) => times.flatMap((time, material) => {
  const t = Math.max(0, Math.min(1, time));
  const alpha = 0.8 * t;
  const field = [alpha, t, alpha, alpha < 0.3 ? 1 : 0,
    ...(material === 0 ? [1, 2, 3] : [4, 5, 6]), alpha < 0.3 ? 1 : 0];
  return [...field, ...field];
});

async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(tmpdir(), "m3-semantic-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith("m3-semantic-"));
    await rm(temp, { recursive: true, force: true });
  });
  const sourceRoot = path.join(temp, "source"), evidenceRoot = path.join(temp, "evidence");
  await mkdir(path.join(sourceRoot, "tools"), { recursive: true });
  await mkdir(evidenceRoot);
  const sourceFile = path.join(sourceRoot, "tools", "probe.ts");
  await writeFile(sourceFile, "export const fixture = 1;\n");
  const sourceIdentity = identity("export const fixture = 1;\n");
  const expected = [oracle([0.25, 0.75]), oracle([1.5, -0.25])];
  const report: Record<string, unknown> = {
    sourceIdentity, passed: true, backend: "webgpu", formalMilestoneAccepted: false,
    adapter: { vendor: "unknown", architecture: "unknown", isFallbackAdapter: false },
    triangles: 4, expected, actual: expected.map((v) => v.map(Math.fround)),
  };
  const reportFile = path.join(evidenceRoot, "material-graph-gpu.json");
  const save = () => writeFile(reportFile, JSON.stringify(report));
  await save();
  return { sourceRoot, evidenceRoot, payload: report, save, sourceFile, reportFile };
}

test("offline verifier recomputes both epochs and returns source/report binding, not milestone acceptance", async (t) => {
  const f = await fixture(t);
  const result = await verifyM3MaterialGraphEvidence(f);
  assert.equal(result.verifiedProbe, "material-graph-gpu-numeric");
  assert.equal(result.sourceIdentity, f.payload.sourceIdentity);
  assert.equal(result.epochs, 2);
  assert.equal(result.triangles, 4);
  assert.ok(result.maxAbsoluteError < 5e-5);
  assert.match(result.reportSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.formalMilestoneAccepted, false);
  assert.notEqual(result.reportSha256, f.payload.sourceIdentity);
});

test("rejects executable JavaScript added after capture", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "changed.cjs"), "module.exports = 1;");
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /sourceIdentity/);
});

test("forged passed, expected and actual values cannot substitute for independent semantics", async (t) => {
  const f = await fixture(t);
  const expected = f.payload.expected as number[][], actual = f.payload.actual as number[][];
  expected[0][16] = 0.1; actual[0][16] = 0.1;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /expected\[0\]\[16\]: numeric mismatch/);
  expected[0][16] = oracle([0.25, 0.75])[16];
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[0\]\[16\]: numeric mismatch/);
  actual[0][16] = expected[0][16];
  f.payload.passed = false;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /passed:/);
});

test("reject missing, extra, malformed and non-finite readback fields", async (t) => {
  const f = await fixture(t);
  (f.payload.actual as number[][])[1].pop();
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[1\]: expected 32 fields/);
  (f.payload.actual as number[][])[1] = [...oracle([1.5, -0.25]), 1];
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[1\]: expected 32 fields/);
  (f.payload.actual as number[][])[1] = oracle([1.5, -0.25]);
  (f.payload.actual as number[][])[1][5] = NaN;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[1\]\[5\]: expected finite number/);
  (f.payload.actual as number[][])[1][5] = 2;
  f.payload.actual = [(f.payload.actual as number[][])[0]];
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /samples: expected exactly two/);
});

test("reject source drift, forged identity, fallback and report path traversal", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceFile, "export const fixture = 2;\n");
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /sourceIdentity: does not match/);
  f.payload.sourceIdentity = identity("export const fixture = 2;\n");
  f.payload.adapter = { isFallbackAdapter: true };
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /adapter: fallback/);
  await assert.rejects(verifyM3MaterialGraphEvidence({ ...f, report: "../material-graph-gpu.json" }), /report: must name/);
});

test("reject fabricated formal acceptance and oversized reports", async (t) => {
  const f = await fixture(t);
  f.payload.formalMilestoneAccepted = true;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /formalMilestoneAccepted:/);
  await writeFile(f.reportFile, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /report: expected bounded regular file/);
});




test("reject stale first-pass readback in the second buffer-update epoch", async (t) => {
  const f = await fixture(t);
  (f.payload.actual as number[][])[1] = [...(f.payload.actual as number[][])[0]];
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[1\]\[0\]: numeric mismatch/);
});

test("reject forged fixture size and missing alpha-test discard even if passed is true", async (t) => {
  const f = await fixture(t);
  f.payload.triangles = 2;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /triangles: unexpected fixture size/);
  f.payload.triangles = 4;
  (f.payload.actual as number[][])[0][3] = 0;
  await f.save();
  await assert.rejects(verifyM3MaterialGraphEvidence(f), /actual\[0\]\[3\]: numeric mismatch/);
});
