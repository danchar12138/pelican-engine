import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { doctor } from "./doctor.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { runFoundationProbe } from "./foundation-probe.ts";
import { attachControl } from "./control-server.ts";
import { createControlClient } from "./control-client.ts";
import { serveDist } from "./static-server.ts";
import { generateApiIndex } from "./api-index.ts";
import { verifyUnattended } from "./verify-unattended.ts";
import {
  automationLaunchOptions,
  automationURL,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activeManifest = JSON.parse(
  await readFile(path.join(root, "engine.manifest.json"), "utf8"),
);
if (activeManifest.milestone !== "M1" || activeManifest.version !== SDK_VERSION)
  throw new Error(
    "TC_VERIFY_MILESTONE: verify:m1 requires the matching M1 source release. Historical evidence will not be overwritten.",
  );
const evidence = path.join(root, "evidence/m1");
await mkdir(evidence, { recursive: true });
const exec = promisify(execFile);
const checks: {
  id: string;
  status: "passed" | "failed";
  evidence: string[];
  detail?: string;
}[] = [];
const redact = (value: string) =>
  value.replaceAll(root, "<engine>").replace(/C:\\Users\\[^\\\s]+/g, "<user>");
const save = (name: string, value: unknown) =>
  writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n");
async function check(id: string, operation: () => Promise<string[]>) {
  try {
    checks.push({ id, status: "passed", evidence: await operation() });
    console.log(JSON.stringify({ id, status: "passed" }));
  } catch (error) {
    const detail = redact(String(error));
    await mkdir(path.join(evidence, "attempts"), { recursive: true });
    await save(`attempts/${Date.now()}-${id}.json`, {
      id,
      detail,
      stdout: redact(String((error as { stdout?: string }).stdout ?? "")),
      stderr: redact(String((error as { stderr?: string }).stderr ?? "")),
    });
    checks.push({ id, status: "failed", evidence: [], detail });
    console.error(JSON.stringify({ id, status: "failed", detail }));
  }
}
await check("environment", async () => {
  const report = await doctor({ projectRoot: root });
  await save("environment.json", report);
  assert.equal(report.status, "succeeded");
  return ["evidence/m1/environment.json"];
});
await check("typecheck", async () => {
  const result = await exec(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    { cwd: root, timeout: 120000, maxBuffer: 4e6 },
  );
  await writeFile(
    path.join(evidence, "typecheck.txt"),
    redact(result.stdout + result.stderr) ||
      "Strict TypeScript check passed.\n",
  );
  return ["evidence/m1/typecheck.txt"];
});
await check("unit-tests", async () => {
  const files = (await readdir(path.join(root, "tests")))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => path.join(root, "tests", file));
  const result = await exec(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { cwd: root, timeout: 180000, maxBuffer: 12e6 },
  );
  await writeFile(
    path.join(evidence, "unit-tests.txt"),
    redact(result.stdout + result.stderr),
  );
  assert.match(result.stdout, /fail 0/);
  return ["evidence/m1/unit-tests.txt"];
});
let foundation: Awaited<ReturnType<typeof runFoundationProbe>> | undefined;
await check("compiler", async () => {
  foundation = await runFoundationProbe(root);
  await save("compiler.json", foundation.compiler);
  assert.equal(foundation.compiler.success, true);
  const index = await generateApiIndex(root);
  assert.ok(index.symbols.some((item) => item.name === "SystemContext"));
  return ["evidence/m1/compiler.json", "docs/api/index.json"];
});
for (const id of ["runtime", "scheduler", "resources"] as const)
  await check(id, async () => {
    assert.ok(foundation, "Foundation probe must run first");
    assert.equal(foundation[id].passed, true);
    await save(`${id}.json`, foundation[id]);
    return [`evidence/m1/${id}.json`];
  });

let server: Awaited<ReturnType<typeof createServer>> | undefined;
let controls: ReturnType<typeof attachControl> | undefined;
await check("protocol", async () => {
  server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(root, "examples/m1/.pelican/public"),
    logLevel: "silent",
    server: { port: 4373, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  controls = attachControl(server);
  // Prepare the actual served project; the CPU probe above deliberately used a separate output directory.
  await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "compile",
    ],
    { cwd: root, timeout: 60000, maxBuffer: 4e6 },
  );
  const client = createControlClient({ url: "http://127.0.0.1:4373/" });
  const initial = await client.send({ type: "inspect" });
  assert.equal(initial.status, "succeeded");
  const snapshot = await client.send({ type: "snapshot" });
  assert.equal(snapshot.status, "succeeded");
  assert.equal(
    (await client.send({ type: "recordStart" })).status,
    "succeeded",
  );
  assert.equal(
    (await client.send({ type: "input", key: "ArrowRight", pressed: true }))
      .status,
    "succeeded",
  );
  const after = await client.send({ type: "step", count: 30 });
  assert.equal(after.status, "succeeded");
  const afterState = after.data as any;
  assert.equal(afterState.runtime.scheduler.tick, 30);
  assert.equal(afterState.game.components.spinner.Progress.ticks, 30);
  assert.equal(afterState.game.transforms.spinner.position[0], -0.65);
  const capture = await client.send({ type: "capture" });
  assert.equal(capture.status, "succeeded");
  const image = capture.data as {
    base64: string;
    bytes: number;
    format: string;
  };
  const png = Buffer.from(image.base64, "base64");
  assert.equal(image.format, "png");
  assert.equal(png.length, image.bytes);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await writeFile(path.join(evidence, "live-control.png"), png);
  const trace = await client.send({ type: "recordStop" });
  assert.equal(trace.status, "succeeded");
  await client.send({ type: "step", count: 5 });
  const replay = await client.send({ type: "replay", trace: trace.data });
  assert.equal(replay.status, "succeeded");
  const replayed = await client.send({ type: "inspect" });
  assert.deepEqual(
    (replayed.data as any).runtime.records,
    afterState.runtime.records,
  );
  assert.deepEqual(
    (replayed.data as any).runtime.scheduler.random,
    afterState.runtime.scheduler.random,
  );
  const restored = await client.send({
    type: "restore",
    snapshot: snapshot.data,
  });
  assert.equal(restored.status, "succeeded");
  assert.equal((restored.data as any).runtime.scheduler.tick, 0);
  const invalid = await client.send({
    type: "setComponent",
    entity: "spinner",
    component: "Progress",
    value: { ticks: "wrong" },
  });
  assert.equal(invalid.status, "failed");
  const status = await client.status();
  assert.equal(status.status, "succeeded");
  assert.ok(status.data.tasks.some((item) => item.status === "failed"));
  const response = await fetch("http://127.0.0.1:4373/__pelican/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "step", count: -1 }),
  });
  assert.equal(response.status, 400);
  await save("protocol.json", {
    passed: true,
    initial,
    after,
    replay,
    restored,
    invalid,
    status,
    invalidHTTPStatus: response.status,
  });
  return ["evidence/m1/protocol.json", "evidence/m1/live-control.png"];
});

await check("unattended", async () => {
  const report = await verifyUnattended("http://127.0.0.1:4373/", () =>
    chromium.launch(automationLaunchOptions()),
  );
  await save("unattended.json", report);
  return ["evidence/m1/unattended.json"];
});

await check("render", async () => {
  assert.ok(server, "Dev server must start");
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const cdp = await browser.newBrowserCDPSession();
        const system = await cdp.send("SystemInfo.getInfo");
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
          deviceScaleFactor: 1,
        });
        const errors: string[] = [];
        const expectedFaultConsole: string[] = [];
        let injectingLoadFailure = false;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") {
            const text = `console: ${message.text()}`;
            if (
              injectingLoadFailure &&
              message.text().includes("503 (Service Unavailable)")
            )
              expectedFaultConsole.push(text);
            else errors.push(text);
          }
        });
        await withAutomationDeadline(() =>
          page.goto(automationURL("http://127.0.0.1:4373/"), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
        );
        await waitForEngine(page);
        const initial = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        assert.equal(initial.backend, "WebGPUBackend");
        assert.equal(initial.adapter.isFallbackAdapter, false);
        assert.equal(initial.triangleCount, 192);
        assert.equal(initial.runtime.world.entities, 4);
        await page.keyboard.press("ArrowRight");
        const input = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        assert.equal(input.game.transforms.spinner.position[0], -0.65);
        assert.equal(input.runtime.scheduler.tick, 1);
        const checkpoint = await page.evaluate(() =>
          (window as any).__pelican.snapshot(),
        );
        const dynamic = await page.evaluate(async () => {
          const api = (window as any).__pelican;
          await api.step(12);
          await api.mode("path");
          return {
            state: api.inspect(),
            pixels: await api.pixels(),
            compute: await api.compute("pulse", 1.25),
          };
        });
        assert.ok(dynamic.pixels.nonBlack > 5000);
        assert.equal(dynamic.state.runtime.scheduler.tick, 13);
        assert.equal(dynamic.state.game.components.spinner.Progress.events, 1);
        for (let i = 0; i < dynamic.compute.count; i++)
          assert.ok(
            Math.abs(dynamic.compute.values[i * 4] - Math.sin(1.25)) < 1e-6,
          );
        await page.screenshot({
          path: path.join(evidence, "path-runtime.png"),
        });
        const restored = await page.evaluate(async (value) => {
          const api = (window as any).__pelican;
          await api.restore(value);
          return api.inspect();
        }, checkpoint);
        assert.deepEqual(restored.runtime.records, input.runtime.records);
        assert.deepEqual(
          restored.runtime.scheduler.random,
          input.runtime.scheduler.random,
        );
        const invalidSnapshot = structuredClone(checkpoint);
        invalidSnapshot.runtime.scheduler.random.version = 99;
        const rejected = await page.evaluate(
          async (value) =>
            await (window as any).__pelican.command({
              type: "restore",
              snapshot: value,
            }),
          invalidSnapshot,
        );
        assert.equal(rejected.status, "failed");
        assert.deepEqual(
          (await page.evaluate(() => (window as any).__pelican.inspect()))
            .runtime.records,
          restored.runtime.records,
        );
        const reloads = await page.evaluate(async () => {
          const api = (window as any).__pelican;
          const results = [];
          for (let i = 0; i < 3; i++) {
            await api.loadGame();
            results.push(api.inspect().resources);
          }
          return results;
        });
        for (const result of reloads) {
          assert.equal(result.owned.entries, 2);
          assert.equal(result.owned.scopes, 1);
          assert.equal(result.owned.references, 2);
        }
        const beforeFailure = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        injectingLoadFailure = true;
        await page.route("**/generated/scene.ir.json*", (route) =>
          route.fulfill({ status: 503, body: "injected failure" }),
        );
        const loadFailure = await page.evaluate(async () => {
          try {
            await (window as any).__pelican.loadGame();
            return null;
          } catch (error) {
            return String(error);
          }
        });
        assert.ok(loadFailure);
        await page.unroute("**/generated/scene.ir.json*");
        const afterFailure = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        injectingLoadFailure = false;
        assert.deepEqual(
          afterFailure.runtime.records,
          beforeFailure.runtime.records,
        );
        assert.equal(afterFailure.resources.owned.scopes, 1);
        assert.equal(afterFailure.resources.owned.entries, 2);
        await page.evaluate(async () => {
          const api = (window as any).__pelican;
          await api.mode("raster");
          await api.step(3);
        });
        await page.screenshot({
          path: path.join(evidence, "raster-runtime.png"),
        });
        assert.deepEqual(errors, []);
        await save("render.json", {
          passed: true,
          backend: initial.backend,
          adapter: initial.adapter,
          headed: true,
          browser: browser.version(),
          gpu: {
            devices: (system.gpu as any).devices,
            featureStatus: (system.gpu as any).featureStatus,
          },
          initial,
          input,
          dynamic,
          restored,
          invalidSnapshotDiagnostic: rejected,
          resourceReloads: reloads,
          resourceFailure: {
            message: loadFailure,
            expectedFaultConsole,
            before: beforeFailure.resources,
            after: afterFailure.resources,
          },
          errors,
          limitations: [
            "Small foundation scene, not a production graphics quality or throughput claim",
            "Path tracing retains the explicitly experimental M0 integration",
          ],
        });
        return [
          "evidence/m1/render.json",
          "evidence/m1/raster-runtime.png",
          "evidence/m1/path-runtime.png",
        ];
      },
      120_000,
      "M1 render validation",
    );
  } finally {
    await browser.close();
  }
});
await controls?.close();
await server?.close();

await check("deploy", async () => {
  await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "build",
    ],
    { cwd: root, timeout: 120000, maxBuffer: 4e6 },
  );
  const staticServer = await serveDist(
    path.join(root, "dist"),
    4374,
    "/nested/m1/",
  );
  let browser: import("playwright").Browser | undefined;
  try {
    browser = await chromium.launch(automationLaunchOptions());
    const ownedBrowser = browser;
    return await withAutomationDeadline(
      async () => {
        const page = await ownedBrowser.newPage({
          viewport: { width: 960, height: 540 },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error")
            errors.push(`console: ${message.text()}`);
        });
        await withAutomationDeadline(() =>
          page.goto(staticServer.url, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
        );
        await waitForEngine(page, 30_000, { production: true });
        const state = await page.evaluate(() => ({
          control: typeof (window as any).__pelican,
          failureHook: typeof (window as any).__pelicanFailure,
          canvases: document.querySelectorAll("canvas").length,
        }));
        assert.equal(state.control, "undefined");
        assert.equal(state.failureHook, "undefined");
        assert.deepEqual(errors, []);
        assert.equal(
          (
            await page.request.get(
              new URL("__pelican/control", staticServer.url).href,
            )
          ).status(),
          404,
        );
        await page.screenshot({ path: path.join(evidence, "dist.png") });
        await save("deploy.json", {
          passed: true,
          base: "/nested/m1/",
          state,
          errors,
          independentStaticServer: true,
        });
        return ["evidence/m1/deploy.json", "evidence/m1/dist.png"];
      },
      120_000,
      "M1 production validation",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await staticServer.close();
    }
  }
});
await check("ai-workflow", async () => {
  const report = JSON.parse(
    await readFile(path.join(evidence, "ai-workflow.json"), "utf8"),
  );
  assert.equal(report.status, "passed");
  assert.equal(report.engineFilesModified, false);
  assert.equal(report.humanTechnicalSteps, 0);
  assert.equal(
    report.sourceIdentity.sha256,
    (await sourceFingerprint(root)).sha256,
  );
  assert.equal(report.independentContext, true);
  assert.ok(report.flows.some((flow: any) => flow.kind === "zip-no-git"));
  assert.ok(
    report.flows.some((flow: any) => flow.kind === "external-directory"),
  );
  for (const flow of report.flows) {
    assert.equal(flow.status, "passed");
    assert.ok(
      flow.commands.some(
        (command: any) => command.expectedFailure && command.exitCode !== 0,
      ),
    );
    for (const command of flow.commands)
      if (!command.expectedFailure) assert.equal(command.exitCode, 0);
    for (const file of flow.artifacts) {
      assert.ok(!path.isAbsolute(file) && !file.includes(".."));
      assert.ok((await readFile(path.join(root, file))).length);
    }
  }
  return [
    "evidence/m1/ai-workflow.json",
    ...report.flows.flatMap((flow: any) => flow.artifacts),
  ];
});
const status = checks.every((check) => check.status === "passed")
  ? "passed"
  : "failed";
await save("acceptance.json", {
  protocolVersion: "0.1.0",
  milestone: "M1",
  scope: "runtime-foundation",
  engineVersion: SDK_VERSION,
  status,
  recordedAt: new Date().toISOString(),
  sourceIdentity: await sourceFingerprint(root),
  checks,
  limitations: [
    "M1 establishes the runtime foundation, not the complete first-release capability matrix",
    "Incremental builds reuse whole-project artifacts and dev changes perform explicit cold reloads",
    "Native module imports retain the browser module cache; resource counts track ownership rather than OS/GPU leak freedom",
    "Production graphics, complete gameplay/physics/UI/audio/world systems remain subsequent milestones",
  ],
});
console.log(
  JSON.stringify(
    {
      milestone: "M1",
      status,
      checks: checks.map(({ id, status, detail }) => ({ id, status, detail })),
    },
    null,
    2,
  ),
);
if (status !== "passed") process.exitCode = 1;
