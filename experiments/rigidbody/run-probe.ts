import { runRigidBodyProbe } from "./index.ts";

// Stdout only: the main M0 verifier owns evidence paths and acceptance aggregation.
const report = await runRigidBodyProbe();
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
