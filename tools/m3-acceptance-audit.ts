/** Incremental fail-closed M3 auditor; never a release gate. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M3_EVIDENCE_REQUIREMENTS, type M3CategoryId } from "./m3-acceptance-contract.ts";
import { verifyBackendEvidence } from "./m3-backend-evidence-verifier.ts";
import { verifyM3SpecularLifecycleEvidence } from "./m3-specular-lifecycle-verifier.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

/** Roots are explicit absolute directories of trusted, frozen inputs. Select two disjoint evidence subdirectories. */
export type M3AuditOptions = { sourceRoot: string; evidenceRoot: string; backendDirectory?: string; specularDirectory?: string };
export type M3AuditResult = {
  status: "failed"; releaseAllowed: false; formalMilestoneAccepted: false; sourceSha256: string | null;
  checks: { id: "backend-probe" | "specular-lifecycle"; status: "verified" | "failed" | "missing"; details: string[] }[];
  missing: { category: M3CategoryId; descriptor: string; reason: string }[];
  errors: string[]; limitations: string;
};
async function directory(input: string, label: string) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw Error(`${label}: absolute directory required`);
  const stat = await lstat(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`${label}: regular directory required`);
  return realpath(input);
}
async function subdirectory(root: string, relative: string, label: string) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes(":") || relative.startsWith("/") || relative.split("/").some(p => !p || p === "." || p === "..")) throw Error(`${label}: safe explicit relative directory required`);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`${label}: regular directory required`);
  }
  const resolved = await realpath(current), rel = path.relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error(`${label}: outside evidence root`);
  return resolved;
}
/** Only existing semantic verifiers can verify slices. No descriptor/status can grant acceptance. */
export async function auditM3Acceptance(options: M3AuditOptions): Promise<M3AuditResult> {
  const checks: M3AuditResult["checks"] = [], errors: string[] = [];
  const missing: M3AuditResult["missing"] = Object.entries(M3_EVIDENCE_REQUIREMENTS).flatMap(([category, descriptors]) => descriptors.map(descriptor => ({ category: category as M3CategoryId, descriptor, reason: {
    "independent-ai": "Missing independently attributable new public-API task, diagnosis/repair and operator workflow.",
    distribution: "Missing clean Windows npm install, actual registry parity/credential state, ZIP/offline build and real GPU distribution proof.",
    performance: "Missing original native-resolution CPU/GPU-or-unknown timing, resource/peak/reset samples and quality controls.",
    verification: "Missing executed frozen-source typecheck, public type tests, zero-skip unit tests and verifier/release negative tests.",
    "scene-static": "Missing original raw/processed raster, hybrid and path reference scene images, configuration and numeric causality.",
    "scene-dynamic": "Missing dynamic public-game raw/processed images, configuration, error and causal proof.",
    materials: "Missing independent material/texture/geometry/light/CPU reference/BSDF/illumination and diagnostic matrix checks.",
    "dynamic-sequence": "Missing executed sequential state mutations, geometry correspondence, rebuild/reset and ghosting/occlusion checks.",
    hardware: "Missing independently authenticated nonfallback WebGPU adapter/browser/driver identity and capabilities; report assertions are not provenance.",
    "webgl-fallback": "Backend probe checks reported fallback and recovery consistency; complete WebGL2 quality and execution provenance remain unverified.",
    lifecycle: "Specular report checks lifecycle consistency only; independent device loss and custom graphics execution remain unverified.",
  }[category as M3CategoryId] ?? "No independently verified formal proof." })));
  let sourceSha256: string | null = null, source = "", root = "";
  try {
    source = await directory(options.sourceRoot, "sourceRoot"); root = await directory(options.evidenceRoot, "evidenceRoot");
    const overlap = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep);
    if (overlap(source, root) || overlap(root, source)) throw Error("sourceRoot and evidenceRoot must be disjoint frozen directories");
    sourceSha256 = (await sourceFingerprint(source)).sha256;
  } catch (error) { errors.push(`roots/source freeze: ${String(error)}`); }
  const seen = new Set<string>();
  for (const { id, relative } of [{ id: "backend-probe" as const, relative: options.backendDirectory }, { id: "specular-lifecycle" as const, relative: options.specularDirectory }]) {
    if (!relative) { checks.push({ id, status: "missing", details: [`${id}: no explicit evidence directory`] }); continue; }
    if (!sourceSha256 || !root) { checks.push({ id, status: "failed", details: [`${id}: roots unavailable`] }); continue; }
    try {
      const dir = await subdirectory(root, relative, id);
      if ([...seen].some(other => dir === other || dir.startsWith(other + path.sep) || other.startsWith(dir + path.sep))) throw Error("evidence directory reused or overlapping");
      seen.add(dir);
      if (id === "backend-probe") {
        const verified = await verifyBackendEvidence(dir, source);
        if (!verified.accepted || verified.issues.length) throw Error(verified.issues.join("; ") || "backend verifier rejected evidence");
        checks.push({ id, status: "verified", details: ["WebGL2 missing/null/rejected adapter, raster/mode rejection/context recovery and WebGPU recovery state/PNG consistency", verified.limitations] });
      } else {
        const verified = await verifyM3SpecularLifecycleEvidence({ sourceRoot: source, evidenceRoot: dir });
        if (verified.sourceIdentity !== sourceSha256 || verified.images.length !== 12) throw Error("source/image verification incomplete");
        checks.push({ id, status: "verified", details: ["12 PNG color semantics and snapshot/rejection/recovery/resource lifecycle consistency", verified.limitations] });
      }
    } catch (error) { checks.push({ id, status: "failed", details: [`${id}: ${String(error)}`] }); }
  }
  if (sourceSha256) try { if ((await sourceFingerprint(source)).sha256 !== sourceSha256) errors.push("source changed during audit"); }
  catch (error) { errors.push(`cannot recheck frozen source: ${String(error)}`); }
  for (const check of checks) if (check.status !== "verified") errors.push(...check.details);
  errors.push("M3 incomplete: independent AI public-API workflow, clean Windows npm/registry parity, full image/material/dynamic quality and failure matrices, independently executed type/unit/public-type verification are not established.");
  return { status: "failed", releaseAllowed: false, formalMilestoneAccepted: false, sourceSha256, checks, missing, errors,
    limitations: "Offline semantic slices only; reports/PNGs cannot authenticate execution, GPU origin, operator or release provenance. Never use for release." };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), allowed = new Set(["--source-root", "--evidence-root", "--backend-directory", "--specular-directory"]);
  try {
    const parsed = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || parsed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw Error(`invalid or repeated option: ${args[i]}`);
      parsed.set(args[i], args[i + 1]);
    }
    if (!parsed.has("--source-root") || !parsed.has("--evidence-root")) throw Error("--source-root and --evidence-root required");
    const result = await auditM3Acceptance({ sourceRoot: parsed.get("--source-root")!, evidenceRoot: parsed.get("--evidence-root")!, backendDirectory: parsed.get("--backend-directory"), specularDirectory: parsed.get("--specular-directory") });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
