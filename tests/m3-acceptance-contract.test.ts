import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditM3AcceptanceContract, M3_EVIDENCE_REQUIREMENTS, M3_MAX_EVIDENCE_BYTES, type M3PreflightReport } from "../tools/m3-acceptance-contract.ts";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";

test("preflight rejects missing, forged, skipped and stale evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "m3-contract-"));
  try {
    const sourceRoot = path.join(root, "source"), evidenceRoot = path.join(root, "evidence");
    await mkdir(sourceRoot); await mkdir(evidenceRoot);
    await writeFile(path.join(sourceRoot, "source.ts"), "source");
    await writeFile(path.join(evidenceRoot, "record.txt"), "synthetic");
    const identity = await sourceFingerprint(sourceRoot);
    const hash = createHash("sha256").update("synthetic").digest("hex");
    const report: M3PreflightReport = {
      protocol: "m3-evidence-preflight-v1", sourceIdentity: { algorithm: "sha256", scope: "executable-source-and-lockfiles", sha256: identity.sha256 },
      hardware: { backend: "webgpu", adapter: "test adapter", vendor: "test vendor", device: "test device", driver: "test driver", browser: "test browser", software: false, fallback: false },
      gpuTiming: { method: "unknown" }, independentAI: { independent: true, operator: "test operator", task: "test task" },
      categories: Object.entries(M3_EVIDENCE_REQUIREMENTS).map(([id, names]) => ({ id: id as M3PreflightReport["categories"][number]["id"], status: "passed", evidence: names.map(name => ({ id: name, path: "record.txt", sha256: hash, sourceSha256: identity.sha256, status: "passed", attested: true, proof: "recorded" })) })),
    };
    const audit = (r: unknown) => auditM3AcceptanceContract(r, { sourceRoot, evidenceRoot });
    const ok = await audit(report);
    assert.equal(ok.status, "passed"); assert.equal(ok.formalMilestoneAccepted, false);
    const beforePublish = structuredClone(report);
    const distribution = beforePublish.categories.find(category => category.id === "distribution")!;
    distribution.evidence = distribution.evidence.filter(item => item.id !== "registry-parity");
    const pre = await auditM3AcceptanceContract(beforePublish, { sourceRoot, evidenceRoot, phase: "pre-publication" });
    assert.equal(pre.status, "passed");
    assert.equal(pre.formalMilestoneAccepted, false);
    assert.deepEqual(pre.deferred, ["distribution/registry-parity"]);
    assert.equal((await audit(beforePublish)).status, "failed");
    assert.equal((await auditM3AcceptanceContract(beforePublish, { sourceRoot, evidenceRoot, phase: "post-publication" })).status, "failed");
    distribution.evidence = distribution.evidence.filter(item => item.id !== "static-deploy");
    assert.equal((await auditM3AcceptanceContract(beforePublish, { sourceRoot, evidenceRoot, phase: "pre-publication" })).status, "failed");
    assert.equal((await auditM3AcceptanceContract(report, { sourceRoot, evidenceRoot, phase: "invalid" as any })).status, "failed");
    const privacy = structuredClone(report); privacy.hardware.device = "unknown"; privacy.hardware.driver = "unknown";
    assert.equal((await audit(privacy)).status, "passed");
    const mutations: ((r: any) => void)[] = [
      r => r.categories.pop(),
      r => r.categories[0].evidence.pop(),
      r => r.categories.push(structuredClone(r.categories[0])),
      r => r.categories[0].evidence.push(structuredClone(r.categories[0].evidence[0])),
      r => r.categories[0].status = "skipped",
      r => r.categories[0].evidence[0].status = "skipped",
      r => r.categories[0].evidence[0].attested = false,
      r => r.categories[0].evidence[0].proof = "missing",
      r => r.categories[0].evidence[0].path = "../source/source.ts",
      r => r.categories[0].evidence[0].path = "missing.txt",
      r => r.categories[0].evidence[0].sha256 = "0".repeat(64),
      r => r.categories[0].evidence[0].sourceSha256 = "0".repeat(64),
      r => r.sourceIdentity.sha256 = "0".repeat(64),
      r => r.hardware.software = true,
      r => r.hardware.fallback = true,
      r => r.hardware.backend = "webgl2",
      r => r.independentAI.independent = false,
      r => r.gpuTiming.method = "raf",
    ];
    for (const mutate of mutations) { const copy = structuredClone(report); mutate(copy); assert.equal((await audit(copy)).status, "failed"); }
    const oversized = path.join(evidenceRoot, "oversized.bin"), file = await open(oversized, "w");
    try { await file.truncate(M3_MAX_EVIDENCE_BYTES + 1); } finally { await file.close(); }
    const oversizedReport = structuredClone(report); oversizedReport.categories[0].evidence[0].path = "oversized.bin";
    assert.equal((await audit(oversizedReport)).status, "failed");
    await writeFile(path.join(evidenceRoot, "record.txt"), "tampered");
    assert.equal((await audit(report)).status, "failed");
    await writeFile(path.join(evidenceRoot, "record.txt"), "synthetic");
    await writeFile(path.join(sourceRoot, "source.ts"), "changed");
    assert.equal((await audit(report)).status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
