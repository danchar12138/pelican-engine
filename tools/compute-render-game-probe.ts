import assert from "node:assert/strict";
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

/** Bounded end-to-end proof of committed GPU copies, not a performance or full M3 gate. */
export async function runComputeRenderGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/compute-render");
  await mkdir(output, { recursive: true });
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  const browser = await chromium.launch(automationLaunchOptions());
  const report: Record<string, any> = { scope: "managed committed GPU compute to render slots", formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen(); const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Resident render game command");
      assert.equal(response.status, "succeeded", JSON.stringify(response)); return response.data;
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(initial.rendering.bufferBindings.gpuCopies, 1);
    assert.equal(initial.rendering.computeGpu.checkpointUploads, 1);
    report.adapter = initial.adapter;
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode });
      const before = await command({ type: "inspect" });
      const stepped = await command({ type: "step", count: 3 });
      assert.equal(stepped.rendering.computeGpu.uploads, before.rendering.computeGpu.uploads, "Computed feedback/render updates must not reupload the CPU mirror.");
      assert.equal(stepped.rendering.computeGpu.commits - before.rendering.computeGpu.commits, 3);
      assert.equal(stepped.rendering.bufferBindings.gpuCopies - before.rendering.bufferBindings.gpuCopies, 3);
      assert.equal(stepped.rendering.bufferBindings.cpuResultUploads, 0);
      assert.ok(stepped.rendering.vertex.bounds[0].frustumCulled);
      assert.ok(stepped.rendering.vertex.bounds[0].worldCenter[0] > before.rendering.vertex.bounds[0].worldCenter[0]);
      const frame = await page.evaluate(() => (window as any).__pelican.cameraDirection());
      const center = stepped.rendering.vertex.bounds[0].worldCenter;
      const delta = center.map((value: number, i: number) => value - frame.origin[i]);
      const z = delta.reduce((sum: number, value: number, i: number) => sum + value * frame.forward[i], 0);
      const axis = (v: number[]) => delta.reduce((sum: number, value: number, i: number) => sum + value * v[i], 0) / (z * v.reduce((sum, value) => sum + value * value, 0));
      const point = { x: Math.floor((0.5 + axis(frame.right) * 0.5) * stepped.width), y: Math.floor((0.5 - axis(frame.up) * 0.5) * stepped.height) };
      const screenshot = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, mode + ".png") });
      const actual = await page.evaluate(async ({ bytes, point }) => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0); image.close(); return Array.from(context.getImageData(point.x, point.y, 1, 1).data).slice(0,3);
      }, { bytes: [...screenshot], point });
      const radial = await page.evaluate(async point => {
        const api = (window as any).__pelican, state = api.inspect();
        if (state.mode !== "raster") { const guides = await api.guidePixels(); return Number(guides.normalDepth[(point.y * state.width + point.x) * 4 + 3]); }
        const frame = api.cameraDirection(), x = ((point.x + 0.5) / state.width) * 2 - 1, y = ((point.y + 0.5) / state.height) * 2 - 1;
        const d = frame.forward.map((value: number, i: number) => value + frame.right[i] * x - frame.up[i] * y), length = Math.hypot(...d);
        const hit = api.vertexRay(frame.origin, d.map((value: number) => value / length)); return hit.distance;
      }, point);
      const linear = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(radial)) * 0.1));
      const expected = Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1/2.4) - 0.055));
      assert.ok(actual.every(value => Math.abs(value - expected) <= 3), JSON.stringify({ mode, actual, expected, radial }));
      report.modes.push({ mode, before: { uploads: before.rendering.computeGpu.uploads, copies: before.rendering.bufferBindings.gpuCopies }, stepped: { gpu: stepped.rendering.computeGpu, bridge: stepped.rendering.bufferBindings, bounds: stepped.rendering.vertex.bounds }, actual, expected });
    }
    const saved = await command({ type: "snapshot" });
    const beforeFailure = await command({ type: "inspect" });
    const failedDispatch = await tap("f");
    assert.equal(failedDispatch.rendering.computeGpu.commits, beforeFailure.rendering.computeGpu.commits);
    assert.equal(failedDispatch.rendering.bufferBindings.gpuCopies, beforeFailure.rendering.bufferBindings.gpuCopies);
    assert.deepEqual(failedDispatch.rendering.vertex.bounds, beforeFailure.rendering.vertex.bounds, "Failed GPU results must not enter CPU bounds or render copies.");
    const cancelled = await tap("c");
    assert.equal(cancelled.rendering.computeGpu.commits, beforeFailure.rendering.computeGpu.commits);
    assert.equal(cancelled.rendering.bufferBindings.gpuCopies, beforeFailure.rendering.bufferBindings.gpuCopies);
    assert.equal(cancelled.game.components.stats.ResidentStats.taskError, "TC_COMPUTE_BOUNDS");
    report.failedAndCancelled = { error: cancelled.game.components.stats.ResidentStats.taskError, commits: [beforeFailure.rendering.computeGpu.commits, failedDispatch.rendering.computeGpu.commits, cancelled.rendering.computeGpu.commits], copies: [beforeFailure.rendering.bufferBindings.gpuCopies, failedDispatch.rendering.bufferBindings.gpuCopies, cancelled.rendering.bufferBindings.gpuCopies] };
    const beforeBind = await command({ type: "inspect" });
    const rebound = await tap("a");
    assert.ok(rebound.rendering.vertex.bounds[0].worldCenter[2] > beforeBind.rendering.vertex.bounds[0].worldCenter[2] + 0.5);
    const pinned = await tap("q");
    assert.equal(pinned.game.components.stats.ResidentStats.releaseError, "TC_COMPUTE_BUFFER_IN_USE");
    const restored = await command({ type: "restore", snapshot: saved });
    assert.equal(restored.rendering.bufferBindings.bindings[0].key === rebound.rendering.bufferBindings.bindings[0].key, false, "Restore must not reuse stale physical resource identity.");
    const bad = structuredClone(saved);
    bad.runtime.plugins["$engine.compute"].payload.buffers = [];
    const failed = await page.evaluate(async value => (window as any).__pelican.command({ type: "restore", snapshot: value }), bad);
    assert.equal(failed.status, "failed");
    assert.ok(failed.diagnostics[0].code.startsWith("TC_RENDER_BUFFER_"), JSON.stringify(failed));
    const afterBad = await command({ type: "inspect" });
    assert.deepEqual(afterBad.game, restored.game);
    const beforeLoss = await command({ type: "inspect" });
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Resident GPU resource recovery");
    assert.deepEqual(recovered.game, beforeLoss.game);
    assert.equal(recovered.rendering.bufferBindings.liveAttributes, 1);
    const committedAfterLoss = await command({ type: "step", count: 2 });
    assert.equal(committedAfterLoss.rendering.computeGpu.uploads, recovered.rendering.computeGpu.uploads);
    await command({ type: "recordStart" });
    await command({ type: "input", key: "r", pressed: true }); await command({ type: "step", count: 2 });
    await command({ type: "input", key: "r", pressed: false });
    const trace = await command({ type: "recordStop" });
    assert.equal((await command({ type: "replay", trace })).status, "passed");
    report.lifecycle = { rebound: rebound.rendering.bufferBindings, pinnedRelease: pinned.game.components.stats.ResidentStats.releaseError, invalidRestore: failed.diagnostics, recovery: recovered.rendering.gpuRecovery, afterLoss: committedAfterLoss.rendering.computeGpu, replay: "passed" };
    const fallback = await browser.newContext();
    try {
      await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
      const page = await fallback.newPage(); await page.goto(target.href, { waitUntil: "domcontentloaded" });
      await assert.rejects(waitForEngine(page), /TC_RENDER_BUFFER_CAPABILITY/);
      report.webgl2 = "TC_RENDER_BUFFER_CAPABILITY; no CPU storage fallback";
    } finally { await fallback.close(); }
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await page.waitForTimeout(100);
    const teardown = await page.evaluate(() => { const state = (window as any).__pelican.inspect(); return { ready: state.ready, resources: state.resources.owned, bridgeDetached: state.rendering.bufferBindings === undefined, canvases: document.querySelectorAll("canvas").length }; });
    assert.equal(teardown.ready, false); assert.equal(teardown.resources.entries, 0); assert.equal(teardown.bridgeDetached, true); assert.equal(teardown.canvases, 0);
    report.teardown = teardown; assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { await browser.close(); await server.close(); await writeFile(path.join(output, "compute-render-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(".pelican/compute-render-game", String(Date.now()));
  runComputeRenderGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed }))).catch(error => { console.error(error); process.exitCode = 1; });
}
