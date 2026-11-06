import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { encode } from "fast-png";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";
import { verifyMaterialSlotsEvidence } from "../tools/m3-material-slots-semantic-verifier.ts";

async function fixture(run: (f: { source: string; evidence: string; report: any; save: () => Promise<void> }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "slots-semantic-"));
  const source = path.join(root, "source"), dest = path.join(root, "evidence");
  try {
    await cp(path.resolve("examples/material-slots"), path.join(source, "examples/material-slots"), { recursive: true });
    await mkdir(dest, { recursive: true });
    const paintBefore = [160, 30, 20], paintAfter = [20, 160, 20], trim = [20, 30, 160];
    const modes = [];
    for (const mode of ["raster", "path", "hybrid"]) {
      for (const [stage, paint] of [["before", paintBefore], ["after", paintAfter]] as const) {
        const data = new Uint8Array(320 * 240 * 3);
        for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
          data.set(x < 160 ? paint : trim, (y * 320 + x) * 3);
        }
        await writeFile(path.join(dest, `${mode}-${stage}.png`), encode({ width: 320, height: 240, data, channels: 3, depth: 8 }));
      }
      modes.push({ mode, before: { paint: [...paintBefore], trim: [...trim] }, after: { paint: [...paintAfter], trim: [...trim] } });
    }
    const gameIdentity: Record<string, string> = {};
    for (const [key, file] of [["gameSha256", "game.ts"], ["manifestSha256", "pelican.project.json"], ["assetSha256", "assets/panels.glb"]]) {
      gameIdentity[key] = createHash("sha256").update(await readFile(path.join(source, "examples/material-slots", file))).digest("hex");
    }
    const report = {
      sourceIdentity: (await sourceFingerprint(source)).sha256,
      scope: "materialSlots public GLB before/after", passed: true, formalMilestoneAccepted: false,
      errors: [], cleanupErrors: [], gameIdentity, installedGameIdentity: { ...gameIdentity }, modes,
    };
    const save = async () => { await writeFile(path.join(dest, "material-slots-game.json"), JSON.stringify(report)); };
    await save();
    await run({ source, evidence: dest, report, save });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const verify = (f: { source: string; evidence: string }) => verifyMaterialSlotsEvidence({ sourceRoot: f.source, evidenceRoot: f.evidence });

test("independently verifies six synthetic PNGs and never authorizes release", async () => fixture(async f => {
  const result = await verify(f);
  assert.equal(result.images.length, 6);
  assert.equal(result.formalMilestoneAccepted, false);
  assert.equal(result.releaseAllowed, false);
}));
test("rejects forged report sample even with passed true", async () => fixture(async f => {
  f.report.modes[0].before.paint[0] = 0;
  await f.save();
  await assert.rejects(verify(f), /report differs from PNG/);
}));
test("rejects swapped screenshot even when its sample is forged to match", async () => fixture(async f => {
  await cp(path.join(f.evidence, "path-before.png"), path.join(f.evidence, "path-after.png"));
  f.report.modes[1].after = structuredClone(f.report.modes[1].before);
  await f.save();
  await assert.rejects(verify(f), /channel causality/);
}));
test("rejects missing or duplicate modes and missing screenshots", async () => fixture(async f => {
  const original = structuredClone(f.report.modes);
  f.report.modes[2].mode = "path";
  await f.save();
  await assert.rejects(verify(f), /duplicate mode/);
  f.report.modes = original;
  await f.save();
  await rm(path.join(f.evidence, "hybrid-after.png"));
  await assert.rejects(verify(f));
}));
test("rejects source mutation and inconsistent game identity", async () => fixture(async f => {
  f.report.gameIdentity.assetSha256 = "0".repeat(64);
  await f.save();
  await assert.rejects(verify(f), /gameIdentity.assetSha256/);
  f.report.gameIdentity.assetSha256 = "unused";
  await writeFile(path.join(f.source, "changed.ts"), "changed");
  await assert.rejects(verify(f), /sourceIdentity: mismatch/);
}));
test("rejects executable JavaScript added after capture", async () => fixture(async f => {
  await writeFile(path.join(f.source, "changed.js"), "export const changed = true;");
  await assert.rejects(verify(f), /sourceIdentity: mismatch/);
}));
test("uses the verifier's fingerprint implementation without executing source-root code", async () => fixture(async f => {
  await mkdir(path.join(f.source, "tools"), { recursive: true });
  await writeFile(path.join(f.source, "tools/source-fingerprint.ts"), 'throw new Error("untrusted source executed");');
  f.report.sourceIdentity = (await sourceFingerprint(f.source)).sha256;
  await f.save();
  assert.equal((await verify(f)).formalMilestoneAccepted, false);
}));
