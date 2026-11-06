import test from "node:test";
import assert from "node:assert/strict";
import { assertAnimationSnapshots, assertDynamicTransition, compareAnimationImages, compareDynamicImages } from "../tools/m3-dynamic-sdk-game-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { createGameServices } from "../packages/runtime/src/game-services.ts";

function state(): any {
  return { mode: "path", tick: 1, objects: { camera: [0, 0, 5] },
    runtime: { records: [{ id: "subject", prefab: "subject-blue", transform: [0] }, { id: "blocker", prefab: "screen-panel" }, { id: "sun", transform: [0] }] },
    game: { components: { control: { TemporalState: { skin: false } } } },
    gameplay: { models: { instances: 1, templates: [{ id: "fox", animations: ["Run"] }] } } };
}
test("dynamic transitions require their own state change", () => {
  for (const kind of ["object", "camera", "animation", "destroy", "spawn", "material", "light"]) {
    const before = state(), after = structuredClone(before);
    after.tick++;
    if (kind === "spawn") before.runtime.records = before.runtime.records.filter((r: any) => r.id !== "blocker");
    const unchanged = structuredClone(before); unchanged.tick++;
    assert.throws(() => assertDynamicTransition(kind, before, unchanged), kind);
    if (kind === "object") after.runtime.records[0].transform = [1];
    if (kind === "camera") after.objects.camera[0] = 1;
    if (kind === "animation") after.game.components.control.TemporalState.skin = true;
    if (kind === "destroy") after.runtime.records = after.runtime.records.filter((r: any) => r.id !== "blocker");
    if (kind === "material") after.runtime.records[0].prefab = "subject-pink";
    if (kind === "light") after.runtime.records[2].transform = [1];
    assert.doesNotThrow(() => assertDynamicTransition(kind, before, after), kind);
  }
});
test("image comparison rejects identical and mismatched frames", () => {
  const before = { width: 2, height: 2, channels: 4, depth: 8, data: new Uint8Array(16) };
  const after = { ...before, data: new Uint8Array(16).fill(100) };
  assert.throws(() => compareDynamicImages(before, before));
  assert.throws(() => compareDynamicImages(before, { ...after, width: 1 }));
  assert.ok(compareDynamicImages(before, after).meanRgbDifference > 0);
});

test("animation image check rejects noise and changes outside the fox region", () => {
  const frame = () => ({ width: 320, height: 240, channels: 4, depth: 8, data: new Uint8Array(320 * 240 * 4) });
  const paint = (image: ReturnType<typeof frame>, x0: number, value: number) => {
    for (let y = 70; y < 130; y++) for (let x = x0; x < x0 + 60; x++)
      for (let c = 0; c < 3; c++) image.data[(y * 320 + x) * 4 + c] = value;
  };
  const reference = frame(), before = frame(), outside = frame(), after = frame();
  paint(outside, 10, 80); paint(after, 200, 80);
  assert.throws(() => compareAnimationImages(reference, before, before));
  assert.throws(() => compareAnimationImages(reference, before, outside));
  assert.ok(compareAnimationImages(reference, before, after).foxRegion.signal.changedFraction > 0);
  const noisy = frame(); paint(noisy, 200, 80);
  assert.throws(() => compareAnimationImages(reference, noisy, before));
});

test("animation snapshots require the Run action to start and advance", () => {
  const snapshot = (speed: number, time: number) => ({ runtime: { plugins: { "$engine.models": { payload: { animation: { animations: [
    { entity: "animated", currentClip: "Run", actions: [{ clip: "Run", speed, time }] },
  ] } } } } } });
  assertAnimationSnapshots(snapshot(0, 0), snapshot(1, 0.5));
  assert.throws(() => assertAnimationSnapshots(snapshot(0, 0), snapshot(1, 0)));
  assert.throws(() => assertAnimationSnapshots(snapshot(0, 0), snapshot(0, 0.5)));
  assert.throws(() => assertAnimationSnapshots({}, {}));
});

test("compiled public game drives CPU runtime transitions", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const outDir = await mkdtemp(path.join(tmpdir(), "pelican-dynamic-sdk-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const compiled = await compileProject({ engineRoot: root, projectRoot: path.join(root, "examples/m3-dynamic-sdk"), outDir });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  assert.ok(compiled.ir);
  const plays: any[] = [];
  const driver = createGameServices(compiled.ir, { play: (...args) => { plays.push(args); }, state: () => ({ clip: null, time: 0, playing: false }) });
  const host = new RuntimeHost(compiled.ir, { plugins: [driver.factory] });
  t.after(() => host.dispose());
  const game = await import(pathToFileURL(path.join(outDir, "game.js")).href);
  host.attach(game.createGame(host.facade));
  const tap = (key: string, count = 1) => { host.input(key, true); host.input(key, false); host.step(count); };
  host.step();
  const start = host.world.getTransform("subject"); tap("o", 20);
  assert.notDeepEqual(host.world.getTransform("subject"), start); tap("f");
  const yaw = driver.inspect().camera!.yaw; tap("c", 30);
  assert.notEqual(driver.inspect().camera!.yaw, yaw); tap("f");
  tap("a"); assert.equal(plays.at(-1)[1], "Run"); assert.equal(plays.at(-1)[2].speed, 1); tap("f");
  tap("b"); assert.ok(!host.world.records().some(r => r.id === "blocker"));
  tap("b"); assert.equal(host.world.records().find(r => r.id === "blocker")?.prefab, "screen-panel");
  tap("m"); assert.equal(host.world.records().find(r => r.id === "subject")?.prefab, "subject-pink");
  const light = host.world.getTransform("sun"); tap("l"); assert.notDeepEqual(host.world.getTransform("sun"), light);
});
