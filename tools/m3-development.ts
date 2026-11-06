import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { doctor } from "./doctor.ts";
import { runSurfaceGpuProbe } from "./surface-gpu-probe.ts";
import { runSurfaceRayGpuProbe } from "./surface-ray-gpu-probe.ts";
import { runM3ImageProbe } from "./m3-image-probe.ts";
import { runM3QualityProbe } from "./m3-quality-probe.ts";
import { runM3RecoveryProbe } from "./m3-recovery-probe.ts";
import { runM3PerformanceProbe } from "./m3-performance-probe.ts";
import { runM3StaticProbe } from "./m3-static-probe.ts";
import { runM3RefractionProbe } from "./m3-refraction-probe.ts";
import { runMotionGpuProbe } from "./motion-gpu-probe.ts";
import { executeMaterialGraphComponent } from "./m3-material-graph-component.ts";
import { runM3TemporalProbe } from "./m3-temporal-probe.ts";
import { verifyUnattended } from "./verify-unattended.ts";
import { automationLaunchOptions } from "./browser-session.ts";
export function planM3Checks(args: readonly string[]) {
  const known = ["environment", "typecheck", "surface-numeric", "dynamic-ray-numeric", "material-graph-numeric", "motion-reprojection-numeric", "compile-and-serve", "unattended", "image-history-lights", "image-denoising-reference", "device-reconstruction", "native-1080p-observation", "native-1080p-temporal-observation", "dielectric-volume-transport", "temporal-motion-history", "production-static", "source-stability"];
  if (!args.length) return { mode: "full", list: false, known, requested: [...known], selected: [...known], automatic: [] as string[], omitted: [] as string[] };
  if (args.length === 1 && args[0] === "--list") return { mode: "list", list: true, known, requested: [], selected: [], automatic: [], omitted: [...known] };
  if (args.length !== 2 || args[0] !== "--checks" || !args[1].trim())
    throw new Error("TC_PROBE_SELECTION: Use --list or --checks <comma-separated-check-ids>; no omitted or unknown selection runs the full GPU suite.");
  const requested = [...new Set(args[1].split(",").map(value => value.trim()))];
  if (requested.some(id => !known.includes(id)))
    throw new Error("TC_PROBE_SELECTION: Unknown check ID. Use --list; available IDs: " + known.join(", "));
  const selected = new Set(requested);
  const browserChecks = ["unattended", "image-history-lights", "image-denoising-reference", "device-reconstruction", "native-1080p-observation", "native-1080p-temporal-observation"];
  if (browserChecks.some(id => selected.has(id))) selected.add("compile-and-serve");
  return { mode: "subset", list: false, known, requested, selected: known.filter(id => selected.has(id)), automatic: known.filter(id => selected.has(id) && !requested.includes(id)), omitted: known.filter(id => !selected.has(id)) };
}
const selection = planM3Checks(process.argv.slice(2));
if (selection.list) {
  console.log(JSON.stringify({ status: "succeeded", checks: selection.known, usage: "--checks <comma-separated-check-ids>", formalMilestoneAccepted: false }));
  process.exit(0);
}
const selectedChecks = new Set(selection.selected);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  manifest = JSON.parse(
    await readFile(path.join(root, "engine.manifest.json"), "utf8"),
  );
if (manifest.milestone !== "M3" || manifest.version !== SDK_VERSION)
  throw new Error("TC_PROBE_MILESTONE: Use matching M3 development sources.");
const output = path.join(root, ".pelican/m3-probes", Date.now().toString());
await mkdir(output, { recursive: true });
const identity = await sourceFingerprint(root),
  exec = promisify(execFile);
const checks: {
  id: string;
  status: "passed" | "failed";
  files: string[];
  detail?: string;
}[] = [];
const save = (name: string, value: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
async function check(id: string, operation: () => Promise<string[]>) {
  if (!selectedChecks.has(id)) return;
  try {
    const files = await operation();
    checks.push({ id, status: "passed", files });
    console.log(JSON.stringify({ id, status: "passed" }));
  } catch (error) {
    const detail = String(error);
    await mkdir(path.join(output, "attempts"), { recursive: true });
    await save("attempts/" + Date.now() + "-" + id + ".json", {
      id,
      detail,
      stdout: String((error as any).stdout ?? ""),
      stderr: String((error as any).stderr ?? ""),
    });
    checks.push({ id, status: "failed", files: [], detail });
    console.error(JSON.stringify({ id, status: "failed", detail }));
  }
}
await check("environment", async () => {
  const report = await doctor({
    projectRoot: root,
    taskId: "M3-development-environment",
  });
  await save("environment.json", report);
  assert.equal(report.status, "succeeded");
  return ["environment.json"];
});
await check("typecheck", async () => {
  const result = await exec(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
    { cwd: root, timeout: 120000, maxBuffer: 5e6 },
  );
  await writeFile(
    path.join(output, "typecheck.txt"),
    result.stdout + result.stderr || "Strict TypeScript check passed.\n",
  );
  return ["typecheck.txt"];
});
await check("surface-numeric", async () => {
  await runSurfaceGpuProbe(output);
  return ["surface-gpu.json"];
});
await check("dynamic-ray-numeric", async () => {
  await runSurfaceRayGpuProbe(output);
  await runSurfaceRayGpuProbe(path.join(output, "ordered"), true);
  return ["surface-ray-gpu.json", "ordered/surface-ray-gpu.json"];
});
await check("material-graph-numeric", async () => {
  await executeMaterialGraphComponent(root, path.join(output, "material-graph"), identity.sha256);
  return ["material-graph/material-graph-raw.json", "material-graph/material-graph-gpu.json", "material-graph/material-graph-semantic-verification.json"];
});
let server: Awaited<ReturnType<typeof createServer>> | undefined;
await check("motion-reprojection-numeric", async () => {
  const report = await runMotionGpuProbe(path.join(output, "motion"));
  assert.equal(report.passed, true, JSON.stringify(report.failures));
  return ["motion/motion-gpu.json", "motion/motion-gpu-packets.json"];
});
try {
  await check("compile-and-serve", async () => {
    const project = path.join(root, "examples/m3"),
      compiled = await compileProject({
        projectRoot: project,
        outDir: path.join(project, ".pelican/public/generated"),
        engineRoot: root,
      });
    await save("compiler.json", compiled.report);
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    server = await createServer({
      root,
      configFile: path.join(root, "vite.config.ts"),
      publicDir: path.join(project, ".pelican/public"),
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1", strictPort: true },
    });
    await server.listen();
    return ["compiler.json"];
  });
  const url = server?.resolvedUrls?.local[0];
  await check("unattended", async () => {
    assert.ok(url);
    await save(
      "unattended.json",
      await verifyUnattended(url, () =>
        chromium.launch(automationLaunchOptions()),
      ),
    );
    return ["unattended.json"];
  });
  await check("image-history-lights", async () => {
    assert.ok(url);
    await runM3ImageProbe(url, output);
    return [
      "image-integration.json",
      "raster.png",
      "path-16.png",
      "denoised-16.png",
      "hybrid-denoised.png",
      "restored-path.png",
      "lights-disabled.png",
    ];
  });
  await check("image-denoising-reference", async () => {
    assert.ok(url);
    await runM3QualityProbe(url, output, root, identity.sha256);
    return ["quality.json", "reference-256.png", "quality-raw.f32", "quality-filtered.f32", "quality-reference.f32"];
  });
  await check("device-reconstruction", async () => {
    assert.ok(url);
    await runM3RecoveryProbe(url, output);
    return ["recovery.json", "recovered-path.png"];
  });
  await check("native-1080p-observation", async () => {
    assert.ok(url);
    await runM3PerformanceProbe(url, output);
    return [
      "performance-1080p.json",
      "native-1080p-raster.png",
      "native-1080p-path.png",
      "native-1080p-hybrid.png",
    ];
  });
  await check("native-1080p-temporal-observation", async () => {
    assert.ok(url);
    await runM3PerformanceProbe(url, path.join(output, "native-temporal"), {
      denoise: true,
    });
    return [
      "native-temporal/performance-1080p.json",
      "native-temporal/native-1080p-path.png",
      "native-temporal/native-1080p-hybrid.png",
    ];
  });
} finally {
  await server?.close();
}
await check("dielectric-volume-transport", async () => {
  const project = path.join(root, "examples/refraction"),
    compiled = await compileProject({
      projectRoot: project,
      outDir: path.join(project, ".pelican/public/generated"),
      engineRoot: root,
    });
  await save("refraction-compiler.json", compiled.report);
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const volumeServer = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(project, ".pelican/public"),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", strictPort: true },
  });
  try {
    await volumeServer.listen();
    const volumeURL = volumeServer.resolvedUrls?.local[0];
    assert.ok(volumeURL);
    await runM3RefractionProbe(volumeURL, path.join(output, "refraction"));
  } finally {
    await volumeServer.close();
  }
  return ["refraction-compiler.json", "refraction/refraction-transport.json"];
});
await check("temporal-motion-history", async () => {
  const project = path.join(root, "examples/temporal"),
    compiled = await compileProject({
      projectRoot: project,
      outDir: path.join(project, ".pelican/public/generated"),
      engineRoot: root,
    });
  await save("temporal-compiler.json", compiled.report);
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const temporalServer = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(project, ".pelican/public"),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", strictPort: true },
  });
  try {
    await temporalServer.listen();
    const temporalURL = temporalServer.resolvedUrls?.local[0];
    assert.ok(temporalURL);
    await runM3TemporalProbe(temporalURL, path.join(output, "temporal"));
  } finally {
    await temporalServer.close();
  }
  return ["temporal-compiler.json", "temporal/temporal-integration.json"];
});
await check("production-static", async () => {
  await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "build",
    ],
    { cwd: root, timeout: 120000, maxBuffer: 5e6 },
  );
  await runM3StaticProbe(path.join(root, "dist"), output);
  return [
    "static-integration.json",
    "production-path.png",
    "production-hybrid.png",
  ];
});
await check("source-stability", async () => {
  assert.equal((await sourceFingerprint(root)).sha256, identity.sha256);
  await save("source.json", identity);
  return ["source.json"];
});
const status = checks.every((check) => check.status === "passed")
  ? "passed"
  : "failed";
await save("development-report.json", {
  protocolVersion: "0.1.0",
  milestone: "M3",
  engineVersion: SDK_VERSION,
  status,
  scope: "selected-render-development-probes",
  formalMilestoneAccepted: false,
  recordedAt: new Date().toISOString(),
  sourceIdentity: identity,
  selection,
  checks,
  openItems: [
    "Closed-volume transmission is integrated, but complete physical material, raster thickness, lighting/caustic, dynamic-volume and recovery/precision matrices remain unaccepted.",
    "Temporal primary motion/history filtering is integrated, but the full physical/ghosting/noise/camera/dynamic/resource quality matrix and custom graphics interfaces remain unaccepted.",
    "Native 1080p path/hybrid timings are observations, not accepted performance. Current recorded scene is still slow; no silent resolution/feature reduction is allowed.",
    "Independent AI M3 workflow, full image/quality/compatibility/resource matrix and release gate/profile are not complete.",
  ],
});
console.log(
  JSON.stringify(
    {
      scope: "development only",
      status,
      formalMilestoneAccepted: false,
      selection,
      output: path.relative(root, output),
      checks,
    },
    null,
    2,
  ),
);
if (status !== "passed") process.exitCode = 1;
