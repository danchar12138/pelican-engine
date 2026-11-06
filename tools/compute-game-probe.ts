import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

/** One small public-API integration, not the M3 image/performance matrix. */
export async function runComputeGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.join(root, "examples/compute");
  await mkdir(output, { recursive: true });
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  const browser = await chromium.launch(automationLaunchOptions());
  const report: Record<string, any> = { scope: "managed compute public game integration", formalMilestoneAccepted: false, passed: false, errors: [] };
  try {
    await server.listen();
    const target = new URL(server.resolvedUrls!.local[0]);
    target.search = "automation=1&width=640&height=360";
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Managed compute game command");
      assert.equal(response.status, "succeeded", JSON.stringify(response));
      return response.data;
    };
    const statistics = (state: any) => state.game.components.statistics.ComputeStatistics;
    const initial = await command({ type: "step", count: 2 });
    assert.equal(initial.backend, "WebGPUBackend");
    assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(statistics(initial).available, true);
    const snapshot = await command({ type: "snapshot" });
    await page.screenshot({ path: path.join(output, "feedback-initial.png") });
    await command({ type: "recordStart" });
    await command({ type: "input", key: "r", pressed: true });
    const reversed = await command({ type: "step", count: 5 });
    assert.ok(statistics(reversed).positionX < statistics(initial).positionX);
    await command({ type: "input", key: "r", pressed: false });
    const final = await command({ type: "step", count: 2 });
    const trace = await command({ type: "recordStop" });
    const replay = await command({ type: "replay", trace });
    assert.equal(replay.status, "passed");
    const replayed = await command({ type: "inspect" });
    assert.deepEqual(replayed.game, final.game);
    const restored = await command({ type: "restore", snapshot });
    assert.deepEqual(restored.game, initial.game);
    const moved = await command({ type: "step", count: 6 });
    assert.equal(moved.tick, 8);
    assert.ok(Math.abs(statistics(moved).positionX - (-1.5 + 7 * 0.6 / 60)) < 2e-6, JSON.stringify(statistics(moved)));
    await page.screenshot({ path: path.join(output, "feedback-moved.png") });
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 60000, "Managed compute device recovery");
    assert.deepEqual(recovered.game, moved.game);
    const continued = await command({ type: "step", count: 2 });
    assert.ok(statistics(continued).positionX > statistics(moved).positionX);
    await page.keyboard.down("r");
    await page.waitForFunction(previous => (window as any).__pelican.inspect().tick === previous + 1, continued.tick, { polling: 50, timeout: 10000 });
    const nativeDown = await command({ type: "inspect" });
    await page.keyboard.up("r");
    const nativeUp = await command({ type: "step", count: 1 });
    assert.ok(statistics(nativeUp).positionX < statistics(nativeDown).positionX, "Native paused input must settle its GPU tick before the next command.");
    report.nativeInput = { down: statistics(nativeDown), up: statistics(nativeUp), ticks: [nativeDown.tick, nativeUp.tick] };
    await command({ type: "mode", mode: "path" });
    const pixels = await page.evaluate(async () => (window as any).__pelican.accumulate(2));
    assert.equal(pixels.finite, true);
    assert.ok(pixels.nonBlack > 1000);
    await page.screenshot({ path: path.join(output, "feedback-path.png") });
    Object.assign(report, { backend: initial.backend, adapter: initial.adapter, initial: statistics(initial), reversed: statistics(reversed), final: statistics(final), replay: replay.status, restored: statistics(restored), continued: statistics(continued), recovery: recovered.rendering.gpuRecovery, pixels });

    // No synthetic compute fallback: the authored system observes WebGL2 and opts out.
    const fallback = await browser.newContext({ viewport: { width: 640, height: 360 } });
    try {
      await fallback.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
      const page = await fallback.newPage();
      await page.goto(target.href, { waitUntil: "domcontentloaded" });
      await waitForEngine(page);
      const result = await page.evaluate(async () => (window as any).__pelican.command({ type: "step", count: 2 }));
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(result.data.backend, "WebGLBackend");
      assert.equal(statistics(result.data).available, false);
      assert.equal(statistics(result.data).failure, "TC_RENDER_COMPUTE_UNAVAILABLE");
      report.webgl2 = { backend: result.data.backend, statistics: statistics(result.data) };
    } finally { await fallback.close(); }
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    await browser.close();
    await server.close();
    await writeFile(path.join(output, "compute-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(".pelican/compute-game", String(Date.now()));
  runComputeGameProbe(output).then(report => console.log(JSON.stringify({ output, passed: report.passed }))).catch(error => { console.error(error); process.exitCode = 1; });
}
