// CPU-only diagnostic. Every potentially trapping WASM operation runs in a child.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";

const mode = process.env.PHYSICS_WASM_HOST_CASE;
if (mode) {
  await RAPIER.init();
  const isolated = mode === "separate-module"
    ? (await import(`${import.meta.resolve("@dimforge/rapier3d-compat")}?host-isolation-experiment`)).default as typeof RAPIER
    : RAPIER;
  await isolated.init();
  console.log("DISTINCT_MODULE", isolated.World !== RAPIER.World);
  const unaffected = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const body = unaffected.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  unaffected.createCollider(RAPIER.ColliderDesc.ball(1), body);
  const victim = new isolated.World({ x: 0, y: 0, z: 0 });
  const queue = new isolated.EventQueue(true);
  const removed = victim.createRigidBody(isolated.RigidBodyDesc.dynamic().setTranslation(3, 0, 0));
  victim.createCollider(isolated.ColliderDesc.cuboid(1, 1, 1).setMass(2), removed);
  const survivor = victim.createRigidBody(isolated.RigidBodyDesc.kinematicPositionBased().setTranslation(40, 0, 0));
  victim.createCollider(isolated.ColliderDesc.cuboid(1, 1, 1), survivor);
  victim.timestep = 0;
  victim.step(queue);
  victim.removeRigidBody(removed);
  victim.timestep = 1 / 60;
  try {
    victim.step(queue);
    console.log("UNEXPECTED_NO_TRAP");
  } catch (error) {
    console.log("TRAPPED", String(error));
  }
  if (mode === "free-victim") {
    console.log("FREE_VICTIM_START");
    victim.free();
    console.log("FREE_VICTIM_OK");
  }
  unaffected.timestep = 1 / 60;
  unaffected.step();
  console.log("OTHER_WORLD_STEP_OK", unaffected.takeSnapshot().length);
  unaffected.free();
  console.log("OTHER_WORLD_FREE_OK");
  // Deliberately abandon the victim in the no-free case; this is not a fix.
} else {
  const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  for (const item of ["abandon-victim", "free-victim", "separate-module"]) {
    const r = spawnSync(process.execPath, [cli, fileURLToPath(import.meta.url)], {
      env: { ...process.env, PHYSICS_WASM_HOST_CASE: item }, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    console.log(JSON.stringify({ scenario: item, status: r.status, signal: r.signal, error: r.error?.message,
      stdout: r.stdout?.trim(), stderr: r.stderr?.trim() }));
  }
}
