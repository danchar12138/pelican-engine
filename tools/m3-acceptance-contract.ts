import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.ts";

export const M3_EVIDENCE_REQUIREMENTS = {
  "scene-static": ["raster-raw", "raster-processed", "hybrid-raw", "hybrid-processed", "path-raw", "path-processed", "configuration", "error-causality"],
  "scene-dynamic": ["raster-raw", "raster-processed", "hybrid-raw", "hybrid-processed", "path-raw", "path-processed", "configuration", "error-causality"],
  materials: ["multi-material", "pbr-textures", "normals", "skinning", "morph", "instance-transform", "topology", "transparency", "emission", "multiple-lights", "unsupported-diagnostics", "cpu-reference", "raster-input-parity", "reflection-refraction", "direct-indirect-mis", "hybrid-causality"],
  "dynamic-sequence": ["camera", "animation", "spawn-destroy", "visibility", "reload", "snapshot-restore", "material-light-world-changes", "geometry-version-consistency", "refit-rebuild-lifecycle", "stale-work", "denoise-ghosting-occlusion"],
  hardware: ["webgpu-hardware-identity", "no-software-fallback", "adapter-capabilities"],
  performance: ["native-dimensions", "cpu-timing-samples", "gpu-timing-samples-or-unknown", "memory-resource-samples", "refit-rebuild-samples", "history-reset-samples", "peak-events", "no-quality-reduction"],
  "independent-ai": ["independent-operator", "new-material-or-render-task", "public-api-only", "diagnose-and-repair", "workflow-record"],
  distribution: ["clean-windows-npm-install", "npm-build-real-gpu", "zip-parity", "registry-parity", "offline-after-install", "license-notices", "single-sdk-api", "static-deploy", "version-internal-dependency-diagnostics", "dist-cold-start", "dev-controls-removed", "package-contents"],
  "webgl-fallback": ["backend-identity", "raster-output", "mode-switch", "compute-mode-rejection", "error-codes-state-preserved", "no-quality-reduction", "resource-lifecycle", "context-loss-recovery"],
  lifecycle: ["device-loss-reconstruction", "resource-reload-disposal", "mode-switch", "custom-graphics-failure", "diagnostics"],
  verification: ["typecheck", "type-tests", "unit-tests-no-skips", "formal-verifier-negative-tests", "release-profile-negative-tests", "source-freeze"],
} as const;
export type M3CategoryId = keyof typeof M3_EVIDENCE_REQUIREMENTS;
export interface M3EvidenceDescriptor { id: string; path: string; sha256: string; sourceSha256: string; status: "passed"; attested: true; proof: "recorded" }
export interface M3EvidenceCategory { id: M3CategoryId; status: "passed"; evidence: M3EvidenceDescriptor[] }
export interface M3PreflightReport {
  protocol: "m3-evidence-preflight-v1";
  sourceIdentity: { algorithm: "sha256"; scope: "executable-source-and-lockfiles"; sha256: string };
  categories: M3EvidenceCategory[];
  hardware: { backend: "webgpu"; adapter: string; vendor: string; device: string; driver: string; browser: string; software: false; fallback: false };
  gpuTiming: { method: "gpu-timestamp" | "unknown" };
  independentAI: { independent: true; operator: string; task: string };
}
export type M3PreflightPhase = "pre-publication" | "post-publication";
export interface M3PreflightResult { status: "passed" | "failed"; phase: M3PreflightPhase; deferred: string[]; formalMilestoneAccepted: false; errors: string[] }
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v === v.trim();
const nonPlaceholder = (v: unknown): v is string => text(v) && !/^(unknown|n\/?a|none|unspecified|software|fallback)$/i.test(v);
export const M3_MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;

async function evidenceDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const data = chunk as Buffer;
    bytes += data.length;
    if (bytes > M3_MAX_EVIDENCE_BYTES) throw new Error("evidence exceeds size limit");
    hash.update(data);
  }
  if (!bytes) throw new Error("empty evidence");
  return hash.digest("hex");
}

async function checkEvidence(item: Record<string, unknown>, label: string, root: string, fail: (message: string) => void, digests: Map<string, Promise<string>>) {
  const name = item.path;
  if (!text(name) || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..") || !root) { fail(`${label}: unsafe path`); return; }
  try {
    let current = root;
    for (const part of name.split("/")) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink"); }
    const stat = await lstat(current);
    if (!stat.isFile() || stat.size === 0 || stat.size > M3_MAX_EVIDENCE_BYTES) throw new Error("not a bounded nonempty file");
    const actual = await realpath(current);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("outside root");
    let digest = digests.get(actual);
    if (!digest) { digest = evidenceDigest(actual); digests.set(actual, digest); }
    if (await digest !== item.sha256) throw new Error("hash mismatch");
  } catch { fail(`${label}: missing, unsafe, or hash mismatch`); }
}

/** Structural preflight only; it neither verifies semantics nor writes acceptance artifacts. */
export async function auditM3AcceptanceContract(report: unknown, options: { sourceRoot: string; evidenceRoot: string; phase?: M3PreflightPhase }): Promise<M3PreflightResult> {
  const errors: string[] = [];
  const phase = options.phase ?? "post-publication";
  const deferred: string[] = [];
  const fail = (message: string) => { errors.push(message); };
  const result = (): M3PreflightResult => ({ status: errors.length ? "failed" : "passed", phase, deferred, formalMilestoneAccepted: false, errors });
  if (phase !== "pre-publication" && phase !== "post-publication") fail("invalid preflight phase");
  if (!record(report)) { fail("report must be an object"); return result(); }
  if (report.protocol !== "m3-evidence-preflight-v1") fail("invalid protocol");
  const identity = report.sourceIdentity;
  if (!record(identity) || identity.algorithm !== "sha256" || identity.scope !== "executable-source-and-lockfiles" || !sha(identity.sha256)) fail("invalid source identity");
  let initial = "";
  try { initial = (await sourceFingerprint(options.sourceRoot)).sha256; } catch { fail("cannot fingerprint source"); }
  if (!record(identity) || identity.sha256 !== initial || !initial) fail("source identity mismatch");
  const hardware = report.hardware;
  // Drivers and device names can be hidden by browser privacy policy; record explicit unknowns without inventing them.
  if (!record(hardware) || hardware.backend !== "webgpu" || hardware.software !== false || hardware.fallback !== false || ![hardware.adapter, hardware.vendor, hardware.browser].every(nonPlaceholder) || ![hardware.device, hardware.driver].every(text)) fail("invalid hardware attestation");
  if (!record(report.gpuTiming) || (report.gpuTiming.method !== "gpu-timestamp" && report.gpuTiming.method !== "unknown")) fail("invalid GPU timing method");
  if (!record(report.independentAI) || report.independentAI.independent !== true || !nonPlaceholder(report.independentAI.operator) || !nonPlaceholder(report.independentAI.task)) fail("invalid independent AI attestation");
  let evidenceRoot = "";
  try { evidenceRoot = await realpath(options.evidenceRoot); } catch { fail("cannot resolve evidence root"); }
  const categories = Array.isArray(report.categories) ? report.categories : [];
  if (!Array.isArray(report.categories)) fail("categories must be an array");
  const seenCategories = new Set<string>();
  // Multiple checks can cite one artifact; read it once per audit, never across audits.
  const digests = new Map<string, Promise<string>>();
  for (const category of categories) {
    if (!record(category) || !text(category.id) || !Object.hasOwn(M3_EVIDENCE_REQUIREMENTS, category.id)) { fail("unknown or invalid category"); continue; }
    const id = category.id as M3CategoryId;
    if (seenCategories.has(id)) fail(`duplicate category: ${id}`);
    seenCategories.add(id);
    if (category.status !== "passed") fail(`${id}: category not passed`);
    const entries = Array.isArray(category.evidence) ? category.evidence : [];
    if (!Array.isArray(category.evidence)) fail(`${id}: evidence must be an array`);
    const seen = new Set<string>();
    for (const item of entries) {
      if (!record(item) || !text(item.id) || !(M3_EVIDENCE_REQUIREMENTS[id] as readonly string[]).includes(item.id)) { fail(`${id}: unknown descriptor`); continue; }
      const label = `${id}/${item.id}`;
      if (seen.has(item.id)) fail(`${label}: duplicate descriptor`);
      seen.add(item.id);
      if (item.status !== "passed" || item.attested !== true || item.proof !== "recorded") fail(`${label}: missing passed attestation/proof`);
      if (!sha(item.sha256) || item.sourceSha256 !== initial || !initial) fail(`${label}: invalid hash or source`);
      await checkEvidence(item, label, evidenceRoot, fail, digests);
    }
    for (const required of M3_EVIDENCE_REQUIREMENTS[id]) if (!seen.has(required)) {
      if (phase === "pre-publication" && id === "distribution" && required === "registry-parity") deferred.push(`${id}/${required}`);
      else fail(`${id}/${required}: missing descriptor`);
    }
  }
  for (const id of Object.keys(M3_EVIDENCE_REQUIREMENTS)) if (!seenCategories.has(id)) fail(`${id}: missing category`);
  try { if ((await sourceFingerprint(options.sourceRoot)).sha256 !== initial) fail("source changed during audit"); } catch { fail("cannot recheck source fingerprint"); }
  return result();
}
