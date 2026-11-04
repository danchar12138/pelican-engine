import { writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { cpuUsage, version } from "node:process";
import { fileURLToPath } from "node:url";
import { runWorldProbe } from "./index.ts";
// Windows process CPU accounting is coarse; repeat rather than claim a 0 ms CPU cost.
const measurementRuns = 32,
  start = performance.now(),
  cpuStart = cpuUsage();
const report = await runWorldProbe();
let passedRuns = report.passed ? 1 : 0;
for (let i = 1; i < measurementRuns; i++) {
  const repeated = await runWorldProbe();
  if (repeated.passed) passedRuns++;
}
const cpu = cpuUsage(cpuStart),
  elapsedWallMs = performance.now() - start;
const evidence = {
  recordedAt: new Date().toISOString(),
  environment: {
    node: version,
    platform: platform(),
    architecture: arch(),
    cpu: cpus()[0]?.model,
    logicalProcessors: cpus().length,
  },
  measurement: {
    runs: measurementRuns,
    passedRuns,
    meanWholeProbeWallMs: elapsedWallMs / measurementRuns,
  },
  processCpu: {
    userMs: cpu.user / 1000,
    systemMs: cpu.system / 1000,
    elapsedWallMs,
  },
  ...report,
  passed: report.passed && passedRuns === measurementRuns,
};
const output = fileURLToPath(new URL("./evidence.json", import.meta.url));
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify(
    {
      passed: evidence.passed,
      output,
      checks: report.checks,
      asyncTransactions: report.asyncTransactions,
      snapshot: report.snapshot,
      timing: report.timing,
      measurement: evidence.measurement,
      processCpu: evidence.processCpu,
    },
    null,
    2,
  ),
);
if (!evidence.passed) process.exitCode = 1;
