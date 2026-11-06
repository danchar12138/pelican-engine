/** Offline semantic check for the fixed two-pass material-graph GPU numeric probe.
 * This is not proof of GPU execution, adapter identity, or formal M3 acceptance.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.ts";


const REPORT_NAME = "material-graph-gpu.json";
const MAX_REPORT_BYTES = 1024 * 1024;
const FIELDS = 8;
const TRIANGLES = 4;
const TOLERANCE = 5e-5;

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value as RecordValue;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}: expected finite number`);
  return value;
}
function vector(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== TRIANGLES * FIELDS)
    throw new Error(`${label}: expected ${TRIANGLES * FIELDS} fields`);
  return value.map((v: unknown, i: number) => number(v, `${label}[${i}]`));
}
function equalNear(actual: number, expected: number, label: string): number {
  const error = Math.abs(actual - expected);
  if (error >= TOLERANCE) throw new Error(`${label}: numeric mismatch (error ${error})`);
  return error;
}
/** Derived independently from the probe's fixed fixture: two planes per material,
 * opacity 0.8, alphaTest 0.3, time graphs for opacity/roughness, constant emissive.
 * Changes to this probe fixture require a deliberate verifier update.
 */
function oracle(epoch: number): number[] {
  const times = epoch === 0 ? [0.25, 0.75] : [1.5, -0.25];
  return times.flatMap((time, material) => {
    const roughness = Math.max(0, Math.min(1, time));
    const alpha = 0.8 * roughness;
    const discarded = alpha < 0.3 ? 1 : 0;
    const emissive = material === 0 ? [1, 2, 3] : [4, 5, 6];
    const fields = [alpha, roughness, alpha, discarded, ...emissive, discarded];
    return [...fields, ...fields];
  });
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export type MaterialGraphEvidenceOptions = {
  /** Explicit, trusted frozen tree used to compute the source fingerprint. */
  sourceRoot: string;
  /** Explicit, trusted directory containing the report (may include subdirectories). */
  evidenceRoot: string;
  /** Relative path below evidenceRoot; defaults to material-graph-gpu.json. */
  report?: string;
};

/** Reject self-attested success and check actual numeric readbacks against the
 * independently reconstructed fixture, plus the live source fingerprint.
 * Use only on frozen trusted inputs: concurrent hostile filesystem edits are not protected.
 */
export async function verifyM3MaterialGraphEvidence(options: MaterialGraphEvidenceOptions) {
  const root = await realpath(options.evidenceRoot);
  const relative = options.report ?? REPORT_NAME;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === "..") ||
      path.basename(relative) !== REPORT_NAME)
    throw new Error("report: must name material-graph-gpu.json inside evidenceRoot");
  const file = path.resolve(root, relative);
  const canonical = await realpath(file);
  const contained = path.relative(root, canonical);
  if (!contained || contained.startsWith(".." + path.sep) || contained === ".." || path.isAbsolute(contained))
    throw new Error("report: escapes evidenceRoot");
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error("report: expected bounded regular file");
  const sourceRoot = await realpath(options.sourceRoot);
  const before = (await sourceFingerprint(sourceRoot)).sha256;
  const bytes = await readFile(file);
  if (bytes.length > MAX_REPORT_BYTES) throw new Error("report: size limit exceeded");
  const report = record(JSON.parse(bytes.toString("utf8")) as unknown, "report");
  if (typeof report.sourceIdentity !== "string" || report.sourceIdentity !== before)
    throw new Error("sourceIdentity: does not match live source fingerprint");
  if (report.backend !== "webgpu") throw new Error("backend: expected webgpu");
  // A false report is rejected, but true is never accepted as evidence of execution.
  if (report.passed !== true) throw new Error("passed: probe did not report success");
  if (report.formalMilestoneAccepted !== false) throw new Error("formalMilestoneAccepted: must remain false");
  if (report.triangles !== TRIANGLES) throw new Error("triangles: unexpected fixture size");
  const adapter = record(report.adapter, "adapter");
  if (adapter.isFallbackAdapter !== false) throw new Error("adapter: fallback or unknown");
  if (!Array.isArray(report.expected) || report.expected.length !== 2 ||
      !Array.isArray(report.actual) || report.actual.length !== 2)
    throw new Error("samples: expected exactly two paired epochs");
  let maxAbsoluteError = 0;
  for (let epoch = 0; epoch < 2; epoch++) {
    const independent = oracle(epoch);
    const claimed = vector(report.expected[epoch], `expected[${epoch}]`);
    const actual = vector(report.actual[epoch], `actual[${epoch}]`);
    for (let i = 0; i < independent.length; i++) {
      // Assert both the claimed reference and GPU readback against the same independent oracle.
      equalNear(claimed[i], independent[i], `expected[${epoch}][${i}]`);
      maxAbsoluteError = Math.max(maxAbsoluteError, equalNear(actual[i], independent[i], `actual[${epoch}][${i}]`));
    }
  }
  const after = (await sourceFingerprint(sourceRoot)).sha256;
  if (after !== before) throw new Error("sourceIdentity: source changed during verification");
  return {
    verifiedProbe: "material-graph-gpu-numeric" as const,
    sourceIdentity: before,
    reportSha256: sha256(bytes),
    epochs: 2,
    triangles: TRIANGLES,
    maxAbsoluteError,
    formalMilestoneAccepted: false as const,
    limitations: "Offline numeric semantics and live source identity only; no proof of GPU execution, hardware, provenance, full rendering or M3 acceptance.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`Missing ${flag}`);
    return args[index + 1];
  };
  try {
    console.log(JSON.stringify(await verifyM3MaterialGraphEvidence({
      sourceRoot: value("--source-root"), evidenceRoot: value("--evidence-root"),
      report: args.includes("--report") ? value("--report") : undefined,
    }), null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}

