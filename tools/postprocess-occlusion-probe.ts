import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const size = { width: 320, height: 240 };
const gameSource = `import { defineGame, defineMaterial, definePostProcess, defineScene, defineSystem } from "pelican-engine";
const near = defineMaterial({ id: "near-green", color: "#000000", emissive: "#00ff00", emissiveIntensity: 1, roughness: 1 });
const far = defineMaterial({ id: "far-red", color: "#000000", emissive: "#ff0000", emissiveIntensity: 1, roughness: 1 });
const identity = definePostProcess({ id: "identity", graph: { nodes: [
  { id: "uv", op: "input", name: "uv" },
  { id: "out", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] },
], output: "out" } });
const distance = definePostProcess({ id: "distance", enabled: false, graph: {
  parameters: [{ name: "reference", type: "float", default: 0 }],
  nodes: [
    { id: "uv", op: "input", name: "uv" },
    { id: "depth", op: "sampleFrame", channel: "scene.depth", inputs: ["uv"] },
    { id: "measured", op: "swizzle", components: "r", inputs: ["depth"] },
    { id: "reference", op: "parameter", name: "reference" },
    { id: "zero", op: "float", value: 0 },
    { id: "useMeasured", op: "equal", inputs: ["reference", "zero"] },
    { id: "value", op: "select", inputs: ["reference", "measured", "useMeasured"] },
    { id: "scale", op: "float", value: 0.1 },
    { id: "gray", op: "multiply", inputs: ["value", "scale"] },
    { id: "one", op: "float", value: 1 },
    { id: "out", op: "compose4", inputs: ["gray", "gray", "gray", "one"] },
  ], output: "out",
} });
const controls = defineSystem({ id: "views", phase: "input", run(engine) {
  for (const event of engine.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    if (input.key === "0" || input.key === "1" || input.key === "z") {
      engine.render.effects.configure("identity", { enabled: input.key === "1" });
      engine.render.effects.configure("distance", { enabled: input.key === "z" });
      engine.render.effects.setParameter("distance", "reference", 0);
    }
    if (input.key === "3") engine.render.effects.setParameter("distance", "reference", 3.5);
    if (input.key === "4") engine.render.effects.setParameter("distance", "reference", 4.5);
  }
} });
export default defineGame({ id: "postprocess-occlusion", scene: defineScene({ id: "scene",
  camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 },
  environment: { background: "#000000", ambientIntensity: 0 },
  // Opaque front-to-back sorting also submits near first; both boxes cover the center.
  entities: [
    { id: "near", transform: { position: [0, 0, 1] }, mesh: { geometry: { kind: "box", size: [2, 2, 1] }, material: near } },
    { id: "far", mesh: { geometry: { kind: "box", size: [2, 2, 1] }, material: far } },
  ],
}), systems: [controls], postProcesses: [identity, distance], render: { mode: "raster" } });
`;

async function prepare(output: string) {
  const project = path.join(output, "project");
  const publicDir = path.join(project, ".pelican/public");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "game.ts"), gameSource);
  const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(publicDir, "generated") });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  assert.deepEqual(compiled.ir!.scene.entities.map(entity => entity.id), ["near", "far"]);
  return { publicDir };
}

async function command(page: Page, input: unknown): Promise<any> {
  const response = await withAutomationDeadline(
    () => page.evaluate(async input => (window as any).__pelican.command(input), input),
    30_000, "Postprocess occlusion command",
  );
  assert.equal(response.status, "succeeded", JSON.stringify(response));
  return response.data;
}

async function tap(page: Page, key: string) {
  await command(page, { type: "input", key, pressed: true });
  await command(page, { type: "input", key, pressed: false });
  await command(page, { type: "step", count: 1 });
}

async function centerPixels(page: Page, file: string) {
  const png = await page.locator("canvas:visible").first().screenshot({ path: file });
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(Math.floor(bitmap.width / 2) - 4, Math.floor(bitmap.height / 2) - 4, 8, 8).data;
      const rgb: number[] = [], mean = [0, 0, 0];
      for (let i = 0; i < rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          rgb.push(rgba[i + c]);
          mean[c] += rgba[i + c] / 64;
        }
      }
      return { width: bitmap.width, height: bitmap.height, rgb, mean };
    } finally { bitmap.close(); }
  }, [...png]);
}

type Pixels = Awaited<ReturnType<typeof centerPixels>>;
function maxDifference(a: Pixels, b: Pixels) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.equal(a.rgb.length, b.rgb.length);
  return Math.max(...a.rgb.map((value, index) => Math.abs(value - b.rgb[index])));
}
function assertGreen(image: Pixels) {
  for (let i = 0; i < image.rgb.length; i += 3)
    assert.ok(image.rgb[i + 1] > 100 && image.rgb[i + 1] > image.rgb[i] + 80 && image.rgb[i + 1] > image.rgb[i + 2] + 80,
      "Near green must occlude far red at every center pixel: " + JSON.stringify(image.mean));
}

/** Caller must own exclusive GPU access. Only small raster cases, WebGPU then WebGL2. */
export async function runPostprocessOcclusionProbe(output: string) {
  output = path.resolve(output);
  const report: Record<string, any> = {
    scope: "MRT reserved-depth occlusion regression; compiled public-API game",
    formalMilestoneAccepted: false, passed: false, errors: [], cases: [],
    tolerance: { maxCenterByteDifference: 2, minFarReferenceByteDifference: 8 },
  };
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const { publicDir } = await prepare(output);
    server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    browser = await chromium.launch(automationLaunchOptions());
    const target = new URL(server.resolvedUrls!.local[0]);
    target.search = "automation=1&width=" + size.width + "&height=" + size.height;
    for (const backend of ["webgpu", "webgl2"]) {
      const context = await browser.newContext({ viewport: size });
      try {
        if (backend === "webgl2")
          await context.addInitScript({ content: "Object.defineProperty(navigator,'gpu',{configurable:true,value:undefined});" });
        const page = await context.newPage();
        page.on("pageerror", error => report.errors.push(backend + ": " + error.message));
        page.on("console", message => { if (message.type() === "error") report.errors.push(backend + ": " + message.text()); });
        await page.goto(target.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const initial = await command(page, { type: "inspect" });
        assert.equal(initial.backend, backend === "webgpu" ? "WebGPUBackend" : "WebGLBackend");
        if (backend === "webgpu") assert.equal(initial.adapter.isFallbackAdapter, false);
        assert.equal(initial.mode, "raster");
        assert.deepEqual(initial.rendering.postProcesses.sourceAttachments, ["output", "normal", "linearDepth"]);
        assert.equal(initial.rendering.postProcesses.samples, 4);
        const image = (name: string) => centerPixels(page, path.join(output, backend + "-" + name + ".png"));
        await tap(page, "0");
        const direct = await image("direct");
        assertGreen(direct);
        await tap(page, "1");
        const identity = await image("identity");
        assertGreen(identity);
        const identityDifference = maxDifference(identity, direct);
        assert.ok(identityDifference <= 2, "Identity differs from effects-disabled raster: " + identityDifference);
        await tap(page, "z");
        const measured = await image("distance");
        await tap(page, "3");
        const nearReference = await image("distance-reference-3.5");
        await tap(page, "4");
        const farReference = await image("distance-reference-4.5");
        // Calibrate via the same display transform, not an assumed tone/sRGB formula.
        const nearDifference = maxDifference(measured, nearReference);
        const farDifference = maxDifference(measured, farReference);
        assert.ok(nearDifference <= 2, "scene.depth must match 3.5 world units: " + nearDifference);
        assert.ok(farDifference >= 8, "scene.depth must reject the occluded 4.5-unit surface: " + farDifference);
        report.cases.push({ backend: initial.backend, adapter: initial.adapter, direct, identity, identityDifference,
          depth: { measured, nearReference, farReference, nearDifference, farDifference, expectedWorldDistance: 3.5, occludedWorldDistance: 4.5 },
          compositor: (await command(page, { type: "inspect" })).rendering.postProcesses });
      } finally { await context.close(); }
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, "postprocess-occlusion.json"), JSON.stringify(report, null, 2) + "\n");
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), outputIndex = args.indexOf("--output");
  const output = path.resolve(outputIndex < 0 ? ".pelican/postprocess-occlusion" : args[outputIndex + 1]);
  const main = async () => {
    if (args.includes("--prepare")) {
      await prepare(output);
      console.log(JSON.stringify({ output, prepared: true, gpuExecuted: false }));
      return;
    }
    assert.ok(args.includes("--exclusive-gpu"), "GPU probe requires --exclusive-gpu after exclusive access is granted; use --prepare for compilation only.");
    const report = await runPostprocessOcclusionProbe(output);
    console.log(JSON.stringify({ output, passed: report.passed, cases: report.cases.length }));
  };
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
