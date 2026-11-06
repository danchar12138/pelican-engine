import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BoundedLog, executeM3 } from "../tools/m3-acceptance-execute.ts";

const options = { isolatedCandidate: true, hardware: true };
const ok = { exitCode: 0, signal: null, stdout: "raw stdout\n", stderr: "raw stderr\n" };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "m3-executor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.ts"), "original");
  return root;
}
test("records real output locations without copying and never authorizes release", async t => {
  const root = await fixture(t), calls: string[] = [];
  const { report, output } = await executeM3(root, async step => {
    calls.push(step.id);
    if (step.artifacts) {
      const dir = path.join(root, step.artifacts);
      await mkdir(dir, { recursive: true });
      if (step.id.endsWith("probe")) {
        await mkdir(path.join(dir, "new"));
        await writeFile(path.join(dir, "new", step.id === "m3-probe" ? "development-report.json" : "report.json"), "raw evidence");
      } else await writeFile(path.join(dir, step.id === "package-pack" ? "package.tgz" : "smoke.json"), "artifact");
    }
    return step.id === "test" ? { ...ok, stdout: "﹣ unsupported A # SKIP known\n﹣ unsupported B # SKIP known\n﹣ unsupported C # SKIP known\n﹣ unsupported D # SKIP known\nℹ skipped 4\n" } : ok;
  }, options);
  assert.deepEqual(calls, ["test", "distribution-test", "m3-probe", "backend-probe", "package-pack", "package-smoke"]);
  assert.equal(report.status, "executed");
  assert.equal(report.releaseAuthorized, false);
  assert.equal(report.sourceBefore, report.sourceAfter);
  assert.equal(report.steps[0].skipped?.count, 4);
  assert.equal(report.steps[0].skipped?.lines.length, 4);
  assert.equal(report.steps[0].skipped?.complete, true);
  assert.equal(report.steps[1].skipped?.complete, false);
  assert.equal(report.steps[2].artifactDiscovery, "recorded");
  const artifact = report.steps[2].artifacts[0];
  assert.equal(artifact.path, path.join(root, ".pelican/m3-probes/new"));
  assert.match(artifact.sha256!, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(artifact.sha256File!, "utf8"), "raw evidence");
  await assert.rejects(readFile(path.join(output, "artifacts/m3-probe/new/development-report.json")));
});
test("records failed exit and stops", async t => {
  const root = await fixture(t), calls: string[] = [];
  const { report, output } = await executeM3(root, async step => { calls.push(step.id); return { ...ok, exitCode: 17 }; }, options);
  assert.deepEqual(calls, ["test"]);
  assert.equal(report.steps[0].exitCode, 17);
  assert.equal(report.omitted[0], "distribution-test");
  assert.equal(await readFile(path.join(output, "test.stderr.log"), "utf8"), ok.stderr);
});
test("runner errors, truncated logs and source mutation stop execution", async t => {
  const root = await fixture(t);
  const error = await executeM3(root, async () => { throw new Error("spawn error"); }, options);
  assert.match(error.report.steps[0].error!, /spawn error/);
  const truncated = await executeM3(root, async () => ({ ...ok, stdoutTruncated: true }), options);
  assert.match(truncated.report.failure!, /log limit/);
  const changed = await executeM3(root, async () => { await writeFile(path.join(root, "source.ts"), "changed"); return ok; }, options);
  assert.notEqual(changed.report.sourceBefore, changed.report.sourceAfter);
  assert.equal(changed.report.steps.length, 1);
});
test("marks missing probe outputs rather than treating exit zero as evidence", async t => {
  const root = await fixture(t);
  const { report } = await executeM3(root, async () => ok, options);
  assert.equal(report.steps[2].artifactDiscovery, "missing-new-artifact");
  assert.equal(report.releaseAuthorized, false);
});
test("refuses missing opt-in, existing artifacts and a concurrent lock", async t => {
  const root = await fixture(t);
  await assert.rejects(executeM3(root, async () => ok), /opt-in/);
  await mkdir(path.join(root, ".pelican/npm/artifacts"), { recursive: true });
  await writeFile(path.join(root, ".pelican/npm/artifacts/keep"), "untouched");
  await assert.rejects(executeM3(root, async () => ok, options), /Existing npm artifacts/);
  assert.equal(await readFile(path.join(root, ".pelican/npm/artifacts/keep"), "utf8"), "untouched");
  await rm(path.join(root, ".pelican/npm/artifacts"), { recursive: true });
  await mkdir(path.join(root, ".pelican/m3-execution/lock"), { recursive: true });
  await assert.rejects(executeM3(root, async () => ok, options));
});
test("log collector retains bounded head and tail", () => {
  const log = new BoundedLog();
  log.add(Buffer.from("start"));
  log.add(Buffer.alloc(5 * 1024 * 1024, 65));
  log.add(Buffer.from("end"));
  assert.equal(log.truncated, true);
  assert.equal(Buffer.byteLength(log.text()), 4 * 1024 * 1024);
  assert.ok(log.text().startsWith("start"));
  assert.ok(log.text().endsWith("end"));
});
