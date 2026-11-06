import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "fast-png";
import { verifyM3SpecularImageEvidence } from "../tools/m3-specular-image-verifier.ts";

const stages = ["initial", "restored", "rejected", "recovered"];
const modes = ["raster", "path", "hybrid"];
const names = ["gray", "zeroAlphaRed", "red", "green", "grayReference"];
const colors = [[70,70,70], [0,0,0], [220,30,20], [20,210,30], [70,70,70]];
const hash = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const source = "export const fixture = 1;\n";
const identity = hash(JSON.stringify([{ path: "probe.ts", sha256: hash(source), bytes: Buffer.byteLength(source) }]));
function png(black = false) {
  const data = new Uint8Array(320 * 240 * 4);
  for (let p = 0; p < 320 * 240; p++) data[p * 4 + 3] = 255;
  if (!black) [73,109,146,182,247].forEach((x, n) => {
    for (let y = 117; y < 124; y++) for (let px = x - 3; px < x + 4; px++) {
      const i = (y * 320 + px) * 4;
      data.set(colors[n], i);
    }
  });
  return Buffer.from(encode({ width: 320, height: 240, data, channels: 4, depth: 8 }));
}
async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(tmpdir(), "m3-specular-image-"));
  t.after(async () => {
    assert.equal(path.dirname(temp), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith("m3-specular-image-"));
    await rm(temp, { recursive: true, force: true });
  });
  const sourceRoot = path.join(temp, "source"), evidenceRoot = path.join(temp, "evidence");
  await mkdir(sourceRoot); await mkdir(evidenceRoot);
  await writeFile(path.join(sourceRoot, "probe.ts"), source);
  const report = { scope: "KHR_materials_specular texture game probe", passed: true, compileOnly: false, phase: "complete", sourceIdentity: identity,
    modes: stages.flatMap(stage => modes.map(mode => ({ stage, mode, screenshot: `${stage}-${mode}.png`,
      samples: Object.fromEntries(names.map((name, i) => [name, colors[i]])) }))) };
  const reportFile = path.join(evidenceRoot, "specular-textures-game.json");
  const image = png();
  for (const entry of report.modes) await writeFile(path.join(evidenceRoot, entry.screenshot), image);
  const save = () => writeFile(reportFile, JSON.stringify(report));
  await save();
  return { temp, sourceRoot, evidenceRoot, payload: report, reportFile, image, save };
}

test("checks twelve image samples and binds report and source without claiming acceptance", async t => {
  const f = await fixture(t), result = await verifyM3SpecularImageEvidence(f);
  assert.equal(result.images.length, 12);
  assert.equal(result.sourceIdentity, identity);
  assert.equal(result.reportSha256, hash(await readFile(f.reportFile)));
  assert.equal(result.formalMilestoneAccepted, false);
  assert.match(result.limitations, /cannot prove GPU execution/);
});
test("rejects truncated PNG, forged checksum and black pixels", async t => {
  const f = await fixture(t), file = path.join(f.evidenceRoot, "initial-raster.png");
  await writeFile(file, f.image.subarray(0, f.image.length - 7));
  await assert.rejects(verifyM3SpecularImageEvidence(f), /PNG/);
  const corrupt = Buffer.from(f.image); corrupt[29] ^= 1;
  await writeFile(file, corrupt);
  await assert.rejects(verifyM3SpecularImageEvidence(f));
  await writeFile(file, png(true));
  await assert.rejects(verifyM3SpecularImageEvidence(f), /pixels:/);
});
test("rejects oversized compressed screenshot before PNG decoding", async t => {
  const f = await fixture(t), file = path.join(f.evidenceRoot, "initial-raster.png");
  const bomb = Buffer.from(encode({ width: 320, height: 480, data: new Uint8Array(320 * 480 * 4), channels: 4, depth: 8 }));
  bomb.writeUInt32BE(240, 20);
  await writeFile(file, bomb);
  await assert.rejects(verifyM3SpecularImageEvidence(f), /oversized compressed image/);
});
test("rejects forged samples, stale identity and incomplete report", async t => {
  const f = await fixture(t);
  f.payload.modes[0].samples.red = [255, 0, 0]; await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /samples.red/);
  f.payload.modes[0].samples.red = colors[2]; f.payload.sourceIdentity = "0".repeat(64); await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /sourceIdentity/);
  f.payload.sourceIdentity = identity; f.payload.passed = false; await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /incomplete/);
  f.payload.passed = true; await f.save();
  await writeFile(path.join(f.sourceRoot, "probe.ts"), "changed");
  await assert.rejects(verifyM3SpecularImageEvidence(f), /sourceIdentity/);
});
test("rejects executable JavaScript added after capture", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "changed.mjs"), "export const changed = true;");
  await assert.rejects(verifyM3SpecularImageEvidence(f), /sourceIdentity/);
});
test("rejects wrong mode, duplicate stage and screenshot substitution", async t => {
  const f = await fixture(t);
  f.payload.modes[0].screenshot = "initial-path.png"; await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /screenshot mismatch/);
  f.payload.modes[0].screenshot = "initial-raster.png"; f.payload.modes[0].mode = "other"; await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /unexpected stage or mode/);
  f.payload.modes[0] = structuredClone(f.payload.modes[1]); await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /duplicate/);
});
test("rejects relative and symlink evidence escapes", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyM3SpecularImageEvidence({ ...f, report: "../specular-textures-game.json" }), /path:/);
  await writeFile(path.join(f.temp, "specular-textures-game.json"), "{}");
  await symlink(f.temp, path.join(f.evidenceRoot, "outside"), "junction");
  await assert.rejects(verifyM3SpecularImageEvidence({ ...f, report: "outside/specular-textures-game.json" }), /path: escapes/);
  f.payload.modes[0].screenshot = "../initial-raster.png"; await f.save();
  await assert.rejects(verifyM3SpecularImageEvidence(f), /screenshot mismatch/);
});
