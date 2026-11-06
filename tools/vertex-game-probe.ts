import assert from "node:assert/strict";
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

const f = Math.fround;
function pixelRay(state: any, frame: any, x: number, y: number) {
  let jx = 0.5, jy = 0.5;
  if (state.mode !== "raster") assert.ok(Number.isSafeInteger(state.rendering.surface.frameSerial), "GPU-frame diagnostics must identify the exact sampled ray.");
  if (state.mode === "path") {
    let seed = (Math.imul(y * state.width + x, 1973) + Math.imul(state.rendering.surface.frameSerial, 9277) + 89173) >>> 0;
    const random = () => {
      seed = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
      const word = Math.imul((seed >>> ((seed >>> 28) + 4)) ^ seed, 277803737) >>> 0;
      return Math.min(f(f(((word >>> 22) ^ word) >>> 0) / 4294967296), f(0.99999994));
    };
    jx = random(); jy = random();
  } else if (state.mode === "hybrid") {
    const halton = (index: number, base: number) => { let value = 0, weight = 1; while (index > 0) { weight /= base; value += weight * (index % base); index = Math.floor(index / base); } return value - 0.5; };
    jx = f(0.5 + f(halton(state.rendering.surface.frameSerial + 1, 2)));
    jy = f(0.5 + f(halton(state.rendering.surface.frameSerial + 1, 3)));
  }
  const px = f(f(f(f(x + jx) / state.width) * 2) - 1), py = f(f(f(f(y + jy) / state.height) * 2) - 1);
  const direction = frame.forward.map((value: number, i: number) => f(f(f(value) + f(f(frame.right[i]) * px)) - f(f(frame.up[i]) * py)));
  const length = Math.sqrt(direction.reduce((sum: number, value: number) => sum + value * value, 0));
  return { origin: frame.origin.map(f), direction: direction.map((value: number) => value / length) };
}
const half = (value: number) => THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(value));
const display = (value: number) => Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055));
function projected(frame: any, state: any, center: number[]) {
  const delta = center.map((value, i) => value - frame.origin[i]);
  const z = delta.reduce((sum, value, i) => sum + value * frame.forward[i], 0);
  const axis = (vector: number[]) => delta.reduce((sum, value, i) => sum + value * vector[i], 0) / (z * vector.reduce((sum, value) => sum + value * value, 0));
  return { x: Math.floor((0.5 + axis(frame.right) * 0.5) * state.width), y: Math.floor((0.5 - axis(frame.up) * 0.5) * state.height) };
}
async function screenshotSamples(page: Page, points: { x: number; y: number }[], file: string) {
  const image = await page.locator("canvas:visible").first().screenshot({ path: file });
  return page.evaluate(async ({ bytes, points }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0); bitmap.close();
    return points.map(point => Array.from(context.getImageData(point.x, point.y, 1, 1).data).slice(0, 3));
  }, { bytes: [...image], points });
}

/** One compact public vertex/material chain. No full image-quality or performance matrix. */
export async function runVertexGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/vertex");
  await mkdir(output, { recursive: true });
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  const browser = await chromium.launch(automationLaunchOptions());
  const report: Record<string, any> = { scope: "controlled GPU vertex and derived geometry bounded integration", formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen();
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => {
      const result = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Vertex game command");
      assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.data;
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    await command({ type: "step", count: 2 });
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(initial.rendering.vertex.meshes, 2);
    assert.ok(initial.rendering.vertex.bounds.every((value: any) => value.frustumCulled));
    report.adapter = initial.adapter;
    async function compareView(label: string, normal: boolean) {
      const state = await tap(normal ? "n" : "v");
      const frame = await page.evaluate(() => (window as any).__pelican.cameraDirection());
      const centers = state.rendering.vertex.bounds.map((entry: any) => ({ entity: entry.entity, ...projected(frame, state, entry.worldCenter) }));
      const values = await screenshotSamples(page, centers, path.join(output, label + ".png"));
      const results = [];
      for (let i = 0; i < centers.length; i++) {
        const point = centers[i], ray = pixelRay(state, frame, point.x, point.y);
        const hit = await page.evaluate(async ray => (window as any).__pelican.vertexRay(ray.origin, ray.direction), ray);
        assert.ok(hit && hit.distance > 0, JSON.stringify({ label, point, hit }));
        const expected = normal ? hit.normal.map((component: number) => display(half(half(component) * 0.5 + 0.5))) : [0, 1, 2].map(() => display(half(half(hit.distance) * 0.1)));
        assert.ok(values[i].every((value, channel) => Math.abs(value - expected[channel]) <= 3), JSON.stringify({ label, point, actual: values[i], expected, hit, ray }));
        let gpu: number[] | undefined;
        if (state.mode !== "raster") {
          gpu = await page.evaluate(async point => { const api = (window as any).__pelican, state = api.inspect(), guides = await api.guidePixels(); const at = (point.y * state.width + point.x) * 4; return Array.from(guides.normalDepth.slice(at, at + 4)) as number[]; }, point);
          assert.ok(Math.abs(gpu![3] - hit.distance) < 2e-4, JSON.stringify({ label, point, gpu, hit }));
          assert.ok(gpu!.slice(0, 3).every((value, j) => Math.abs(value - hit.normal[j]) < 2e-4), JSON.stringify({ label, point, gpu, hit }));
        }
        results.push({ entity: point.entity, point, actual: values[i], expected, hit, gpu });
      }
      return { tick: state.tick, results, vertex: state.rendering.vertex };
    }
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode });
      const depth = await compareView(mode + "-depth", false);
      const normal = await compareView(mode + "-normal", true);
      const snapshot = await command({ type: "snapshot" });
      const beforeTexture = (await command({ type: "inspect" })).rendering.vertex.bounds.find((item: any) => item.entity === "sphere").worldCenter[2];
      const textured = await tap("t");
      const afterTexture = textured.rendering.vertex.bounds.find((item: any) => item.entity === "sphere").worldCenter[2];
      assert.ok(afterTexture - beforeTexture > 0.43 && afterTexture - beforeTexture < 0.45);
      const textureDepth = await compareView(mode + "-texture-depth", false);
      await tap("o");
      const moved = await compareView(mode + "-moved", false);
      const miss = await page.evaluate(() => (window as any).__pelican.vertexRay([0, 0, 7], [0, 0, -1]));
      assert.equal(miss, null, "Render ray must not hit the original undeformed sphere location after movement.");
      const restored = await command({ type: "restore", snapshot });
      assert.ok(restored.rendering.vertex.bounds.every((value: any) => value.frustumCulled));
      await tap("x");
      const beauty = await screenshotSamples(page, [{ x: 160, y: 120 }], path.join(output, mode + "-beauty.png"));
      assert.ok(beauty[0][0] > 20, "An originally off-frustum mesh must remain visible through its derived bounds.");
      report.modes.push({ mode, depth, normal, textureDepth, moved, beforeTexture, afterTexture, beauty, restored: restored.rendering.vertex });
    }
    const beforeLoss = await command({ type: "inspect" });
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Vertex GPU reconstruction");
    assert.equal(recovered.tick, beforeLoss.tick);
    report.recovery = recovered.rendering.gpuRecovery;
    report.recovered = await compareView("recovered-depth", false);
    const fallback = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
      const page = await fallback.newPage();
      page.on("pageerror", error => report.errors.push(error.message));
      await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
      const result = await page.evaluate(async () => (window as any).__pelican.command({ type: "step", count: 2 }));
      assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(result.data.backend, "WebGLBackend");
      const view = await page.evaluate(async () => { const api = (window as any).__pelican; await api.command({ type: "input", key: "v", pressed: true }); return api.command({ type: "step", count: 1 }); });
      assert.equal(view.status, "succeeded", JSON.stringify(view));
      const frame = await page.evaluate(() => (window as any).__pelican.cameraDirection());
      const sphere = view.data.rendering.vertex.bounds.find((item: any) => item.entity === "sphere");
      const point = projected(frame, view.data, sphere.worldCenter), ray = pixelRay(view.data, frame, point.x, point.y);
      const hit = await page.evaluate(ray => (window as any).__pelican.vertexRay(ray.origin, ray.direction), ray);
      const actual = (await screenshotSamples(page, [point], path.join(output, "webgl2-depth.png")))[0];
      const expected = display(half(half(hit.distance) * 0.1));
      assert.ok(actual.every(value => Math.abs(value - expected) <= 3), JSON.stringify({ point, actual, expected, hit }));
      report.webgl2 = { point, actual, expected, hit };
    } finally { await fallback.close(); }
    assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { await browser.close(); await server.close(); await writeFile(path.join(output, "vertex-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(".pelican/vertex-game", String(Date.now()));
  runVertexGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed }))).catch(error => { console.error(error); process.exitCode = 1; });
}
