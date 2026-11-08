import { graphicsLaunchArguments } from "./browser-session.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { decode } from "fast-png";
import { createHash } from "node:crypto";

const root = process.cwd(), index = process.argv.indexOf("--output");
const output = path.resolve(index >= 0 ? process.argv[index + 1] : `.pelican/quality-comparison-${Date.now()}`);
const budgetIndex = process.argv.indexOf("--budget-ms");
const budgetMs = Number(budgetIndex < 0 ? 400 : process.argv[budgetIndex + 1]);
if (!Number.isFinite(budgetMs) || budgetMs < 10 || budgetMs > 10000)
  throw new Error("TC_QUALITY_BUDGET: --budget-ms must be 10..10000.");
await mkdir(output, { recursive: true });
const child = spawn(process.execPath, ["--import", "tsx", "tools/cli.ts", "dev", "--project", "examples/quality-room", "--port", "43930"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", bytes => log += bytes); child.stderr.on("data", bytes => log += bytes);
const browser = await chromium.launch({ headless: true, channel: "chromium", args: graphicsLaunchArguments() });
const result: Record<string, unknown> = { scope: "Emissive-only Cornell-style scene: integrated path transport versus stock Three.js raster. Not a ceiling comparison against arbitrary Three.js extensions.", width: 480, height: 270, samples: [1, 32, 256], reference: "256-sample Pelican estimate, not independent ground truth" };
try {
  for (let i = 0; i < 150; i++) { try { await fetch("http://127.0.0.1:43930/", { signal: AbortSignal.timeout(500) }); break; } catch { if (child.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 100)); } }
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.goto("http://127.0.0.1:43930/?automation=1&width=480&height=270");
  await page.waitForFunction(() => document.documentElement.dataset.pelicanReady === "true", undefined, { timeout: 30000 });
  await page.addScriptTag({ content: "window.__name = value => value;" });
  const command = async (input: unknown) => { const response = await page.evaluate(input => (globalThis as any).__pelican.command(input), input); assert.equal(response.status, "succeeded", JSON.stringify(response)); return response.data; };
  const state = await command({ type: "inspect" });
  assert.equal(state.capabilities.backend, "webgpu"); assert.equal(state.adapter.isFallbackAdapter, false); result.adapter = state.adapter;
  result.scene = { assets: state.compiledIR.assets.length, inputSHA256: createHash("sha256").update(JSON.stringify(state.compiledIR)).digest("hex"), camera: state.compiledIR.scene.camera, exposure: 1, resolution: [480, 270] };
  const coldStarted = performance.now();
  await command({ type: "render", samples: 1, mode: "path", denoise: false });
  result.coldPipelineAndFrameMs = performance.now() - coldStarted;
  const files: Buffer[] = [], timings: unknown[] = [];
  for (const samples of [1, 32, 256]) {
    const start = Date.now(), rendered = await command({ type: "render", samples, mode: "path", denoise: false });
    assert.equal(rendered.render.samples, samples); timings.push({ samples, wallMs: Date.now() - start });
    const image = await page.screenshot({ path: path.join(output, `pelican-${samples}.png`) }); files.push(image);
  }
  const warm32 = timings[1] as { wallMs: number };
  const budgetSamples = Math.max(1, Math.min(256, Math.floor(budgetMs * 0.7 * 32 / Math.max(1, warm32.wallMs))));
  const budgetStart = performance.now();
  await command({ type: "render", samples: budgetSamples, mode: "path", denoise: false });
  const pelicanBudgetWallMs = performance.now() - budgetStart;
  const budgetImage = decode(await page.screenshot({ path: path.join(output, "pelican-budget.png") }));
  const threeURL = "/@fs/" + path.join(root, "node_modules/three/build/three.webgpu.js").replaceAll("\\", "/");
  await page.evaluate(async ({ ir, threeURL }) => {
    const THREE = await import(threeURL);
    for (const node of document.querySelectorAll("canvas,#status")) (node as HTMLElement).style.display = "none";
    const canvas = document.createElement("canvas"); document.body.appendChild(canvas);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(1); renderer.setSize(480, 270); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1; await renderer.init();
    const scene = new THREE.Scene(); scene.background = new THREE.Color(ir.scene.environment.background);
    const materials = new Map(ir.materials.map((material: any) => [material.id, new THREE.MeshStandardMaterial({ color: material.color, roughness: material.roughness, metalness: material.metalness,
      emissive: material.emissive ?? "#000000", emissiveIntensity: material.emissiveIntensity ?? 1 })]));
    for (const entity of ir.scene.entities) if (entity.mesh) {
      const g = entity.mesh.geometry;
      const geometry = g.kind === "box" ? new THREE.BoxGeometry(...g.size) : new THREE.SphereGeometry(g.radius, g.segments ?? 64, Math.max(8, Math.ceil((g.segments ?? 64) / 2)));
      const mesh = new THREE.Mesh(geometry, materials.get(entity.mesh.material)); mesh.position.fromArray(entity.transform.position); mesh.rotation.set(...entity.transform.rotation); mesh.scale.fromArray(entity.transform.scale); scene.add(mesh);
    }
    const c = ir.scene.camera, camera = new THREE.PerspectiveCamera(c.fov, 480 / 270, c.near, c.far); camera.position.fromArray(c.position); camera.lookAt(...c.target);
    await renderer.renderAsync(scene, camera); (globalThis as any).__qualityThree = { renderer, scene, materials, camera };
  }, { ir: state.compiledIR, threeURL });
  const threeBudget = await page.evaluate(async targetMs => {
    const { renderer, scene, camera } = (globalThis as any).__qualityThree;
    // Warm the actual Three pipeline separately; one static raster frame is the image, not one GI sample.
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const start = performance.now();
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - start;
    return { wallMs, withinBudget: wallMs <= targetMs, frames: 1, unusedBudgetMs: Math.max(0, targetMs - wallMs) };
  }, budgetMs);
  const raster = await page.screenshot({ path: path.join(output, "three-stock-raster.png") });
  const images = files.map(bytes => decode(bytes)), stock = decode(raster), reference = images[2];
  const metric = (image: ReturnType<typeof decode>) => {
    let error = 0, sum = 0, lit = 0, count = 0;
    for (let y = 100; y < 240; y++) for (let x = 70; x < 410; x++) {
      const p = (y * 480 + x) * image.channels, q = (y * 480 + x) * reference.channels;
      const luminance = (.2126 * image.data[p] + .7152 * image.data[p + 1] + .0722 * image.data[p + 2]) / 255;
      sum += luminance; if (luminance > .02) lit++;
      for (let axis = 0; axis < 3; axis++) error += ((image.data[p + axis] - reference.data[q + axis]) / 255) ** 2;
      count++;
    }
    return { meanLuminance: sum / count, illuminatedFraction: lit / count, mseToEngineReference: error / (count * 3), roi: { x: 70, y: 100, width: 340, height: 140 } };
  };
  result.timings = timings; result.stockThreeRaster = metric(stock); result.pelican = images.map((image, i) => ({ samples: [1, 32, 256][i], ...metric(image) }));
  result.equalBudget = {
    targetWallMs: budgetMs,
    pelican: { samples: budgetSamples, wallMs: pelicanBudgetWallMs, withinBudget: pelicanBudgetWallMs <= budgetMs, ...metric(budgetImage) },
    three: { ...threeBudget, ...metric(stock) },
    scope: "Same static asset-free input, camera, pixel dimensions, exposure and maximum warm wall-time budget; actual times and overruns are reported. Raster does not gain indirect light by repeating frames. Protocol overhead is included only for Pelican, screenshots are excluded for both. This emissive-only negative control is not a ceiling or equivalent-algorithm benchmark.",
  };
  assert.ok(metric(images[1]).meanLuminance > metric(stock).meanLuminance + .02, "Integrated path transport must illuminate non-emitting surfaces.");
  assert.ok(metric(images[1]).mseToEngineReference < metric(images[0]).mseToEngineReference, "Additional samples must improve this frozen scene estimate.");
  result.passed = true;
} catch (error) { result.passed = false; result.error = String(error); process.exitCode = 1; }
finally { await browser.close(); child.kill(); if (child.exitCode === null) await once(child, "exit"); await writeFile(path.join(output, "comparison.json"), JSON.stringify(result, null, 2) + "\n"); await writeFile(path.join(output, "server.log"), log); }
console.log(JSON.stringify(result));
