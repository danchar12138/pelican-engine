import { writeFileSync } from "node:fs";
import { cpus, arch, platform } from "node:os";
import { cpuUsage, version } from "node:process";
import { fileURLToPath } from "node:url";
import { runSimulationProbe } from "./index.ts";

const cpuStart = cpuUsage(),
  start = performance.now();
const report = runSimulationProbe({ steps: 240, lifecycleCycles: 12 });
const cpu = cpuUsage(cpuStart);
const evidence = {
  recordedAt: new Date().toISOString(),
  environment: {
    node: version,
    platform: platform(),
    architecture: arch(),
    cpu: cpus()[0]?.model,
    logicalProcessors: cpus().length,
  },
  processCpu: {
    userMs: cpu.user / 1000,
    systemMs: cpu.system / 1000,
    elapsedWallMs: performance.now() - start,
  },
  ...report,
};
const output = fileURLToPath(new URL("./evidence.json", import.meta.url));
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      output,
      processCpu: evidence.processCpu,
      cases: report.cases.map((c) => ({
        kind: c.kind,
        passed: c.passed,
        checks: c.checks,
        meanStepMs: c.timing.meanCoupledStepMs,
        snapshotBytes: c.snapshot.bytes,
      })),
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
