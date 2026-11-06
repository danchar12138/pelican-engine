import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runMaterialGraphGpuProbe } from "./m3-material-graph-gpu-probe.ts";
import { verifyM3MaterialGraphEvidence } from "./m3-material-graph-semantic-verifier.ts";

/** Fixed GPU execution followed by independent numeric validation and source freeze.
 * The optional runner is for CPU tests only; the development entrypoint always uses the real probe.
 */
export async function executeMaterialGraphComponent(root: string, output: string, identity: string,
  run: typeof runMaterialGraphGpuProbe = runMaterialGraphGpuProbe) {
  // Never reuse prior evidence when an execution fails.
  await mkdir(output);
  let readbackJson: string | undefined;
  const save = (name: string, value: unknown) => writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
  const report = await run(async readback => {
    if (readbackJson !== undefined) throw new Error("probe: multiple readbacks");
    readbackJson = JSON.stringify(readback);
    await save("material-graph-raw.json", { sourceIdentity: identity, formalMilestoneAccepted: false, ...readback });
  });
  const { backend, adapter, triangles, expected, actual } = report;
  if (readbackJson === undefined || JSON.stringify({ backend, adapter, triangles, expected, actual }) !== readbackJson)
    throw new Error("probe: report differs from raw readback");
  await save("material-graph-gpu.json", { sourceIdentity: identity, formalMilestoneAccepted: false, ...report });
  const verification = await verifyM3MaterialGraphEvidence({ sourceRoot: root, evidenceRoot: output });
  if (verification.sourceIdentity !== identity) throw new Error("sourceIdentity: changed during probe");
  await save("material-graph-semantic-verification.json", verification);
  return verification;
}
