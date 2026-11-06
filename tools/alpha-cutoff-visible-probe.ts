import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = path.join(root, "examples/alpha-cutoff-visible-20261106");
const negative = process.argv.includes("--negative-control");
const i = process.argv.indexOf("--output");
if (!process.argv.includes("--exclusive-gpu") || i < 0 || !process.argv[i + 1]) throw new Error("Reserve GPU and provide --exclusive-gpu --output <new-directory>");
const output = path.resolve(process.argv[i + 1]);
await mkdir(output, { recursive: false }); // Never overwrite a previous run.
const report: any = { scope: "public game, constant-opacity blend alphaTest equality boundary", negativeControl: negative, negativeControlMeaning: negative ? "synthetic mutation: apply cutoff only to mask, not blend; not claimed to be the original revision" : null, formalMilestoneAccepted: false, passed: false, failures: [], errors: [], modes: [] };
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const identity = await sourceFingerprint(root); report.sourceIdentity = identity.sha256;
  await writeFile(path.join(output, "source.json"), JSON.stringify(identity, null, 2) + "\n");
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  report.compile = { success: compiled.success, diagnostics: compiled.diagnostics };
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  let mutations = 0;
  server = await createServer({ root, cacheDir: path.join(root, ".pelican/alpha-cutoff-vite-cache", negative ? "negative" : "fixed"), configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", plugins: negative ? [{ name: "synthetic-mask-only-cutoff", enforce: "pre", transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("/packages/renderer/src/surface-shader.ts")) return;
    const before = code;
    code = code.replace("material.factors.z>0.0&&alpha<=material.factors.z", "material.normal.w==1.0&&material.factors.z>0.0&&alpha<=material.factors.z").replace("material.factors.z>0.0&&result.alpha<=material.factors.z", "material.normal.w==1.0&&material.factors.z>0.0&&result.alpha<=material.factors.z");
    if (code === before) throw new Error("negative mutation not applied");
    mutations++; return { code, map: null };
  } }] : [], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); browser = await chromium.launch(automationLaunchOptions());
  report.browserVersion = browser.version();
  const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  page.on("pageerror", e => report.errors.push(e.message)); page.on("console", m => { if (m.type() === "error") report.errors.push(m.text()); });
  await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
  const command = async (input: unknown) => { const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "alpha game command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
  const initial = await command({ type: "inspect" }); report.adapter = initial.adapter; report.backend = initial.backend;
  assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
  for (const mode of ["raster", "path", "hybrid"]) {
    await command({ type: "mode", mode });
    if (mode !== "raster") await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(48)), 120000, "alpha accumulation");
    const state = await command({ type: "inspect" });
    const bytes = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, mode + ".png") });
    const samples = await page.evaluate(async bytes => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close(); return [73,131,189,247].map(x => { const rgb = [0,0,0]; const pixels = ctx.getImageData(x-3,117,7,7).data; for(let j=0;j<pixels.length;j+=4) for(let c=0;c<3;c++) rgb[c] += pixels[j+c]/49; return rgb; }); }, [...bytes]);
    const [below, above, noCutoff, back] = samples;
    const checks = { cutoffDiscard: below.every((v: number, c: number) => Math.abs(v-back[c]) < 25), aboveVisible: above[0] > back[0]+25 && above[1] > 20, noCutoffVisible: noCutoff[0] > back[0]+25 && noCutoff[1] > 20, backGreen: back[1] > 60 && back[1] > back[0]+40, controlAgreement: Math.abs(above[0]-noCutoff[0]) < 40 && Math.abs(above[1]-noCutoff[1]) < 40 };
    report.modes.push({ mode, samples, checks, surface: state.rendering.surface });
    for (const [name, passed] of Object.entries(checks)) if (!passed) report.failures.push(`${mode}:${name}`);
    if (mode !== "raster" && state.rendering.surface.triangleCount < 14) report.failures.push(`${mode}:surface-triangle-count`);
  }
  report.shaderMutations = mutations;
  if (negative && !mutations) report.failures.push("negative-control-not-injected");
  if (report.errors.length) report.failures.push("browser-errors");
  report.passed = report.failures.length === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); } finally { await server?.close(); }
  try {
    report.endSourceIdentity = (await sourceFingerprint(root)).sha256;
    if (report.endSourceIdentity !== report.sourceIdentity) {
      report.failures.push("source-changed-during-probe");
      report.passed = false; process.exitCode = 1;
    }
  } catch (e) {
    report.endFingerprintError = String(e);
    report.passed = false; process.exitCode = 1;
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, passed: report.passed, failure: report.failure, failures: report.failures, sourceIdentity: report.sourceIdentity, endSourceIdentity: report.endSourceIdentity }));
}
