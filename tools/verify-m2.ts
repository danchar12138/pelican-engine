import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { compileProject } from "../packages/compiler/src/index.ts";
import { inspectAsset } from "../packages/assets/src/index.ts";
import { optimizeModel } from "../packages/assets/src/optimize.ts";
import { doctor } from "./doctor.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { runM2Journey } from "./m2-browser-probe.ts";
import { runM2Deployment } from "./m2-deploy-probe.ts";
import { runM2Performance } from "./m2-performance-probe.ts";
import { runM2Physics } from "./m2-physics-probe.ts";
import { runUIRisk } from "./ui-risk-probe.ts";
import { verifyUnattended } from "./verify-unattended.ts";
import { automationLaunchOptions } from "./browser-session.ts";
import { attachControl } from "./control-server.ts";
import { createControlClient } from "./control-client.ts";
import { generateApiIndex } from "./api-index.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "engine.manifest.json"), "utf8"),
);
if (manifest.milestone !== "M2" || manifest.version !== SDK_VERSION)
  throw new Error(
    "TC_VERIFY_MILESTONE: verify:m2 requires matching M2 sources.",
  );
const evidence = path.join(root, "evidence/m2"),
  project = path.join(root, "examples/m2");
await mkdir(evidence, { recursive: true });
const initialIdentity = await sourceFingerprint(root),
  exec = promisify(execFile);
const checks: {
  id: string;
  status: "passed" | "failed";
  evidence: string[];
  detail?: string;
}[] = [];
const redact = (text: string) =>
  text
    .replaceAll(root, "<engine>")
    .replace(/C:[\\/]Users[\\/][^\\/\s]+/gi, "<user>");
const save = (file: string, data: unknown) =>
  writeFile(path.join(evidence, file), JSON.stringify(data, null, 2) + "\n");
async function check(id: string, operation: () => Promise<string[]>) {
  try {
    const files = await operation();
    checks.push({ id, status: "passed", evidence: files });
    console.log(JSON.stringify({ id, status: "passed" }));
  } catch (error) {
    const detail = redact(String(error));
    await mkdir(path.join(evidence, "attempts"), { recursive: true });
    await save("attempts/" + Date.now() + "-" + id + ".json", {
      id,
      detail,
      stdout: redact(String((error as any).stdout ?? "")),
      stderr: redact(String((error as any).stderr ?? "")),
    });
    checks.push({ id, status: "failed", evidence: [], detail });
    console.error(JSON.stringify({ id, status: "failed", detail }));
  }
}
async function runTests(names: string[], out: string, browser = false) {
  const result = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      ...names.map((f) => path.join(root, "tests", f)),
    ],
    {
      cwd: root,
      timeout: 180000,
      maxBuffer: 20e6,
      env: {
        ...process.env,
        ...(browser ? { PELICAN_MODEL_BROWSER: "1" } : {}),
      },
    },
  );
  await writeFile(
    path.join(evidence, out),
    redact(result.stdout + result.stderr),
  );
  assert.match(result.stdout, /fail 0/);
  assert.match(result.stdout, /skipped 0/);
  return ["evidence/m2/" + out];
}
await check("environment", async () => {
  const report = await doctor({ projectRoot: root });
  await save("environment.json", report);
  assert.equal(report.status, "succeeded");
  return ["evidence/m2/environment.json"];
});
await check("typecheck", async () => {
  const result = await exec(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    { cwd: root, timeout: 120000, maxBuffer: 5e6 },
  );
  await writeFile(
    path.join(evidence, "typecheck.txt"),
    redact(result.stdout + result.stderr) ||
      "Strict TypeScript check passed.\n",
  );
  return ["evidence/m2/typecheck.txt"];
});
await check("unit-tests", async () =>
  runTests(
    (await readdir(path.join(root, "tests"))).filter((f) =>
      f.endsWith(".test.ts"),
    ),
    "unit-tests.txt",
    true,
  ),
);
await check("compiler", async () => {
  const result = await compileProject({
    projectRoot: project,
    outDir: path.join(project, ".pelican/public/generated"),
    engineRoot: root,
  });
  await save("compiler.json", result.report);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  await generateApiIndex(root);
  return ["evidence/m2/compiler.json", "docs/api/index.json"];
});
await check("assets", async () => {
  const fox = await inspectAsset(path.join(project, "assets/Fox.glb"), "model"),
    bottle = await inspectAsset(
      path.join(project, "assets/WaterBottle.glb"),
      "model",
    ),
    audio = await inspectAsset(path.join(project, "assets/chime.wav"), "audio");
  assert.equal(fox.skinCount, 1);
  assert.equal(fox.animationCount, 3);
  assert.equal(bottle.textureCount, 4);
  assert.equal(audio.duration, 0.45);
  const optimization = await optimizeModel(
    path.join(project, "assets/Fox.glb"),
    path.join(root, ".pelican/m2-optimized/fox-" + Date.now() + ".glb"),
  );
  assert.ok(optimization.bytesSaved > 0);
  await save("assets.json", { passed: true, fox, bottle, audio });
  await save("optimization.json", optimization);
  return [
    "evidence/m2/assets.json",
    "evidence/m2/optimization.json",
    ...(await runTests(
      [
        "assets.test.ts",
        "compiler-assets.test.ts",
        "asset-optimization.test.ts",
      ],
      "asset-tests.txt",
    )),
  ];
});
await check("physics", async () => {
  const files = await runTests(["physics.test.ts"], "physics-tests.txt");
  await runM2Physics(root, evidence);
  return [
    ...files,
    "evidence/m2/kinematic-regression.json",
    "evidence/m2/kinematic-contact.png",
    "evidence/m2/kinematic-open.png",
  ];
});
await check("runtime", async () =>
  runTests(
    ["runtime-host.test.ts", "game-services.test.ts", "models.test.ts"],
    "runtime-tests.txt",
    true,
  ),
);
await check("ui-prototype", async () => {
  await runUIRisk(root, evidence);
  return [
    "evidence/m2/ui-prototype.json",
    "evidence/m2/ui-world-occluded.png",
    "evidence/m2/ui-composition.png",
    "evidence/m2/ui-focus-world.png",
  ];
});
let server: Awaited<ReturnType<typeof createServer>> | undefined,
  controls: ReturnType<typeof attachControl> | undefined;
try {
  await check("dev-server", async () => {
    server = await createServer({
      root,
      configFile: path.join(root, "vite.config.ts"),
      publicDir: path.join(project, ".pelican/public"),
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1", strictPort: true },
    });
    await server.listen();
    controls = attachControl(server);
    return ["evidence/m2/compiler.json"];
  });
  const url = server?.resolvedUrls?.local[0];
  await check("protocol", async () => {
    assert.ok(url);
    const client = createControlClient({ url });
    const initial = await client.send({ type: "inspect" });
    assert.equal(initial.status, "succeeded");
    const step = await client.send({ type: "step", count: 3 });
    assert.equal(step.status, "succeeded");
    const capture = await client.send({ type: "capture" });
    assert.equal(capture.status, "succeeded");
    const png = Buffer.from((capture.data as any).base64, "base64");
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    await writeFile(path.join(evidence, "control.png"), png);
    await save("protocol.json", {
      passed: true,
      initial,
      step,
      captureBytes: png.length,
    });
    return ["evidence/m2/protocol.json", "evidence/m2/control.png"];
  });
  await check("unattended", async () => {
    assert.ok(url);
    const report = await verifyUnattended(url, () =>
      chromium.launch(automationLaunchOptions()),
    );
    await save("unattended.json", report);
    return ["evidence/m2/unattended.json"];
  });
  await check("render", async () => {
    assert.ok(url);
    const report = await runM2Journey(url, evidence);
    await runM2Performance(url, evidence);
    await save("render.json", report);
    return [
      "evidence/m2/render.json",
      "evidence/m2/journey.json",
      "evidence/m2/first-relic.png",
      "evidence/m2/all-relics.png",
      "evidence/m2/sanctuary.png",
      "evidence/m2/dynamic-prefabs.png",
      "evidence/m2/performance.json",
      "evidence/m2/native-1080p.png",
    ];
  });
} finally {
  await controls?.close();
  await server?.close();
}
await check("deploy", async () => {
  await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "build",
    ],
    { cwd: root, timeout: 120000, maxBuffer: 5e6 },
  );
  const report = await runM2Deployment(path.join(root, "dist"), evidence);
  assert.equal(report.passed, true);
  return ["evidence/m2/deploy.json", "evidence/m2/dist.png"];
});
await check("ai-workflow", async () => {
  const report = JSON.parse(
    await readFile(path.join(evidence, "ai-workflow.json"), "utf8"),
  );
  assert.equal(report.milestone, "M2");
  assert.equal(report.engineVersion, SDK_VERSION);
  assert.equal(report.status, "passed");
  assert.equal(report.engineFilesModified, false);
  assert.equal(report.humanTechnicalSteps, 0);
  assert.equal(report.independentContext, true);
  assert.equal(report.sourceIdentity.sha256, initialIdentity.sha256);
  assert.ok(report.flows.some((f: any) => f.kind === "zip-no-git"));
  assert.ok(report.flows.some((f: any) => f.kind === "external-directory"));
  for (const flow of report.flows) {
    assert.equal(flow.status, "passed");
    assert.equal(flow.engineFilesModified, false);
    assert.equal(flow.humanTechnicalSteps, 0);
    assert.ok(typeof flow.task === "string" && flow.task.length > 20);
    assert.ok(flow.commands.length >= 10);
    assert.ok(
      flow.verification?.gameplayChanged === true &&
        flow.verification?.gpuRendered === true &&
        flow.verification?.distColdStart === true,
    );
    assert.ok(
      flow.commands.some((c: any) => c.expectedFailure && c.exitCode !== 0),
    );
    for (const command of flow.commands)
      if (!command.expectedFailure) assert.equal(command.exitCode, 0);
    for (const artifact of flow.artifacts) {
      assert.ok(
        typeof artifact === "string" &&
          !path.isAbsolute(artifact) &&
          !artifact.split(/[\\/]/).includes(".."),
      );
      assert.ok((await readFile(path.join(root, artifact))).length);
    }
  }
  return [
    "evidence/m2/ai-workflow.json",
    ...report.flows.flatMap((f: any) => f.artifacts),
  ];
});
await check("source-freeze", async () => {
  assert.equal(
    (await sourceFingerprint(root)).sha256,
    initialIdentity.sha256,
    "Executable source changed during verification; freeze and rerun.",
  );
  return ["evidence/m2/compiler.json"];
});
const status = checks.every((c) => c.status === "passed") ? "passed" : "failed";
await save("acceptance.json", {
  protocolVersion: "0.1.0",
  milestone: "M2",
  scope: "playable-game-slice",
  engineVersion: SDK_VERSION,
  status,
  recordedAt: new Date().toISOString(),
  sourceIdentity: initialIdentity,
  checks,
  limitations: [
    "M2 is a playable game slice and asset pipeline prerelease; M3-M8 capabilities are not complete.",
    "Textured GLB content currently uses raster. Full glTF material hybrid/path tracing is M3 work.",
    "Asset inspection supports self-contained core GLB, baseline PNG/JPEG and PCM/float WAV. Extensions, compressed mesh/texture pipelines and other audio formats remain explicit gaps.",
    "Physics snapshots use validated operation-history reconstruction, bounded to 100000 operations per scene; sustained-game checkpoint optimization remains required.",
    "Basic text/progress/button UI and buffer audio are M2 subsets; the complete 2D/UI/audio module matrix remains M6 work.",
    "Current visuals and timings establish behavior only on the recorded machine and load, not universal high-quality or performance acceptance.",
  ],
});
console.log(JSON.stringify({ milestone: "M2", status, checks }, null, 2));
if (status !== "passed") process.exitCode = 1;
