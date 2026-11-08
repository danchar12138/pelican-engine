import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { npmCommand } from "./doctor.ts";
import { serveDist } from "./static-server.ts";
import { recipeIds } from "./npm/recipes.ts";

const root = process.cwd(), execute = promisify(execFile);
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : `.pelican/ai-first-${Date.now()}`);
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(path.join(tmpdir(), "pelican-ai-first-"));
const npm = npmCommand(root)!;
if (!npm) throw new Error("TC_AI_FIRST_NPM: Local npm JS CLI is required.");
const records: unknown[] = [];
const record = async (name: string, action: () => Promise<unknown>) => {
  const start = Date.now();
  try { const data = await action(); records.push({ name, passed: true, ms: Date.now() - start, data }); console.log(JSON.stringify({ name, passed: true })); return data; }
  catch (error) { records.push({ name, passed: false, ms: Date.now() - start, error: String(error) }); console.log(JSON.stringify({ name, passed: false, error: String(error) })); throw error; }
  finally { await writeFile(path.join(output, "results.json"), JSON.stringify({ engineVersion: SDK_VERSION, workspace, records }, null, 2) + "\n"); }
};
const cli = path.join(workspace, "node_modules/pelican-engine/lib/tools/npm/entry.js");
const run = async (args: string[], cwd = workspace) => {
  try { const result = await execute(process.execPath, [cli, ...args], { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`CLI ${args.join(" ")}: ${(error as { stdout?: string }).stdout ?? String(error)}`); }
};
await record("install-current-tarball", async () => {
  await execute(npm.file, [...npm.prefix, "--prefix", workspace, "install", "--save-dev", "--save-exact", path.join(root, `.pelican/npm/artifacts/pelican-engine-${SDK_VERSION}.tgz`), "--offline", "--no-audit", "--no-fund"], { cwd: workspace, timeout: 120000, maxBuffer: 2000000 });
  return { workspace, engineVersion: SDK_VERSION };
});
await record("machine-discovery", async () => {
  const features = await run(["capabilities", "--feature", "pointer"]);
  assert.equal(features.data.features[0].id, "input.pointer");
  const api = await run(["api", "--search", "PointerState"]);
  assert.ok(api.data.symbols.some((symbol: { name: string }) => symbol.name === "PointerState"));
  const recipe = await run(["recipe", "--id", "pointer-3d"]); assert.match(recipe.data.source, /pointer\(\)/);
  return { features: features.data, symbols: api.data.symbols.map((symbol: { name: string }) => symbol.name) };
});
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--use-angle=d3d11"] });
let port = 43900;
async function game(name: string, template: string, action: (page: Page, command: (input: unknown) => Promise<any>) => Promise<unknown>, selectedBrowser = browser) {
  const project = path.join(workspace, name);
  await run(["create", "--project", project, "--template", template]);
  if (["cloth-sheet", "softbody-ball", "fluid-basin", "rope-reaction"].includes(name)) await writeFile(path.join(project, "game.ts"), await readFile(path.join(root, "examples", name, "game.ts"), "utf8"));
  if (name === "dynamic-residency") await writeFile(path.join(project, "game.ts"), `import{defineGame,defineScene,defineSystem,definePrefab}from'pelican-engine';
    const box=definePrefab({id:'box',rigidBody:{type:'dynamic',mass:1,collider:{shape:'box',size:[1,1,1]}}});
    const update=defineSystem({id:'update',run(ctx){if(ctx.time.tick===1){ctx.streaming.configure({chunkSize:8,loadRadius:0,unloadRadius:0});ctx.streaming.defineChunk({x:0,z:0,entities:[{id:'chunk-body',prefab:'box',transform:{position:[0,3,0]}}]});ctx.streaming.setFocus([0,0,0]);}if(ctx.time.tick===4)ctx.streaming.setFocus([100,0,0]);if(ctx.time.tick===7)ctx.streaming.setFocus([0,0,0]);}});
    export default defineGame({id:'residency',prefabs:[box],systems:[update],scene:defineScene({id:'main',entities:[]})});`);
  if (name === "quality") {
    const source = await readFile(path.join(project, "game.ts"), "utf8");
    await writeFile(path.join(project, "game.ts"), source.replace("systems: [spin]", 'systems: [spin], ui: [{id:"world-label",kind:"text",text:"world",x:0,y:0,world:{entity:"shape",offset:[0,0,0],occlude:false}}]'));
  }
  const child = spawn(process.execPath, [cli, "dev", "--project", project, "--port", String(++port)], { cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => log += data); child.stderr.on("data", data => log += data);
  const page = await selectedBrowser.newPage({ viewport: name === "quality" ? { width: 480, height: 270 } : { width: 960, height: 540 }, deviceScaleFactor: name === "quality" ? 2 : 1 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    let listening = false;
    for (let i = 0; i < 150; i++) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); listening = true; break; } catch { if (child.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(listening, log);
    await page.goto(`http://127.0.0.1:${port}/?automation=1`);
    await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true", undefined, { timeout: 30000 });
    const command = async (input: unknown) => {
      const result = await page.evaluate(input => (globalThis as any).__pelican.command(input), input);
      assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.data;
    };
    const result = await action(page, command);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    return result;
  } finally {
    await page.close(); child.kill(); if (child.exitCode === null) await once(child, "exit");
    await writeFile(path.join(output, `${name}-server.log`), log);
  }
}
try {
  await record("pointer-game-lifecycle", () => game("pointer", "pointer-3d", async (page, command) => {
    await command({ type: "step", count: 1 });
    await command({ type: "input", key: "e", pressed: true }); await command({ type: "step", count: 1 }); await command({ type: "input", key: "e", pressed: false });
    let state = await command({ type: "inspect" }); assert.ok(state.runtime.records.some((entity: { id: string }) => entity.id === "prop-0"));
    await page.mouse.move(400, 250); await page.mouse.wheel(0, 100); await command({ type: "step", count: 1 });
    state = await command({ type: "inspect" }); assert.equal(state.gameplay.input.pointer.wheel[1], 100);
    const batch = await command({ type: "batch", commands: [{ type: "pointer", x: 120, y: 80, buttons: 1, delta: [2, 3] }, { type: "step", count: 1 }, { type: "inspect", entity: "player" }] });
    assert.equal(batch.completed, 3); assert.equal(batch.results[2].data.gameplay.input.pointer.buttons, 1);
    assert.deepEqual(batch.results[2].data.gameplay.input.pointer.position, [120, 80]);
    await command({ type: "step", count: 300 }); state = await command({ type: "inspect" }); assert.ok(!state.runtime.records.some((entity: { id: string }) => entity.id === "prop-0"));
    const saved = await command({ type: "snapshot" }); await command({ type: "step", count: 3 }); await command({ type: "restore", snapshot: saved });
    return { tick: state.tick, adapter: state.adapter, backend: state.backend };
  }));
  await record("button-save-load-cleanup", () => game("storage", "gameplay-loop", async (page, command) => {
    const step = () => command({ type: "step", count: 1 }); await step();
    const click = async (id: string) => { await page.locator(`[data-pelican-element="${id}"]`).click(); await step(); };
    await click("accept"); await click("gather"); await click("save"); await click("gather"); await click("gather"); await click("load");
    assert.equal(await page.locator("[data-pelican-ui]").count(), 1); assert.match(await page.locator('[data-pelican-element="status"]').innerText(), /active.*Crystals: 1/);
    await click("gather"); await click("gather"); await click("report"); await click("equip");
    const state = await command({ type: "inspect" }); assert.deepEqual(state.errors, []);
    assert.match(await page.locator('[data-pelican-element="status"]').innerText(), /Hand: sword/);
    return { roots: 1, tick: state.tick, errors: state.errors };
  }));
  await record("native-viewport-resize", () => game("viewport", "minimal", async (page, command) => {
    await page.setViewportSize({ width: 390, height: 844 }); await command({ type: "step", count: 1 });
    const state = await command({ type: "inspect" }); assert.equal(state.width, 390); assert.equal(state.height, 844);
    const canvas = await page.locator("canvas").first().boundingBox(); assert.equal(canvas!.width, 390); assert.equal(canvas!.height, 844);
    return { viewport: state.viewport, canvas };
  }));
  await record("progressive-quality-render", () => game("quality", "minimal", async (page, command) => {
    const before = await command({ type: "inspect" });
    assert.equal(before.capabilities.backend, "webgpu"); assert.equal(before.adapter.isFallbackAdapter, false);
    for (const mode of ["hybrid", "path"]) {
      const rendered = await command({ type: "render", mode, samples: 32, denoise: false });
      assert.equal(rendered.render.samples, 32); const after = await command({ type: "inspect" }); assert.equal(after.tick, before.tick);
      const label = await page.locator('[data-pelican-element="world-label"]').boundingBox();
      assert.ok(label && Math.abs(label.x - 240) < 1 && Math.abs(label.y - 135) < 1, `${mode} world UI at DPR=2: ${JSON.stringify(label)}`);
    }
    return { modes: ["hybrid", "path"], samples: 32, adapter: before.adapter };
  }));
  await record("dynamic-chunk-native-residency", () => game("dynamic-residency", "minimal", async (_page, command) => {
    await command({ type: "step", count: 3 }); let state = await command({ type: "inspect" }); assert.ok(state.runtime.records.some((r: { id: string }) => r.id === "chunk-body"));
    await command({ type: "step", count: 2 }); state = await command({ type: "inspect" }); assert.ok(!state.runtime.records.some((r: { id: string }) => r.id === "chunk-body"));
    const parked = await command({ type: "snapshot" }); await command({ type: "step", count: 3 }); state = await command({ type: "inspect" }); assert.ok(state.runtime.records.some((r: { id: string }) => r.id === "chunk-body"));
    await command({ type: "restore", snapshot: parked }); await command({ type: "step", count: 3 }); const restored = await command({ type: "inspect" });
    assert.deepEqual(restored.game.transforms, state.game.transforms); assert.deepEqual(restored.errors, []); return { tick: restored.tick, restored: true };
  }));
  const fallback = await chromium.launch({ headless: true, args: ["--disable-webgpu"] });
  try {
    await record("webgl2-real-fallback-and-mode-rejection", () => game("fallback", "minimal", async (page, command) => {
      const before = await command({ type: "inspect" }); assert.equal(before.capabilities.backend, "webgl2");
      const rejected = await page.evaluate(() => (globalThis as any).__pelican.command({ type: "render", mode: "path", samples: 1 }));
      assert.equal(rejected.status, "failed"); assert.match(rejected.diagnostics[0].code, /TC_RENDER_/);
      const after = await command({ type: "inspect" }); assert.deepEqual(after.rendering.settings, before.rendering.settings); assert.equal(after.playback.state, "paused");
      await command({ type: "step", count: 2 }); return { backend: after.capabilities.backend, diagnostic: rejected.diagnostics[0].code };
    }, fallback));
  } finally { await fallback.close(); }
  for (const recipe of [...recipeIds.filter(id => !["pointer-3d", "gameplay-loop"].includes(id)), "cloth-sheet", "softbody-ball", "fluid-basin", "rope-reaction"]) {
    await record(`installed-recipe-${recipe}`, () => game(recipe, recipeIds.includes(recipe) ? recipe : "minimal", async (_page, command) => {
      await command({ type: "step", count: 120 }); const snapshot = await command({ type: "snapshot" });
      await command({ type: "step", count: 2 }); await command({ type: "restore", snapshot });
      const state = await command({ type: "inspect" }); assert.deepEqual(state.errors, []); return { tick: state.tick, backend: state.backend };
    }));
  }
  const project = path.join(workspace, "production"); await run(["create", "--project", project]);
  const source = await readFile(path.join(project, "game.ts"), "utf8");
  await writeFile(path.join(project, "game.ts"), source.replace("systems: [spin]", 'systems: [spin], ui: [{id:"world-label",kind:"button",text:"World",x:0,y:0,width:100,world:{entity:"shape",offset:[0,0,0],occlude:false}}]'));
  await run(["build", "--project", project]);
  await record("production-native-dpr-and-no-debug-hud", async () => {
    const server = await serveDist(path.join(project, "dist"), ++port); const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    try {
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true");
      const result = await page.evaluate(() => ({ width: document.querySelector("canvas")!.width, height: document.querySelector("canvas")!.height, hudHidden: (document.querySelector("#status") as HTMLElement).hidden, control: !!(globalThis as any).__pelican }));
      assert.deepEqual(result, { width: 780, height: 1688, hudHidden: true, control: false });
      const label = await page.locator('[data-pelican-element="world-label"]').boundingBox();
      assert.ok(label && Math.abs(label.x - 195) < 1 && Math.abs(label.y - 422) < 1, `World UI must use CSS pixels at DPR=2: ${JSON.stringify(label)}`);
      await page.screenshot({ path: path.join(output, "production-mobile-dpr2.png") }); return { ...result, worldUI: label };
    } finally { await context.close(); await server.close(); }
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ output, workspace, passed: records.length }));
