import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.ts";

const WIDTH = 320, HEIGHT = 180, PIXELS = WIDTH * HEIGHT;
const NAMES = ["raw", "filtered", "reference"] as const;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as Record<string, any>;
}
async function readRegular(root: string, name: string, maxBytes: number): Promise<Buffer> {
  const file = path.join(root, name), info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes || path.dirname(await realpath(file)) !== root)
    throw new Error(`${name}: expected bounded regular file in evidence directory`);
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw new Error(`${name}: too large`);
  return bytes;
}
function near(claim: unknown, actual: number, label: string) {
  if (typeof claim !== "number" || !Number.isFinite(claim) || Math.abs(claim - actual) > 1e-12 + 1e-8 * Math.abs(actual))
    throw new Error(`${label}: does not match pixels`);
}

/** Offline audit of the 320x180 static gallery probe's persisted linear radiance.
 * Evidence directory must be a trusted, frozen snapshot (not adversarially mutated).
 * Hashes bind report to files and the supplied source identity, not GPU provenance.
 */
export async function verifyM3QualityPixels(evidenceDirectory: string, sourceRoot: string) {
  if (!path.isAbsolute(sourceRoot)) throw new Error("sourceRoot: absolute path required");
  const sourceIdentity = (await sourceFingerprint(sourceRoot)).sha256;
  const root = await realpath(evidenceDirectory);
  const reportBytes = await readRegular(root, "quality.json", 1024 * 1024);
  const report = object(JSON.parse(reportBytes.toString("utf8")), "report");
  if (report.sourceIdentity !== sourceIdentity) throw new Error("sourceIdentity: mismatch");
  if (report.passed !== true || report.finite !== true || !Array.isArray(report.errors) || report.errors.length !== 0)
    throw new Error("report: failed or incomplete capture");
  const scene = object(report.scene, "scene"), before = object(scene.before, "scene.before"), after = object(scene.after, "scene.after");
  for (const state of [before, after]) {
    if (state.gameId !== "m3-surface-gallery" || state.sceneId !== "gallery" || state.mode !== "path" ||
        !Number.isSafeInteger(state.tick) || state.tick < 0 || (!Number.isInteger(state.geometryHash) || state.geometryHash < 0 || state.geometryHash > 0xffffffff) ||
        !Array.isArray(state.camera) || state.camera.length !== 3 || !state.camera.every((v: unknown) => typeof v === "number" && Number.isFinite(v)))
      throw new Error("scene: unexpected gallery capture state");
  }
  if (before.tick !== after.tick || before.geometryHash !== after.geometryHash ||
      before.camera.some((v: number, i: number) => v !== after.camera[i]))
    throw new Error("scene: tick, geometry or camera changed during capture");
  const pixels = object(report.pixels, "pixels"), files = object(pixels.files, "pixels.files");
  if (pixels.format !== "rgba-f32le" || pixels.width !== WIDTH || pixels.height !== HEIGHT)
    throw new Error("pixels: unexpected format or dimensions");
  const frames: Record<string, Buffer> = {};
  const hashes: Record<string, string> = {};
  for (const name of NAMES) {
    const entry = object(files[name], `pixels.files.${name}`), expectedName = `quality-${name}.f32`;
    if (entry.file !== expectedName) throw new Error(`${name}: unexpected file name`);
    const bytes = await readRegular(root, expectedName, PIXELS * 16);
    if (bytes.length !== PIXELS * 16) throw new Error(`${name}: wrong pixel byte length`);
    const hash = sha256(bytes);
    if (entry.sha256 !== hash) throw new Error(`${name}: sha256 mismatch`);
    frames[name] = bytes; hashes[name] = hash;
  }
  let rawError = 0, filteredError = 0, referenceEnergy = 0;
  for (let i = 0; i < PIXELS; i++) {
    const offset = i * 16;
    const counts = NAMES.map(name => frames[name].readFloatLE(offset + 12));
    if (!counts.every(value => Number.isFinite(value) && value > 0) ||
        !Number.isInteger(counts[0]) || !Number.isInteger(counts[2]) || counts[2] <= counts[0])
      throw new Error(`pixel ${i}: invalid accumulation counts`);
    for (let channel = 0; channel < 3; channel++) {
      const values = NAMES.map(name => frames[name].readFloatLE(offset + 4 * channel));
      if (!values.every(value => Number.isFinite(value) && value >= 0))
        throw new Error(`pixel ${i}, channel ${channel}: invalid radiance`);
      const [raw, filtered, reference] = values;
      const compressedReference = reference / (1 + reference);
      rawError += (raw / (1 + raw) - compressedReference) ** 2;
      filteredError += (filtered / (1 + filtered) - compressedReference) ** 2;
      referenceEnergy += reference;
    }
  }
  if (!(referenceEnergy > 0)) throw new Error("reference: black image");
  const rawMse = rawError / (PIXELS * 3), filteredMse = filteredError / (PIXELS * 3);
  near(report.rawMse, rawMse, "rawMse"); near(report.filteredMse, filteredMse, "filteredMse");
  near(report.rawSamples, frames.raw.readFloatLE(12), "rawSamples");
  near(report.referenceSamples, frames.reference.readFloatLE(12), "referenceSamples");
  if (!(filteredMse < rawMse)) throw new Error("pixels: filtered MSE does not improve over raw");
  if ((await sourceFingerprint(sourceRoot)).sha256 !== sourceIdentity) throw new Error("sourceIdentity: changed during verification");
  return { verifiedProbe: "static-gallery-denoising-pixels", rawMse, filteredMse, pixels: PIXELS,
    sourceIdentity, reportSha256: sha256(reportBytes), pixelSha256: hashes, formalMilestoneAccepted: false,
    limitations: "Offline numerical and source consistency only: no proof of GPU execution, scene provenance, perceptual quality or formal M3 acceptance. The 256-sample reference uses the same integrator, not ground truth." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) { console.error("Usage: node tools/m3-quality-pixels-verifier.ts <evidence-directory> <absolute-source-root>"); process.exitCode = 1; }
  else try { console.log(JSON.stringify(await verifyM3QualityPixels(process.argv[2], process.argv[3]), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
