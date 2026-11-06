import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

export async function runComputeTexturesGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/compute-textures");
  await mkdir(output, { recursive: true }); const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  if (!compiled.success) await writeFile(path.join(output, "compile-failure.json"), JSON.stringify({ sourceIdentity: identity.sha256, diagnostics: compiled.diagnostics }, null, 2) + "\n");
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "managed GPU texture storage/sampling/dependency feedback", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => {
      const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Managed texture command");
      assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data;
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const resources = async () => { const s = await command({ type: "snapshot" }); return Object.fromEntries(s.runtime.plugins["$engine.compute"].payload.buffers.map((b: any) => [b.id, b])); };
    const close = (a: unknown, b: unknown) => {
      if (Array.isArray(a) && Array.isArray(b)) { assert.equal(a.length, b.length); a.forEach((value, i) => close(value, b[i])); }
      else assert.ok(typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.000002, JSON.stringify({ a, b }));
    };
    const pixels = async (label: string) => {
      const expectedValues = (await resources()).current.data as number[][];
      const screenshot = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, label + ".png") });
      const actual = await page.evaluate(async bytes => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0); image.close(); return [110, 210].map(x => Array.from(context.getImageData(x, 120, 1, 1).data).slice(0, 3));
      }, [...screenshot]);
      const expected = expectedValues.map(rgb => rgb.map(value => { const v = Math.min(1, Math.max(0, value)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }));
      actual.forEach((rgb, j) => rgb.forEach((v, i) => assert.ok(Math.abs(v - expected[j][i]) <= 2, JSON.stringify({ label, actual, expected }))));
      return { actual, expected };
    };
    const initial = await command({ type: "inspect" }); assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false); report.adapter = initial.adapter;
    const first = await command({ type: "step", count: 1 }), values = await resources();
    report.initialChain = { gpu: first.rendering.computeGpu, values };
    close(values.field.data, [[0.375,0.3125,0,1],[0.875,0.3125,0.25,1],[0.375,0.8125,0.5,1],[0.875,0.8125,0.75,1]]);
    close(values.current.data, [[0.375,0.5625,0.25],[0.875,0.5625,0.5]]);
    close(values.old.data, [[0.25,0.5,0.25],[0.75,0.5,0.5]]); close(values.captured.data, [[0,0,0],[0,0,0]]);
    close(values.nearest.data, [[0.375,0.3125,0,1]]); close(values.linear.data, [[0.625,0.3125,0.125,1]]);
    const wide = [[1/6,0.25,0,1],[0.5,0.25,0.25,1],[5/6,0.25,0.5,1],[1/6,0.75,0.75,1],[0.5,0.75,1,1],[5/6,0.75,1.25,1]];
    close(values.wide.data, wide); close(values.wideCopy.data, wide);
    assert.equal(first.rendering.computeGpu.commits, 9); assert.equal(first.rendering.computeGpu.liveTextures, 4);
    assert.equal(first.rendering.computeGpu.textureUploads, 1, "Only the captured initial-zero texture checkpoint is uploaded, never storage results.");
    assert.equal(first.game.components.stats.TextureStats.busyError, "TC_COMPUTE_BUSY");
    const late = await command({ type: "step", count: 1 }); close((await resources()).late.data, values.old.data);
    assert.equal(late.rendering.computeGpu.textureUploads, first.rendering.computeGpu.textureUploads);
    assert.equal(late.rendering.computeGpu.uploads, first.rendering.computeGpu.uploads);
    const raster = await pixels("raster"); await command({ type: "mode", mode: "path" }); const traced = await pixels("path");
    report.chain = { firstGpu: first.rendering.computeGpu, lateGpu: late.rendering.computeGpu, values, raster, traced };
    const failed = await tap("f"), observedFailure = await command({ type: "step", count: 1 });
    assert.equal(failed.rendering.computeGpu.commits, late.rendering.computeGpu.commits + 1);
    assert.match(observedFailure.game.components.stats.TextureStats.taskErrors, /TC_COMPUTE_TEXTURE_COORD/);
    assert.match(observedFailure.game.components.stats.TextureStats.taskErrors, /TC_COMPUTE_DEPENDENCY_FAILED/);
    close((await resources()).field.data, values.field.data); close((await resources()).current.data, values.current.data);
    assert.equal(failed.rendering.computeGpu.liveTextures, 4);
    const cancelled = await tap("c"); await command({ type: "step", count: 1 });
    assert.equal(cancelled.rendering.computeGpu.commits, failed.rendering.computeGpu.commits + 1);
    close((await resources()).field.data, values.field.data);
    const released = await tap("r"); assert.equal(released.rendering.compute.tasks, 0); assert.equal(released.rendering.computeGpu.liveTextures, 3);
    const saved = await command({ type: "snapshot" });
    const written = await tap("w"); assert.equal(written.rendering.computeGpu.textureUploads, released.rendering.computeGpu.textureUploads + 1);
    close((await resources()).current.data, [[0.6375,0.50625,0.3],[0.875,0.5625,0.5]]); await pixels("rect-write");
    await command({ type: "restore", snapshot: saved }); close((await resources()).field.data, values.field.data);
    const malformed = structuredClone(saved), texture = malformed.runtime.plugins["$engine.compute"].payload.buffers.find((b: any) => b.id === "field"); texture.texture.width = 3;
    const rejected = await page.evaluate(async snapshot => (window as any).__pelican.command({ type: "restore", snapshot }), malformed);
    assert.equal(rejected.status, "failed"); close((await resources()).field.data, values.field.data);
    await tap("u"); const beforeLoss = await resources();
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Texture device reconstruction");
    close((await resources()).field.data, beforeLoss.field.data); await pixels("recovered");
    const resumed = await tap("u"), continued = await tap("u");
    assert.equal(continued.rendering.computeGpu.textureUploads, resumed.rendering.computeGpu.textureUploads);
    await pixels("continued");
    await command({ type: "recordStart" }); await tap("u"); const trace = await command({ type: "recordStop" }); assert.equal((await command({ type: "replay", trace })).status, "passed");
    report.lifecycle = { failed: observedFailure.game.components.stats.TextureStats.taskErrors, failureGpu: failed.rendering.computeGpu, cancelledGpu: cancelled.rendering.computeGpu, releasedGpu: released.rendering.computeGpu, writtenGpu: written.rendering.computeGpu, invalidRestore: rejected.diagnostics, recovery: recovered.rendering.gpuRecovery, resumedGpu: resumed.rendering.computeGpu, continuedGpu: continued.rendering.computeGpu, replay: "passed" };
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 }); report.teardown = teardown;
    assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { try { await browser?.close(); } finally { await server.close(); } await writeFile(path.join(output, "compute-textures-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_COMPUTE_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/compute-textures/" + Date.now());
  runComputeTexturesGameProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
