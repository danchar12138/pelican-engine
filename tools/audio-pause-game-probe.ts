import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";

async function installedIdentity(project: string) {
  const packageRoot = path.join(project, "node_modules", "pelican-engine");
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "pelican-engine");
  const sdkEntry = typeof pkg.exports?.["."] === "string" ? pkg.exports["."] : pkg.exports?.["."]?.import;
  assert.equal(typeof sdkEntry, "string", "Installed package has no SDK import entry");
  const sdk = await import(pathToFileURL(path.resolve(packageRoot, sdkEntry)).href);
  assert.equal(typeof sdk.SDK_VERSION, "string", "Installed SDK has no version");
  const projectPackage = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8")
    .then(text => JSON.parse(text), error => { if (error.code === "ENOENT") return undefined; throw error; });
  const lockEntry = lock?.packages?.["node_modules/pelican-engine"] ?? lock?.dependencies?.["pelican-engine"];
  const distribution = await readFile(path.join(packageRoot, "distribution.json"), "utf8")
    .then(text => JSON.parse(text), error => { if (error.code === "ENOENT") return undefined; throw error; });
  return { packageRoot, packageVersion: pkg.version, sdkVersion: sdk.SDK_VERSION, distributionVersion: distribution?.version ?? null,
    tarball: { resolved: lockEntry?.resolved ?? null, integrity: lockEntry?.integrity ?? null, version: lockEntry?.version ?? null },
    declared: projectPackage.dependencies?.["pelican-engine"] ?? projectPackage.devDependencies?.["pelican-engine"] ?? null,
    bin: path.resolve(packageRoot, typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pelican) };
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

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
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

export async function runAudioPauseGameProbe(output: string, installedRoot?: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const project = path.join(root, "examples/audio-pause");
  await mkdir(output, { recursive: true });
  const report: any = { scope: "game audio pause/resume; native Web Audio node calls, not speaker output", passed: false, errors: [], steps: {} };
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    let serverUrl: string;
    if (installedRoot) {
      const installedProject = path.resolve(installedRoot);
      const identity = await installedIdentity(installedProject);
      report.installedIdentity = identity;
      const port = await freePort();
      child = spawn(process.execPath, [identity.bin, "dev", "--project", installedProject, "--port", String(port)], {
        cwd: installedProject, env: { ...process.env, npm_config_offline: "true" }, windowsHide: true, stdio: "pipe",
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
          try { message = JSON.parse(stdout); } catch { /* Wait for the complete JSON envelope. */ }
          if (message?.status === "failed") throw new Error(`Installed dev failed: ${stdout} ${stderr}`);
          if (message?.status === "running") return message;
          if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Installed dev exited: ${stdout} ${stderr}`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }, 30000, "Installed dev server startup");
      report.dev = running;
      const url = new URL(running.data?.url);
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(Number(url.port), port);
      serverUrl = url.href;
    } else {
      report.sourceIdentity = await sourceFingerprint(root);
      const compiled = await compileProject({ engineRoot: root, projectRoot: project, outDir: path.join(project, ".pelican/public/generated") });
      report.compile = { success: compiled.success, diagnostics: compiled.diagnostics };
      assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
      server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), publicDir: path.join(project, ".pelican/public"), logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
      await server.listen();
      serverUrl = server.resolvedUrls!.local[0];
    }
    browser = await chromium.launch(automationLaunchOptions());
    page = await browser.newPage({ viewport: { width: 320, height: 240 } });
    const activePage = page;
    const allowedOrigin = new URL(serverUrl).origin;
    await page.route("**/*", route => {
      const request = new URL(route.request().url());
      return request.origin === allowedOrigin ? route.continue() : route.abort();
    });
    report.networkPolicy = { browser: "only local development server origin allowed", origin: allowedOrigin };
    page.on("pageerror", error => report.errors.push({ kind: "pageerror", message: error.message }));
    page.on("console", message => { if (message.type() === "error") report.errors.push({ kind: "console", message: message.text() }); });
    await page.addInitScript(() => {
      const events: any[] = [], ids = new WeakMap<AudioBufferSourceNode, number>();
      let next = 0;
      const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start = function(when, offset, duration) {
        const id = ++next; ids.set(this, id);
        events.push({ action: "start", id, when, offset: offset ?? 0, duration: this.buffer?.duration, loop: this.loop, contextTime: this.context.currentTime });
        return duration === undefined ? start.call(this, when, offset) : start.call(this, when, offset, duration);
      };
      AudioBufferSourceNode.prototype.stop = function(when) {
        events.push({ action: "stop", id: ids.get(this) ?? null, when: when ?? 0, contextTime: this.context.currentTime });
        return stop.call(this, when);
      };
      (window as any).__audioProbeEvents = events;
    });
    const target = new URL(serverUrl); target.search = "automation=1&width=320&height=240";
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    await page.keyboard.press("Shift");
    await page.waitForFunction(() => (window as any).__pelican.inspect().gameplay?.audioDevice === "running", null, { timeout: 10000 });
    const command = async (input: unknown) => {
      const result = await withAutomationDeadline(() => activePage.evaluate(async input => (window as any).__pelican.command(input), input), 30000, "audio pause game command");
      if (result.status !== "succeeded") report.errors.push({ kind: "command", input, result });
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      return result.data;
    };
    const capture = async (name: string, state: any) => {
      const nodes = await activePage.evaluate(() => (window as any).__audioProbeEvents.slice());
      report.steps[name] = { tick: state.tick, audio: state.gameplay?.audio, audioDevice: state.gameplay?.audioDevice, decodedSounds: state.gameplay?.decodedSounds, diagnostics: state.gameplay?.diagnostics, component: state.game?.components?.state?.AudioState, resources: state.resources, errors: state.errors, nodes };
      return report.steps[name];
    };
    const tap = async (key: string) => { await command({ type: "input", key, pressed: true }); await command({ type: "input", key, pressed: false }); return command({ type: "step", count: 1 }); };
    const initial = await capture("initial", await command({ type: "inspect" }));
    assert.equal(initial.decodedSounds, 1);
    const play = await capture("play", await tap("p"));
    assert.equal(play.component.error, "");
    const { target: targetId, control: controlId } = play.component;
    assert.ok(targetId && controlId && targetId !== controlId);
    assert.equal(play.audio.voices.length, 2);
    assert.equal(play.audio.voices[0].bus, "music");
    assert.equal(play.audio.voices[1].bus, "effects");
    assert.equal(play.audioDevice, "running", "AudioContext not running; native playback nodes cannot be observed");
    const starts = (step: any) => step.nodes.filter((e: any) => e.action === "start");
    const stops = (step: any) => step.nodes.filter((e: any) => e.action === "stop");
    assert.equal(starts(play).length, 2, "Expected two real source starts");
    const targetNode = starts(play)[0].id, controlNode = starts(play)[1].id;
    const bus = await capture("busVolume", await tap("m"));
    assert.equal(bus.audio.busVolumes.find((v: any) => v.id === "music").volume, 0.25);
    assert.equal(bus.audio.busVolumes.find((v: any) => v.id === "effects").volume, 1);
    assert.equal(starts(bus).length, 2, "Changing bus gain must not restart voices");
    const unmuted = await capture("busRestore", await tap("u"));
    assert.equal(unmuted.audio.busVolumes.find((v: any) => v.id === "music").volume, 1);
    assert.equal(starts(unmuted).length, 2, "Restoring bus gain must not restart voices");
    const paused = await capture("pause", await tap("a"));
    const voice = (step: any, id: string) => step.audio.voices.find((v: any) => v.id === id);
    assert.equal(typeof voice(paused, targetId).pausedAt, "number");
    assert.ok(stops(paused).some((e: any) => e.id === targetNode));
    assert.ok(!stops(paused).some((e: any) => e.id === controlNode));
    const stepped = await capture("pausedStep", await command({ type: "step", count: 30 }));
    const elapsed = (step: any, id: string) => { const v = voice(step, id); return (v.pausedAt ?? step.tick) - v.startedAt - (v.pausedTicks ?? 0); };
    assert.equal(elapsed(stepped, targetId), elapsed(paused, targetId));
    assert.ok(elapsed(stepped, controlId) > elapsed(paused, controlId));
    assert.equal(starts(stepped).length, starts(paused).length);
    assert.ok(!stops(stepped).some((e: any) => e.id === controlNode));
    const snapshot = await command({ type: "snapshot" });
    report.snapshot = snapshot;
    await capture("snapshot", await command({ type: "inspect" }));
    const beforeRestore = await capture("preRestoreResume", await tap("r"));
    const restored = await capture("restore", await command({ type: "restore", snapshot }));
    assert.equal(restored.component.target, targetId); assert.equal(restored.component.control, controlId);
    assert.equal(typeof voice(restored, targetId).pausedAt, "number");
    assert.equal(elapsed(restored, targetId), elapsed(stepped, targetId));
    const restoreStarts = starts(restored), restoredControl = restoreStarts[restoreStarts.length - 1];
    assert.ok(restoredControl && restoreStarts.length === starts(beforeRestore).length + 1, "Restore must produce exactly one observable control node");
    const resumed = await capture("resume", await tap("r"));
    assert.equal(voice(resumed, targetId).pausedAt, null);
    assert.equal(starts(resumed).length, restoreStarts.length + 1);
    assert.ok(!stops(resumed).slice(stops(restored).length).some((e: any) => e.id === restoredControl.id), "Resume restarted control source");
    const resumedNode = starts(resumed).at(-1);
    const expectedOffset = (elapsed(resumed, targetId) / 60) % resumedNode.duration;
    assert.ok(Math.abs(resumedNode.offset - expectedOffset) < 0.04, JSON.stringify({ expectedOffset, resumedNode }));
    const stopped = await capture("stop", await tap("s"));
    assert.equal(stopped.audio.voices.length, 0);
    assert.ok(stops(stopped).some((e: any) => e.id === resumedNode.id));
    assert.ok(stops(stopped).some((e: any) => e.id === restoredControl.id));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    report.teardown = await page.evaluate(() => { const state = (window as any).__pelican.inspect(); return { ready: state.ready, resources: state.resources, errors: state.errors }; });
    assert.equal(report.teardown.ready, false);
    assert.equal(report.teardown.resources.owned.entries, 0);
    assert.deepEqual(report.errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = error instanceof Error ? error.stack : String(error);
    if (page) {
      try { report.failureObservation = await page.evaluate(() => ({ nodes: (window as any).__audioProbeEvents, state: (window as any).__pelican?.inspect?.(), failure: (window as any).__pelicanFailure })); }
      catch (observationError) { report.errors.push({ kind: "observation", message: String(observationError) }); }
    }
    throw error;
  } finally {
    try { await browser?.close(); } catch (error) { report.errors.push({ kind: "browser-close", message: String(error) }); }
    try { await server?.close(); } catch (error) { report.errors.push({ kind: "server-close", message: String(error) }); }
    try { if (child) await stopChild(child); } catch (error) { report.errors.push({ kind: "dev-close", message: String(error) }); }
    if (report.errors.length) report.passed = false;
    await writeFile(path.join(output, "audio-pause-game.json"), JSON.stringify(report, null, 2) + "\n");
    if (report.errors.some((error: any) => ["browser-close", "server-close", "dev-close"].includes(error.kind))) throw new Error("Audio probe cleanup failed; see report");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_AUDIO_PROBE: Reserve the GPU and pass --exclusive-gpu; this probe starts the game renderer.");
  const i = process.argv.indexOf("--output");
  const installedIndex = process.argv.indexOf("--installed-root");
  if (installedIndex >= 0 && (!process.argv[installedIndex + 1] || process.argv[installedIndex + 1].startsWith("--"))) throw new Error("TC_AUDIO_PROBE: --installed-root requires an npm project directory.");
  const output = path.resolve(i >= 0 ? process.argv[i + 1] : ".pelican/audio-pause/" + Date.now());
  runAudioPauseGameProbe(output, installedIndex >= 0 ? process.argv[installedIndex + 1] : undefined).then(report => console.log(JSON.stringify({ output, passed: report.passed, sourceIdentity: report.sourceIdentity?.sha256, installedIdentity: report.installedIdentity }))).catch(error => { console.error(error); process.exitCode = 1; });
}
