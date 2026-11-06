import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

export async function runSpecularGameProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/specular-material");
  await mkdir(output, { recursive: true }); const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  if (!compiled.success) await writeFile(path.join(output, "compile-failure.json"), JSON.stringify({ sourceIdentity: identity.sha256, diagnostics: compiled.diagnostics }, null, 2) + "\n");
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, any> = { scope: "opaque dielectric specular color and strength in public game", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [], modes: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    page.on("pageerror", error => report.errors.push(error.message)); page.on("console", msg => { if (msg.type() === "error") report.errors.push(msg.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => { const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "Specular game command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
    const initial = await command({ type: "inspect" }); assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false); report.adapter = initial.adapter;
    for (const mode of ["raster", "path", "hybrid"]) {
      await command({ type: "mode", mode });
      if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(16)), 45000, "Specular path accumulation");
      const state = await command({ type: "inspect" });
      const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, mode + ".png") });
      const samples = await page.evaluate(async bytes => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!; ctx.drawImage(image,0,0); image.close(); return [73,131,189,247].map(x => { const rgb = [0,0,0]; const pixels = ctx.getImageData(x-3,117,7,7).data; for(let i=0;i<pixels.length;i+=4) for(let c=0;c<3;c++) rgb[c] += pixels[i+c]/49; return rgb; }); }, [...bytes]);
      const [imported, dark, green, red] = samples;
      assert.ok(imported[0] > 20 && imported[0] > imported[1] + 12 && imported[0] > imported[2] + 12, JSON.stringify({ mode, samples }));
      assert.ok(red[0] > 20 && red[0] > red[1] + 12 && red[0] > red[2] + 12, JSON.stringify({ mode, samples }));
      assert.ok(green[1] > 20 && green[1] > green[0] + 12 && green[1] > green[2] + 12, JSON.stringify({ mode, samples }));
      assert.ok(dark.every(v => v < 5), JSON.stringify({ mode, samples }));
      assert.ok(Math.abs(imported[0] - red[0]) < 10, JSON.stringify({ mode, samples }));
      if (mode !== "raster") assert.ok(state.rendering.surface.triangleCount >= 8);
      report.modes.push({ mode, samples, surface: state.rendering.surface });
    }
    assert.deepEqual(report.errors, []); report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { try { await browser?.close(); } finally { await server.close(); } await writeFile(path.join(output, "specular-game.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_GRAPH_PROBE: Reserve GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/specular/" + Date.now());
  runSpecularGameProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
