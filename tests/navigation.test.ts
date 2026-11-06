import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationPlugin } from "../packages/navigation/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { SDK_VERSION, defineGame, defineScene, defineSystem, instantiateGame } from "../packages/sdk/src/index.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";

const start = { x: 0, y: 0 }, end = { x: 2, y: 0 };
function fixture(system = false): SceneIR {
  return {
    format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "nav",
    scene: { id: "scene", camera: { position: [0, 1, 5], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 }, environment: { background: "#000000", ambientIntensity: 1 }, gravity: [0, -9.81, 0], entities: [] },
    components: [], systems: system ? [{ id: "navigate", phase: "update", source: { file: "game.ts", line: 1, column: 1, length: 1 } }] : [], prefabs: [], materials: [], computes: [], assets: [],
  };
}
function host(system = false, withNavigation = true) {
  const h = new RuntimeHost(fixture(system), { plugins: withNavigation ? [createNavigationPlugin] : [] });
  const systems = system ? [defineSystem({ id: "navigate", run(ctx) {
    if (ctx.time.tick === 1) ctx.navigation.createGrid({ id: "map", owner: "level", width: 3, height: 2 });
    else ctx.navigation.setBlocked("map", { x: 1, y: 0 }, true);
    ctx.emit("path", ctx.navigation.findPath("map", start, end));
  } })] : [];
  h.attach(instantiateGame(defineGame({ id: "nav", scene: defineScene({ id: "scene", entities: [] }), systems }), h.facade));
  return h;
}

test("obstacle batches validate before committing and retain last update for a cell", () => {
  const h = host(), n = h.facade.navigation;
  try {
    n.createGrid({ id: "batch", owner: "level", width: 3, height: 2 });
    const before = h.snapshot();
    n.setBlockedBatch("batch", [
      { cell: { x: 1, y: 0 }, blocked: true },
      { cell: { x: 1, y: 1 }, blocked: true },
      { cell: { x: 1, y: 1 }, blocked: false },
    ]);
    assert.equal(n.findPath("batch", start, end).length, 5);
    const saved = h.snapshot();
    assert.throws(() => n.setBlockedBatch("batch", [
      { cell: { x: 1, y: 0 }, blocked: false },
      { cell: { x: 3, y: 0 }, blocked: true },
    ]), /TC_NAVIGATION_CELL/);
    assert.equal(n.isBlocked("batch", { x: 1, y: 0 }), true);
    assert.throws(() => n.setBlockedBatch("batch", [
      { cell: { x: 1, y: 0 }, blocked: false },
      { cell: { x: 0, y: 0 }, blocked: 1 as unknown as boolean },
    ]), /TC_NAVIGATION_BLOCKED/);
    assert.equal(n.isBlocked("batch", { x: 1, y: 0 }), true);
    n.setBlockedBatch("batch", [{ cell: { x: 1, y: 0 }, blocked: false }]);
    assert.equal(n.findPath("batch", start, end).length, 3);
    h.restore(saved);
    assert.equal(n.findPath("batch", start, end).length, 5);
    h.restore(before);
    assert.equal(n.findPath("batch", start, end).length, 3);
    n.destroyOwner("level");
    assert.throws(() => n.setBlockedBatch("batch", []), /TC_NAVIGATION_MISSING/);
  } finally { h.dispose(); }
  assert.throws(() => n.setBlockedBatch("batch", []), /TC_RUNTIME_DISPOSED|TC_NAVIGATION_DISPOSED/);
});

test("grid inspection is detached and tracks obstacle updates, restore and disposal", () => {
  const h = host(), n = h.facade.navigation;
  try {
    n.createGrid({ id: "map", owner: "level", width: 3, height: 2, blocked: [{ x: 1, y: 0 }], searchCellBudget: 7 });
    assert.equal(n.isBlocked("map", { x: 1, y: 0 }), true);
    assert.equal(n.isBlocked("map", { x: 2, y: 0 }), false);
    const grid = n.getGrid("map");
    assert.deepEqual(grid, { id: "map", owner: "level", width: 3, height: 2, blocked: [{ x: 1, y: 0 }], searchCellBudget: 7 });
    (grid.blocked![0] as { x: number }).x = 2;
    assert.equal(n.isBlocked("map", { x: 1, y: 0 }), true);
    const saved = h.snapshot();
    n.setBlocked("map", { x: 1, y: 0 }, false);
    n.setBlocked("map", { x: 2, y: 0 }, true);
    assert.equal(n.isBlocked("map", { x: 1, y: 0 }), false);
    assert.equal(n.isBlocked("map", { x: 2, y: 0 }), true);
    h.restore(saved);
    assert.equal(n.isBlocked("map", { x: 1, y: 0 }), true);
    assert.equal(n.isBlocked("map", { x: 2, y: 0 }), false);
    assert.throws(() => n.isBlocked("map", { x: 3, y: 0 }), /TC_NAVIGATION_CELL/);
    n.destroyOwner("level");
    assert.throws(() => n.getGrid("map"), /TC_NAVIGATION_MISSING/);
  } finally { h.dispose(); }
  assert.throws(() => n.getGrid("map"), /TC_NAVIGATION_DISPOSED/);
});

test("public game systems route around dynamic obstacles and restore snapshots", () => {
  const h = host(true);
  try {
    h.step();
    const snapshot = h.snapshot();
    assert.equal(h.facade.navigation.findPath("map", start, end).length, 3);
    h.step();
    const reroute = h.facade.navigation.findPath("map", start, end);
    assert.equal(reroute.length, 5);
    assert.deepEqual(h.facade.navigation.findPath("map", start, end), reroute);
    h.restore(snapshot);
    assert.equal(h.facade.navigation.findPath("map", start, end).length, 3);
    h.step();
    assert.deepEqual(h.facade.navigation.findPath("map", start, end), reroute);
  } finally { h.dispose(); }
});

test("validation, unreachable paths, ownership and lifecycle", () => {
  const h = host();
  const n = h.facade.navigation;
  try {
    assert.throws(() => n.createGrid({ id: "x", owner: "a", width: 0, height: 1 }), /TC_NAVIGATION_GRID/);
    n.createGrid({ id: "long", owner: "a", width: 1000000, height: 1 });
    assert.throws(() => n.createGrid({ id: "oversized", owner: "a", width: 65536, height: 65536 }), /TC_NAVIGATION_GRID.*array length limit/);
    n.createGrid({ id: "x", owner: "a", width: 3, height: 1 });
    n.createGrid({ id: "y", owner: "b", width: 1, height: 1 });
    assert.throws(() => n.createGrid({ id: "x", owner: "a", width: 1, height: 1 }), /TC_NAVIGATION_DUPLICATE/);
    assert.throws(() => n.findPath("x", { x: NaN, y: 0 }, end), /TC_NAVIGATION_CELL/);
    n.setBlocked("x", { x: 1, y: 0 }, true);
    assert.throws(() => n.findPath("x", start, end), /TC_NAVIGATION_UNREACHABLE/);
    assert.throws(() => n.findPath("x", start, { x: 1, y: 0 }), /TC_NAVIGATION_BLOCKED/);
    assert.deepEqual(n.findPath("y", start, start), [start]);
    n.destroyOwner("a");
    assert.throws(() => n.findPath("x", start, end), /TC_NAVIGATION_MISSING/);
    n.destroyGrid("y");
    assert.throws(() => n.destroyGrid("y"), /TC_NAVIGATION_MISSING/);
  } finally { h.dispose(); }
  assert.throws(() => n.destroyOwner("a"), /TC_RUNTIME_DISPOSED|TC_NAVIGATION_DISPOSED/);
});

test("a narrow path may exceed 4096 cells", () => {
  const h = host();
  try {
    const n = h.facade.navigation;
    n.createGrid({ id: "long", owner: "level", width: 4100, height: 1 });
    const result = n.findPath("long", start, { x: 4099, y: 0 });
    assert.equal(result.length, 4100);
    assert.deepEqual(result.at(-1), { x: 4099, y: 0 });
  } finally { h.dispose(); }
});

test("large blocked-cell sets remain sorted, detached and idempotent across changes and restore", () => {
  const h = host();
  try {
    const n = h.facade.navigation;
    const blocked = Array.from({ length: 10000 }, (_, i) => ({ x: 19999 - 2 * i, y: 0 }));
    n.createGrid({ id: "large", owner: "level", width: 20000, height: 1, blocked });
    n.setBlocked("large", { x: 4, y: 0 }, true);
    n.setBlocked("large", { x: 4, y: 0 }, true);
    n.setBlocked("large", { x: 3, y: 0 }, false);
    n.setBlocked("large", { x: 3, y: 0 }, false);
    const snapshot = h.snapshot();
    const cells = (snapshot.plugins!["$engine.navigation"].payload as any).grids[0].blocked as { x: number }[];
    assert.equal(cells.length, 10000);
    assert.deepEqual(cells.slice(0, 5).map(cell => cell.x), [1, 4, 5, 7, 9]);
    blocked[0].x = 0;
    cells[0].x = 0;
    const current = (h.snapshot().plugins!["$engine.navigation"].payload as any).grids[0].blocked as { x: number }[];
    assert.equal(current[0].x, 1);
    const saved = h.snapshot();
    n.destroyGrid("large");
    h.restore(saved);
    assert.deepEqual((h.snapshot().plugins!["$engine.navigation"].payload as any).grids[0].blocked, current);
  } finally { h.dispose(); }
});

test("huge grids search sparsely and budget exhaustion does not mutate state", () => {
  const h = host();
  try {
    const n = h.facade.navigation;
    n.createGrid({ id: "huge", owner: "level", width: 1000000, height: 1, searchCellBudget: 5 });
    const before = h.snapshot();
    const original = Array.from;
    let failure: unknown;
    try {
      Array.from = (() => { throw new Error("matrix allocation attempted"); }) as typeof Array.from;
      assert.equal(n.findPath("huge", start, end).length, 3);
      n.findPath("huge", start, { x: 999999, y: 0 });
    } catch (error) { failure = error; }
    finally { Array.from = original; }
    assert.match(String(failure), /TC_NAVIGATION_CAPACITY.*reduce or partition/);
    assert.deepEqual(h.snapshot(), before);
    assert.throws(() => n.createGrid({ id: "invalid", owner: "level", width: 1, height: 1, searchCellBudget: 0 }), /TC_NAVIGATION_GRID.*searchCellBudget/);
  } finally { h.dispose(); }
});

test("capacity is distinct from proven unreachable at the search boundary", () => {
  const h = host(), n = h.facade.navigation;
  try {
    const wall = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }];
    n.createGrid({ id: "short-budget", owner: "level", width: 3, height: 3, blocked: wall, searchCellBudget: 3 });
    n.createGrid({ id: "enough", owner: "level", width: 3, height: 3, blocked: wall, searchCellBudget: 4 });
    assert.throws(() => n.findPath("short-budget", start, end), /TC_NAVIGATION_CAPACITY/);
    assert.throws(() => n.findPath("enough", start, end), /TC_NAVIGATION_UNREACHABLE/);
    n.createGrid({ id: "large-unreachable", owner: "level", width: 1000000, height: 2, blocked: [{ x: 999998, y: 0 }, { x: 999999, y: 1 }], searchCellBudget: 20 });
    assert.throws(() => n.findPath("large-unreachable", start, { x: 999999, y: 0 }), /TC_NAVIGATION_CAPACITY/);
    n.createGrid({ id: "one", owner: "level", width: 2, height: 1, searchCellBudget: 1 });
    assert.deepEqual(n.findPath("one", start, start), [start]);
    assert.throws(() => n.findPath("one", start, { x: 1, y: 0 }), /TC_NAVIGATION_CAPACITY/);
  } finally { h.dispose(); }
});

test("all 3x3 obstacle layouts match an independent breadth-first shortest-path oracle", () => {
  const h = host(), n = h.facade.navigation;
  try {
    for (let mask = 0; mask < 512; mask++) {
      if ((mask & 1) || (mask & 256)) continue;
      const blocked = Array.from({ length: 9 }, (_, i) => i).filter((i) => (mask & (1 << i)) !== 0);
      n.createGrid({ id: "oracle", owner: "level", width: 3, height: 3, blocked: blocked.map((i) => ({ x: i % 3, y: Math.floor(i / 3) })) });
      const distances = new Map<number, number>([[0, 0]]), queue = [0];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const index = queue[cursor]!, x = index % 3, y = Math.floor(index / 3);
        for (const [nx, ny] of [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]]) {
          const next = ny * 3 + nx;
          if (nx < 0 || nx >= 3 || ny < 0 || ny >= 3 || blocked.includes(next) || distances.has(next)) continue;
          distances.set(next, distances.get(index)! + 1);
          queue.push(next);
        }
      }
      if (!distances.has(8)) assert.throws(() => n.findPath("oracle", start, { x: 2, y: 2 }), /TC_NAVIGATION_UNREACHABLE/);
      else {
        const path = n.findPath("oracle", start, { x: 2, y: 2 });
        assert.equal(path.length, distances.get(8)! + 1, `mask ${mask}`);
        assert.deepEqual(path[0], start);
        assert.deepEqual(path.at(-1), { x: 2, y: 2 });
        for (let i = 1; i < path.length; i++) {
          assert.equal(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y), 1);
          assert.ok(!blocked.includes(path[i].y * 3 + path[i].x));
        }
        assert.deepEqual(n.findPath("oracle", start, { x: 2, y: 2 }), path);
      }
      n.destroyGrid("oracle");
    }
  } finally { h.dispose(); }
});

test("grid and owner identifiers do not collide with object prototype keys", () => {
  const h = host(), n = h.facade.navigation;
  try {
    for (const id of ["__proto__", "constructor", "toString"]) n.createGrid({ id, owner: "__proto__", width: 2, height: 1 });
    const saved = h.snapshot();
    n.destroyOwner("__proto__");
    h.restore(saved);
    for (const id of ["__proto__", "constructor", "toString"]) assert.equal(n.findPath(id, start, { x: 1, y: 0 }).length, 2);
    n.destroyOwner("__proto__");
    assert.throws(() => n.findPath("__proto__", start, start), /TC_NAVIGATION_MISSING/);
  } finally { h.dispose(); }
});

test("explicit budgets persist across restore and older grid snapshots use the default", () => {
  const h = host();
  try {
    const n = h.facade.navigation;
    n.createGrid({ id: "limited", owner: "level", width: 3, height: 1, searchCellBudget: 2 });
    assert.throws(() => n.findPath("limited", start, end), /TC_NAVIGATION_CAPACITY/);
    const saved = h.snapshot();
    n.destroyGrid("limited");
    n.createGrid({ id: "limited", owner: "level", width: 3, height: 1, searchCellBudget: 3 });
    assert.equal(n.findPath("limited", start, end).length, 3);
    h.restore(saved);
    assert.throws(() => n.findPath("limited", start, end), /TC_NAVIGATION_CAPACITY/);
    const legacy = structuredClone(saved);
    delete (legacy.plugins!["$engine.navigation"].payload as any).grids[0].searchCellBudget;
    h.restore(legacy);
    assert.equal(n.findPath("limited", start, end).length, 3);
    const before = h.snapshot(), invalid = structuredClone(before);
    (invalid.plugins!["$engine.navigation"].payload as any).grids[0].searchCellBudget = -1;
    assert.throws(() => h.restore(invalid), /TC_NAVIGATION_GRID.*searchCellBudget/);
    assert.deepEqual(h.snapshot(), before);
    n.createGrid({ id: "larger-budget", owner: "level", width: 1, height: 1, searchCellBudget: 65537 });
    assert.equal((h.snapshot().plugins!["$engine.navigation"].payload as any).grids.find((grid: any) => grid.id === "larger-budget").searchCellBudget, 65537);
    n.createGrid({ id: "authorized", owner: "level", width: 257, height: 256, searchCellBudget: 65792 });
    assert.deepEqual(n.findPath("authorized", start, start), [start]);
  } finally { h.dispose(); }
});

test("legacy snapshots restore empty navigation and malformed snapshots do not mutate", () => {
  const old = host(false, false), h = host();
  try {
    const legacy = old.snapshot();
    h.facade.navigation.createGrid({ id: "x", owner: "a", width: 1, height: 1 });
    h.restore(legacy);
    assert.throws(() => h.facade.navigation.findPath("x", start, start), /TC_NAVIGATION_MISSING/);
    h.facade.navigation.createGrid({ id: "x", owner: "a", width: 1, height: 1 });
    const before = h.snapshot(), broken = structuredClone(before);
    (broken.plugins!["$engine.navigation"].payload as any).grids[0].width = 0;
    assert.throws(() => h.restore(broken), /TC_NAVIGATION_GRID/);
    assert.deepEqual(h.snapshot(), before);
  } finally { old.dispose(); h.dispose(); }
});

test("old snapshots with other plugins preserve their state", () => {
  let state = 0;
  const other = () => ({ id: "existing", snapshot: () => ({ state }), validateSnapshot: () => {}, restore: (value: unknown) => { state = (value as { state: number }).state; }, dispose: () => {} });
  const old = new RuntimeHost(fixture(), { plugins: [other] });
  const current = new RuntimeHost(fixture(), { plugins: [other, createNavigationPlugin] });
  const game = () => defineGame({ id: "nav", scene: defineScene({ id: "scene", entities: [] }) });
  try {
    old.attach(instantiateGame(game(), old.facade));
    current.attach(instantiateGame(game(), current.facade));
    state = 17;
    const legacy = old.snapshot();
    state = 42;
    current.facade.navigation.createGrid({ id: "x", owner: "a", width: 1, height: 1 });
    current.restore(legacy);
    assert.equal(state, 17);
    assert.throws(() => current.facade.navigation.findPath("x", start, start), /TC_NAVIGATION_MISSING/);
  } finally { old.dispose(); current.dispose(); }
});

test("compiled public SDK game uses navigation through the runtime host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-navigation-"));
  let h: RuntimeHost | undefined;
  try {
    await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ entry: "game.ts", engineVersion: SDK_VERSION }));
    await writeFile(path.join(root, "game.ts"), `
import { defineGame, defineScene, defineSystem } from "pelican-engine";
const nav = defineSystem({ id: "nav", run(ctx) {
  if (ctx.time.tick === 1) ctx.navigation.createGrid({ id: "level", owner: "level", width: 3, height: 2 });
  ctx.navigation.setBlocked("level", {x:1,y:0}, true);
  if (!ctx.navigation.isBlocked("level", {x:1,y:0}) || ctx.navigation.getGrid("level").width !== 3) throw new Error("Navigation inspection failed");
  ctx.emit("route", ctx.navigation.findPath("level", {x:0,y:0}, {x:2,y:0}));
} });
export default defineGame({ id: "compiled-nav", scene: defineScene({ id: "scene", entities: [] }), systems: [nav] });
`);
    const result = await compileProject({ projectRoot: root, outDir: "dist", engineRoot: fileURLToPath(new URL("../", import.meta.url)) });
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    const compiled = await import(pathToFileURL(path.join(root, "dist/game.js")).href);
    h = new RuntimeHost(result.ir!, { plugins: [createNavigationPlugin] });
    h.attach(compiled.createGame(h.facade));
    h.step();
    assert.equal(h.facade.navigation.findPath("level", start, end).length, 5);
  } finally {
    h?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
