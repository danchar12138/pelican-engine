import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.ts";

/** Each raw WASM case is isolated: a trap must not poison the next case. */
export async function runPhysicsZeroInitMatrix(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(output, { recursive: true });
  const identity = await sourceFingerprint(root), types = ["dynamic", "fixed", "kinematicPositionBased"] as const;
  const source = `import R from '@dimforge/rapier3d-compat';
await R.init();
const [removed,survivor,normalFirst]=process.argv.slice(1);
const world=new R.World({x:0,y:0,z:0}), queue=new R.EventQueue(true);
const a=world.createRigidBody(R.RigidBodyDesc[removed]().setTranslation(0,0,0));
const b=world.createRigidBody(R.RigidBodyDesc[survivor]().setTranslation(4,0,0));
world.createCollider(R.ColliderDesc.cuboid(1,1,1),a);
world.createCollider(R.ColliderDesc.cuboid(1,1,1),b);
world.timestep=0;world.step(queue);
if(normalFirst==='yes'){world.timestep=1/60;world.step(queue);world.timestep=0;world.step(queue);world.step(queue);}
world.removeRigidBody(a);world.timestep=1/60;world.step(queue);
console.log(JSON.stringify({outcome:'no-trap',position:b.translation()}));queue.free();world.free();`;
  const cases: { removed: string; survivor: string; normalStepBeforeRemoval: boolean; outcome: string; exitCode: number | null; diagnostic?: string }[] = [];
  for (const normalFirst of [false, true]) for (const removed of types) for (const survivor of types) {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", source, removed, survivor, normalFirst ? "yes" : "no"], { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1_000_000 });
    const combined = run.stdout + run.stderr, noTrap = run.status === 0 && combined.includes('"outcome":"no-trap"');
    const outcome = noTrap ? "no-trap" : /RuntimeError: unreachable/.test(combined) ? "wasm-trap" : run.error ? "runner-error" : "unexpected-failure";
    cases.push({ removed, survivor, normalStepBeforeRemoval: normalFirst, outcome, exitCode: run.status, ...(noTrap ? {} : { diagnostic: String(run.error ?? combined).slice(-2000) }) });
  }
  const summary = { scope: "Rapier zero-time initialization and body-removal matrix", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, cases, note: "A no-trap outcome does not prove correct contacts, events, sleep, snapshot or numerical behavior." };
  await writeFile(path.join(output, "physics-zero-init-matrix.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/physics-zero-init-matrix/" + Date.now());
  runPhysicsZeroInitMatrix(output).then(r => { const unexpected = r.cases.filter(c => c.outcome === "runner-error" || c.outcome === "unexpected-failure").length; console.log(JSON.stringify({ output, sourceIdentity: r.sourceIdentity, cases: r.cases.length, traps: r.cases.filter(c => c.outcome === "wasm-trap").length, unexpected })); if (unexpected) process.exitCode = 1; }).catch(error => { console.error(error); process.exitCode = 1; });
}
