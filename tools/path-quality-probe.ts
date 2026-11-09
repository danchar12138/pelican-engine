import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { npmCommand } from "./doctor.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

// Actual installed-package stress probe. No desktop focus, private scene access or resolution reduction.
const root = process.cwd(),
  outputIndex = process.argv.indexOf("--output");
const output = path.resolve(
  outputIndex < 0 ? ".pelican/path-quality" : process.argv[outputIndex + 1],
);
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(path.join(tmpdir(), "pelican-path-quality-"));
const execute = promisify(execFile),
  npm = npmCommand(root)!;
await execute(
  npm.file,
  [
    ...npm.prefix,
    "--prefix",
    workspace,
    "install",
    "--save-dev",
    "--save-exact",
    path.join(root, `.pelican/npm/artifacts/pelican-engine-${SDK_VERSION}.tgz`),
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
  ],
  { timeout: 120000, windowsHide: true },
);
const bin = path.join(
  workspace,
  "node_modules/pelican-engine/lib/tools/npm/entry.js",
);
const run = async (...args: string[]) =>
  JSON.parse(
    (
      await execute(process.execPath, [bin, ...args], {
        cwd: workspace,
        timeout: 120000,
        maxBuffer: 8000000,
        windowsHide: true,
      })
    ).stdout,
  );
await run("create");
await cp(
  path.join(root, "examples/m3/assets"),
  path.join(workspace, "assets"),
  { recursive: true },
);
await writeFile(
  path.join(workspace, "game.ts"),
  `
import {defineGame,defineScene,defineMaterial,defineAsset,defineSystem,defineComponent,renderQuality} from 'pelican-engine';
const fox=defineAsset({id:'fox',type:'model',path:'assets/Fox.glb'}), bottle=defineAsset({id:'bottle',type:'model',path:'assets/WaterBottle.glb'});
const paint=defineMaterial({id:'paint',color:'#568e9f',roughness:.35,metalness:.25}), ground=defineMaterial({id:'ground',color:'#9b9a95',roughness:.8});
const control=defineComponent({id:'Control',schema:{moving:{type:'boolean',default:false}}});
const system=defineSystem({id:'control',run(ctx){
if(ctx.input.pressed('motion'))ctx.setComponent('control',control,{moving:!ctx.getComponent('control',control).moving});
if(ctx.getComponent('control',control).moving){const a=ctx.time.tick*.015;ctx.camera.setPose([Math.sin(a)*8,3,Math.cos(a)*8],[0,1,0]);}
if(ctx.input.pressed('high'))ctx.render.configure(renderQuality('high'));if(ctx.input.pressed('medium'))ctx.render.configure(renderQuality('medium'));if(ctx.input.pressed('low'))ctx.render.configure(renderQuality('low'));if(ctx.input.pressed('prepare'))ctx.render.prepare('path');
if(ctx.input.pressed('freeze'))ctx.animation.pause('fox');
}});
export default defineGame({id:'path-quality',services:{physics3d:'disabled'},components:[control],systems:[system],input:{motion:['m'],high:['1'],medium:['2'],low:['3'],prepare:['p'],freeze:['f']},scene:defineScene({id:'main',camera:{position:[0,3,8],target:[0,1,0]},entities:[
{id:'control',components:[{component:control}]},{id:'floor',mesh:{geometry:{kind:'box',size:[20,.1,20]},material:ground}},
...Array.from({length:4},(_,i)=>({id:'dense-'+i,transform:{position:[(i%2)*3-1.5,1,Math.floor(i/2)*3-1.5]},mesh:{geometry:{kind:'sphere',radius:.8,segments:192},material:paint}} as const)),
{id:'fox',model:{asset:fox,scale:.02,animation:{clip:'Run',speed:1,loop:true}},transform:{position:[0,0,0]}},
{id:'bottle',model:{asset:bottle,scale:4},transform:{position:[3,1,0]}},
{id:'sun',light:{kind:'directional',intensity:3,castShadow:true},transform:{position:[3,8,4]}}
]})});`,
);
assert.equal((await run("check")).status, "succeeded");
const server = spawn(process.execPath, [bin, "dev", "--port", "44363"], {
  cwd: workspace,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (bytes) => (log += bytes));
server.stderr.on("data", (bytes) => (log += bytes));
const browser = await chromium.launch(automationLaunchOptions());
const result: any = {
  version: SDK_VERSION,
  workspace,
  cases: [],
  scope:
    "High default path and optional hybrid/raster; >140k authored triangles plus animated/textured GLBs, actual native 1080p. Frame wall time is protocol-inclusive, not FPS; no hardware RT claim.",
};
try {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch("http://127.0.0.1:44363/", {
        signal: AbortSignal.timeout(500),
      });
      break;
    } catch {
      if (server.exitCode !== null) throw new Error(log);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  for (const [width, height] of [
    [960, 540],
    [1920, 1080],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript("globalThis.__name=value=>value;");
    try {
      const coldStart = performance.now();
      await page.goto(
        `http://127.0.0.1:44363/?automation=1&width=${width}&height=${height}`,
      );
      await waitForEngine(page, 120000);
      const coldMs = performance.now() - coldStart;
      const command = async (input: unknown) =>
        withAutomationDeadline(async () => {
          const response = await page.evaluate(
            (input) => (globalThis as any).__pelican.command(input),
            input,
          );
          assert.equal(response.status, "succeeded", JSON.stringify(response));
          return response.data;
        }, 120000);
      const press = async (key: string) => {
        await command({ type: "input", key, pressed: true });
        await command({ type: "step", count: 1 });
        await command({ type: "input", key, pressed: false });
      };
      const initial = await command({ type: "inspect" });
      assert.equal(initial.mode, "path");
      assert.equal(initial.rendering.settings.denoise, true);
      assert.ok(initial.triangleCount > 140000);
      assert.equal(initial.width, width);
      assert.equal(initial.height, height);
      assert.equal(initial.adapter.isFallbackAdapter, false);
      const frames: any[] = [];
      for (const mode of ["path", "hybrid", "raster"]) {
        if (mode !== "path") await press(mode === "hybrid" ? "2" : "3");
        await press("m");
        for (let i = 0; i < 8; i++) {
          const start = performance.now(),
            state = await command({ type: "step", count: 1 });
          frames.push({
            mode,
            wallMs: performance.now() - start,
            metric: state.metrics.at(-1),
            temporal: state.rendering.surface?.temporal,
            uploadBytes: state.rendering.surface?.uploadBytes,
          });
        }
        await press("m");
        await page.screenshot({
          path: path.join(output, `${width}-${mode}.png`),
        });
      }
      const saved = await command({ type: "snapshot" });
      const before = await command({ type: "inspect" });
      await page.evaluate(() => {
        (globalThis as any).__pelicanDocument = "retained";
      });
      await page.evaluate(() =>
        (globalThis as any).__pelican.prepareRendering("path"),
      );
      const prepared = await command({ type: "inspect" });
      assert.equal(prepared.mode, "raster");
      assert.equal(prepared.tick, before.tick);
      assert.equal(
        prepared.rendering.preparation.find((item: any) => item.mode === "path")
          .status,
        "ready",
      );
      const start = performance.now();
      await press("1");
      const warmSwitchMs = performance.now() - start;
      assert.equal(
        await page.evaluate(() => (globalThis as any).__pelicanDocument),
        "retained",
      );
      await command({ type: "restore", snapshot: saved });
      assert.equal((await command({ type: "inspect" })).mode, "raster");
      // Freeze the animated asset through the public API; keep simulation and camera running against static geometry.
      await press("1");
      await press("f");
      await command({ type: "step", count: 2 });
      const packingBefore = (await command({ type: "inspect" })).rendering
        .surface.motion;
      await press("m");
      await command({ type: "step", count: 6 });
      const final = await command({ type: "inspect" });
      assert.ok(
        final.rendering.surface.motion.packingCacheHits >
          packingBefore.packingCacheHits,
        "Unchanged geometry should reuse motion packing while simulation and camera move.",
      );
      const finite = await page.evaluate(async () => {
        const pixels = await (globalThis as any).__pelican.linearPixels();
        let invalid = 0,
          sum = 0;
        for (let i = 0; i < pixels.length; i++) {
          if (!Number.isFinite(pixels[i])) invalid++;
          if (i % 4 !== 3) sum += Math.abs(pixels[i]);
        }
        return { invalid, sum };
      });
      assert.equal(finite.invalid, 0);
      assert.ok(finite.sum > 0);
      assert.deepEqual(final.errors, []);
      assert.deepEqual(errors, []);
        await page.evaluate(async () => {
          const api = (globalThis as any).__pelican;
          (globalThis as any).__qualityPlanes = { raw: await api.linearPixels(false), filtered: await api.linearPixels(true) };
        });
        const referenceTick = final.tick;
        await command({ type: "render", mode: "path", samples: 64, denoise: false });
        const quality = await page.evaluate(async () => {
          const reference = await (globalThis as any).__pelican.linearPixels(false);
          const { raw, filtered } = (globalThis as any).__qualityPlanes;
          let rawError = 0, filteredError = 0, count = 0;
          for (let i = 0; i < reference.length; i++) if (i % 4 !== 3) {
            rawError += (raw[i] - reference[i]) ** 2;
            filteredError += (filtered[i] - reference[i]) ** 2;
            count++;
          }
          delete (globalThis as any).__qualityPlanes;
          return { rawMSE: rawError / count, filteredMSE: filteredError / count, referenceSamples: 64, reference: "Same frozen pose engine estimate, not independent physical ground truth." };
        });
        assert.ok(Number.isFinite(quality.rawMSE) && Number.isFinite(quality.filteredMSE));
        assert.equal((await command({ type: "inspect" })).tick, referenceTick);
      result.cases.push({
        width,
        height,
        coldMs,
        triangles: initial.triangleCount,
        adapter: initial.adapter,
        warmSwitchMs,
        frames,
        finite,
          quality,
        motion: final.rendering.surface.motion,
        temporal: final.rendering.surface.temporal,
        storageBytes: final.rendering.surface.ownedBytes,
        note: "No fixed FPS or independent image-quality score is inferred from a short sequence.",
      });
      await writeFile(
        path.join(output, "results.json"),
        JSON.stringify(result, null, 2),
      );
    } finally {
      await page.close();
    }
  }
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  if (server.exitCode === null) await once(server, "exit");
  await writeFile(path.join(output, "server.log"), log);
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(result, null, 2),
  );
}
console.log(
  JSON.stringify({
    output,
    passed: result.passed,
    error: result.error,
    cases: result.cases.map((item: any) => ({
      width: item.width,
      height: item.height,
      triangles: item.triangles,
      coldMs: item.coldMs,
      warmSwitchMs: item.warmSwitchMs,
    })),
  }),
);
