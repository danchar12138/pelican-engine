import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyM3QualityPixels } from "../tools/m3-quality-pixels-verifier.ts";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";

const count = 320 * 180;
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), "m3-quality-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "m3-quality-source-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writeFile(path.join(sourceRoot, "source.ts"), "source-v1");
  const sourceIdentity = (await sourceFingerprint(sourceRoot)).sha256;
  const frames: Record<string, Buffer> = {};
  for (const [name, value, samples] of [["raw", 2, 16], ["filtered", 1.1, 16], ["reference", 1, 256]] as const) {
    const buffer = Buffer.alloc(count * 16);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) buffer.writeFloatLE(value, i * 16 + c * 4);
      buffer.writeFloatLE(samples, i * 16 + 12);
    }
    frames[name] = buffer;
  }
  const mse = (a: number, b: number) => (a / (1 + a) - b / (1 + b)) ** 2;
  const report = { sourceIdentity, passed: true, finite: true, errors: [], rawSamples: 16, referenceSamples: 256,
    rawMse: mse(2, 1), filteredMse: mse(frames.filtered.readFloatLE(0), 1),
    scene: { before: { gameId: "m3-surface-gallery", sceneId: "gallery", mode: "path", tick: 1, geometryHash: 123, camera: [1, 2, 3] },
      after: { gameId: "m3-surface-gallery", sceneId: "gallery", mode: "path", tick: 1, geometryHash: 123, camera: [1, 2, 3] } },
    pixels: { format: "rgba-f32le", width: 320, height: 180, files: {} as Record<string, any> } };
  async function save() {
    for (const name of Object.keys(frames)) {
      const file = `quality-${name}.f32`;
      report.pixels.files[name] = { file, sha256: hash(frames[name]) };
      await writeFile(path.join(dir, file), frames[name]);
    }
    await writeFile(path.join(dir, "quality.json"), JSON.stringify(report));
  }
  await save(); return { dir, sourceRoot, frames, report, save };
}
test("recomputes static gallery image MSE from all persisted float pixels", async t => {
  const f = await fixture(t); // Temporal filtering can preserve a fractional effective history weight.
  f.frames.filtered.writeFloatLE(16.5, 12); await f.save();
  const result = await verifyM3QualityPixels(f.dir, f.sourceRoot);
  assert.equal(result.pixels, count); assert.ok(result.filteredMse < result.rawMse);
  assert.equal(result.formalMilestoneAccepted, false);
});
test("rejects forged or stale source identity", async t => {
  const f = await fixture(t);
  f.report.sourceIdentity = "0".repeat(64); await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /sourceIdentity: mismatch/);
  f.report.sourceIdentity = (await sourceFingerprint(f.sourceRoot)).sha256; await f.save();
  await writeFile(path.join(f.sourceRoot, "source.ts"), "source-v2");
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /sourceIdentity: mismatch/);
  await assert.rejects(verifyM3QualityPixels(f.dir, "relative"), /absolute path/);
});
test("rejects claimed success with forged summary and mismatching file hash", async t => {
  const f = await fixture(t); f.report.rawMse = 0.8; await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /rawMse/);
  const bytes = f.frames.raw; bytes.writeFloatLE(5, 0);
  await writeFile(path.join(f.dir, "quality-raw.f32"), bytes);
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /sha256 mismatch/);
});
test("rejects invalid radiance and wrong per-pixel sample count even with matching hashes", async t => {
  const f = await fixture(t); f.frames.filtered.writeFloatLE(NaN, 0); await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /invalid radiance/);
  f.frames.filtered.writeFloatLE(1.1, 0); f.frames.filtered.writeFloatLE(0, 28); await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /accumulation counts/);
});
test("rejects worse filtering even if claimed metrics and hashes agree", async t => {
  const f = await fixture(t);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) f.frames.filtered.writeFloatLE(4, i * 16 + 4 * c);
  f.report.filteredMse = (4 / 5 - 1 / 2) ** 2; await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /does not improve/);
});
test("rejects truncated frame, incorrect filename and black reference", async t => {
  const f = await fixture(t); f.frames.raw = f.frames.raw.subarray(0, 20); await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /wrong pixel byte length/);
  const g = await fixture(t); g.report.pixels.files.raw.file = "../quality-raw.f32";
  await writeFile(path.join(g.dir, "quality.json"), JSON.stringify(g.report));
  await assert.rejects(verifyM3QualityPixels(g.dir, g.sourceRoot), /unexpected file name/);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) g.frames.reference.writeFloatLE(0, i * 16 + c * 4);
  await g.save(); await assert.rejects(verifyM3QualityPixels(g.dir, g.sourceRoot), /black image/);
});

test("rejects a different or moving gallery despite a passing pixel summary", async t => {
  const f = await fixture(t); f.report.scene.after.tick++; await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /changed during capture/);
  f.report.scene.after.tick--; f.report.scene.after.sceneId = "other"; await f.save();
  await assert.rejects(verifyM3QualityPixels(f.dir, f.sourceRoot), /unexpected gallery/);
});
