import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { runM3RecoveryProbe } from "./m3-recovery-probe.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

async function frameEvidence(page: Page, output: string) {
  const png = await page.locator("canvas").first().screenshot({ path: output });
  const pixels = await page.evaluate(async (bytes) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i] + data[i + 1] + data[i + 2] > 12) nonBlack++;
      colors.add((data[i] >> 3) * 1024 + (data[i + 1] >> 3) * 32 + (data[i + 2] >> 3));
    }
    image.close();
    return { width: canvas.width, height: canvas.height, colors: colors.size, nonBlack };
  }, [...png]);
  assert.ok(pixels.colors > 20 && pixels.nonBlack > 1000, JSON.stringify(pixels));
  return pixels;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".pelican/backend-probes", String(Date.now()));
await mkdir(output, { recursive: true });
const project = path.join(root, "examples/m3");
const compiled = await compileProject({ projectRoot: project, engineRoot: root, outDir: path.join(project, ".pelican/public/generated") });
assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
const browser = await chromium.launch(automationLaunchOptions());
const report: Record<string, unknown> = { source: await sourceFingerprint(root), scope: "development backend probe; not formal M3 acceptance", passed: false, cases: [] };
try {
  await server.listen();
  const target = new URL(server.resolvedUrls!.local[0]);
  target.search = "automation=1&width=640&height=360";
  for (const failure of ["missing-api", "null-adapter", "rejected-adapter"] as const) {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    try {
      const gpu = failure === "missing-api" ? "undefined" : failure === "null-adapter" ? "({ requestAdapter() { window.__adapterRequests++; return Promise.resolve(null); } })" : "({ requestAdapter() { window.__adapterRequests++; return Promise.reject(new Error('injected adapter rejection')); } })";
      await context.addInitScript({ content: `window.__adapterRequests = 0; Object.defineProperty(navigator, 'gpu', { configurable: true, value: ${gpu} });` });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(target.href);
      await waitForEngine(page);
      const result = await withAutomationDeadline(() => page.evaluate(async () => {
        const api = (window as any).__pelican;
        const before = api.inspect();
        const codes = [];
        const modeReplies = [];
        for (const mode of ["path", "hybrid"]) {
          const reply = await api.command({ type: "mode", mode });
          modeReplies.push({ mode, reply, after: api.inspect() });
          if (reply.status !== "failed") throw Error("unsupported mode accepted on " + before.backend + ": " + reply.status);
          codes.push(reply.diagnostics[0].code);
        }
        for (const settings of [{ denoise: true }]) {
          try { await api.configureRendering(settings); throw Error("unsupported denoise accepted"); }
          catch (error) { codes.push(String(error).match(/TC_[A-Z_]+/)?.[0]); }
        }
        try { await api.compute("anything", 0); } catch (error) { codes.push(String(error).match(/TC_[A-Z_]+/)?.[0]); }
        await api.step(2);
        const gl = document.querySelector("canvas")!.getContext("webgl2")!;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        return { before, after: api.inspect(), codes, modeReplies, adapterRequests: (window as any).__adapterRequests, identity: { vendor: gl.getParameter(gl.VENDOR), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), unmasked: Boolean(debug) }, status: document.querySelector("#status")!.textContent };
      }), 60000, "WebGL2 mode and compute rejection");
      assert.equal(result.before.backend, "WebGLBackend");
      assert.ok(failure === "missing-api" ? result.adapterRequests === 0 : result.adapterRequests > 0);
      assert.deepEqual(result.codes, ["TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE"]);
      assert.equal(result.after.mode, "raster");
      assert.equal(result.after.tick, result.before.tick + 2);
      assert.deepEqual(result.after.rendering.settings, result.before.rendering.settings);
      assert.match(result.status!, /WebGL2/);
      assert.doesNotMatch(String(result.identity.renderer), /swiftshader|llvmpipe|software/i);
      const pixels = await frameEvidence(page, path.join(output, failure + ".png"));
      const recoveries = [];
      for (let i = 0; i < 2; i++) {
        const before = await page.evaluate(() => (window as any).__pelican.inspect());
        const recovered = await withAutomationDeadline(() => page.evaluate(async () => await (window as any).__pelican.exerciseContextLoss()), 60000, "WebGL2 context recovery");
        assert.equal(recovered.backend, "WebGLBackend");
        assert.equal(recovered.ready, true);
        assert.equal(recovered.tick, result.after.tick);
        assert.deepEqual(recovered.runtime.records, result.after.runtime.records);
        recoveries.push({ before, after: recovered });
      }
      await frameEvidence(page, path.join(output, failure + "-restored.png"));
      const lifecycle = await page.evaluate(async () => {
        const api = (window as any).__pelican;
        const before = api.inspect().resources;
        const reloads = [];
        for (let i = 0; i < 3; i++) { await api.loadGame(); reloads.push(api.inspect().resources); }
        const after = api.inspect().resources;
        await api.step(1);
        return { before, after, reloads };
      });
      assert.deepEqual(lifecycle.after.owned, lifecycle.before.owned);
      assert.equal(lifecycle.after.counters.disposalsCompleted - lifecycle.before.counters.disposalsCompleted, 6);
      assert.equal(lifecycle.after.counters.disposalsFailed, 0);
      const teardown = await page.evaluate(async () => {
        const api = (window as any).__pelican;
        const gl = document.querySelector("canvas")!.getContext("webgl2")!;
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
        for (let i = 0; i < 50 && !gl.isContextLost(); i++) await new Promise(resolve => setTimeout(resolve, 20));
        const state = api.inspect();
        return { ready: state.ready, resources: state.resources, contextLost: gl.isContextLost(), canvases: document.querySelectorAll("canvas").length };
      });
      assert.equal(teardown.ready, false);
      assert.equal(teardown.contextLost, true);
      assert.equal(teardown.canvases, 0);
      assert.equal(teardown.resources.disposed, true);
      assert.equal(teardown.resources.owned.entries, 0);
      assert.deepEqual(errors, []);
      (report.cases as unknown[]).push({ failure, ...result, pixels, recoveries, lifecycle, teardown, errors });
      console.log(JSON.stringify({ failure, passed: true, identity: result.identity }));
    } finally { await context.close(); }
  }
  const context = await browser.newContext();
  try {
    await context.addInitScript({ content: `
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
      window.__webgl2Requests = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { if (type === 'webgl2') { window.__webgl2Requests++; return null; } return original.call(this, type, ...args); };
    ` });
    const page = await context.newPage();
    await page.goto(target.href);
    await assert.rejects(waitForEngine(page), /TC_RENDER_BACKEND_UNAVAILABLE/);
    const observation = await page.evaluate(() => ({ failureDetail: (window as any).__pelicanFailure, ready: document.documentElement.dataset.pelicanReady ?? null, backend: document.documentElement.dataset.pelicanBackend ?? null, webgl2Requests: (window as any).__webgl2Requests }));
    assert.match(observation.failureDetail, /TC_RENDER_BACKEND_UNAVAILABLE/);
    assert.notEqual(observation.ready, "true");
    assert.ok(observation.webgl2Requests > 0);
    (report.cases as unknown[]).push({ failure: "no-graphics-backend", ...observation });
  } finally { await context.close(); }
  if (!process.argv.includes("--webgl-only")) {
    report.webgpu = await runM3RecoveryProbe(target.href, path.join(output, "webgpu"));
  }
  const sourceFinal = await sourceFingerprint(root);
  report.sourceFinal = sourceFinal;
  assert.equal(sourceFinal.sha256, (report.source as { sha256: string }).sha256, "Source changed during backend probe");
  report.passed = true;
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser.close();
  await server.close();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, passed: report.passed }));
}
