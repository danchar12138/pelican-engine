import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { legacyRig, type LegacyCase } from "./support/physics-v3-fixture.ts";

for (const which of ["separate-remove-last", "overlap-remove-first"] as LegacyCase[]) test(`legacy v3 snapshot restores and remains verifiable: ${which}`, async () => {
  const fixture = JSON.parse(await readFile(new URL(`./fixtures/physics-v3/${which}.json`, import.meta.url), "utf8"));
  assert.equal(fixture.format, "pelican.physics-legacy-fixture"); assert.equal(fixture.scenario, which); assert.equal(fixture.snapshot.version, 3);
  assert.match(fixture.sourceIdentity, /^[a-f0-9]{64}$/);
  const rig = await legacyRig(which);
  try {
    rig.prepare(); rig.plugin.validateSnapshot(fixture.snapshot); rig.plugin.restore(fixture.snapshot);
    assert.deepEqual(rig.plugin.snapshot(), fixture.snapshot); assert.deepEqual(rig.world.getTransform(fixture.survivor), fixture.survivorTransform);
    assert.deepEqual(rig.physics.velocity(fixture.survivor), fixture.survivorVelocity); assert.deepEqual(rig.physics.angularVelocity(fixture.survivor), fixture.survivorAngularVelocity);
    rig.step(); rig.plugin.validateSnapshot(rig.plugin.snapshot());
  } finally { rig.dispose(); }
});
