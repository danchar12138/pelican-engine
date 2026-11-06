import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

export async function runFragmentBuffersGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/fragment-buffers");
  await mkdir(output, { recursive: true });
  const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "GPU compute to fragment/postprocess slots", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Fragment slot game command");
      assert.equal(response.status, "succeeded", JSON.stringify(response)); return response.data;
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const pixel = async (label: string, factor: number, black = false) => {
      const checkpoint = await command({ type: "snapshot" });
      const selected = checkpoint.runtime.plugins["$engine.render-settings"].payload.bufferBindings.bindings.palette.colors.id;
      const colors: number[][] = checkpoint.runtime.plugins["$engine.compute"].payload.buffers.find((b: any) => b.id === selected).data;
      const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, label + ".png") });
      const actual = await page.evaluate(async bytes => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0); image.close(); return [110, 210].map(x => Array.from(ctx.getImageData(x, 120, 1, 1).data).slice(0, 3));
      }, [...bytes]);
      const expected = colors.map(rgb => rgb.map(v => { const linear = black ? 0 : v * factor; return Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055)); }));
      actual.forEach((rgb, j) => rgb.forEach((v, i) => assert.ok(Math.abs(v - expected[j][i]) <= 2, JSON.stringify({ label, actual, expected, colors }))));
      return { actual, expected, colors };
    };
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(initial.rendering.computeGpu.uploads, 1); report.adapter = initial.adapter;
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode });
      const updated = await command({ type: "step", count: 1 });
      const material = await pixel(mode + "-material", 1);
      await tap("e"); const effect = await pixel(mode + "-effect", 0.5);
      await tap("o"); const outOfBounds = await pixel(mode + "-post-oob", 0, true);
      if (mode === "raster") {
        await tap("j"); await pixel("post-fractional", 0, true);
        await tap("n"); await pixel("post-negative", 0, true);
      }
      await tap("0"); await tap("i"); await tap("m");
      const materialOob = await pixel(mode + "-material-oob", 0, true);
      const reset = await tap("b"); await pixel(mode + "-reset", 1);
      assert.equal(reset.rendering.computeGpu.uploads, initial.rendering.computeGpu.uploads, "Computed render values must stay on GPU.");
      assert.equal(reset.rendering.bufferBindings.cpuResultUploads, 0);
      const copies = reset.rendering.bufferBindings.gpuCopies;
      if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(2)), 30000, "Stable fragment frames");
      const stable = await command({ type: "inspect" });
      assert.equal(stable.rendering.bufferBindings.gpuCopies, copies, "Unchanged frames must not recopy resident values.");
      report.modes.push({ mode, material, effect, outOfBounds, materialOob, gpu: reset.rendering.computeGpu, bridge: reset.rendering.bufferBindings, native: reset.rendering.surface?.materialGraphs, updatedCommits: updated.rendering.computeGpu.commits });
    }
    const saved = await command({ type: "snapshot" });
    const beforeRebind = await command({ type: "inspect" });
    const rebound = await tap("a"); await pixel("rebound", 1);
    assert.equal(rebound.rendering.computeGpu.uploads, beforeRebind.rendering.computeGpu.uploads + 1, "New CPU checkpoint is uploaded exactly once.");
    const pinned = await tap("q"); assert.equal(pinned.game.components.stats.SlotStats.releaseError, "TC_COMPUTE_BUFFER_IN_USE");
    const restored = await command({ type: "restore", snapshot: saved }); await pixel("restored", 1);
    const bad = structuredClone(saved); bad.runtime.plugins["$engine.render-settings"].payload.effectBufferBindings.bindings.palette.colors.count = 9;
    const badRestore = await page.evaluate(async snapshot => (window as any).__pelican.command({ type: "restore", snapshot }), bad);
    assert.equal(badRestore.status, "failed");
    assert.deepEqual((await command({ type: "inspect" })).game, restored.game);
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Fragment resources device reconstruction");
    await pixel("recovered", 1);
    const afterRecovery = await command({ type: "step", count: 1 }); await pixel("after-recovery-compute", 1);
    assert.equal(afterRecovery.rendering.computeGpu.uploads, recovered.rendering.computeGpu.uploads);
    await command({ type: "recordStart" }); await command({ type: "step", count: 2 });
    const trace = await command({ type: "recordStop" }); assert.equal((await command({ type: "replay", trace })).status, "passed");
    report.lifecycle = { rebound: rebound.rendering.bufferBindings, pinError: pinned.game.components.stats.SlotStats.releaseError, invalidRestore: badRestore.diagnostics, recovered: recovered.rendering.gpuRecovery, replay: "passed" };
    const fallback = await browser.newContext();
    try {
      await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
      const fallbackPage = await fallback.newPage(); await fallbackPage.goto(target.href, { waitUntil: "domcontentloaded" });
      await assert.rejects(waitForEngine(fallbackPage), /TC_RENDER_BUFFER_CAPABILITY/); report.webgl2 = "TC_RENDER_BUFFER_CAPABILITY";
    } finally { await fallback.close(); }
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 }); report.teardown = teardown;
    assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    try { await browser?.close(); } finally { await server.close(); }
    await writeFile(path.join(output, "fragment-buffers-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_COMPUTE_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/fragment-buffers/" + Date.now());
  runFragmentBuffersGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed, sourceIdentity: report.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
