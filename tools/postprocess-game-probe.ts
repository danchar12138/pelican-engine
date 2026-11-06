import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

async function pixels(page: Page, file: string) {
  const png = await page.locator("canvas:visible").first().screenshot({ path: file });
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(Math.floor(bitmap.width / 2) - 4, Math.floor(bitmap.height / 2) - 4, 8, 8).data;
    const mean = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) mean[c] += data[i + c] / 64;
    bitmap.close();
    const upper = Array.from(context.getImageData(Math.round(canvas.width * 0.16), Math.round(canvas.height * 0.30), 1, 1).data).slice(0, 3);
    const lower = Array.from(context.getImageData(Math.round(canvas.width * 0.16), Math.round(canvas.height * 0.70), 1, 1).data).slice(0, 3);
    return { width: canvas.width, height: canvas.height, mean, orientation: { upper, lower } };
  }, [...png]);
}

async function tracedDisplayReference(page: Page) {
  const captured = await page.evaluate(async () => {
    const api = (window as any).__pelican, state = api.inspect();
    const linear = await api.linearPixels(true);
    const center: number[] = [];
    for (let y = state.height / 2 - 4; y < state.height / 2 + 4; y++)
      for (let x = state.width / 2 - 4; x < state.width / 2 + 4; x++) {
        const at = (y * state.width + x) * 4;
        center.push(linear[at], linear[at + 1], linear[at + 2]);
      }
    return { center, exposure: state.rendering.settings.exposure, samples: state.rendering.surface.samples };
  });
  const mean = [0, 0, 0];
  for (let i = 0; i < captured.center.length; i++) {
    const color = Math.max(0, captured.center[i] * captured.exposure);
    const tone = Math.min(1, Math.max(0, color * (2.51 * color + 0.03) / (color * (2.43 * color + 0.59) + 0.14)));
    const srgb = tone <= 0.0031308 ? 12.92 * tone : 1.055 * Math.pow(tone, 1 / 2.4) - 0.055;
    mean[i % 3] += Math.round(srgb * 255) / 64;
  }
  return { mean, samples: captured.samples };
}

/** Bounded real pixel causality; no 1080p/performance/reference convergence matrix. */
export async function runPostprocessGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/postprocess");
  await mkdir(output, { recursive: true });
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  const browser = await chromium.launch(automationLaunchOptions());
  const report: Record<string, any> = { scope: "controlled HDR postprocess bounded development integration", formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen();
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Postprocess game command");
      assert.equal(response.status, "succeeded", JSON.stringify(response));
      return response.data;
    };
    const tap = async (key: string) => {
      await command({ type: "input", key, pressed: true });
      await command({ type: "input", key, pressed: false });
      return command({ type: "step", count: 1 });
    };
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(initial.rendering.postProcesses.samples, 4, "Postprocessing must preserve the configured scene MSAA count.");
    report.adapter = initial.adapter;
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode });
      await tap("1");
      const identity = await pixels(page, path.join(output, mode + "-identity.png"));
      assert.ok(identity.mean[0] > 20, JSON.stringify(identity));
      assert.ok(identity.orientation.upper[1] > identity.orientation.upper[0] + 30 && identity.orientation.upper[1] > identity.orientation.lower[1] + 30, JSON.stringify({ mode, orientation: identity.orientation }));
      const identityReference = mode === "raster" ? undefined : await tracedDisplayReference(page);
      if (identityReference) assert.ok(identity.mean.every((value, i) => Math.abs(value - identityReference.mean[i]) < 2), JSON.stringify({ mode, identity, identityReference }));
      await tap("0");
      const direct = await pixels(page, path.join(output, mode + "-direct.png"));
      const directReference = mode === "raster" ? undefined : await tracedDisplayReference(page);
      if (directReference) assert.ok(direct.mean.every((value, i) => Math.abs(value - directReference.mean[i]) < 2), JSON.stringify({ mode, direct, directReference }));
      else assert.ok(identity.mean.every((value, i) => Math.abs(value - direct.mean[i]) < 7), JSON.stringify({ mode, identity, direct }));
      await tap("1");
      await tap("g");
      const quarter = await pixels(page, path.join(output, mode + "-quarter.png"));
      assert.ok(quarter.mean[0] + 8 < identity.mean[0], JSON.stringify({ identity, quarter }));
      const snapshot = await command({ type: "snapshot" });
      await tap("b");
      const black = await pixels(page, path.join(output, mode + "-black.png"));
      assert.ok(black.mean.every(value => value < 3), JSON.stringify(black));
      const restored = await command({ type: "restore", snapshot });
      assert.equal(restored.rendering.effectStates.find((item: any) => item.id === "grade").parameters.gain, 0.25);
      await tap("n");
      const normal = await pixels(page, path.join(output, mode + "-normal.png"));
      assert.ok(normal.mean[2] > normal.mean[0] + 5 && normal.mean[2] > normal.mean[1] + 5, JSON.stringify(normal));
      await tap("z");
      const depth = await pixels(page, path.join(output, mode + "-depth.png"));
      assert.ok(depth.mean[0] > 20 && Math.max(...depth.mean) - Math.min(...depth.mean) < 2, JSON.stringify(depth));
      await tap("1");
      await tap("e");
      const first = await pixels(page, path.join(output, mode + "-history-first.png"));
      await command({ type: "step", count: 1 });
      const second = await pixels(page, path.join(output, mode + "-history-second.png"));
      assert.ok(second.mean[0] > first.mean[0] + 2, JSON.stringify({ first, second }));
      await tap("r");
      const reset = await pixels(page, path.join(output, mode + "-history-reset.png"));
      assert.ok(reset.mean[0] + 2 < second.mean[0], JSON.stringify({ reset, second }));
      report.modes.push({ mode, identity, identityReference, direct, directReference, quarter, black, normal, depth, history: { first, second, reset }, compositor: (await command({ type: "inspect" })).rendering.postProcesses });
    }
    const beforeLoss = await command({ type: "inspect" });
    assert.equal(new Set(report.modes.map((item: any) => item.compositor.resources.live)).size, 1, "Parameter/mode changes must not grow owned compositor resources.");
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Postprocess GPU reconstruction");
    assert.equal(recovered.mode, beforeLoss.mode);
    assert.deepEqual(recovered.rendering.effectStates, beforeLoss.rendering.effectStates);
    assert.equal(recovered.rendering.postProcesses.resources.live, beforeLoss.rendering.postProcesses.resources.live);
    await tap("1"); await tap("n");
    const recoveredPixels = await pixels(page, path.join(output, "recovered-normal.png"));
    assert.ok(recoveredPixels.mean[2] > recoveredPixels.mean[0] + 5);
    report.recovery = recovered.rendering.gpuRecovery;
    const fallback = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
      const page = await fallback.newPage();
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
      const call = async (input: unknown) => {
        const response = await page.evaluate(async input => (window as any).__pelican.command(input), input);
        assert.equal(response.status, "succeeded", JSON.stringify(response)); return response.data;
      };
      const initial = await call({ type: "inspect" }); assert.equal(initial.backend, "WebGLBackend");
      assert.equal(initial.rendering.postProcesses.samples, 4);
      const identity = await pixels(page, path.join(output, "webgl2-identity.png"));
      assert.ok(identity.orientation.upper[1] > identity.orientation.upper[0] + 30 && identity.orientation.upper[1] > identity.orientation.lower[1] + 30, JSON.stringify(identity.orientation));
      await call({ type: "input", key: "g", pressed: true }); await call({ type: "step", count: 1 });
      const quarter = await pixels(page, path.join(output, "webgl2-quarter.png"));
      assert.ok(quarter.mean[0] + 8 < identity.mean[0]);
      report.webgl2 = { identity, quarter, compositor: initial.rendering.postProcesses };
    } finally { await fallback.close(); }
    report.teardown = await page.evaluate(async () => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = (window as any).__pelican.inspect();
      return { ready: state.ready, resources: state.resources.owned, canvases: document.querySelectorAll("canvas").length, postprocessDetached: state.rendering.postProcesses === undefined };
    });
    assert.equal(report.teardown.ready, false);
    assert.equal(report.teardown.resources.entries, 0);
    assert.equal(report.teardown.canvases, 0);
    assert.equal(report.teardown.postprocessDetached, true);
    assert.deepEqual(report.errors, []);
    report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    await browser.close(); await server.close();
    await writeFile(path.join(output, "postprocess-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(".pelican/postprocess-game", String(Date.now()));
  runPostprocessGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed }))).catch(error => { console.error(error); process.exitCode = 1; });
}
