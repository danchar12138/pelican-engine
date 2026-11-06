import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { legacyRig, type LegacyCase } from "../tests/support/physics-v3-fixture.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

if (!process.argv.includes("--capture-legacy")) throw Error("TC_PHYSICS_FIXTURE: Explicit --capture-legacy is required; never overwrite compatibility fixtures after changing the legacy implementation.");
const root = fileURLToPath(new URL("../", import.meta.url)), out = path.join(root, "tests/fixtures/physics-v3");
await mkdir(out, { recursive: true });
const identity = await sourceFingerprint(root);
for (const which of ["separate-remove-last", "overlap-remove-first"] as LegacyCase[]) {
  const rig = await legacyRig(which);
  try {
    const ids = rig.prepare(); rig.step();
    const payload = { format: "pelican.physics-legacy-fixture", sourceIdentity: identity.sha256, scenario: which, ...ids, snapshot: rig.plugin.snapshot(), survivorTransform: rig.world.getTransform(ids.survivor), survivorVelocity: rig.physics.velocity(ids.survivor), survivorAngularVelocity: rig.physics.angularVelocity(ids.survivor) };
    await writeFile(path.join(out, which + ".json"), JSON.stringify(payload) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ scenario: which, sourceIdentity: identity.sha256 }));
  } finally { rig.dispose(); }
}
