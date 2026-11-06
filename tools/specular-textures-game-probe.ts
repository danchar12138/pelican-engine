import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

export const SPECULAR_TEXTURE_LIFECYCLE_OPERATIONS = [
  { id: "initial-raster", operation: "inspect in initial raster mode", expected: "capabilities.tracer contains lazy initialization and tracerInitialized=false" },
  { id: "path-activation", operation: "switch to path and inspect", expected: "capabilities.tracerInitialized=true" },
  { id: "three-mode-pixels", operation: "render raster, path, and hybrid", expected: "all five pixel probes pass and model/resource observations remain live" },
  { id: "snapshot-restore", operation: "snapshot, step once, restore snapshot", expected: "tick returns to the snapshot tick and resources remain loaded" },
  { id: "invalid-restore", operation: "restore a malformed snapshot", expected: "public command fails and tick/resources remain unchanged" },
  { id: "device-recovery", operation: "exerciseDeviceLoss", expected: "a new recovery event is recorded and runtime records/mode/tick survive" },
] as const;

export function checkTraceCapabilities(capabilities: any, expectedInitialized: boolean) {
  assert.equal(capabilities.tracerInitialized, expectedInitialized, JSON.stringify(capabilities));
  if (!expectedInitialized) assert.match(capabilities.tracer, /lazy initialization/i);
}

export function checkSpecularObservation(result: any) {
  const { mode, samples: { gray, zeroAlphaRed, red, green, grayReference }, surface, models, resources, capabilities } = result;
  const diagnostic = JSON.stringify(result);
  assert.ok(zeroAlphaRed.every((v: number) => v < 5), `alpha=0 must suppress red: ${diagnostic}`);
  assert.ok(red[0] > 20 && red[0] > red[1] + 12 && red[0] > red[2] + 12, `alpha=1 red: ${diagnostic}`);
  assert.ok(green[1] > 20 && green[1] > green[0] + 12 && green[1] > green[2] + 12, `green RGB: ${diagnostic}`);
  assert.ok(grayReference.every((v: number) => v > 5) && gray.every((v: number, c: number) => Math.abs(v - grayReference[c]) < 10), `sRGB 128 must match symmetric SDK #808080: ${diagnostic}`);
  assert.equal(models.disposed, false, diagnostic);
  assert.ok(models.instances >= 1 && models.owned.textures >= 1, `model and textures must remain owned: ${diagnostic}`);
  assert.equal(resources.disposed, false, diagnostic);
  assert.ok(resources.owned.loaded >= 1, `content resources must remain loaded: ${diagnostic}`);
  if (mode !== "raster") {
    assert.ok(surface.triangleCount >= 4, diagnostic);
    assert.ok(surface.capture.textures.entries >= 2 && surface.capture.textures.texels > 0, `tracer texture capture: ${diagnostic}`);
    assert.equal(capabilities.tracerInitialized, true, `path tracer must be initialized: ${diagnostic}`);
  }
}

export async function runSpecularTexturesGameProbe(output: string, compileOnly = false, projectDirectory = "examples/specular-textures") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.resolve(root, projectDirectory);
  await mkdir(output, { recursive: true });
  const report: Record<string, any> = { scope: "KHR_materials_specular texture game probe", passed: false, compileOnly, operations: SPECULAR_TEXTURE_LIFECYCLE_OPERATIONS, modes: [], errors: [], phase: "fingerprint" };
  let server: Awaited<ReturnType<typeof import("vite").createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>> | undefined;
  try {
    report.sourceIdentity = (await sourceFingerprint(root)).sha256;
    report.phase = "compile";
    const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
    report.diagnostics = compiled.diagnostics;
    assert.equal(compiled.success, true, `Compilation failed: ${JSON.stringify(compiled.diagnostics)}`);
    if (compileOnly) { report.phase = "compile-complete"; return report; }
    report.phase = "launch";
    const [{ createServer }, { chromium }, { automationLaunchOptions, waitForEngine, withAutomationDeadline }] = await Promise.all([
      import("vite"), import("playwright"), import("./browser-session.ts")
    ]);
    server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", msg => { if (msg.type() === "error") report.errors.push(msg.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const rawCommand = async (input: unknown) => {
      const result = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Specular texture command");
      return result;
    };
    const command = async (input: unknown) => {
      const result = await rawCommand(input);
      assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.data;
    };
    const initial = await command({ type: "inspect" });
    report.adapter = initial.adapter;
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    report.lifecycle = { initialRasterCapabilities: initial.capabilities };
    assert.equal(initial.mode, "raster");
    checkTraceCapabilities(initial.capabilities, false);
    await command({ type: "mode", mode: "path" });
    const activated = await command({ type: "inspect" });
    report.lifecycle.activatedPathCapabilities = activated.capabilities;
    assert.equal(activated.mode, "path");
    checkTraceCapabilities(activated.capabilities, true);
    await command({ type: "pause" });
    const baseline = await command({ type: "inspect" });
    const observation = (state: any) => ({ tick: state.tick, mode: state.mode, records: state.runtime.records });
    const observeModes = async (stage: string) => {
    for (const mode of ["raster", "path", "hybrid"]) {
      report.phase = `${stage}/${mode}`;
      await command({ type: "mode", mode });
      if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(16)), 45000, "Specular texture accumulation");
      const state = await command({ type: "inspect" });
      assert.equal(state.mode, mode, `actual render mode before ${stage} screenshot`);
      assert.equal(state.tick, baseline.tick, `tick before ${stage} screenshot`);
      assert.deepEqual(state.runtime.records, baseline.runtime.records, `runtime before ${stage} screenshot`);
      const screenshot = `${stage}-${mode}.png`;
      const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, screenshot) });
      const afterCapture = await command({ type: "inspect" });
      assert.deepEqual(observation(afterCapture), observation(state), `state changed during ${stage}/${mode} screenshot`);
      const samples = await page.evaluate(async data => {
        const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
        const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0); image.close();
        return [73,109,146,182,247].map(x => {
          const rgb = [0,0,0], pixels = ctx.getImageData(x-3,117,7,7).data;
          for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) rgb[c] += pixels[i+c] / 49;
          return rgb;
        });
      }, [...bytes]);
      const [gray, zeroAlphaRed, red, green, grayReference] = samples;
      const result = { stage, mode, screenshot, observation: { before: observation(state), after: observation(afterCapture) }, samples: { gray, zeroAlphaRed, red, green, grayReference }, surface: state.rendering.surface, models: state.gameplay?.models, resources: state.resources, capabilities: state.capabilities };
      report.modes.push(result);
      checkSpecularObservation(result);
    }
    };
    await observeModes("initial");
    report.phase = "snapshot";
    const beforeSnapshot = await command({ type: "inspect" });
    const saved = await command({ type: "snapshot" });
    assert.equal(saved.tick, beforeSnapshot.tick);
    report.lifecycle.snapshot = { tick: saved.tick, mode: beforeSnapshot.mode, records: beforeSnapshot.runtime.records, resources: saved.resources };
    const stepped = await command({ type: "step", count: 1 });
    report.lifecycle.steppedTick = stepped.tick;
    assert.equal(stepped.tick, saved.tick + 1, "step must advance before restore");
    report.phase = "restore";
    const restored = await command({ type: "restore", snapshot: saved });
    report.lifecycle.restore = { tick: restored.tick, mode: restored.mode, records: restored.runtime.records, resources: restored.resources };
    assert.equal(restored.tick, saved.tick, "restore must rewind the tick");
    assert.equal(restored.mode, beforeSnapshot.mode, "restore must retain the snapshot mode");
    assert.deepEqual(restored.runtime.records, beforeSnapshot.runtime.records, "restore must recover runtime records");
    await observeModes("restored");
    report.phase = "invalid-restore";
    const beforeRejection = await command({ type: "inspect" });
    const malformed = structuredClone(saved); malformed.version = -1;
    const rejected = await rawCommand({ type: "restore", snapshot: malformed });
    report.lifecycle.invalidRestore = rejected;
    assert.equal(rejected.status, "failed", `invalid checkpoint must be rejected: ${JSON.stringify(rejected)}`);
    const afterRejection = await command({ type: "inspect" });
    report.lifecycle.beforeRejection = observation(beforeRejection);
    report.lifecycle.afterRejection = { ...observation(afterRejection), resources: afterRejection.resources };
    assert.equal(afterRejection.tick, saved.tick, "rejected restore must not change tick");
    assert.deepEqual(observation(afterRejection), observation(beforeRejection), "rejected restore must not change runtime state");
    await observeModes("rejected");
    report.phase = "device-recovery";
    const before = await command({ type: "inspect" });
    report.lifecycle.beforeRecovery = { tick: before.tick, mode: before.mode, records: before.runtime.records, recovery: before.rendering.gpuRecovery, resources: before.resources };
    const recovered = await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.exerciseDeviceLoss()), 90000, "Specular texture device recovery");
    report.lifecycle.recovery = { tick: recovered.tick, mode: recovered.mode, records: recovered.runtime.records, recovery: recovered.rendering.gpuRecovery, resources: recovered.resources };
    assert.equal(recovered.tick, before.tick);
    assert.equal(recovered.mode, before.mode);
    assert.deepEqual(recovered.runtime.records, before.runtime.records);
    assert.equal(recovered.rendering.gpuRecovery.count, before.rendering.gpuRecovery.count + 1);
    await waitForEngine(page);
    await observeModes("recovered");
    assert.deepEqual(report.errors, []); report.phase = "complete"; report.passed = true; return report;
  } catch (error) { report.failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
  finally {
    try { await browser?.close(); } finally { await server?.close(); }
    await writeFile(path.join(output, "specular-textures-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const compileOnly = process.argv.includes("--compile-only");
  if (!compileOnly && !process.argv.includes("--exclusive-gpu")) throw new Error("Reserve GPU and pass --exclusive-gpu, or use --compile-only.");
  const i = process.argv.indexOf("--output");
  if (i >= 0 && (!process.argv[i+1] || process.argv[i+1].startsWith("--"))) throw new Error("--output requires a path");
  const projectIndex = process.argv.indexOf("--project");
  if (projectIndex >= 0 && (!process.argv[projectIndex+1] || process.argv[projectIndex+1].startsWith("--"))) throw new Error("--project requires a path");
  const output = path.resolve(i >= 0 ? process.argv[i+1] : `examples/specular-textures/.pelican/probe/${Date.now()}`);
  runSpecularTexturesGameProbe(output, compileOnly, projectIndex < 0 ? undefined : process.argv[projectIndex+1]).then(r => console.log(JSON.stringify({ output, passed: r.passed, phase: r.phase }))).catch(error => { console.error(error); process.exitCode = 1; });
}
