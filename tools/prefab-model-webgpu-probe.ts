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

const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/prefab-model-probe");
const output = path.join(root, ".pelican", `prefab-model-webgpu-${Date.now()}`);
await mkdir(output, { recursive: false });
const report: any = { output, sourceIdentity: null, modes: {}, errors: [], passed: false };
let browser: any, server: any;
try {
  report.sourceIdentity = (await sourceFingerprint(root)).sha256;
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  server = await createServer({ root, cacheDir: path.join(root, ".pelican/prefab-model-vite-cache"), configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  await server.listen();
  browser = await chromium.launch(automationLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  page.on("pageerror", (e: Error) => report.errors.push(e.message));
  page.on("console", (m: any) => { if (m.type() === "error") report.errors.push(m.text()); });
  const url = new URL(server.resolvedUrls.local[0]);
  url.searchParams.set("automation", "1"); url.searchParams.set("width", "320"); url.searchParams.set("height", "240");
  const command = async (v: unknown) => { const r: any = await withAutomationDeadline(() => page.evaluate(async (x: any) => (window as any).__pelican.command(x), v), 30000, "probe command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
  for (const mode of ["raster", "path", "hybrid"]) {
    const result: any = report.modes[mode] = { captures: {}, failure: null };
    try {
      await page.goto(url.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
      await command({ type: "mode", mode }); await command({ type: "step", count: 1 });
      const capture = async (label: string, expected: string) => {
        if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(32)), 60000, "accumulate");
        const state = await command({ type: "inspect" });
        await writeFile(path.join(output, `${mode}-${label}.json`), JSON.stringify(state, null, 2));
        const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, `${mode}-${label}.png`) });
        const image = decode(bytes); let red = 0, green = 0, count = 0;
        for (let y = 48; y < 192; y++) for (let x = 48; x < 272; x++) { const i = (y * image.width + x) * image.channels; const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!; if (r > g * 1.15 && r > b * 1.15 && r > 35) red++; if (g > r * 1.15 && g > b * 1.15 && g > 35) green++; count++; }
        const subject = state.runtime.records.filter((r: any) => r.id === "subject");
        result.captures[label] = { red, green, count, subject, adapter: state.adapter, backend: state.backend, mode: state.mode, instances: state.gameplay.models.instances };
        await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        assert.equal(state.mode, mode); assert.equal(state.backend, "WebGPUBackend"); assert.equal(state.adapter.isFallbackAdapter, false);
        assert.equal(subject.length, 1); assert.equal(subject[0].prefab, expected); assert.ok(state.gameplay.models.instances > 0);
        if (expected === "model-a") assert.ok(red > 100 && red > green * 2, JSON.stringify({ red, green }));
        else assert.ok(green > 100 && green > red * 2, JSON.stringify({ red, green }));
      };
      await capture("a", "model-a"); const a = await command({ type: "snapshot" }); await writeFile(path.join(output, `${mode}-snapshot-a.json`), JSON.stringify(a, null, 2));
      await command({ type: "input", key: "m", pressed: true }); await command({ type: "input", key: "m", pressed: false }); await command({ type: "step", count: 1 });
      await capture("b", "model-b"); const b = await command({ type: "snapshot" }); await writeFile(path.join(output, `${mode}-snapshot-b.json`), JSON.stringify(b, null, 2));
      await command({ type: "restore", snapshot: a }); await capture("restore-a", "model-a");
      await command({ type: "restore", snapshot: b }); await capture("restore-b", "model-b");
    } catch (e) { result.failure = String(e); }
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  }
  report.endSourceIdentity = (await sourceFingerprint(root)).sha256;
  report.passed = Object.keys(report.modes).length === 3 && Object.values(report.modes).every((m: any) => !m.failure) && report.errors.length === 0 && report.endSourceIdentity === report.sourceIdentity;
} catch (e) { report.failure = String(e); }
finally { await browser?.close(); await server?.close(); await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
