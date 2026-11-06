import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

export async function runAngularPhysicsGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/angular-physics");
  await mkdir(output, { recursive: true }); const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  if (!compiled.success) await writeFile(path.join(output, "compile-failure.json"), JSON.stringify({ sourceIdentity: identity.sha256, diagnostics: compiled.diagnostics }, null, 2) + "\n");
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "public rigid body angular impulses and snapshots", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message)); page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => { const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Angular physics game command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const stats = (state: any) => state.game.components.stats.AngularStats;
    const near = (actual: number, expected: number, tolerance = 0.0001) => assert.ok(Math.abs(actual - expected) <= tolerance, JSON.stringify({ actual, expected, tolerance }));
    const initial = await command({ type: "inspect" }); assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false); report.adapter = initial.adapter;
    const impulse = await tap("i"), values = stats(impulse);
    near(values.centered[2], 0); near(values.offset[2], -1.2, 0.0005);
    const checkpoint = await command({ type: "snapshot" });
    const later = await command({ type: "step", count: 20 });
    assert.ok(Math.abs(later.game.transforms.offset.rotation[2]) > 0.2, JSON.stringify(later.game.transforms.offset));
    assert.ok(Math.abs(later.game.transforms.centered.rotation[2]) < 0.0001);
    const screenshot = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, "angular-motion.png") });
    const visible = await page.evaluate(async bytes => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!; ctx.drawImage(image,0,0); image.close(); const data = ctx.getImageData(0,0,canvas.width,canvas.height).data; let colored = 0; for(let i=0;i<data.length;i+=4) if (Math.max(data[i],data[i+1],data[i+2]) - Math.min(data[i],data[i+1],data[i+2]) > 30) colored++; return colored; }, [...screenshot]);
    assert.ok(visible > 200, "Expected visible rendered bodies.");
    const invalid = await tap("f"); assert.equal(stats(invalid).error, "TC_PHYSICS_BODY_TYPE");
    const restored = await command({ type: "restore", snapshot: checkpoint }); near(stats(restored).offset[2], values.offset[2]);
    const set = await tap("v"); near(stats(set).centered[2], 1, 0.0005);
    const beforeTorque = stats(set).offset[2], torque = await tap("t"); near(stats(torque).offset[2] - beforeTorque, 0.6, 0.001);
    await command({ type: "recordStart" }); await tap("i"); await command({ type: "step", count: 8 });
    const trace = await command({ type: "recordStop" }); assert.equal((await command({ type: "replay", trace })).status, "passed");
    await command({ type: "mode", mode: "path" }); const traced = await command({ type: "step", count: 1 }); assert.equal(traced.mode, "path"); assert.ok(traced.rendering.surface.triangleCount > 0);
    report.results = { impulse: values, after20Ticks: later.game.transforms, visibleColoredPixels: visible, invalid: stats(invalid).error, restored: stats(restored), set: stats(set), torque: stats(torque), replay: "passed", tracedTriangles: traced.rendering.surface.triangleCount };
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 }); report.teardown = teardown; assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { try { await browser?.close(); } finally { await server.close(); } await writeFile(path.join(output, "angular-physics-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_PHYSICS_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/angular-physics/" + Date.now());
  runAngularPhysicsGameProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
