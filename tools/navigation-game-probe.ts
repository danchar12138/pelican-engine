import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decode } from "fast-png";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = path.join(root, "examples/navigation-grid");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function gameIdentity(dir: string) {
  const game = await readFile(path.join(dir, "game.ts"));
  const manifest = await readFile(path.join(dir, "pelican.project.json"));
  return { gameSha256: sha256(game), manifestSha256: sha256(manifest) };
}

async function installedIdentity(dir: string) {
  const packageRoot = path.join(dir, "node_modules", "pelican-engine");
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "pelican-engine");
  const entry = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.import;
  assert.equal(typeof entry, "string", "Installed package has no SDK import entry");
  const entryPath = path.resolve(packageRoot, entry);
  const sdk = await import(pathToFileURL(entryPath).href);
  assert.equal(typeof sdk.SDK_VERSION, "string");
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

// Measure the rendered actor, not just a nonempty canvas; screenshot is saved
// separately as evidence. A second image proves visible movement.
function pixels(png: Buffer) {
  const image = decode(png), data = image.data;
  assert.equal(image.depth, 8); assert.ok(image.channels === 3 || image.channels === 4);
  let count = 0, sumX = 0, sumY = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * image.channels;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (g > 70 && b > 70 && g > r * 1.45 && b > r * 1.45) { count++; sumX += x; sumY += y; }
  }
  return { width: image.width, height: image.height, cyanPixels: count, centroid: count ? [sumX / count, sumY / count] : null };
}

export async function runNavigationGameProbe(output: string, installedRoot?: string) {
  await mkdir(output, { recursive: true });
  const report: any = { scope: "public orthogonal grid navigation game, browser and hardware WebGPU", formalMilestoneAccepted: false,
    passed: false, errors: [], steps: {}, screenshots: {} };
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let teardownAttempted = false;
  try {
    report.gameIdentity = await gameIdentity(project);
    let serverUrl: string;
    if (installedRoot) {
      const dir = path.resolve(installedRoot);
      report.installedGameIdentity = await gameIdentity(dir);
      assert.deepEqual(report.installedGameIdentity, report.gameIdentity, "Installed project must contain the exact example game and manifest");
      const identity = await installedIdentity(dir);
      report.installedIdentity = identity;
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
      report.sourceIdentity = await sourceFingerprint(root);
      const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
      report.compile = { success: compiled.success, diagnostics: compiled.diagnostics };
      assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
      server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), resolve: { alias: { "pelican-engine": path.join(root, "packages/sdk/src/index.ts") } }, publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
      await server.listen();
      serverUrl = server.resolvedUrls!.local[0];
    }
    browser = await chromium.launch(automationLaunchOptions());
    page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const activePage = page, allowedOrigin = new URL(serverUrl).origin;
    await page.route("**/*", route => new URL(route.request().url()).origin === allowedOrigin ? route.continue() : route.abort());
    report.networkPolicy = { allowedOrigin };
    page.on("pageerror", error => report.errors.push({ kind: "pageerror", message: error.message, stack: error.stack }));
    page.on("console", message => { if (message.type() === "error") report.errors.push({ kind: "console", message: message.text() }); });
    page.on("requestfailed", request => {
      if (new URL(request.url()).origin === allowedOrigin) report.errors.push({ kind: "requestfailed", url: request.url(), failure: request.failure() });
    });
    const target = new URL(serverUrl); target.search = "automation=1&width=640&height=360";
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    const command = async (input: unknown) => {
      const response = await withAutomationDeadline(() => activePage.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "navigation game command");
      if (response.status !== "succeeded") report.errors.push({ kind: "command", input, response });
      assert.equal(response.status, "succeeded", JSON.stringify(response));
      return response.data;
    };
    const capture = (name: string, s: any) => {
      report.steps[name] = { tick: s.tick, ready: s.ready, backend: s.backend, adapter: s.adapter, playback: s.playback,
        state: s.game?.components?.state?.NavigationState, transforms: s.game?.transforms, runtime: s.runtime,
        resources: s.resources, errors: s.errors };
      assert.equal(s.ready, true); assert.deepEqual(s.errors, []);
      assert.equal(s.runtime.scheduler.fault, null);
      return report.steps[name];
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const screenshot = async (name: string) => {
      const image = await activePage.locator("canvas:visible").first().screenshot({ path: path.join(output, name + ".png") });
      return report.screenshots[name] = { file: name + ".png", sha256: sha256(image), ...pixels(image) };
    };
    const route = (s: any): { x: number; y: number }[] => JSON.parse(s.state.path);
    const position = (s: any) => ({ x: s.state.x, y: s.state.y });
    const assertTransform = (s: any) => {
      const next = route(s)[s.state.cursor + 1] ?? position(s), f = s.state.progress / 12;
      const expected = [s.state.x - 3 + (next.x - s.state.x) * f, 0.38, s.state.y - 1 + (next.y - s.state.y) * f];
      s.transforms.player.position.forEach((v: number, i: number) => assert.ok(Math.abs(v - expected[i]) < 1e-6));
    };
    const initial = capture("initial", await command({ type: "step", count: 1 }));
    assert.equal(initial.backend, "WebGPUBackend"); assert.equal(initial.adapter.isFallbackAdapter, false);
    assert.equal(initial.state.initialized, true); assertTransform(initial);
    const straight = route(initial); assert.equal(straight.length, 7);
    assert.deepEqual(straight[0], { x: 0, y: 1 }); assert.deepEqual(straight.at(-1), { x: 6, y: 1 });
    const beforeImage = await screenshot("initial");
    const moved = capture("straightMove", await command({ type: "step", count: 12 }));
    assert.deepEqual(position(moved), straight[1]); assert.equal(moved.state.cursor, 1); assertTransform(moved);
    const movedImage = await screenshot("straight-move");
    assert.ok(beforeImage.cyanPixels > 20 && movedImage.cyanPixels > 20, "Cyan player must be visible in both frames");
    assert.ok(beforeImage.centroid && movedImage.centroid);
    assert.ok(Math.hypot(beforeImage.centroid[0] - movedImage.centroid[0], beforeImage.centroid[1] - movedImage.centroid[1]) > 3, "Rendered player must visibly move");
    const saved = await command({ type: "snapshot" }); report.snapshot = saved;
    const blocked = capture("blocked", await tap("b")), detour = route(blocked);
    assert.equal(blocked.state.obstacles, 1); assert.deepEqual(position(blocked), position(moved));
    assert.deepEqual(detour[0], position(moved)); assert.deepEqual(detour.at(-1), { x: 6, y: 1 });
    assert.ok(detour.length > straight.length - 1 && !detour.some(p => p.x === 3 && p.y === 1));
    assert.equal(blocked.transforms["block-1"].position[1], 0.4);
    await screenshot("blocked");
    const detourMove = capture("detourMove", await command({ type: "step", count: 1 }));
    assert.deepEqual(position(detourMove), detour[0]); assert.equal(detourMove.state.progress, 1); assertTransform(detourMove); await screenshot("detour-move");
    const mid = await command({ type: "snapshot" }); report.midSnapshot = mid;
    const afterMid = capture("afterMid", await command({ type: "step", count: 1 }));
    const midRestored = capture("midRestore", await command({ type: "restore", snapshot: mid }));
    assert.deepEqual(midRestored.state, detourMove.state); assert.deepEqual(midRestored.transforms.player, detourMove.transforms.player);
    const midRepeated = capture("midRepeat", await command({ type: "step", count: 1 }));
    assert.deepEqual(midRepeated.state, afterMid.state); assert.deepEqual(midRepeated.transforms.player, afterMid.transforms.player);
    const unreachable = capture("unreachable", await tap("u"));
    assert.match(unreachable.state.error, /TC_NAVIGATION_UNREACHABLE/); assert.deepEqual(route(unreachable), []);
    const stopped = capture("unreachableStep", await command({ type: "step", count: 1 }));
    assert.deepEqual(position(stopped), position(unreachable));
    const budget = capture("budget", await tap("c")); assert.match(budget.state.error, /TC_NAVIGATION_CAPACITY/);
    assert.deepEqual(position(budget), position(stopped));
    const recovered = capture("recovered", await tap("r")); assert.equal(recovered.state.error, ""); assert.ok(route(recovered).length > 0);
    const restored = capture("restore", await command({ type: "restore", snapshot: saved }));
    assert.deepEqual(restored.state, moved.state); assert.deepEqual(restored.transforms, moved.transforms);
    const restoredSnapshot = await command({ type: "snapshot" });
    assert.deepEqual(restoredSnapshot.runtime.plugins["$engine.navigation"], saved.runtime.plugins["$engine.navigation"]);
    const repeatedBlock = capture("blockAfterRestore", await tap("b")); assert.deepEqual(route(repeatedBlock), detour);
    let previous = repeatedBlock;
    for (let i = 1; i < detour.length; i++) {
      const start = position(previous);
      for (let tick = 1; tick <= 12; tick++) {
        const next = capture(`route${i}tick${tick}`, await command({ type: "step", count: 1 }));
        assertTransform(next);
        const delta = next.transforms.player.position.map((v: number, n: number) => v - previous.transforms.player.position[n]);
        assert.ok(Math.abs(Math.abs(delta[0]) + Math.abs(delta[2]) - 1 / 12) < 1e-6 && Math.abs(delta[1]) < 1e-6);
        assert.ok(Math.abs(delta[0]) < 1e-6 || Math.abs(delta[2]) < 1e-6);
        assert.equal(next.state.progress, tick === 12 ? 0 : tick);
        assert.deepEqual(position(next), tick === 12 ? detour[i] : start);
        assert.equal(next.state.cursor, tick === 12 ? i : i - 1);
        previous = next;
      }
      assert.equal(Math.abs(detour[i].x - start.x) + Math.abs(detour[i].y - start.y), 1);
    }
    assert.deepEqual(position(previous), { x: 6, y: 1 }); await screenshot("arrived");
    teardownAttempted = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const released = await withAutomationDeadline(() => activePage.waitForFunction(() => {
      const s = (window as any).__pelican.inspect();
      return !s.ready && s.resources.owned.entries === 0 && s.resources.owned.inFlightLoads === 0 && s.resources.owned.inFlightDisposals === 0;
    }, null, { timeout: 15000 }), 16000, "Navigation resources release");
    await released.dispose();
    report.teardown = await page.evaluate(() => { const s = (window as any).__pelican.inspect(); return { ready: s.ready, resources: s.resources, canvases: document.querySelectorAll("canvas").length, errors: s.errors }; });
    assert.equal(report.teardown.ready, false); assert.equal(report.teardown.resources.owned.entries, 0); assert.equal(report.teardown.canvases, 0);
    assert.deepEqual(report.teardown.errors, []); assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = error instanceof Error ? error.stack : String(error);
    if (page) try { report.failureObservation = await page.evaluate(() => ({ state: (window as any).__pelican?.inspect?.(), failure: (window as any).__pelicanFailure })); }
    catch (observationError) { report.errors.push({ kind: "observation", message: String(observationError) }); }
    throw error;
  } finally {
    if (page && !teardownAttempted) try { await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide"))); }
    catch (error) { report.errors.push({ kind: "pagehide", message: String(error) }); }
    try { await browser?.close(); } catch (error) { report.errors.push({ kind: "browser-close", message: String(error) }); }
    try { await server?.close(); } catch (error) { report.errors.push({ kind: "server-close", message: String(error) }); }
    try { if (child) await stopChild(child); } catch (error) { report.errors.push({ kind: "dev-close", message: String(error) }); }
    if (report.errors.length) report.passed = false;
    await writeFile(path.join(output, "navigation-game.json"), JSON.stringify(report, null, 2) + "\n");
    if (report.errors.length && !report.failure) throw new Error("Navigation probe observed errors; see report");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_NAVIGATION_PROBE: Reserve the GPU and pass --exclusive-gpu; this probe starts the game renderer.");
  const option = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const value = process.argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`TC_NAVIGATION_PROBE: ${name} requires a directory.`);
    return value;
  };
  const output = path.resolve(option("--output") ?? path.join(".pelican/navigation-game", String(Date.now())));
  runNavigationGameProbe(output, option("--installed-root")).then(report => console.log(JSON.stringify({ output, passed: report.passed, sourceIdentity: report.sourceIdentity?.sha256, installedIdentity: report.installedIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
