import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileProject } from "../packages/compiler/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { createPhysicsFactory } from "../packages/physics/index.ts";
import { createClothPlugin } from "../packages/simulation/src/cloth-plugin.ts";
import { createSoftBodyPlugin } from "../packages/simulation/src/softbody-plugin.ts";
import { createGameServices } from "../packages/runtime/src/game-services.ts";

for (const name of ["cloth-sheet", "softbody-ball"]) test(`production coupling: ${name} stays finite and restores`, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "pelican-coupled-"));
  let host: RuntimeHost | undefined;
  try {
    const result = await compileProject({ projectRoot: path.resolve("examples", name), engineRoot: process.cwd(), outDir });
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    let native: ReturnType<Awaited<ReturnType<typeof createPhysicsFactory>>>;
    let sample: unknown;
    const factory = await createPhysicsFactory();
    const gameplay = createGameServices(result.ir!, {} as never);
    host = new RuntimeHost(result.ir!, { plugins: [gameplay.factory, context => {
      native = factory(context);
      for (const key of ["sampleClothBody", "sampleParticleBody"] as const) {
        const original = native.ropePhysicsBridge![key]!;
        native.ropePhysicsBridge![key] = id => { const value = original(id); sample = value; return value; };
      }
      return native;
    }, createClothPlugin, createSoftBodyPlugin] });
    const module = await import(pathToFileURL(path.join(outDir, "game.js")).href);
    host.attach(module.createGame(host.facade));
    for (let i = 0; i < 2400; i++) {
      try { host.step(); }
      catch (error) {
        throw new Error(`${name} tick=${i + 1}; sample=${JSON.stringify(sample)}; ${String(error)}`, { cause: error });
      }
    }
    const snapshot = host.snapshot();
    host.restore(snapshot);
    assert.deepEqual(host.snapshot(), snapshot);
    host.step();
  } finally {
    host?.dispose();
    await rm(outDir, { recursive: true, force: true });
  }
});
