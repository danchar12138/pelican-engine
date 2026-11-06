/** Offline inspection only: never a release or formal acceptance gate. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { decode } from "fast-png";
import { sourceFingerprint } from "./source-fingerprint.ts";
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const modes = ["raster", "path", "hybrid"];
type Samples = { paint: number[]; trim: number[] };
function object(value: any, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}: expected object`);
  return value;
}
// The helper is imported from this verifier's installation, never sourceRoot.
const fingerprint = async (root: string) => (await sourceFingerprint(root)).sha256;
async function readEvidence(root: string, name: string): Promise<Buffer> {
  const file = path.join(root, name), actual = await realpath(file);
  if (path.dirname(actual) !== root) throw new Error(`${name}: outside evidence directory`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`${name}: expected bounded regular file`);
  const bytes = await readFile(file);
  if (bytes.length > 4 * 1024 * 1024) throw new Error(`${name}: file too large`);
  return bytes;
}
function sample(bytes: Buffer): Samples {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== 320 ||
    bytes.readUInt32BE(20) !== 240 || bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[28] !== 0)
    throw new Error("PNG: expected 320x240 8-bit non-interlaced RGB/RGBA");
  let offset = 8, end = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), next = offset + 12 + length;
    if (next > bytes.length) throw new Error("PNG: truncated chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "tRNS", "iCCP"].includes(type)) throw new Error("PNG: unsupported chunk");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { if (length !== 0 || next !== bytes.length) throw new Error("PNG: invalid IEND"); end = true; break; }
    offset = next;
  }
  if (!end) throw new Error("PNG: missing IEND");
  const expected = (320 * (bytes[25] === 2 ? 3 : 4) + 1) * 240;
  if (inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }).length !== expected) throw new Error("PNG: invalid inflated size");
  const image = decode(bytes, { checkCrc: true });
  if (image.width !== 320 || image.height !== 240 || image.depth !== 8 || ![3, 4].includes(image.channels) || image.data.length !== 320 * 240 * image.channels)
    throw new Error("PNG: invalid decoded image");
  const roi = (center: number) => {
    const rgb = [0, 0, 0];
    for (let y = 115; y < 126; y++) for (let x = center - 5; x <= center + 5; x++) {
      const i = (y * 320 + x) * image.channels;
      if (image.channels === 4 && image.data[i + 3] !== 255) throw new Error("PNG: non-opaque ROI");
      for (let c = 0; c < 3; c++) rgb[c] += image.data[i + c] / 121;
    }
    return rgb;
  };
  return { paint: roi(114), trim: roi(206) };
}
function checkSamples(claim: unknown, actual: Samples, label: string): void {
  const obj = object(claim, label);
  for (const slot of ["paint", "trim"] as const) {
    const rgb = obj[slot];
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((v, c) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v - actual[slot][c]) > 1e-6))
      throw new Error(`${label}.${slot}: report differs from PNG`);
  }
}
function causal(before: Samples, after: Samples, mode: string): void {
  const b = before.paint, a = after.paint;
  if (!(b[0] > 35 && b[0] > b[1] + 20 && a[1] > 35 && a[1] > a[0] + 20 && b[0] - a[0] > 20 && a[1] - b[1] > 20) ||
      ![before.trim, after.trim].every(t => t[2] > 35 && t[2] > t[0] + 20 && t[2] > t[1] + 20) ||
      !before.trim.every((v, i) => Math.abs(v - after.trim[i]) < 30)) throw new Error(`${mode}: paint/trim channel causality failed`);
}

/** Source and evidence must be immutable snapshots during verification. */
export async function verifyMaterialSlotsEvidence(options: { sourceRoot: string; evidenceRoot: string }) {
  const source = await realpath(options.sourceRoot), root = await realpath(options.evidenceRoot);
  const identity = await fingerprint(source);
  const reportBytes = await readEvidence(root, "material-slots-game.json");
  const report = object(JSON.parse(reportBytes.toString("utf8")), "report");
  if (report.sourceIdentity !== identity) throw new Error(`sourceIdentity: mismatch (report ${report.sourceIdentity}, actual ${identity})`);
  if (report.scope !== "materialSlots public GLB before/after" || report.passed !== true || report.formalMilestoneAccepted !== false ||
      !Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.cleanupErrors) || report.cleanupErrors.length)
    throw new Error("report: incomplete or invalid probe");
  const game = object(report.gameIdentity, "gameIdentity");
  for (const [key, relative] of [["gameSha256", "game.ts"], ["manifestSha256", "pelican.project.json"], ["assetSha256", "assets/panels.glb"]]) {
    if (game[key] !== hash(await readFile(path.join(source, "examples/material-slots", relative)))) throw new Error(`gameIdentity.${key}: mismatch`);
    if (report.installedGameIdentity !== undefined && object(report.installedGameIdentity, "installedGameIdentity")[key] !== game[key]) throw new Error(`installedGameIdentity.${key}: mismatch`);
  }
  if (!Array.isArray(report.modes) || report.modes.length !== 3) throw new Error("modes: expected three unique modes");
  const seen = new Set<string>(), images: { mode: string; stage: string; sha256: string; samples: Samples }[] = [];
  for (const value of report.modes) {
    const entry = object(value, "mode"), mode = entry.mode;
    if (!modes.includes(mode) || seen.has(mode)) throw new Error("modes: unknown or duplicate mode");
    seen.add(mode);
    const samples: Samples[] = [];
    for (const stage of ["before", "after"] as const) {
      const bytes = await readEvidence(root, `${mode}-${stage}.png`), actual = sample(bytes);
      checkSamples(entry[stage], actual, `${mode}.${stage}`);
      samples.push(actual);
      images.push({ mode, stage, sha256: hash(bytes), samples: actual });
    }
    causal(samples[0], samples[1], mode);
  }
  if (await fingerprint(source) !== identity) throw new Error("sourceIdentity: changed during verification");
  return { verifiedProbe: "material-slots-offline-image-semantics", sourceIdentity: identity, reportSha256: hash(reportBytes), images,
    formalMilestoneAccepted: false, releaseAllowed: false,
    limitations: "Offline semantics only; does not establish capture provenance, GPU execution, installed package identity, formal M3 acceptance, or release readiness." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${name}`); return args[i + 1]; };
  try { console.log(JSON.stringify(await verifyMaterialSlotsEvidence({ sourceRoot: option("--source-root"), evidenceRoot: option("--evidence-root") }), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
