import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "fast-png";
import { chromium } from "playwright";
import { createServer } from "vite";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

type State = { mode: string; tick: number; backend: string; adapter: { isFallbackAdapter: boolean }; objects: { camera: number[] }; runtime: { records: { id: string; prefab?: string; transform: unknown }[] }; game: { components: Record<string, Record<string, any>> }; gameplay: { models: { instances: number; templates: { id: string; animations: string[] }[] } } };
type Image = { width: number; height: number; data: ArrayLike<number>; channels: number; depth: number };
const record = (s: State, id: string) => s.runtime.records.find(r => r.id === id);
const control = (s: State) => s.game.components.control.TemporalState;

// Public-game checks are independent from milestone acceptance.

export function assertDynamicTransition(kind: string, before: State, after: State) {
  assert.equal(after.mode, before.mode);
  assert.ok(after.tick > before.tick, `${kind}: tick did not advance`);
  switch (kind) {
    case "object": assert.notDeepEqual(record(after, "subject")?.transform, record(before, "subject")?.transform); break;
    case "camera": assert.notDeepEqual(after.objects.camera, before.objects.camera); break;
    case "animation":
      assert.equal(control(before).skin, false); assert.equal(control(after).skin, true);
      assert.ok(after.gameplay.models.instances > 0);
      assert.ok(after.gameplay.models.templates.some(t => t.id === "fox" && t.animations.includes("Run")));
      break;
    case "destroy": assert.ok(record(before, "blocker")); assert.equal(record(after, "blocker"), undefined); break;
    case "spawn": assert.equal(record(before, "blocker"), undefined); assert.equal(record(after, "blocker")?.prefab, "screen-panel"); break;
    case "material": assert.equal(record(before, "subject")?.prefab, "subject-blue"); assert.equal(record(after, "subject")?.prefab, "subject-pink"); break;
    case "light": assert.notDeepEqual(record(before, "sun")?.transform, record(after, "sun")?.transform); break;
    default: throw new Error(`Unknown transition: ${kind}`);
  }
}

export function measureDynamicImages(before: Image, after: Image) {
  assert.equal(before.width, after.width); assert.equal(before.height, after.height);
  assert.equal(before.depth, 8); assert.equal(after.depth, 8);
  assert.ok(before.channels >= 3 && after.channels >= 3);
  let sum = 0, changed = 0;
  for (let i = 0; i < before.width * before.height; i++) {
    let delta = 0;
    for (let c = 0; c < 3; c++) delta += Math.abs(before.data[i * before.channels + c]! - after.data[i * after.channels + c]!);
    sum += delta; if (delta >= 24) changed++;
  }
  return { meanRgbDifference: sum / (before.width * before.height * 3), changedFraction: changed / (before.width * before.height) };
}

export function compareDynamicImages(before: Image, after: Image) {
  const result = measureDynamicImages(before, after);
  assert.ok(result.meanRgbDifference >= 0.5 && result.changedFraction >= 0.005, JSON.stringify(result));
  return result;
}

export function compareAnimationImages(reference: Image, before: Image, after: Image) {
  const crop = (image: Image): Image => {
    assert.equal(image.width, 320); assert.equal(image.height, 240);
    const x0 = 160, y0 = 48, width = 160, height = 172;
    const data = new Uint8Array(width * height * image.channels);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < image.channels; c++)
      data[(y * width + x) * image.channels + c] = image.data[((y + y0) * image.width + x + x0) * image.channels + c]!;
    return { width, height, channels: image.channels, depth: image.depth, data };
  };
  const check = (a: Image, b: Image, c: Image) => {
    const noise = measureDynamicImages(a, b);
    const signal = compareDynamicImages(b, c);
    assert.ok(signal.meanRgbDifference > 2 * noise.meanRgbDifference, JSON.stringify({ noise, signal }));
    assert.ok(signal.changedFraction > 2 * noise.changedFraction, JSON.stringify({ noise, signal }));
    return { noise, signal };
  };
  return { whole: check(reference, before, after), foxRegion: check(crop(reference), crop(before), crop(after)) };
}

export function assertAnimationSnapshots(before: any, after: any) {
  const action = (snapshot: any) => snapshot.runtime?.plugins?.["$engine.models"]?.payload?.animation?.animations
    ?.find((entry: any) => entry.entity === "animated" && entry.currentClip === "Run")?.actions
    ?.find((entry: any) => entry.clip === "Run");
  const a = action(before), b = action(after);
  assert.ok(a && b, "Missing animated Run snapshot");
  assert.equal(a.speed, 0); assert.equal(b.speed, 1);
  assert.ok(Number.isFinite(a.time) && Number.isFinite(b.time) && Math.abs(a.time - b.time) > 1e-5, "Animation time did not change");
}

async function runSequence(page: import("playwright").Page, target: URL, command: (input: unknown) => Promise<any>, output: string, report: any) {
  const capture = async (mode: string, label: string) => {
    if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(32)), 60000, "dynamic game accumulation");
    const state: State = await command({ type: "inspect" });
    assert.equal(state.mode, mode); assert.equal(state.backend, "WebGPUBackend"); assert.equal(state.adapter.isFallbackAdapter, false);
    const name = `${mode}-${label}`;
    const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, name + ".png") });
    await writeFile(path.join(output, name + ".json"), JSON.stringify(state, null, 2));
    const snapshot = label.startsWith("animation-") ? await command({ type: "snapshot" }) : undefined;
    if (snapshot) await writeFile(path.join(output, name + "-snapshot.json"), JSON.stringify(snapshot, null, 2));
    return { state, image: decode(bytes), snapshot };
  };
  for (const mode of ["raster", "path", "hybrid"]) {
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    await command({ type: "mode", mode }); await command({ type: "step", count: 1 });
    for (const [kind, key, ticks] of [["object", "o", 20], ["camera", "c", 30], ["animation", "a", 30], ["destroy", "b", 1], ["spawn", "b", 1], ["material", "m", 1], ["light", "l", 1]] as const) {
      await command({ type: "input", key: "f", pressed: true }); await command({ type: "input", key: "f", pressed: false }); await command({ type: "step", count: 1 });
      const reference = kind === "animation" ? await capture(mode, "animation-static") : undefined;
      const before = await capture(mode, kind + "-before");
      await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); await command({ type: "step", count: ticks });
      const after = await capture(mode, kind + "-after");
      assertDynamicTransition(kind, before.state, after.state);
      let pixels: unknown;
      if (reference) {
        assert.equal(reference.state.tick, before.state.tick);
        assert.deepEqual(reference.state.objects.camera, before.state.objects.camera);
        assert.deepEqual(before.state.objects.camera, after.state.objects.camera);
        const geometry = (state: State) => state.runtime.records.map(({ id, prefab, transform }) => ({ id, prefab, transform }));
        assert.deepEqual(geometry(before.state), geometry(after.state));
        assertAnimationSnapshots(before.snapshot, after.snapshot);
        pixels = compareAnimationImages(reference.image, before.image, after.image);
      } else pixels = compareDynamicImages(before.image, after.image);
      report.cases.push({ mode, kind, beforeTick: before.state.tick, afterTick: after.state.tick, pixels, before: `${mode}-${kind}-before`, after: `${mode}-${kind}-after` });
      await writeFile(path.join(output, "dynamic-sdk-game.json"), JSON.stringify(report, null, 2));
    }
  }
}

async function runCases(browser: Awaited<ReturnType<typeof chromium.launch>>, target: URL, output: string, report: any) {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") report.errors.push(m.text()); });
  target.searchParams.set("automation", "1"); target.searchParams.set("width", "320"); target.searchParams.set("height", "240");
  const command = async (input: unknown) => {
    const r = await withAutomationDeadline(() => page.evaluate(async v => (window as any).__pelican.command(v), input), 30000, "dynamic game command");
    assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data;
  };
  await runSequence(page, target, command, output, report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("Reserve the GPU and pass --exclusive-gpu.");
  const index = process.argv.indexOf("--output");
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1]!.startsWith("--"))) throw new Error("--output requires a directory");
  const output = path.resolve(index >= 0 ? process.argv[index + 1]! : `.pelican/dynamic-sdk/${Date.now()}`);
  runDynamicSdkGameProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(e => { console.error(e); process.exitCode = 1; });
}

export async function runDynamicSdkGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.join(root, "examples/m3-dynamic-sdk");
  await mkdir(output, { recursive: true });
  const report: any = { formalMilestoneAccepted: false, passed: false, sourceIdentity: null, cases: [], errors: [], failure: null };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    report.sourceIdentity = (await sourceFingerprint(root)).sha256;
    const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    browser = await chromium.launch(automationLaunchOptions());
    await runCases(browser, new URL(server.resolvedUrls!.local[0]), output, report);
    assert.deepEqual(report.errors, []);
    assert.equal((await sourceFingerprint(root)).sha256, report.sourceIdentity, "Source changed during dynamic game probe");
    report.passed = true;
  } catch (error) { report.failure = String(error); throw error; }
  finally { await browser?.close(); await server?.close(); await writeFile(path.join(output, "dynamic-sdk-game.json"), JSON.stringify(report, null, 2)); }
  return report;
}
