import assert from "node:assert/strict";
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

/** One small hardware chain for explicit task versions, failure isolation and collection. */
export async function runComputeDependenciesGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/compute-dependencies");
  await mkdir(output, { recursive: true });
  const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "explicit compute dependency versions", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Compute dependency game command");
      assert.equal(response.status, "succeeded", JSON.stringify(response)); return response.data;
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const buffers = async () => {
      const snapshot = await command({ type: "snapshot" });
      return Object.fromEntries(snapshot.runtime.plugins["$engine.compute"].payload.buffers.map((b: any) => [b.id, b.data[0]]));
    };
    const close = (actual: number[], expected: number[]) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.000002, JSON.stringify({ actual, expected })));
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    report.adapter = initial.adapter;
    const initialSnapshot = await command({ type: "snapshot" });
    const first = await command({ type: "step", count: 1 }), values = await buffers();
    close(values.state, [-7, 0, 0]); close(values.branch, [-7.7, 0, 0]);
    close(values.snapshot, [-7.6, 0, 0]); close(values.final, [-7.7, 0, 0.25]);
    assert.equal(first.game.components.stats.DependencyStats.releaseError, "TC_COMPUTE_TASK_IN_USE");
    assert.equal(first.rendering.computeGpu.commits, 5);
    assert.equal(first.rendering.computeGpu.uploads, 2, "Only initial render checkpoint and captured source upload.");
    assert.equal(first.rendering.bufferBindings.cpuResultUploads, 0);
    const late = await command({ type: "step", count: 1 }), lateValues = await buffers();
    close(lateValues.branch, [-7.4, 0, 0]);
    assert.equal(late.rendering.computeGpu.uploads, first.rendering.computeGpu.uploads, "Old task result remains resident across flush and newer writes.");
    assert.equal(late.rendering.computeGpu.commits, 6);
    assert.ok(late.rendering.computeGpu.committedVersions > 4);
    // One depth pixel ties the dependency result to the rendered geometry.
    const point = { x: 172, y: 120 };
    const screenshot = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, "dependency-render.png") });
    const actual = await page.evaluate(async ({ bytes, point }) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0); image.close(); return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data).slice(0, 3);
    }, { bytes: [...screenshot], point });
    const radial = await page.evaluate(point => {
      const api = (window as any).__pelican, state = api.inspect(), frame = api.cameraDirection();
      const x = (point.x + 0.5) / state.width * 2 - 1, y = (point.y + 0.5) / state.height * 2 - 1;
      const d = frame.forward.map((v: number, i: number) => v + frame.right[i] * x - frame.up[i] * y), length = Math.hypot(...d);
      return api.vertexRay(frame.origin, d.map((v: number) => v / length))?.distance;
    }, point);
    assert.ok(Number.isFinite(radial));
    const linear = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(radial)) * 0.1));
    const expected = Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055));
    assert.ok(actual.every(v => Math.abs(v - expected) <= 3), JSON.stringify({ actual, expected, radial }));
    report.chain = { values, lateValues, firstGpu: first.rendering.computeGpu, lateGpu: late.rendering.computeGpu, pixel: { actual, expected, radial }, releaseError: first.game.components.stats.DependencyStats.releaseError };
    const failed = await tap("f"), failedObserved = await command({ type: "step", count: 1 });
    assert.equal(failed.rendering.computeGpu.commits, late.rendering.computeGpu.commits + 1, "Only independent task commits.");
    assert.equal(failed.rendering.bufferBindings.gpuCopies, late.rendering.bufferBindings.gpuCopies);
    assert.match(failedObserved.game.components.stats.DependencyStats.taskErrors, /TC_COMPUTE_BOUNDS/);
    assert.match(failedObserved.game.components.stats.DependencyStats.taskErrors, /TC_COMPUTE_DEPENDENCY_/);
    const cancelled = await tap("c"), cancelledObserved = await command({ type: "step", count: 1 });
    assert.equal(cancelled.rendering.computeGpu.commits, failed.rendering.computeGpu.commits + 1);
    assert.equal(cancelled.rendering.bufferBindings.gpuCopies, late.rendering.bufferBindings.gpuCopies);
    close((await buffers()).final, values.final);
    report.failureIsolation = { failed: failedObserved.game.components.stats.DependencyStats.taskErrors, cancelled: cancelledObserved.game.components.stats.DependencyStats.taskErrors, commits: [late.rendering.computeGpu.commits, failed.rendering.computeGpu.commits, cancelled.rendering.computeGpu.commits] };
    const released = await tap("r");
    assert.equal(released.rendering.compute.tasks, 0);
    assert.equal(released.rendering.computeGpu.committedVersions, 4);
    assert.ok(released.rendering.computeGpu.liveBuffers < cancelled.rendering.computeGpu.liveBuffers);
    report.collection = { retained: cancelled.rendering.computeGpu, released: released.rendering.computeGpu };
    const restored = await command({ type: "restore", snapshot: initialSnapshot });
    assert.equal(restored.rendering.compute.tasks, 0);
    const restarted = await command({ type: "step", count: 2 });
    close((await buffers()).final, values.final);
    await tap("r");
    await command({ type: "recordStart" }); await command({ type: "step", count: 1 });
    const trace = await command({ type: "recordStop" });
    assert.equal((await command({ type: "replay", trace })).status, "passed");
    report.restoreReplay = { rebuiltCommits: restarted.rendering.computeGpu.commits, replay: "passed" };
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const teardown = await page.evaluate(() => { const state = (window as any).__pelican.inspect(); return { ready: state.ready, resources: state.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 });
    report.teardown = teardown; assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    try { await browser?.close(); } finally { await server.close(); }
    await writeFile(path.join(output, "compute-dependencies-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_COMPUTE_PROBE: Pass --exclusive-gpu after reserving the GPU.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/compute-dependencies-game/" + Date.now());
  runComputeDependenciesGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed, sourceIdentity: report.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
