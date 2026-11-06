import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { sampleManagedTexture } from "../packages/renderer/src/managed-texture-sampling.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

export async function runRenderTexturesGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/render-textures");
  await mkdir(output, { recursive: true }); const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  if (!compiled.success) await writeFile(path.join(output, "compile-failure.json"), JSON.stringify({ sourceIdentity: identity.sha256, diagnostics: compiled.diagnostics }, null, 2) + "\n");
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "managed texture rendering and asset import", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message)); page.on("console", msg => { if (msg.type() === "error") report.errors.push(msg.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => { const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Render texture command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const resources = async () => { const s = await command({ type: "snapshot" }); return { snapshot: s, values: Object.fromEntries(s.runtime.plugins["$engine.compute"].payload.buffers.map((b: any) => [b.id, b])) as Record<string, any> }; };
    const pixels = async (label: string, effect: boolean) => {
      const { values, snapshot } = await resources(); const id = snapshot.runtime.plugins["$engine.render-settings"].payload.textureBindings.bindings.palette.image.id, texture = values[id];
      const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, label + ".png") });
      const points = [{ x: 80, y: 120 }, { x: 240, y: 120 }];
      const actual = await page.evaluate(async ({ bytes, points }) => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close(); return points.map(({x,y}) => Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3)); }, { bytes: [...bytes], points });
      if (effect) {
        const descriptor = { key: "fixture", type: "vec4" as const, revision: 0, texture: texture.texture, values: texture.data }, sampler = { name: "image", filter: "linear" as const, wrapU: "repeat" as const, wrapV: "mirror" as const };
        const expected = points.map(p => sampleManagedTexture(descriptor, [(p.x + 0.5) / 320, 1 - (p.y + 0.5) / 240], sampler).slice(0,3).map(v => { const c = Math.max(0, Math.min(1, v * 0.5)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }));
        actual.forEach((rgb, i) => rgb.forEach((v,j) => assert.ok(Math.abs(v - expected[i][j]) <= 3, JSON.stringify({ label, actual, expected })))); return { actual, expected };
      }
      const uvs = await page.evaluate(points => {
        const api = (window as any).__pelican, state = api.inspect(), frame = api.cameraDirection(), center = state.rendering.vertex.bounds[0].worldCenter;
        return points.map(p => { const x = (p.x + 0.5) / state.width * 2 - 1, y = (p.y + 0.5) / state.height * 2 - 1;
          const direction = frame.forward.map((v: number, i: number) => v + frame.right[i] * x - frame.up[i] * y), distance = (center[2] - frame.origin[2]) / direction[2];
          return [0.5 + (frame.origin[0] + distance * direction[0] - center[0]) / 4, 0.5 + (frame.origin[1] + distance * direction[1] - center[1]) / 3]; });
      }, points);
      const descriptor = { key: "fixture", type: "vec4" as const, revision: 0, texture: texture.texture, values: texture.data }, sampler = { name: "image", filter: "linear" as const, wrapU: "repeat" as const, wrapV: "mirror" as const };
      const expected = uvs.map(uv => sampleManagedTexture(descriptor, uv as [number,number], sampler).slice(0,3).map(v => { const c = Math.max(0, Math.min(1, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }));
      actual.forEach((rgb, i) => rgb.forEach((v,j) => assert.ok(Math.abs(v - expected[i][j]) <= 4, JSON.stringify({ label, actual, expected, uvs })))); return { actual, expected, uvs };
    };
    const initial = await command({ type: "inspect" }); assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false); report.adapter = initial.adapter;
    const initialResources = await resources();
    const imported = initialResources.values.imported; assert.deepEqual(imported.texture, { width: 2, height: 2 });
    const srgb = (v: number) => Math.fround(v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
    const expectedImport = [[srgb(128),srgb(128),srgb(128),1],[1,1,1,1],[0,0,0,1],[srgb(64),srgb(64),srgb(64),1]];
    imported.data.forEach((rgba: number[], i: number) => rgba.forEach((v,j) => assert.ok(Math.abs(v - expectedImport[i][j]) < 1e-6, JSON.stringify({ actual: imported.data, expectedImport }))));
    const before = initial.rendering.vertex.bounds[0].worldCenter;
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode }); const updated = await command({ type: "step", count: 1 });
      const material = await pixels(mode + "-material", false);
      await tap("e"); const post = await pixels(mode + "-post", true); await tap("i");
      const state = await command({ type: "inspect" });
      assert.equal(state.rendering.textureBindings.cpuResultUploads, 0);
      if (mode !== "raster") { assert.ok(state.rendering.surface.materialGraphs.textureSlots.gpuCopies > 0); assert.equal(state.rendering.surface.materialGraphs.textureSlots.cpuResultUploads, 0); }
      report.modes.push({ mode, material, post, textureGpu: state.rendering.textureBindings, native: state.rendering.surface?.materialGraphs, compute: state.rendering.computeGpu, center: updated.rendering.vertex.bounds[0].worldCenter });
    }
    const moved = (await command({ type: "inspect" })).rendering.vertex.bounds[0].worldCenter; assert.ok(moved[0] > before[0] && moved[1] > before[1]);
    const saved = (await resources()).snapshot; const rebound = await tap("a"); await tap("e"); const importedPixels = await pixels("imported-post", true);
    const pinned = await tap("q"); assert.equal(pinned.game.components.stats.TextureSlotStats.releaseError, "TC_COMPUTE_BUFFER_IN_USE");
    const restored = await command({ type: "restore", snapshot: saved });
    const bad = structuredClone(saved); bad.runtime.plugins["$engine.render-settings"].payload.effectTextureBindings.bindings.palette.image.width = 9;
    const rejected = await page.evaluate(async snapshot => (window as any).__pelican.command({ type: "restore", snapshot }), bad); assert.equal(rejected.status, "failed"); assert.deepEqual((await command({ type: "inspect" })).game, restored.game);
    const recovery = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Render texture recovery");
    const resumed = await command({ type: "step", count: 1 }); assert.equal(resumed.rendering.textureBindings.cpuResultUploads, 0);
    await command({ type: "recordStart" }); await command({ type: "step", count: 1 }); const trace = await command({ type: "recordStop" }); assert.equal((await command({ type: "replay", trace })).status, "passed");
    report.lifecycle = { imported: imported.data, rebound: rebound.rendering.textureBindings, importedPixels, pinned: pinned.game.components.stats.TextureSlotStats.releaseError, rejected: rejected.diagnostics, recovery: recovery.rendering.gpuRecovery, replay: "passed" };
    const fallback = await browser.newContext(); try { await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" }); const p = await fallback.newPage(); await p.goto(target.href, { waitUntil: "domcontentloaded" }); await assert.rejects(waitForEngine(p), /TC_RENDER_TEXTURE_CAPABILITY/); report.webgl2 = "TC_RENDER_TEXTURE_CAPABILITY"; } finally { await fallback.close(); }
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide"))); const teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 }); report.teardown = teardown; assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { try { await browser?.close(); } finally { await server.close(); } await writeFile(path.join(output, "render-textures-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_COMPUTE_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/render-textures/" + Date.now());
  runRenderTexturesGameProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
