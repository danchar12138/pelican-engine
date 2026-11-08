import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }, content = "typescript") {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "pelican-lifecycle-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION, content }));
  await mkdir(path.join(root, "node_modules"));
  await cp(path.resolve("node_modules/fflate"), path.join(root, "node_modules/fflate"), { recursive: true });
  return {
    root,
    compile: () => compileProject({ projectRoot: root, engineRoot: process.cwd(), outDir: "out" }),
  };
}

test("recipe builds without evaluating browser-only lazy npm dependencies, initializes in Chromium, restores and replays", { timeout: 60000 }, async t => {
  const { root, compile } = await fixture(t);
  await cp(path.resolve("examples/runtime-lifecycle/game.ts"), path.join(root, "game.ts"));
  await cp(path.resolve("examples/runtime-lifecycle/browser-counter.ts"), path.join(root, "browser-counter.ts"));
  const compiled = await compile();
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  assert.deepEqual(compiled.ir!.systems.map(s => s.id), ["counter"]);
  assert.equal(compiled.ir!.runtime?.version, "counter-v1");
  const code = await readFile(path.join(root, "out/game.js"), "utf8");
  const map = JSON.parse(await readFile(path.join(root, "out/game.js.map"), "utf8"));
  assert.ok(map.sources.some((s: string) => s.endsWith("browser-counter.ts")));
  assert.ok(compiled.report.inputs.some(input => input.path.endsWith("browser-counter.ts")));
  assert.ok(compiled.report.inputs.some(input => input.path.includes("fflate")));
  const server = await createServer({
    configFile: false, root: process.cwd(), logLevel: "error",
    plugins: [{ name: "lifecycle-test-page", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__lifecycle") { next(); return; }
        res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Lifecycle</title>");
      });
    } }],
    server: { port: 0, host: "127.0.0.1", fs: { strict: false } },
  });
  await server.listen();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
    await page.goto(`http://127.0.0.1:${address.port}/__lifecycle`);
    await page.addScriptTag({ content: "window.__name = target => target;" });
    const result = await page.evaluate(async ({ code, serializedIR }) => {
      const hostURL = "/packages/runtime/src/host.ts";
      const { RuntimeHost } = await import(hostURL);
      const ir = JSON.parse(serializedIR);
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const module = await import(/* @vite-ignore */ url);
      const a = new RuntimeHost(ir), b = new RuntimeHost(ir);
      try {
        const ga = module.createGame(a.facade), gb = module.createGame(b.facade);
        a.attach(ga); b.attach(gb);
        await Promise.all([a.stepAsync(3), b.stepAsync(1)]);
        const checkpoint = a.snapshot();
        await a.stepAsync(2); a.restore(checkpoint); await a.stepAsync(1);
        const restored = a.snapshot().runtime!.payload;
        a.startRecording(); await a.stepAsync(3); const trace = a.stopRecording();
        await a.stepAsync(2); const replay = await a.replayAsync(trace);
        return {
          restored, a: a.snapshot().runtime!.payload, b: b.snapshot().runtime!.payload,
          replay: replay.status, outputs: document.querySelectorAll("output[data-pelican-counter]").length,
        };
      } finally { a.dispose(); b.dispose(); URL.revokeObjectURL(url); }
    }, { code, serializedIR: JSON.stringify(compiled.ir!) });
    assert.deepEqual(result, { restored: { ticks: 4 }, a: { ticks: 7 }, b: { ticks: 1 }, replay: "passed", outputs: 2 });
    assert.equal(await page.locator("output[data-pelican-counter]").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
  const cached = await compile();
  assert.equal(cached.report.incremental.cacheHit, true);
});

test("legacy static extraction recognizes async runtime factory metadata without executing it", async t => {
  const { root, compile } = await fixture(t, "static");
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene,defineSystem} from 'pelican-engine';
export default defineGame({id:'static-runtime',scene:defineScene({id:'s',entities:[]}),
  systems:[defineSystem({id:'logic'})],runtime:{version:'1',async create(){
    let ticks=0; return {systems:{logic(){ticks++;}},snapshot:()=>({ticks}),
      validateSnapshot(){},restore(value){ticks=(value as {ticks:number}).ticks;}};
  }}});
`);
  const result = await compile();
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const module = await import(pathToFileURL(path.join(root, "out/game.js")).href);
  const host = new RuntimeHost(result.ir!);
  try {
    host.attach(module.createGame(host.facade)); await host.stepAsync(2);
    assert.deepEqual(host.snapshot().runtime!.payload, { ticks: 2 });
  } finally { host.dispose(); }
});

test("invalid factory metadata and missing runtime bindings are diagnosed at build with source", async t => {
  const { root, compile } = await fixture(t);
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene,defineSystem} from 'pelican-engine';
export default defineGame({id:'invalid',scene:defineScene({id:'s',entities:[]}),systems:[defineSystem({id:'logic'})]});
`);
  const result = await compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some(d => d.code === "TC_SYSTEM_RUN" && d.source?.file === "game.ts"));
});

test("browser-only declaration initialization has a source-mapped actionable diagnostic", async t => {
  const { root, compile } = await fixture(t);
  await writeFile(path.join(root, "browser.ts"), "export const title = document.title;\n");
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene} from 'pelican-engine';
import {title} from './browser.ts';
export default defineGame({id:title,scene:defineScene({id:'s',entities:[]})});
`);
  const result = await compile();
  assert.equal(result.success, false);
  const diagnostic = result.diagnostics.find(d => d.code === "TC_CONTENT_BROWSER_GLOBAL");
  assert.ok(diagnostic, JSON.stringify(result.diagnostics));
  assert.equal(diagnostic.source?.file, "browser.ts", JSON.stringify(diagnostic));
  assert.equal(diagnostic.source?.line, 1);
  assert.match(diagnostic.suggestion!, /runtime.create.*import/);
});

test("factory metadata scan catches asynchronous runtime system functions before invoking create", async t => {
  const { root, compile } = await fixture(t);
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene,defineSystem} from 'pelican-engine';
export default defineGame({id:'bad-runtime',scene:defineScene({id:'s',entities:[]}),systems:[defineSystem({id:'logic'})],
  runtime:{version:'1',create(){throw new Error('must not execute');return {systems:{async logic(){}}};}}});
`);
  const result = await compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some(d => d.code === "TC_SYSTEM_ASYNC" && d.source?.file === "game.ts"), JSON.stringify(result.diagnostics));
});

test("Node/browser declaration differences fail before creating author runtime resources", async t => {
  const { root, compile } = await fixture(t);
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene} from 'pelican-engine';
export default defineGame({id:typeof window==='undefined'?'node':'browser',scene:defineScene({id:'s',entities:[]}),
 runtime:{version:'1',create(){throw new Error('must not initialize');}}});
`);
  const result = await compile();
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const code = await readFile(path.join(root, "out/game.js"), "utf8");
  const emulateBrowser = code.replace("typeof window", "typeof globalThis");
  const output = path.join(root, "browser-game.mjs"); await writeFile(output, emulateBrowser);
  const module = await import(pathToFileURL(output).href);
  const host = new RuntimeHost(result.ir!);
  try { assert.throws(() => module.createGame(host.facade), /TC_GAME_CONSTRUCTION_DRIFT.*game.ts.*runtime.create/); }
  finally { host.dispose(); }
});

test("legacy structural system literals retain run contextual typing without runtime", async t => {
  const { root, compile } = await fixture(t);
  await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene} from 'pelican-engine';
export default defineGame({id:'legacy',scene:defineScene({id:'s',entities:[]}),
 systems:[{kind:'system',id:'logic',run(ctx,dt){ctx.emit('tick',{dt});}}]});
`);
  const result = await compile();
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const module = await import(pathToFileURL(path.join(root, "out/game.js")).href);
  const host = new RuntimeHost(result.ir!);
  try { host.attach(module.createGame(host.facade)); host.step(); assert.equal(host.snapshot().scheduler.tick, 1); }
  finally { host.dispose(); }
});
test("compiled declarations tolerate observed numerical tails but reject meaningful browser value changes", async t => {
  for (const browserValue of ["-0.06758126995938143", "-0.06"]) {
    const { root, compile } = await fixture(t);
    await writeFile(path.join(root, "game.ts"), `
import {defineGame,defineScene} from 'pelican-engine';
const x=typeof window==='undefined'?-0.06758126995938145:${browserValue};
export default defineGame({id:'math',scene:defineScene({id:'s',entities:[{id:'shape',transform:{position:[x,0,0]}}]})});
`);
    const result = await compile();
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    const code = (await readFile(path.join(root, "out/game.js"), "utf8")).replace("typeof window", "typeof globalThis");
    const output = path.join(root, "browser-game.mjs"); await writeFile(output, code);
    const module = await import(pathToFileURL(output).href), host = new RuntimeHost(result.ir!);
    try {
      if (browserValue === "-0.06") assert.throws(() => module.createGame(host.facade), /TC_GAME_CONSTRUCTION_DRIFT/);
      else { const instance = module.createGame(host.facade); await instance.ready; instance.dispose(); }
    } finally { host.dispose(); }
  }
});
