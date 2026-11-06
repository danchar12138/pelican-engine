/** Offline screenshot semantics only: not proof of GPU execution or M3 acceptance. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "fast-png";
import { inflateSync } from "node:zlib";
import { sourceFingerprint } from "./source-fingerprint.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
// Import the verifier's trusted helper, never executable code from sourceRoot.
const fingerprint = async (root: string) => (await sourceFingerprint(root)).sha256;
const stages = ["initial", "restored", "rejected", "recovered"] as const;
const modes = ["raster", "path", "hybrid"] as const;
const names = ["gray", "zeroAlphaRed", "red", "green", "grayReference"] as const;
const xs = [73, 109, 146, 182, 247];
type Obj = Record<string, unknown>;
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as Obj;
}
async function inside(root: string, relative: string, limit: number): Promise<Buffer> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === ".." || p === "")) throw new Error("path: invalid or escapes evidenceRoot");
  const file = path.resolve(root, relative), canonical = await realpath(file);
  const rel = path.relative(root, canonical);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("path: escapes evidenceRoot");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > limit) throw new Error("file: expected bounded regular file");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error("file: size limit exceeded");
  return bytes;
}
function pixels(bytes: Buffer): number[][] {
  // Validate framing before handing compressed data to the decoder, including exact IEND.
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== 320 || bytes.readUInt32BE(20) !== 240 || bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[28] !== 0)
    throw new Error("PNG: expected 320x240 8-bit RGB/RGBA screenshot");
  let offset = 8, end = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), next = offset + 12 + length;
    if (next > bytes.length) throw new Error("PNG: truncated chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "tRNS" || type === "iCCP") throw new Error("PNG: unsupported animation, transparency or color profile");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { if (length !== 0 || next !== bytes.length) throw new Error("PNG: invalid IEND"); end = true; break; }
    offset = next;
  }
  if (!end) throw new Error("PNG: missing IEND");
  const expected = (320 * (bytes[25] === 2 ? 3 : 4) + 1) * 240;
  let inflated: Buffer;
  try { inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); }
  catch { throw new Error("PNG: invalid or oversized compressed image"); }
  if (inflated.length !== expected) throw new Error("PNG: invalid decompressed size");
  const image = decode(bytes, { checkCrc: true });
  if (image.width !== 320 || image.height !== 240 || image.depth !== 8 || ![3, 4].includes(image.channels) || image.data.length !== 320 * 240 * image.channels)
    throw new Error("PNG: unexpected decoded image");
  return xs.map(x => {
    const rgb = [0, 0, 0];
    for (let y = 117; y < 124; y++) for (let px = x - 3; px < x + 4; px++) {
      const i = (y * 320 + px) * image.channels;
      if (image.channels === 4 && image.data[i + 3] !== 255) throw new Error("PNG: non-opaque sample");
      for (let c = 0; c < 3; c++) rgb[c] += image.data[i + c] / 49;
    }
    return rgb;
  });
}
function semantic(samples: number[][]): void {
  const [gray, zero, red, green, reference] = samples;
  if (!zero.every(v => v < 5) || !(red[0] > 20 && red[0] > red[1] + 12 && red[0] > red[2] + 12) ||
      !(green[1] > 20 && green[1] > green[0] + 12 && green[1] > green[2] + 12) ||
      !reference.every(v => v > 5) || !gray.every((v, c) => Math.abs(v - reference[c]) < 10))
    throw new Error("pixels: specular color semantics failed");
}
export type SpecularImageEvidenceOptions = { sourceRoot: string; evidenceRoot: string; report?: string };
/** Inputs must be trusted, frozen filesystem snapshots; concurrent mutation is not protected. */
export async function verifyM3SpecularImageEvidence(options: SpecularImageEvidenceOptions) {
  const root = await realpath(options.evidenceRoot), sourceRoot = await realpath(options.sourceRoot);
  const reportPath = options.report ?? "specular-textures-game.json";
  if (path.basename(reportPath) !== "specular-textures-game.json") throw new Error("report: unexpected filename");
  const before = await fingerprint(sourceRoot);
  const bytes = await inside(root, reportPath, 4 * 1024 * 1024);
  const report = object(JSON.parse(bytes.toString("utf8")), "report");
  if (report.sourceIdentity !== before) throw new Error("sourceIdentity: mismatch");
  if (report.scope !== "KHR_materials_specular texture game probe" || report.passed !== true || report.compileOnly !== false || report.phase !== "complete") throw new Error("report: incomplete probe");
  if (!Array.isArray(report.modes) || report.modes.length !== stages.length * modes.length) throw new Error("modes: expected twelve observations");
  const observed = new Set<string>(), images: { stage: string; mode: string; sha256: string }[] = [];
  for (const value of report.modes) {
    const entry = object(value, "mode"), stage = entry.stage, mode = entry.mode;
    if (typeof stage !== "string" || !stages.some(s => s === stage) || typeof mode !== "string" || !modes.some(m => m === mode)) throw new Error("mode: unexpected stage or mode");
    const key = `${stage}-${mode}`;
    if (observed.has(key) || entry.screenshot !== `${key}.png`) throw new Error("mode: duplicate or screenshot mismatch");
    observed.add(key);
    const imageBytes = await inside(root, path.join(path.dirname(reportPath), `${key}.png`), 4 * 1024 * 1024);
    const actual = pixels(imageBytes), claimed = object(entry.samples, `${key}.samples`);
    semantic(actual);
    for (let i = 0; i < names.length; i++) {
      const sample = claimed[names[i]];
      if (!Array.isArray(sample) || sample.length !== 3 || sample.some((v, c) => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v - actual[i][c]) > 1e-6))
        throw new Error(`${key}.samples.${names[i]}: mismatch with PNG`);
    }
    images.push({ stage, mode, sha256: hash(imageBytes) });
  }
  if (await fingerprint(sourceRoot) !== before) throw new Error("sourceIdentity: source changed during verification");
  return { verifiedProbe: "specular-textures-image-semantics" as const, sourceIdentity: before, reportSha256: hash(bytes), images,
    formalMilestoneAccepted: false as const,
    limitations: "Offline pixel semantics and source identity only; cannot prove GPU execution, hardware, provenance, lifecycle behavior, or formal M3 acceptance." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
    return args[index + 1];
  };
  try {
    const result = await verifyM3SpecularImageEvidence({ sourceRoot: option("--source-root"), evidenceRoot: option("--evidence-root") });
    if (args.includes("--output")) await writeFile(option("--output"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
