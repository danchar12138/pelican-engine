import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

type RGB = [number, number, number];
export type SlotSamples = { paint: RGB; trim: RGB };

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function materialSlotsGameIdentity(dir: string) {
  return {
    gameSha256: sha256(await readFile(path.join(dir, "game.ts"))),
    manifestSha256: sha256(await readFile(path.join(dir, "pelican.project.json"))),
    assetSha256: sha256(await readFile(path.join(dir, "assets/panels.glb"))),
  };
}

export async function verifyMaterialSlotsProject(project: string, installed: string) {
  const gameIdentity = await materialSlotsGameIdentity(project);
  const installedGameIdentity = await materialSlotsGameIdentity(installed);
  assert.deepEqual(installedGameIdentity, gameIdentity, "Installed project must contain the exact example game, manifest and asset");
  return { gameIdentity, installedGameIdentity };
}

export async function materialSlotsInstalledIdentity(dir: string) {
  const packageRoot = path.join(dir, "node_modules", "pelican-engine");
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "pelican-engine");
  assert.equal(typeof pkg.version, "string", "Installed package has no version");
  const entry = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.import;
  assert.equal(typeof entry, "string", "Installed package has no SDK import entry");
  const entryPath = path.resolve(packageRoot, entry);
  const sdk = await import(pathToFileURL(entryPath).href);
  assert.equal(typeof sdk.SDK_VERSION, "string", "Installed SDK has no version");
  const projectPackage = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  const optionalJson = async (file: string) => readFile(file, "utf8").then(JSON.parse, error => { if (error.code === "ENOENT") return undefined; throw error; });
  const lock = await optionalJson(path.join(dir, "package-lock.json"));
  const lockEntry = lock?.packages?.["node_modules/pelican-engine"] ?? lock?.dependencies?.["pelican-engine"];
  const distribution = await optionalJson(path.join(packageRoot, "distribution.json"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pelican;
  assert.equal(typeof bin, "string", "Installed package has no pelican CLI");
  return { packageRoot, packageVersion: pkg.version, sdkVersion: sdk.SDK_VERSION, sdkEntrySha256: sha256(await readFile(entryPath)),
    distributionVersion: distribution?.version ?? null,
    tarball: { resolved: lockEntry?.resolved ?? null, integrity: lockEntry?.integrity ?? null, version: lockEntry?.version ?? null },
    declared: projectPackage.dependencies?.["pelican-engine"] ?? projectPackage.devDependencies?.["pelican-engine"] ?? null,
    bin: path.resolve(packageRoot, bin) };
}

export function materialSlotsAllowedRequest(url: string, allowedOrigin: string): boolean {
  try { return new URL(url).origin === allowedOrigin; } catch { return false; }
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Unable to reserve a port")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
  finally { clearTimeout(timer); }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await withAutomationDeadline(() => exited, 15000, "Installed dev server shutdown");
  }
}

export function assertMaterialSlotPixels(before: SlotSamples, after: SlotSamples): void {
  const detail = JSON.stringify({ before, after });
  assert.ok(before.paint[0] > 35 && before.paint[0] > before.paint[1] + 20, detail);
  assert.ok(after.paint[1] > 35 && after.paint[1] > after.paint[0] + 20, detail);
  assert.ok(before.paint[0] - after.paint[0] > 20 && after.paint[1] - before.paint[1] > 20, detail);
  for (const sample of [before.trim, after.trim])
    assert.ok(sample[2] > 35 && sample[2] > sample[0] + 20 && sample[2] > sample[1] + 20, detail);
  assert.ok(before.trim.every((value, i) => Math.abs(value - after.trim[i]!) < 30), detail);
}

async function screenshot(page: Page, output: string): Promise<SlotSamples> {
  const bytes = await page.locator("canvas:visible").first().screenshot({ path: output });
  return page.evaluate(async data => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
    try {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d");
      if (!context || image.width !== 320 || image.height !== 240) throw new Error("Unexpected screenshot dimensions or unavailable pixel context");
      context.drawImage(image, 0, 0);
      const sample = (x: number) => {
        const pixels = context.getImageData(x - 5, 115, 11, 11).data;
        const rgb: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4)
          for (let c = 0; c < 3; c++) rgb[c] += pixels[i + c]! / 121;
        return rgb;
      };
      return { paint: sample(114), trim: sample(206) };
    } finally { image.close(); }
  }, [...bytes]);
}

export async function runMaterialSlotsGameProbe(output: string, installedRoot?: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.join(root, "examples/material-slots");
  await mkdir(output, { recursive: true });
  const report: { scope: string; sourceIdentity?: string; gameIdentity?: unknown; installedGameIdentity?: unknown; installedIdentity?: unknown; dev?: unknown; devStdout?: string; devStderr?: string; networkPolicy?: unknown; formalMilestoneAccepted: false; passed: boolean; errors: string[]; modes: unknown[]; adapter?: unknown; failure?: string; cleanupErrors: string[] } = {
    scope: "materialSlots public GLB before/after", formalMilestoneAccepted: false, passed: false, errors: [], modes: [], cleanupErrors: [],
  };
  let temporary: string | undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let failure: unknown;
  try {
    let serverUrl: string;
    if (installedRoot) {
      const dir = path.resolve(installedRoot);
      Object.assign(report, await verifyMaterialSlotsProject(project, dir));
      const identity = await materialSlotsInstalledIdentity(dir);
      report.installedIdentity = identity;
      const expected = JSON.parse(await readFile(path.join(project, "pelican.project.json"), "utf8")).engineVersion;
      assert.equal(identity.packageVersion, expected, "Installed package must match the project engine version");
      assert.equal(identity.sdkVersion, expected, "Installed SDK must match the project engine version");
      assert.equal(identity.distributionVersion, expected, "Installed distribution must match the project engine version");
      assert.equal(identity.tarball.version, expected, "Installed lockfile must match the project engine version");
      const port = await freePort();
      child = spawn(process.execPath, [identity.bin, "dev", "--project", dir, "--port", String(port)], {
        cwd: dir, env: { ...process.env, npm_config_offline: "true" }, windowsHide: true, stdio: "pipe",
      });
      child.stdin.end();
      let stdout = "", stderr = "", spawnError: Error | undefined;
      child.on("error", error => { spawnError = error; });
      child.stdout.on("data", chunk => { stdout += String(chunk); report.devStdout = stdout; });
      child.stderr.on("data", chunk => { stderr += String(chunk); report.devStderr = stderr; });
      const running = await withAutomationDeadline(async () => {
        while (true) {
          if (spawnError) throw spawnError;
          let message: any;
          try { message = JSON.parse(stdout); } catch { /* wait for the complete envelope */ }
          if (message?.status === "failed") throw new Error(`Installed dev failed: ${stdout} ${stderr}`);
          if (message?.status === "running") return message;
          if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Installed dev exited: ${stdout} ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }, 30000, "Installed dev server startup");
      report.dev = running;
      const url = new URL(running.data?.url);
      assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(Number(url.port), port);
      serverUrl = url.href;
    } else {
      report.gameIdentity = await materialSlotsGameIdentity(project);
      report.sourceIdentity = (await sourceFingerprint(root)).sha256;
      temporary = await mkdtemp(path.join(tmpdir(), "pelican-material-slots-"));
      const publicDir = path.join(temporary, "public");
      const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(publicDir, "generated") });
      assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
      server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir, logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
      await server.listen();
      serverUrl = server.resolvedUrls!.local[0];
    }
    browser = await chromium.launch(automationLaunchOptions());
    const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const allowedOrigin = new URL(serverUrl).origin;
    await page.route("**/*", route => materialSlotsAllowedRequest(route.request().url(), allowedOrigin) ? route.continue() : route.abort());
    report.networkPolicy = { allowedOrigin };
    await page.addInitScript("globalThis.__name = (target) => target;");
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
    page.on("requestfailed", request => { if (materialSlotsAllowedRequest(request.url(), allowedOrigin)) report.errors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`); });
    const target = new URL(serverUrl);
    target.search = "automation=1&width=320&height=240";
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    const command = async (input: unknown) => {
      const result = await withAutomationDeadline(() => page.evaluate(async value => (window as any).__pelican.command(value), input), 30000, "material slots command");
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      return result.data;
    };
    const initial = await command({ type: "inspect" });
    assert.equal(initial.backend, "WebGPUBackend");
    assert.equal(initial.adapter.isFallbackAdapter, false);
    report.adapter = initial.adapter;
    for (const mode of ["raster", "path", "hybrid"] as const) {
      await command({ type: "mode", mode });
      const captures: Partial<Record<"before" | "after", SlotSamples>> = {};
      for (const [label, key] of [["before", "b"], ["after", "a"]] as const) {
        await command({ type: "input", key, pressed: true });
        await command({ type: "input", key, pressed: false });
        await command({ type: "step", count: 1 });
        if (mode !== "raster")
          await withAutomationDeadline(() => page.evaluate(async () => (window as any).__pelican.accumulate(32)), 60000, "material slots accumulation");
        const state = await command({ type: "inspect" });
        assert.equal(state.mode, mode);
        if (mode !== "raster") assert.ok(state.rendering.surface.triangleCount >= 4);
        captures[label] = await screenshot(page, path.join(output, `${mode}-${label}.png`));
      }
      report.modes.push({ mode, ...captures });
      assertMaterialSlotPixels(captures.before!, captures.after!);
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    failure = error;
    report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    for (const cleanup of [
      async () => { await browser?.close(); },
      async () => { await server?.close(); },
      async () => { if (child) await stopChild(child); },
      async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); },
    ]) {
      try { await cleanup(); } catch (error) { report.cleanupErrors.push(String(error)); }
    }
    if (report.cleanupErrors.length) report.passed = false;
    await writeFile(path.join(output, "material-slots-game.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) throw failure;
  if (report.cleanupErrors.length) throw new Error(`Cleanup failed: ${report.cleanupErrors.join("; ")}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("Reserve the GPU and pass --exclusive-gpu.");
  const i = process.argv.indexOf("--output");
  if (i >= 0 && (!process.argv[i + 1] || process.argv[i + 1]!.startsWith("--"))) throw new Error("--output requires a directory.");
  const output = path.resolve(i >= 0 ? process.argv[i + 1]! : `.pelican/material-slots/${Date.now()}`);
  const installedIndex = process.argv.indexOf("--installed-root");
  if (installedIndex >= 0 && (!process.argv[installedIndex + 1] || process.argv[installedIndex + 1]!.startsWith("--"))) throw new Error("--installed-root requires a directory.");
  const installedRoot = installedIndex >= 0 ? process.argv[installedIndex + 1] : undefined;
  runMaterialSlotsGameProbe(output, installedRoot).then(report => console.log(JSON.stringify({ output, passed: report.passed, sourceIdentity: report.sourceIdentity, installedIdentity: report.installedIdentity })))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
