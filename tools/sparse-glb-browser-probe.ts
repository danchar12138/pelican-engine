import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { NodeIO } from "@gltf-transform/core";
import { chromium } from "playwright";
import { createServer } from "vite";
import { compileProject } from "../packages/compiler/src/index.ts";
import { parseGLB } from "../packages/assets/src/glb.ts";
import { InspectionContext } from "../packages/assets/src/errors.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { reproduceSparseLoaderLimits } from "./sparse-gltfloader-regression.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = path.join(root, "examples/sparse-glb");
const expected = [0, 0, 0, 1, -1, 0, 0, 1, 0];

async function cpuPreflight() {
  const source = await readFile(path.join(project, "game.ts"), "utf8");
  const ast = ts.createSourceFile("game.ts", source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier)); imports.push(node.moduleSpecifier.text);
    }
    assert.ok(!ts.isCallExpression(node) || (node.expression.kind !== ts.SyntaxKind.ImportKeyword && !(ts.isIdentifier(node.expression) && node.expression.text === "require")), "Dynamic or CommonJS imports are not allowed");
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.deepEqual(imports, ["pelican-engine"]);
  const files = ["sparse.glb", "optimized.glb"].map(name => path.join(project, "assets", name));
  const original = parseGLB(await readFile(files[0]), new InspectionContext(files[0]));
  const originalAccessor = original.json.meshes![0].primitives[0].attributes.POSITION;
  assert.ok(original.json.accessors![originalAccessor].sparse);
  assert.equal(original.json.accessors![originalAccessor].bufferView, undefined);
  const io = new NodeIO();
  const geometries = await Promise.all(files.map(async file => {
    const doc = await io.read(file), primitive = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const positions = primitive.getAttribute("POSITION")!, indices = primitive.getIndices();
    return Array.from({ length: indices?.getCount() ?? positions.getCount() }, (_, i) => positions.getElement(indices ? indices.getScalar(i) : i, [])).flat();
  }));
  assert.deepEqual(geometries[0], expected); assert.deepEqual(geometries[1], expected);
  return { imports, geometry: geometries[0], originalSparse: true };
}

async function main() {
  const webgpu = process.argv.includes("--webgpu");
  if (webgpu && !process.argv.includes("--exclusive-gpu")) throw new Error("Reserve the GPU and pass --exclusive-gpu.");
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith("--"))) throw new Error("--output requires a directory.");
  const output = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : undefined;
  if (output) await mkdir(output, { recursive: true });
  const sourceIdentity = (await sourceFingerprint(root)).sha256;
  const cpu = await cpuPreflight();
  const temporary = await mkdtemp(path.join(tmpdir(), "pelican-sparse-probe-"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const publicDir = path.join(temporary, "public");
    const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(publicDir, "generated") });
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    if (process.argv.includes("--cpu-only")) { console.log(JSON.stringify({ cpu, compile: true, browser: "not run" })); return; }
    server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir, logLevel: "silent", optimizeDeps: { include: ["three/examples/jsm/loaders/GLTFLoader.js"] }, server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    browser = await chromium.launch(webgpu ? automationLaunchOptions() : { headless: true, args: ["--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const identity = webgpu ? null : await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) throw new Error("Software WebGL2 unavailable");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (!ext) throw new Error("WebGL renderer identity unavailable");
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    });
    if (!webgpu) assert.match(identity!, /swiftshader/i, "Refusing to load the game without verified SwiftShader");
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    if (!webgpu) await page.addInitScript(() => { Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true }); });
    await page.addInitScript("globalThis.__name = (target) => target;");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url + "?automation=1&width=320&height=240", { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    const loaderLimits = await reproduceSparseLoaderLimits(page);
    const command = async (value: unknown) => {
      const result = await withAutomationDeadline(() => page.evaluate(async input => (window as any).__pelican.command(input), value), 30000, "sparse command");
      assert.equal(result.status, "succeeded", JSON.stringify(result)); return result.data;
    };
    const state = await command({ type: "inspect" });
    assert.equal(state.backend, webgpu ? "WebGPUBackend" : "WebGLBackend");
    if (webgpu) assert.equal(state.adapter.isFallbackAdapter, false);
    await command({ type: "mode", mode: "raster" });
    const samples: number[][] = [];
    for (const key of ["b", "a"]) {
      await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false });
      await command({ type: "step", count: 1 });
      const png = await page.locator("canvas").first().screenshot(output ? { path: path.join(output, key === "b" ? "original.png" : "optimized.png") } : {});
      const pixels = await page.evaluate(async bytes => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); image.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const result: number[] = []; for (let i = 0; i < data.length; i += 4) result.push(data[i], data[i + 1], data[i + 2]); return result;
      }, [...png]);
      samples.push(pixels);
    }
    const red = (p: number[], i: number) => p[i] > 40 && p[i] > p[i + 1] * 2 && p[i] > p[i + 2] * 2;
    let redPixels = 0, changed = 0;
    for (let i = 0; i < samples[0].length; i += 3) {
      if (red(samples[0], i)) redPixels++;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(samples[0][i + c] - samples[1][i + c]))) > 3) changed++;
    }
    assert.ok(redPixels > 100, "Sparse triangle did not appear in the canvas");
    assert.ok(changed <= samples[0].length / 3 * 0.001, "Original and optimized canvas pixels differ: " + changed);
    assert.deepEqual(errors, []);
    assert.equal((await sourceFingerprint(root)).sha256, sourceIdentity, "Source changed during probe");
    const result = { scope: "sparse-glb-raster-development", formalMilestoneAccepted: false, sourceIdentity, cpu, compile: true, browser: { backend: state.backend, renderer: identity, adapter: state.adapter, redPixels, changedPixels: changed, loaderLimits } };
    if (output) await writeFile(path.join(output, "sparse-glb.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    await browser?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
