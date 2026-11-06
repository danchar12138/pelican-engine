import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject } from "../../packages/compiler/src/index.ts";
import { createNavigationPlugin } from "../../packages/navigation/src/index.ts";
import { RuntimeHost } from "../../packages/runtime/src/host.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const projectRoot = path.join(root, "examples/navigation-grid");
const outDir = await mkdtemp(path.join(tmpdir(), "pelican-nav-game-"));
let host: RuntimeHost | undefined;
try {
  const result = await compileProject({ engineRoot: root, projectRoot, outDir });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const compiled = await import(pathToFileURL(path.join(outDir, "game.js")).href);
  host = new RuntimeHost(result.ir!, { plugins: [createNavigationPlugin] });
  host.attach(compiled.createGame(host.facade));
  const h = host;
  const state = () => h.facade.getComponent("state", "NavigationState") as any;
  const tap = (key: string) => { h.input(key, true); h.input(key, false); h.step(); return state(); };
  h.step();
  const straight = JSON.parse(state().path);
  assert.equal(straight.length, 7);
  h.step(12); assert.deepEqual([state().x, state().y, state().cursor, state().progress], [1, 1, 1, 0]);
  const snapshot = h.snapshot();
  const blocked = tap("b"), detour = JSON.parse(blocked.path);
  assert.equal(blocked.obstacles, 1); assert.ok(!detour.some((p: any) => p.x === 3 && p.y === 1));
  assert.ok(detour.length > 6); assert.deepEqual(detour[0], { x: 1, y: 1 });
  h.step(); assert.equal(state().progress, 1); assert.deepEqual([state().x, state().y], [detour[0].x, detour[0].y]);
  const mid = h.snapshot(); h.step(); const afterMid = { ...state() };
  h.restore(mid); h.step(); assert.deepEqual(state(), afterMid);
  const unreachable = tap("u"); assert.match(unreachable.error, /TC_NAVIGATION_UNREACHABLE/);
  assert.equal(unreachable.progress, 0);
  assert.deepEqual(h.facade.getTransform("player").position, [unreachable.x - 3, 0.38, unreachable.y - 1]);
  const x = unreachable.x, y = unreachable.y; h.step(); assert.deepEqual([state().x, state().y], [x, y]);
  const budget = tap("c"); assert.match(budget.error, /TC_NAVIGATION_CAPACITY/);
  const recovered = tap("r"); assert.equal(recovered.error, ""); assert.notEqual(recovered.path, "[]");
  h.restore(snapshot); assert.deepEqual(h.facade.navigation.findPath("board", { x: 1, y: 1 }, { x: 6, y: 1 }), straight.slice(1));
  assert.deepEqual(JSON.parse(tap("b").path), detour);
  for (let i = 1; i < detour.length; i++) {
    const previous = { x: state().x, y: state().y };
    for (let t = 0; t < 12; t++) {
      const before = h.facade.getTransform("player").position;
      h.step();
      const after = h.facade.getTransform("player").position;
      const dx = after[0] - before[0], dz = after[2] - before[2];
      assert.ok(Math.abs(Math.abs(dx) + Math.abs(dz) - 1 / 12) < 1e-6);
      assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dz) < 1e-6);
    }
    assert.deepEqual({ x: state().x, y: state().y }, detour[i]);
    assert.equal(Math.abs(state().x - previous.x) + Math.abs(state().y - previous.y), 1);
    if (state().x === 3) {
      const rejected = tap("u"); assert.match(rejected.error, /current cell/);
      assert.equal(rejected.obstacles, 1); assert.deepEqual({ x: state().x, y: state().y }, detour[i]);
    }
  }
  assert.deepEqual([state().x, state().y], [6, 1]);
  assert.equal(h.inspect().scheduler.fault, null);
  const service = h.facade.navigation;
  h.dispose(); host = undefined;
  assert.throws(() => service.findPath("board", { x: 0, y: 1 }, { x: 6, y: 1 }), /TC_NAVIGATION_DISPOSED|TC_RUNTIME_DISPOSED/);
  console.log("navigation-grid: CPU compilation, gameplay, snapshot, and disposal passed");
} finally {
  host?.dispose();
  await rm(outDir, { recursive: true, force: true });
}
