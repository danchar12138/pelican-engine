import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

export async function runPhysicsFirstRemovalProbe(output: string) {
  const root = fileURLToPath(new URL("../", import.meta.url)), project = path.join(root, "examples/physics-first-removal");
  await mkdir(output, { recursive: true }); const identity = await sourceFingerprint(root);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
  if (!compiled.success) await writeFile(path.join(output, "compile-failure.json"), JSON.stringify({ sourceIdentity: identity.sha256, diagnostics: compiled.diagnostics }, null, 2) + "\n");
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: Record<string, unknown> = { scope: "first-tick removal with immediate physics queries", sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, errors: [] };
  try {
    await server.listen(); browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]); target.search = "automation=1&width=320&height=240";
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const errors = report.errors as string[]; page.on("pageerror", error => errors.push(error.message)); page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    await page.goto(target.href, { waitUntil: "domcontentloaded" }); await waitForEngine(page);
    const command = async (input: unknown) => { const r = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "First physics removal command"); assert.equal(r.status, "succeeded", JSON.stringify(r)); return r.data; };
    const initial = await command({ type: "inspect" }); assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false); report.adapter = initial.adapter;
    const checkpoint = await command({ type: "snapshot" }); await command({ type: "recordStart" });
    const first = await command({ type: "step", count: 1 });
    assert.deepEqual(first.game.components.state.RemovalState, { initialHit: "removed", afterHit: "none", alive: false });
    assert.equal(first.tick, 1); assert.equal(first.game.transforms.removed, undefined); assert.ok(first.game.transforms.survivor);
    const later = await command({ type: "step", count: 4 }); assert.equal(later.tick, 5); assert.deepEqual(later.game.transforms.survivor.position, [1,0,0]);
    const trace = await command({ type: "recordStop" }); assert.equal((await command({ type: "replay", trace })).status, "passed");
    const restored = await command({ type: "restore", snapshot: checkpoint }); assert.equal(restored.tick, 0); assert.ok(restored.game.transforms.removed);
    const repeated = await command({ type: "step", count: 1 }); assert.deepEqual(repeated.game.components.state.RemovalState, first.game.components.state.RemovalState);
    await page.locator("canvas:visible").first().screenshot({ path: path.join(output, "first-removal.png") });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources.owned.entries, canvases: document.querySelectorAll("canvas").length }; });
    assert.deepEqual(teardown, { ready: false, resources: 0, canvases: 0 }); assert.deepEqual(errors, []);
    report.results = { first: first.game.components.state.RemovalState, ticks: [initial.tick, first.tick, later.tick, restored.tick, repeated.tick], survivor: later.game.transforms.survivor, replay: "passed", teardown }; report.passed = true; return report;
  } catch (error) { report.failure = String(error); throw error; }
  finally { try { await browser?.close(); } finally { await server.close(); } await writeFile(path.join(output, "physics-first-removal.json"), JSON.stringify(report, null, 2) + "\n"); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_PHYSICS_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output"), output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/physics-first-removal/" + Date.now());
  runPhysicsFirstRemovalProbe(output).then(r => console.log(JSON.stringify({ output, passed: r.passed, sourceIdentity: r.sourceIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
