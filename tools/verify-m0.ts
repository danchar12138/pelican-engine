import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  cp,
  mkdtemp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import { serveDist } from "./static-server.ts";
import { chromium } from "playwright";
import { compileProject } from "../experiments/compiler/index.ts";
import { runSimulationProbe } from "../experiments/simulation/index.ts";
import { runWorldProbe } from "../experiments/world/index.ts";
import { runRigidBodyProbe } from "../experiments/rigidbody/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { doctor } from "./doctor.ts";
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historicalManifest = JSON.parse(await readFile(path.join(root, "engine.manifest.json"), "utf8"));
if (historicalManifest.milestone !== "M0") throw new Error("TC_HISTORICAL_MILESTONE: Run M0 verification from tag v0.0.1-m0.0. Historical evidence is immutable; use the active milestone verifier for current sources.");
const evidence = path.join(root, "evidence/m0");
await mkdir(evidence, { recursive: true });
const checks: {
  id: string;
  status: "passed" | "failed";
  evidence: string[];
  detail?: string;
}[] = [];
const save = async (name: string, value: unknown) =>
  writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
const sanitize = (s: string) =>
  s
    .replaceAll(root, "<engine>")
    .replaceAll(tmpdir(), "<temp>")
    .replace(/C:\\Users\\[^\\\s]+/g, "<user>");
async function check(id: string, operation: () => Promise<string[]>) {
  try {
    const artifacts = await operation();
    checks.push({ id, status: "passed", evidence: artifacts });
    console.log(JSON.stringify({ check: id, status: "passed" }));
  } catch (error) {
    const failure = {
      id,
      status: "failed",
      recordedAt: new Date().toISOString(),
      detail: sanitize(String(error)),
      stdout: sanitize(String((error as any)?.stdout ?? "")),
      stderr: sanitize(String((error as any)?.stderr ?? "")),
    };
    await mkdir(path.join(evidence, "attempts"), { recursive: true });
    await writeFile(
      path.join(evidence, "attempts", `${Date.now()}-${id}.json`),
      JSON.stringify(failure, null, 2) + "\n",
    );
    checks.push({ id, status: "failed", evidence: [], detail: failure.detail });
    console.error(
      JSON.stringify({ check: id, status: "failed", detail: failure.detail }),
    );
  }
}

await check("environment", async () => {
  const result = await doctor({ projectRoot: root });
  await save("environment.json", result);
  assert.equal(result.status, "succeeded");
  return ["evidence/m0/environment.json"];
});
await check("typecheck", async () => {
  const r = await exec(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    { cwd: root, maxBuffer: 4e6 },
  );
  await writeFile(
    path.join(evidence, "typecheck.txt"),
    sanitize(r.stdout + r.stderr) || "TypeScript strict check passed.\n",
  );
  return ["evidence/m0/typecheck.txt"];
});
await check("unit-tests", async () => {
  const files = (await readdir(path.join(root, "tests")))
    .filter((n) => n.endsWith(".test.ts"))
    .map((n) => path.join(root, "tests", n));
  const r = await exec(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { cwd: root, maxBuffer: 8e6, timeout: 120000 },
  );
  await writeFile(
    path.join(evidence, "unit-tests.txt"),
    sanitize(r.stdout + r.stderr),
  );
  assert.match(r.stdout, /(?:fail 0|"failed":0)/);
  return ["evidence/m0/unit-tests.txt"];
});
await check("compiler", async () => {
  const result = await compileProject({
    projectRoot: path.join(root, "examples/m0"),
    outDir: ".pelican/public/generated",
    engineRoot: root,
  });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  await save("compiler.json", result.report);
  await save("scene.ir.json", result.ir);
  return ["evidence/m0/compiler.json", "evidence/m0/scene.ir.json"];
});
await check("rigidbody", async () => {
  const report = await runRigidBodyProbe();
  await save("rigidbody.json", report);
  assert.equal(report.passed, true);
  return ["evidence/m0/rigidbody.json"];
});

await check("simulation", async () => {
  const start = performance.now();
  const result = runSimulationProbe({ steps: 240, lifecycleCycles: 12 });
  await save("simulation.json", {
    recordedAt: new Date().toISOString(),
    wallMs: performance.now() - start,
    ...result,
  });
  assert.equal(result.passed, true);
  return ["evidence/m0/simulation.json"];
});

await check("world", async () => {
  const report = await runWorldProbe();
  await save("world.json", report);
  assert.equal(report.passed, true);
  return ["evidence/m0/world.json"];
});

await check("render", async () => {
  process.env.NODE_ENV = "development";
  const server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(root, "examples/m0/.pelican/public"),
    logLevel: "silent",
    server: { port: 4273, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  const launchArgs = [
    "--use-angle=d3d11",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  const browser = await chromium.launch({ headless: false, args: launchArgs });
  const failures: string[] = [];
  const shots: string[] = [];
  try {
    const cdp = await browser.newBrowserCDPSession();
    const system = await cdp.send("SystemInfo.getInfo");
    const gpu = system.gpu as any;
    assert.equal(gpu.featureStatus.webgpu, "enabled");
    assert.ok(!/swiftshader|warp/i.test(gpu.auxAttributes.glRenderer));
    const page = await browser.newPage({
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto("http://127.0.0.1:4273/");
    await page.waitForFunction(
      () =>
        Boolean(
          (window as any).__pelican || (window as any).__pelicanFailure,
        ),
      null,
      { timeout: 30000 },
    );
    assert.equal(
      await page.evaluate(() => (window as any).__pelicanFailure),
      undefined,
    );
    const initial = await page.evaluate(() =>
      (window as any).__pelican.inspect(),
    );
    assert.equal(initial.backend, "WebGPUBackend");
    assert.deepEqual(
      initial.objects.camera,
      initial.compiledIR.scene.camera.position,
    );
    const parentTransform = await page.evaluate(
      () => (window as any).__pelican.worldTransforms()["m0-child"],
    );
    assert.deepEqual(parentTransform, [7, 0.5, -2]);
    const adapter = await page.evaluate(
      () => (window as any).__pelican.adapter,
    );
    assert.equal(adapter.isFallbackAdapter, false);
    assert.ok(
      adapter.vendor || adapter.architecture,
      "Adapter identity is unavailable.",
    );
    const shot = async (name: string) => {
      await page.screenshot({ path: path.join(evidence, name) });
      shots.push(`evidence/m0/${name}`);
    };
    await shot("raster.png");
    const beforeInput = initial.game.transforms["m0-spinner"].position[0];
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      (x) =>
        (window as any).__pelican.inspect().game.transforms["m0-spinner"]
          .position[0] !== x,
      beforeInput,
    );
    const directSnapshot = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      const saved = api.snapshot();
      const original = saved.components["m0-spinner"].Motion.speed;
      api.setComponent("m0-spinner", "Motion", { speed: 9 });
      const unpolluted =
        saved.components["m0-spinner"].Motion.speed === original;
      await api.restore(saved);
      api.setComponent("m0-spinner", "Motion", { speed: 7 });
      await api.restore(saved);
      return {
        unpolluted,
        restored: api.inspect().game.components["m0-spinner"].Motion.speed,
        expected: original,
      };
    });
    assert.equal(directSnapshot.unpolluted, true);
    assert.equal(directSnapshot.restored, directSnapshot.expected);
    const isolatedGeometry = await page.evaluate(() => {
      const api = (window as any).__pelican;
      return {
        morph0: api.geometryProbe("morph", 0),
        morph1: api.geometryProbe("morph", 1),
        skin0: api.geometryProbe("skin", 0),
        skin1: api.geometryProbe("skin", 0.6),
      };
    });
    assert.notDeepEqual(
      isolatedGeometry.morph0.vertices,
      isolatedGeometry.morph1.vertices,
    );
    assert.notDeepEqual(
      isolatedGeometry.skin0.vertices,
      isolatedGeometry.skin1.vertices,
    );
    assert.notEqual(isolatedGeometry.morph0.hash, isolatedGeometry.morph1.hash);
    assert.notEqual(isolatedGeometry.skin0.hash, isolatedGeometry.skin1.hash);
    const isolatedRays = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      api.geometryProbe("morph", 0);
      const morph0 = await api.ray([1.5, 5, -0.2], [0, -1, 0]);
      api.geometryProbe("morph", 1);
      const morph1 = await api.ray([1.5, 5, -0.2], [0, -1, 0]);
      api.geometryProbe("skin", 0);
      const skin0 = await api.ray([5, 1.7, -1.4], [-1, 0, 0]);
      api.geometryProbe("skin", 0.6);
      const skin1 = await api.ray([5, 1.7, -1.4], [-1, 0, 0]);
      return { morph0, morph1, skin0, skin1 };
    });
    assert.ok(
      Math.abs(isolatedRays.morph0.distance - isolatedRays.morph1.distance) >
        0.1,
    );
    assert.ok(
      Math.abs(isolatedRays.skin0.distance - isolatedRays.skin1.distance) >
        0.05,
    );
    const afterInput = await page.evaluate(() =>
      (window as any).__pelican.inspect(),
    );
    assert.equal(
      afterInput.game.transforms["m0-spinner"].position[0],
      beforeInput + 0.25,
    );
    const compute = await page.evaluate(
      async () => await (window as any).__pelican.compute("pulse", 1.25),
    );
    for (let i = 0; i < compute.count; i++)
      assert.ok(Math.abs(compute.values[i * 4] - Math.sin(1.25)) < 1e-6);
    const dynamic: unknown[] = [];
    for (const mode of ["raster", "hybrid", "path"]) {
      const result = await page.evaluate(async (mode) => {
        const api = (window as any).__pelican;
        await api.mode(mode);
        const before = api.inspect();
        await api.step(12);
        const after = api.inspect();
        const gpuMs = mode === "raster" ? null : await api.gpuTimeMs();
        const pixels = mode === "raster" ? null : await api.pixels();
        return { mode, before, after, gpuMs, pixels };
      }, mode);
      assert.notEqual(result.after.geometryHash, result.before.geometryHash);
      assert.notEqual(result.after.objects.morph, result.before.objects.morph);
      assert.notEqual(result.after.objects.bone, result.before.objects.bone);
      assert.ok(
        result.after.game.transforms["m0-spinner"].rotation[1] >
          result.before.game.transforms["m0-spinner"].rotation[1],
      );
      if (result.pixels) assert.ok(result.pixels.nonBlack > 5000);
      assert.deepEqual(result.after.errors, []);
      dynamic.push(result);
      await shot(`${mode}-dynamic.png`);
    }
    const ray = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      const state = api.inspect();
      return api.ray([state.objects.box[0], 10, 0], [0, -1, 0]);
    });
    assert.ok(ray.triangle >= 0);
    assert.ok(Math.abs(ray.distance - 9) < 0.01);
    for (let frame = 0; frame < 4; frame++) {
      await page.evaluate(async () => {
        await (window as any).__pelican.step(4);
      });
      await shot(`sequence-path-${frame.toString().padStart(2, "0")}.png`);
    }
    const camera = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      const before = await api.pixels();
      const directionBefore = api.cameraDirection();
      const state = await api.camera(0.35);
      const directionAfter = api.cameraDirection();
      const after = await api.pixels();
      return { before, after, state, directionBefore, directionAfter };
    });
    assert.notEqual(camera.after.hash, camera.before.hash);
    assert.notDeepEqual(
      camera.directionBefore.forward,
      camera.directionAfter.forward,
    );
    const topology = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      const before = api.inspect();
      const after = await api.topology();
      return { before: before.triangleCount, after: after.triangleCount };
    });
    assert.ok(topology.after > topology.before);
    const simulations: unknown[] = [];
    for (const kind of ["rope", "cloth", "softbody", "fluid"]) {
      const result = await page.evaluate(async (kind) => {
        const api = (window as any).__pelican;
        await api.simulation(kind);
        const before = api.inspect();
        const saved = api.snapshot();
        const captureStart = performance.now();
        const serialized = JSON.stringify(saved);
        const captureMs = performance.now() - captureStart;
        await api.step(12);
        const after = api.inspect();
        const restoreStart = performance.now();
        await api.restore(JSON.parse(serialized));
        const restoreMs = performance.now() - restoreStart;
        const restored = api.inspect();
        return {
          kind,
          before,
          after,
          restored,
          captureMs,
          restoreMs,
          snapshotBytes: new TextEncoder().encode(serialized).byteLength,
          pixels: await api.pixels(),
        };
      }, kind);
      assert.notEqual(result.before.geometryHash, result.after.geometryHash);
      assert.equal(result.restored.geometryHash, result.before.geometryHash);
      assert.equal(
        result.restored.simulation.tick,
        result.before.simulation.tick,
      );
      assert.deepEqual(result.restored.errors, []);
      assert.ok(result.pixels.nonBlack > 5000);
      simulations.push(result);
      await shot(`simulation-${kind}.png`);
    }
    const worldIntegration = await page.evaluate(async () => {
      const api = (window as any).__pelican;
      const loaded = await api.worldLoad();
      const edited = await api.worldEdit();
      const saved = api.snapshot();
      const unloaded = await api.worldUnload();
      const reloaded = await api.worldReload();
      await api.restore(saved);
      const restored = api.inspect();
      return { loaded, edited, unloaded, reloaded, restored };
    });
    assert.equal(worldIntegration.edited.collision.height, 1.8);
    assert.ok(worldIntegration.edited.navigation.blockedCells > 0);
    assert.notEqual(
      worldIntegration.loaded.geometryHash,
      worldIntegration.edited.state.geometryHash,
    );
    assert.equal(
      worldIntegration.reloaded.geometryHash,
      worldIntegration.edited.state.geometryHash,
    );
    assert.equal(
      worldIntegration.restored.geometryHash,
      worldIntegration.edited.state.geometryHash,
    );
    await shot("world-edited-path.png");
    await page.evaluate(async () => {
      await (window as any).__pelican.accumulate(24);
    });
    await shot("path-static-24spp.png");
    // A separate native 1080p page. Report serialized fence wall time and compute timestamps, never call either FPS.
    const benchmark = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    await benchmark.goto("http://127.0.0.1:4273/?width=1920&height=1080");
    await benchmark.waitForFunction(
      () => Boolean((window as any).__pelican),
      null,
      { timeout: 30000 },
    );
    const benchmarkResults: unknown[] = [];
    for (const mode of ["raster", "hybrid", "path"]) {
      const result = await benchmark.evaluate(async (mode) => {
        const api = (window as any).__pelican;
        await api.mode(mode);
        await api.step(5);
        const frames = [];
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          await api.step(1);
          frames.push({
            fenceWallMs: performance.now() - start,
            gpuComputeMs: mode === "raster" ? null : await api.gpuTimeMs(),
          });
        }
        const state = api.inspect();
        return {
          mode,
          frames,
          configuration: {
            width: state.width,
            height: state.height,
            triangles: state.triangleCount,
            denoiser: false,
            spp: mode === "raster" ? 0 : 1,
            bounces: mode === "path" ? 5 : mode === "hybrid" ? 2 : 0,
            hybrid: "35% traced image + raster compositing prototype",
          },
          metrics: state.metrics.slice(-30),
          errors: state.errors,
        };
      }, mode);
      assert.deepEqual(result.errors, []);
      benchmarkResults.push(result);
    }
    await benchmark.screenshot({ path: path.join(evidence, "path-1080p.png") });
    shots.push("evidence/m0/path-1080p.png");
    await benchmark.close();
    // Failure injection must terminate, without requesting any WebGL context.
    const failureTests = [];
    for (const failure of [
      "missing-api",
      "missing-adapter",
      "device-failure",
    ]) {
      console.log(
        JSON.stringify({ phase: "failure-injection", case: failure }),
      );
      const broken = await browser.newPage();
      broken.on("pageerror", (e) => console.error("Injected-page:", e.message));
      await broken.addInitScript({
        content: `window.__webglCalls=0;const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...rest){if(type==='webgl'||type==='webgl2')window.__webglCalls++;return original.call(this,type,...rest);};const failure=${JSON.stringify(failure)};if(failure==='missing-api')Object.defineProperty(navigator,'gpu',{value:undefined});else if(failure==='missing-adapter')Object.defineProperty(navigator,'gpu',{value:{requestAdapter:async function(){return null;}}});else GPUAdapter.prototype.requestDevice=async function(){throw new Error('injected device creation failure');};`,
      });
      await broken.goto("http://127.0.0.1:4273/");
      await broken.waitForFunction(() =>
        Boolean((window as any).__pelicanFailure),
      );
      const result = await broken.evaluate(() => ({
        failure: (window as any).__pelicanFailure,
        webglCalls: (window as any).__webglCalls,
      }));
      assert.equal(result.webglCalls, 0);
      failureTests.push({ case: failure, ...result });
      await broken.close();
    }
    assert.deepEqual(failures, []);
    await save("render.json", {
      recordedAt: new Date().toISOString(),
      browser: browser.version(),
      headed: true,
      launchArgs,
      adapter,
      cdp: {
        devices: gpu.devices,
        featureStatus: gpu.featureStatus,
        renderer: gpu.auxAttributes.glRenderer,
      },
      initial,
      afterInput,
      directSnapshot,
      isolatedGeometry,
      isolatedRays,
      compute,
      dynamic,
      offscreenRay: ray,
      camera,
      topology,
      simulations,
      worldIntegration,
      benchmark: benchmarkResults,
      failureTests,
      pageErrors: failures,
      limitations: [
        "Tiny synthetic geometry, not a representative high-quality game scene",
        "Software BVH compute traversal; no hardware RT",
        "CPU rebuild and complete upload every dynamic step; production refit not implemented",
        "Hybrid uses 35% traced-image compositing, not material-resolved lighting integration",
        "Prototype roughness reflection heuristic; no energy-conserving production BSDF/MIS or denoiser",
        "Fluid visualized as particles, no fluid surface reconstruction",
        "Serialized GPU-fence wall time is not sustained presentation FPS; GPU query measures tracer compute only",
      ],
    });
    return ["evidence/m0/render.json", ...shots];
  } finally {
    await browser.close();
    await server.close();
  }
});

await check("deploy", async () => {
  await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "build",
    ],
    { cwd: root, maxBuffer: 4e6, timeout: 120000 },
  );
  const server = await serveDist(
    path.join(root, "dist"),
    4274,
    "/nested/game/",
  );
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-angle=d3d11"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 960, height: 540 },
    });
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto(server.url);
    await page
      .waitForFunction(
        () => document.documentElement.dataset.pelicanReady === "true",
        null,
        { timeout: 30000 },
      )
      .catch(async (error) => {
        console.error(
          "Deploy status:",
          await page.locator("#status").textContent(),
          failures,
        );
        throw error;
      });
    const state = await page.evaluate(() => ({
      hook: typeof (window as any).__pelican,
      failureHook: typeof (window as any).__pelicanFailure,
      canvases: document.querySelectorAll("canvas").length,
      text: document.querySelector("#status")?.textContent,
    }));
    assert.equal(state.hook, "undefined");
    assert.equal(state.failureHook, "undefined");
    assert.equal(state.canvases, 2);
    assert.deepEqual(failures, []);
    await page.screenshot({ path: path.join(evidence, "dist.png") });
    const response = await page.request.get(
      new URL("generated/scene.ir.json", server.url).href,
    );
    assert.equal(response.status(), 200);
    await save("deploy.json", {
      passed: true,
      url: "http://localhost:<test-port>/nested/game/",
      state,
      errors: failures,
      standalone: true,
    });
    return ["evidence/m0/deploy.json", "evidence/m0/dist.png"];
  } finally {
    await browser.close();
    await server.close();
  }
});

// AI hands-on validation is executed by a separate, context-free external agent and attached afterward.
const aiPath = path.join(evidence, "ai-workflow.json");
await check("ai-workflow", async () => {
  const report = JSON.parse(await readFile(aiPath, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.engineFilesModified, false);
  assert.equal(report.humanTechnicalSteps, 0);
  assert.equal(
    report.sourceIdentity.sha256,
    (await sourceFingerprint(root)).sha256,
    "AI validation must refer to current executable sources and lockfiles",
  );
  assert.equal(report.independentContext, true);
  assert.ok(Array.isArray(report.flows));
  assert.ok(report.flows.some((f: any) => f.kind === "external-directory"));
  assert.ok(report.flows.some((f: any) => f.kind === "zip-no-git"));
  for (const flow of report.flows) {
    assert.equal(flow.status, "passed");
    assert.ok(flow.commands.length >= 4);
    assert.ok(
      flow.commands.some(
        (c: any) => c.expectedFailure === true && c.exitCode !== 0,
      ),
      "Failure-fix evidence is required",
    );
    for (const command of flow.commands)
      if (!command.expectedFailure) assert.equal(command.exitCode, 0);
    assert.ok(flow.artifacts.length >= 3);
    for (const relative of flow.artifacts) {
      assert.ok(!relative.includes("..") && !path.isAbsolute(relative));
      assert.ok((await readFile(path.join(root, relative))).length > 0);
    }
  }
  return [
    "evidence/m0/ai-workflow.json",
    ...report.flows.flatMap((flow: any) => flow.artifacts),
  ];
});
const status = checks.every((c) => c.status === "passed") ? "passed" : "failed";
await save("acceptance.json", {
  sourceIdentity: await sourceFingerprint(root),
  milestone: "M0",
  engineVersion: "0.0.1-m0.0",
  version: "0.0.1-m0.0",
  status,
  scope: "risk-prototypes",
  recordedAt: new Date().toISOString(),
  checks,
  limitations: [
    "M0 prototypes only; none of the complete first-release CAP entries are declared finished",
    "Dynamic path tracing needs production BSDF, denoising, acceleration and representative asset validation",
    "CPU particle simulation is a small reference implementation, not the complete physics feature set",
    "Full live state-preserving hot reload, arbitrary TS compilation, complete terrain/navigation/UI/audio remain future milestones",
  ],
});
console.log(JSON.stringify({ milestone: "M0", status, checks }, null, 2));
if (status !== "passed") process.exitCode = 1;
