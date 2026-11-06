// CPU-only diagnostic: Rapier is executed only in child processes.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { legacyRig, type LegacyCase } from "./support/physics-v3-fixture.ts";

const cases = ["separate-remove-last", "overlap-remove-first", "untrusted-remove-first"] as const;
const mode = process.env.PHYSICS_ISOLATION_CASE;
if (mode) {
  if (!cases.includes(mode as typeof cases[number])) throw new Error("Unknown case");
  const name: LegacyCase = mode === "overlap-remove-first" ? mode : "separate-remove-last";
  const fixture = JSON.parse(await readFile(new URL(`./fixtures/physics-v3/${name}.json`, import.meta.url), "utf8"));
  const rig = await legacyRig(name);
  try {
    if (mode === "untrusted-remove-first") {
      const h = fixture.snapshot.history;
      h[0].id = h[1].id = "last";
      h[2].removed = ["first"];
      h[2].frame = [{ id: "last", transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }];
      fixture.snapshot.bindings = ["last"];
    }
    const before = mode === "untrusted-remove-first" ? rig.plugin.snapshot() : undefined;
    console.log("VALIDATION_START");
    try {
      rig.plugin.validateSnapshot(fixture.snapshot);
      if (mode === "untrusted-remove-first") console.log("UNEXPECTED_ACCEPTANCE");
      else {
        rig.plugin.restore(fixture.snapshot);
        assert.deepEqual(rig.plugin.snapshot(), fixture.snapshot);
        console.log("FIXTURE_RESTORED_BYTE_EXACT");
      }
    } catch (error) {
      if (mode !== "untrusted-remove-first" || !String(error).includes("TC_PHYSICS_SNAPSHOT")) throw error;
      assert.deepEqual(rig.plugin.snapshot(), before);
      console.log("VALIDATION_REJECTED_ATOMICALLY");
    }
  } finally { rig.dispose(); }
} else {
  const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  let failed = false;
  for (const item of cases) {
    const r = spawnSync(process.execPath, [cli, fileURLToPath(import.meta.url)], {
      env: { ...process.env, PHYSICS_ISOLATION_CASE: item }, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    const stdout = r.stdout ?? "";
    const expected = item === "untrusted-remove-first" ? "VALIDATION_REJECTED_ATOMICALLY" : "FIXTURE_RESTORED_BYTE_EXACT";
    const pass = !r.error && r.status === 0 && stdout.includes("VALIDATION_START") && stdout.includes(expected);
    console.log(JSON.stringify({ scenario: item, pass, status: r.status, signal: r.signal, error: r.error?.message, stdout: stdout.trim(), stderr: (r.stderr ?? "").trim() }));
    if (!pass) failed = true;
  }
  if (failed) process.exitCode = 1;
}
