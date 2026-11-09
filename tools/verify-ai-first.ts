import { graphicsLaunchArguments } from "./browser-session.ts";
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
import { decode } from "fast-png";

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
  const guide = await run(["guide"]);
  assert.match(guide.data.authoring.language, /Not a mandatory engine DSL/);
  const targeted = await run(["guide", "--goal", "npm"]);
  assert.ok(targeted.data.discovery.recipes.some((recipe: { id: string }) => recipe.id === "runtime-lifecycle"));
  const full = await run(["capabilities"]), compact = await run(["capabilities", "--summary"]);
  const fullBytes = Buffer.byteLength(JSON.stringify(full.data)), summaryBytes = Buffer.byteLength(JSON.stringify(compact.data));
  assert.ok(summaryBytes < fullBytes * .6);
  const features = await run(["capabilities", "--feature", "pointer"]);
  assert.ok(features.data.features.some((feature: { id: string }) => feature.id === "input.pointer"));
  const api = await run(["api", "--search", "PointerState"]);
  assert.ok(api.data.symbols.some((symbol: { name: string }) => symbol.name === "PointerState"));
  const recipe = await run(["recipe", "--id", "pointer-3d"]); assert.match(recipe.data.source, /pointer\(\)/);
  const tasks = await run(["guide", "--goal", "让角色跳跃并保存游戏"]);
  assert.ok(tasks.data.discovery.tasks.some((task: { id: string }) => task.id === "character-jump"));
  assert.ok(tasks.data.discovery.tasks.some((task: { id: string }) => task.id === "save-game"));
  const unknown = await run(["guide", "--goal", "not-a-real-task-xyz"]);
  assert.equal(unknown.data.discovery.status, "unrecognized");
  assert.ok(unknown.data.discovery.candidates.length);
  return { features: features.data, symbols: api.data.symbols.map((symbol: { name: string }) => symbol.name), coldStart: { guideBytes: Buffer.byteLength(JSON.stringify(guide.data)), fullBytes, summaryBytes, npmRecipe: "runtime-lifecycle" } };
});
const browser = await chromium.launch({ headless: true, channel: "chromium", args: graphicsLaunchArguments() });
let port = 43900;
async function game(name: string, template: string, action: (page: Page, command: (input: unknown) => Promise<any>) => Promise<unknown>, selectedBrowser = browser) {
  const project = path.join(workspace, name);
  await run(["create", "--project", project, "--template", template]);
  if (name === "fallback") {
    const source = await readFile(path.join(project, "game.ts"), "utf8");
    await writeFile(path.join(project, "game.ts"), source.replace('id: "game",', 'id: "game", render: {mode:"raster",denoise:false},'));
  }
  if (["cloth-sheet", "softbody-ball", "fluid-basin", "rope-reaction"].includes(name)) await writeFile(path.join(project, "game.ts"), await readFile(path.join(root, "examples", name, "game.ts"), "utf8"));
  if (name === "unattended") {
    const source = await readFile(path.join(project, "game.ts"), "utf8");
    await writeFile(path.join(project, "game.ts"), source
      .replace('id: "runtime-lifecycle",', 'id: "runtime-lifecycle", ui: [{id:"save",kind:"button",text:"Save",x:8,y:8},{id:"load",kind:"button",text:"Load",x:120,y:8}],')
      .replace("ticks++;", 'ticks++; for(const event of ctx.events("ui.activate")){const id=(event.payload as {id:string}).id; if(id==="save")ctx.storage.save("counter"); if(id==="load")ctx.storage.load("counter");}'));
  }
  if (name === "floating-geometry") await writeFile(path.join(project, "game.ts"), `
import {defineGame,defineScene,defineMaterial} from 'pelican-engine';
const positions:number[]=[],uv:number[]=[],indices:number[]=[];
for(let y=0;y<=16;y++)for(let x=0;x<=24;x++){const u=x/24,v=y/16;positions.push((u-.5)*3,(v-.5)*2,Math.sin(u*Math.PI*4)*Math.sin(v*Math.PI)*.4);uv.push(u,v);}
for(let y=0;y<16;y++)for(let x=0;x<24;x++){const i=y*25+x;indices.push(i,i+1,i+25,i+1,i+26,i+25);}
const paint=defineMaterial({id:'paint',color:'#2baebd',roughness:.4,side:'double'});
export default defineGame({id:'floating-geometry',services:{physics3d:'disabled'},scene:defineScene({id:'main',camera:{position:[0,0,4],target:[0,0,0]},entities:[{id:'surface',mesh:{material:paint,geometry:{kind:'buffer',positions,uv,indices}}}]})});`);
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
  await page.addInitScript("globalThis.__name = value => value;");
  if (name === "unattended") await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    document.hasFocus = () => false;
    Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    let listening = false;
    for (let i = 0; i < 150; i++) { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); listening = true; break; } catch { if (child.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(listening, log);
    await page.goto(`http://127.0.0.1:${port}/?automation=1`);
    await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true", undefined, { timeout: 30000, polling: 100 });
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
  await record("quality-tiers-preparation-and-cache-lifetime", () => game("quality-options", "render-quality", async (page, command) => {
    assert.equal((await command({ type: "inspect" })).mode, "path");
    const highStartup = await command({ type: "snapshot" });
    await page.goto(page.url() + "&quality=low");
    await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true", undefined, { timeout: 60000, polling: 100 });
    const low = await command({ type: "snapshot" });
    const initial = await command({ type: "inspect" }); assert.equal(initial.mode, "raster"); assert.equal(initial.rendering.surface, undefined);
    await command({ type: "restore", snapshot: highStartup });
    assert.equal((await command({ type: "inspect" })).mode, "path");
    await command({ type: "restore", snapshot: low });
    assert.equal((await command({ type: "inspect" })).mode, "raster");
    const prepared = await command({ type: "prepareRender", mode: "path" });
    assert.equal(prepared.mode, "raster"); assert.equal(prepared.tick, initial.tick);
    assert.equal(prepared.rendering.preparation.find((item: any) => item.mode === "path").status, "ready");
    assert.deepEqual((await command({ type: "snapshot" })).runtime, low.runtime);
    const click = async (id: string) => { await page.locator(`[data-pelican-element="${id}"]`).click(); return command({ type: "step", count: 1 }); };
    const high = await click("high"); assert.equal(high.mode, "path"); assert.equal(high.rendering.settings.denoise, true);
    const bytes = high.rendering.surface.ownedBytes;
    for (let i = 0; i < 3; i++) {
      const medium = await click("medium"); assert.equal(medium.mode, "hybrid");
      assert.equal((await click("low")).rendering.settings.denoise, false);
      const state = await click("high"); assert.equal(state.rendering.surface.ownedBytes, bytes);
    }
    await command({ type: "restore", snapshot: low });
    assert.equal((await command({ type: "inspect" })).mode, "raster");
    await page.setViewportSize({ width: 640, height: 360 }); await command({ type: "step", count: 1 });
    assert.equal((await command({ type: "inspect" })).rendering.preparation.find((item: any) => item.mode === "path").status, "idle");
    await command({ type: "prepareRender", mode: "path" });
    assert.deepEqual((await command({ type: "inspect" })).errors, []);
    return { defaultMode: "path", explicitLow: true, preparedWithoutTick: true, repeatedSwitches: 9, tracingStorageBytes: bytes, resizeInvalidates: true };
  }));
  await record("unquantized-procedural-math-and-boot-causes", () => game("floating-geometry", "minimal", async (page, command) => {
    await command({ type: "step", count: 1 });
    const state = await command({ type: "inspect" }); assert.deepEqual(state.errors, []);
    const project = path.join(workspace, "floating-geometry"), file = path.join(project, "game.ts"), source = await readFile(file, "utf8");
    await writeFile(file, source.replace("id:'floating-geometry'", "id:typeof window==='undefined'?'node-only':'browser-only'"));
    await run(["check", "--project", project]);
    let failure: any;
    try { await execute(process.execPath, [cli, "inspect", "--project", project, "--port", String(port)], { cwd: project, timeout: 60000, maxBuffer: 4000000 }); }
    catch (error) { failure = JSON.parse((error as { stdout: string }).stdout); }
    assert.equal(failure?.status, "failed", JSON.stringify(failure));
    assert.equal(failure.diagnostics[0].code, "TC_AUTOMATION_BOOT_FAILED");
    assert.ok(failure.diagnostics[0].causeCodes.includes("TC_GAME_CONSTRUCTION_DRIFT"));
    await run(["reset-session", "--port", String(port)]);
    return { unquantizedVertices: 425, startup: true, deliberateDriftRejected: true, causeCodes: failure.diagnostics[0].causeCodes };
  }));
  await record("typed-instance-context-npm-and-save", () => game("typed-context", "npm-component", async (page, command) => {
    await command({ type: "step", count: 3 });
    const label = page.locator("[data-pelican-npm-counter]");
    assert.match(await label.innerText(), /^3 ticks \| \d+ compressed bytes$/);
    await page.locator('[data-pelican-element="save"]').click(); await command({ type: "step", count: 1 });
    await command({ type: "step", count: 3 }); assert.match(await label.innerText(), /^7 ticks/);
    await page.locator('[data-pelican-element="load"]').click(); await command({ type: "step", count: 1 });
    await command({ type: "step", count: 1 });
    assert.equal(await label.count(), 1); assert.match(await label.innerText(), /^5 ticks/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await label.evaluate(element => (element as HTMLElement).style.maxWidth), "358px");
    return { npmRoundTrip: true, instanceContext: true, savedTicks: 4, resumedTicks: 5, ownedMarkers: 1 };
  }));
  await record("binary-npm-codec-managed-texture", () => game("dynamic-image", "dynamic-texture", async (page, command) => {
    await command({ type: "step", count: 1 });
    const first = await command({ type: "snapshot" });
    const label = page.locator('[data-pelican-element="state"]');
    assert.match(await label.innerText(), /^2 x 2 \| managed image$/);
    const image = decode(await page.locator("canvas:visible").first().screenshot());
    const colors = new Set<string>();
    for (let y = 160; y < 380; y += 20) for (let x = 360; x < 600; x += 20) {
      const i = (y * image.width + x) * image.channels;
      colors.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`);
    }
    assert.ok(colors.size >= 4, `Decoded PNG must produce multiple real colors, got ${colors.size}`);
    await command({ type: "step", count: 2 }); await command({ type: "restore", snapshot: first });
    await command({ type: "step", count: 1 });
    assert.deepEqual((await command({ type: "inspect" })).errors, []);
    await page.evaluate(() => { (globalThis as any).__imageDocument = "same"; });
    await command({ type: "reload" });
    await command({ type: "step", count: 1 });
    assert.equal(await page.evaluate(() => (globalThis as any).__imageDocument), "same");
    assert.match(await label.innerText(), /^2 x 2/);
    return { decodedSize: [2, 2], visibleColors: colors.size, managedCheckpoint: true, compatibleReload: true };
  }));
  await record("third-person-jump-follow-and-save", () => game("third-person-flow", "third-person", async (page, command) => {
    await command({ type: "step", count: 90 });
    const base = await command({ type: "snapshot" });
    const before = await command({ type: "inspect" });
    const position = (state: any) => state.game.transforms.player.position as number[];
    await command({ type: "input", key: " ", pressed: true });
    await command({ type: "step", count: 12 });
    const airborne = await command({ type: "inspect" });
    assert.ok(position(airborne)[1] > position(before)[1] + 0.2, JSON.stringify({ before: position(before), after: position(airborne) }));
    assert.match(await page.locator('[data-pelican-element="state"]').innerText(), /Jumps 1/);
    await command({ type: "step", count: 90 });
    assert.match(await page.locator('[data-pelican-element="state"]').innerText(), /Jumps 1/);
    await command({ type: "input", key: " ", pressed: false });
    await command({ type: "restore", snapshot: base });
    await command({ type: "step", count: 1 });
    assert.match(await page.locator('[data-pelican-element="state"]').innerText(), /Jumps 0/);
    await page.locator('[data-pelican-element="save"]').click(); await command({ type: "step", count: 1 });
    await command({ type: "input", key: "d", pressed: true }); await command({ type: "step", count: 20 }); await command({ type: "input", key: "d", pressed: false });
    await page.locator('[data-pelican-element="load"]').click(); await command({ type: "step", count: 1 });
    const loaded = await command({ type: "inspect" });
    assert.ok(Math.abs(position(loaded)[0] - position(before)[0]) < 0.05);
    assert.equal(await page.locator("[data-pelican-ui]").count(), 1);
    return { groundedJump: true, heldJumpCount: 1, savedWorldAndInstance: true, before: position(before), airborne: position(airborne), camera: loaded.gameplay.camera };
  }));
  await record("logic-edit-preserves-state-and-rejects-incompatible-content", () => game("iteration", "third-person", async (page, command) => {
    await command({ type: "step", count: 90 });
    const project = path.join(workspace, "iteration"), file = path.join(project, "game.ts"), source = await readFile(file, "utf8");
    await page.evaluate(() => { (window as any).__iterationDocument = "same-document"; });
    const before = await command({ type: "snapshot" });
    await writeFile(file, source.replace("4 * dt", "5 * dt"));
    await page.waitForFunction(() => (window as any).__pelican?.inspect().iteration.status === "applied", undefined, { timeout: 30000, polling: 100 });
    assert.equal(await page.evaluate(() => (window as any).__iterationDocument), "same-document");
    const after = await command({ type: "snapshot" });
    assert.deepEqual(after.runtime, before.runtime, "Logic-only edits preserve world, scheduler, physics, services and author state.");
    await page.keyboard.down("d");
    await command({ type: "inspect" });
    await writeFile(file, source.replace("4 * dt", "5 * dt").replace("state: () =>", "setup: () => new Promise<void>(resolve => setTimeout(resolve, 800)), state: () =>"));
    await page.waitForFunction(() => (window as any).__pelican?.inspect().iteration.status === "applying", undefined, { timeout: 30000, polling: 50 });
    await page.keyboard.up("d");
    await page.waitForFunction(() => (window as any).__pelican?.inspect().iteration.applied === 2, undefined, { timeout: 30000, polling: 100 });
    const stopped = (await command({ type: "inspect" })).game.transforms.player.position[0];
    await command({ type: "step", count: 1 });
    assert.equal((await command({ type: "inspect" })).game.transforms.player.position[0], stopped, "A key released during candidate initialization must not remain held.");
    const stable = await command({ type: "snapshot" });
    await writeFile(file, source.replace('version: "player-v1"', 'version: "player-v2"'));
    await page.waitForFunction(() => (window as any).__pelican?.inspect().iteration.status === "rejected", undefined, { timeout: 30000, polling: 100 });
    const rejected = await command({ type: "inspect" }); assert.match(rejected.iteration.error, /TC_DEV_RESTART_REQUIRED/);
    assert.deepEqual((await command({ type: "snapshot" })).runtime, stable.runtime);
    await command({ type: "reload", restart: true });
    const restarted = await command({ type: "inspect" }); assert.equal(restarted.tick, 0);
    return { preservedTick: rejected.tick, rejection: rejected.iteration.error, explicitRestartTick: restarted.tick, releasedDuringLoad: true };
  }));
  await record("no-focus-no-raf-runtime-initialization", () => game("unattended", "runtime-lifecycle", async (page, command) => {
    const initial = await command({ type: "inspect" }); assert.equal(initial.tick, 0);
    assert.equal(await page.locator("[data-pelican-counter]").count(), 1);
    await command({ type: "step", count: 3 });
    const after = await command({ type: "inspect" }); assert.equal(after.tick, 3);
    assert.match(await page.locator("[data-pelican-counter]").innerText(), /3 ticks/);
    assert.equal(await page.evaluate(() => document.hasFocus()), false);
    await page.locator('[data-pelican-element="save"]').click();
    await command({ type: "step", count: 1 });
    const checkpoint = await page.locator("[data-pelican-counter]").innerText();
    assert.match(checkpoint, /4 ticks/);
    await command({ type: "step", count: 3 });
    assert.match(await page.locator("[data-pelican-counter]").innerText(), /7 ticks/);
    await page.locator('[data-pelican-element="load"]').click();
    await command({ type: "step", count: 1 });
    assert.equal(await page.locator("[data-pelican-counter]").count(), 1);
    assert.equal(await page.locator("[data-pelican-counter]").innerText(), checkpoint);
    const restored = await command({ type: "inspect" });
    assert.deepEqual(restored.errors, []);
    await command({ type: "step", count: 1 });
    assert.match(await page.locator("[data-pelican-counter]").innerText(), /5 ticks/);
    return { initialTick: 0, finalTick: after.tick, focus: false, rafDisabled: true, nativeInputRequired: false, asyncRuntimeSaveLoad: true, ownedMarkers: 1 };
  }));
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
    assert.equal(await page.locator("#status").isHidden(), true);
    await page.setViewportSize({ width: 390, height: 844 }); await command({ type: "step", count: 1 });
    const state = await command({ type: "inspect" }); assert.equal(state.width, 390); assert.equal(state.height, 844);
    const canvas = await page.locator("canvas:visible").first().boundingBox(); assert.equal(canvas!.width, 390); assert.equal(canvas!.height, 844);
    await page.goto(page.url() + "&diagnostics=1");
    await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true");
    assert.equal(await page.locator("#status").isVisible(), true);
    return { viewport: state.viewport, canvas, diagnosticsOptIn: true };
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
  await record("external-worker-managed-render-update", () => game("worker-resource", "external-adapters", async (page, command) => {
    const label = page.locator('[data-pelican-element="state"]');
    const until = async (count: number) => {
      for (let i = 0; i < 100; i++) {
        await command({ type: "step", count: 1 });
        if ((await label.innerText()).endsWith(`| ${count}`)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`Worker palette did not reach ${count} messages`);
    };
    await until(1);
    const before = decode(await page.locator("canvas:visible").first().screenshot());
    const saved = await command({ type: "snapshot" });
    await page.locator('[data-pelican-element="refresh"]').click(); await until(2);
    const after = decode(await page.locator("canvas:visible").first().screenshot());
    assert.equal(before.width, after.width); assert.equal(before.height, after.height); assert.equal(before.channels, after.channels);
    let changed = 0;
    for (let i = 0; i < before.data.length; i++) if (before.data[i] !== after.data[i]) changed++;
    assert.ok(changed > 64, `Worker data must visibly update the managed material buffer, changed=${changed}`);
    await command({ type: "restore", snapshot: saved }); await command({ type: "step", count: 1 });
    assert.match(await label.innerText(), /\| 1$/);
    const state = await command({ type: "inspect" }); assert.deepEqual(state.errors, []);
    return { changedChannels: changed, restored: true, backend: state.backend, moduleWorker: true };
  }));
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
  const workerProject = path.join(workspace, "worker-resource"); await run(["build", "--project", workerProject]);
  await record("production-module-worker-below-base-path", async () => {
    const server = await serveDist(path.join(workerProject, "dist"), ++port, "/nested/");
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(server.url);
      await page.waitForFunction(() => document.querySelector('[data-pelican-element="state"]')?.textContent?.endsWith("| 1"), undefined, { timeout: 30000, polling: 100 });
      await page.locator('[data-pelican-element="refresh"]').click();
      await page.waitForFunction(() => document.querySelector('[data-pelican-element="state"]')?.textContent?.endsWith("| 2"), undefined, { timeout: 30000, polling: 100 });
      assert.equal(await page.evaluate(() => !!(globalThis as any).__pelican), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, "production-worker-mobile.png") });
      return { basePath: "/nested/", workerReplies: 2, productionControlAbsent: true, errors };
    } finally { await page.close(); await server.close(); }
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ output, workspace, passed: records.length }));
