import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { decode } from "fast-png";
import { npmCommand } from "./doctor.ts";
import {
  graphicsLaunchArguments,
  withAutomationDeadline,
} from "./browser-session.ts";

/** Same assets/camera/settings on actual installed packages; no engine internals are patched. */
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const candidate = option("tarball");
if (!candidate)
  throw new Error(
    "Usage: npm run benchmark:render -- --tarball <candidate.tgz> [--baseline pelican-engine@1.2.0] [--width 960 --height 540] [--samples 5] [--output <directory>]",
  );
const width = Number(option("width", "960")),
  height = Number(option("height", "540")),
  count = Number(option("samples", "5"));
if (
  ![width, height, count].every(Number.isSafeInteger) ||
  width < 64 ||
  height < 64 ||
  width > 3840 ||
  height > 2160 ||
  count < 3 ||
  count > 30
)
  throw new Error(
    "TC_BENCHMARK_RANGE: Use dimensions 64..3840 x 64..2160 and 3..30 warm samples.",
  );
const output = path.resolve(option("output", ".pelican/benchmarks/render")!);
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(
  path.join(tmpdir(), "pelican-render-benchmark-"),
);
const execute = promisify(execFile),
  npm = npmCommand(root)!;
if (!npm) throw new Error("TC_BENCHMARK_NPM: npm JS CLI not available.");
const gallery = await readFile(path.join(root, "examples/m3/game.ts"), "utf8");
const room = await readFile(
  path.join(root, "examples/quality-room/game.ts"),
  "utf8",
);
const source = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const result: any = {
  format: "pelican.render-benchmark",
  version: 1,
  width,
  height,
  warmSamples: count,
  assetHashes: Object.fromEntries(
    await Promise.all(
      ["Fox.glb", "WaterBottle.glb"].map(async (name) => [
        name,
        source(await readFile(path.join(root, "examples/m3/assets", name))),
      ]),
    ),
  ),
  sourceHashes: { gallery: source(gallery), room: source(room) },
  packages: [],
  scope:
    "One actual adapter, same authored assets/camera/budgets. GPU timestamp intervals and protocol wall time are distinct; neither is reported as FPS. Screenshot MSE uses the engine's own high-sample image, not independent physical truth.",
};
const save = () =>
  writeFile(
    path.join(output, "results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: graphicsLaunchArguments(),
});
let port = 44800;
function mse(a: ReturnType<typeof decode>, b: ReturnType<typeof decode>) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let sum = 0,
    count = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++)
      for (let channel = 0; channel < 3; channel++) {
        sum +=
          ((a.data[(y * a.width + x) * a.channels + channel]! -
            b.data[(y * b.width + x) * b.channels + channel]!) /
            255) **
          2;
        count++;
      }
  const value = sum / count;
  assert.ok(Number.isFinite(value));
  return value;
}
try {
  for (const [label, specifier] of [
    ["baseline", option("baseline", "pelican-engine@1.2.0")!],
    ["candidate", path.resolve(candidate)],
  ] as const) {
    const directory = path.join(workspace, label);
    await mkdir(directory);
    await execute(
      npm.file,
      [
        ...npm.prefix,
        "--prefix",
        directory,
        "install",
        "--save-dev",
        "--save-exact",
        "--no-audit",
        "--no-fund",
        specifier,
      ],
      {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 4000000,
        windowsHide: true,
      },
    );
    const installed = path.join(directory, "node_modules/pelican-engine"),
      bin = path.join(installed, "lib/tools/npm/entry.js");
    const pkg = JSON.parse(
      await readFile(path.join(installed, "package.json"), "utf8"),
    );
    const report: any = {
      label,
      version: pkg.version,
      specifier,
      gallery: [],
      room: [],
    };
    result.packages.push(report);
    await save();
    for (const [name, text] of [
      ["gallery", gallery],
      ["room", room],
    ] as const) {
      const project = path.join(directory, name);
      await execute(process.execPath, [bin, "create", "--project", project], {
        cwd: directory,
        timeout: 30000,
        windowsHide: true,
      });
      await writeFile(path.join(project, "game.ts"), text);
      if (name === "gallery")
        await cp(
          path.join(root, "examples/m3/assets"),
          path.join(project, "assets"),
          { recursive: true },
        );
      const service = spawn(
        process.execPath,
        [bin, "dev", "--project", project, "--port", String(++port)],
        {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let log = "";
      service.stdout.on("data", (bytes) => (log += bytes));
      service.stderr.on("data", (bytes) => (log += bytes));
      const page = await browser.newPage({
        viewport:
          name === "gallery" ? { width, height } : { width: 480, height: 270 },
        deviceScaleFactor: 1,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await withAutomationDeadline(
          async () => {
            while (true) {
              try {
                if (
                  (
                    await fetch(`http://127.0.0.1:${port}/`, {
                      signal: AbortSignal.timeout(500),
                    })
                  ).ok
                )
                  break;
              } catch {}
              if (service.exitCode !== null) throw new Error(log);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          },
          60000,
          "benchmark dev startup",
        );
        const size = page.viewportSize()!;
        await page.goto(
          `http://127.0.0.1:${port}/?automation=1&width=${size.width}&height=${size.height}`,
        );
        await page.waitForFunction(
          () => document.documentElement.dataset.pelicanReady === "true",
          undefined,
          { timeout: 60000, polling: 100 },
        );
        const command = async (input: unknown) =>
          withAutomationDeadline(
            async () => {
              const response = await page.evaluate(
                (input) => (globalThis as any).__pelican.command(input),
                input,
              );
              assert.equal(
                response.status,
                "succeeded",
                JSON.stringify(response),
              );
              return response.data;
            },
            120000,
            "benchmark command",
          );
        const initial = await command({ type: "inspect" });
        assert.equal(initial.capabilities.backend, "webgpu");
        assert.equal(initial.adapter.isFallbackAdapter, false);
        report.adapter = initial.adapter;
        if (name === "gallery") {
          for (const mode of ["raster", "hybrid", "path"]) {
            const start = performance.now();
            if (mode === "raster") await command({ type: "mode", mode });
            else
              await command({
                type: "render",
                mode,
                samples: 1,
                denoise: true,
              });
            const coldWallMs = performance.now() - start;
            await command({ type: "step", count: 1 });
            const samples = [];
            for (let i = 0; i < count; i++) {
              const started = performance.now(),
                state = await command({ type: "step", count: 1 });
              const wallMs = performance.now() - started;
              const gpu =
                mode === "raster"
                  ? null
                  : await page.evaluate(() =>
                      (globalThis as any).__pelican.gpuTimeMs(),
                    );
              const surface = state.rendering.surface;
              samples.push({
                wallMs,
                gpu,
                triangles: state.triangleCount,
                captureMs: surface?.captureMs,
                updateAndUploadMs: surface?.uploadMs,
                uploadBytes: surface?.uploadBytes,
                tracerBytes: surface?.ownedBytes,
                temporalBytes: surface?.temporal?.bytes,
                denoiserBytes: surface?.denoiser?.bytes,
                emissiveSampling: surface?.emissiveSampling,
                metric: state.metrics.at(-1),
              });
            }
            report.gallery.push({
              mode,
              coldWallMs,
              settings: (await command({ type: "inspect" })).rendering.settings,
              samples,
            });
            await page
              .locator("canvas:visible")
              .first()
              .screenshot({
                path: path.join(output, `${label}-gallery-${mode}.png`),
              });
            await save();
          }
          // Equal scene pose, capped transport budget: report actual elapsed time
          // rather than implying sample counts alone are equivalent quality.
          await command({
            type: "render",
            mode: "path",
            samples: 64,
            denoise: false,
          });
          const reference = decode(
            await page
              .locator("canvas:visible")
              .first()
              .screenshot({
                path: path.join(output, `${label}-gallery-reference64.png`),
              }),
          );
          const transport = report.gallery
            .find((entry: any) => entry.mode === "path")
            .samples.map((entry: any) => entry.gpu?.frameMs)
            .filter((value: unknown) => typeof value === "number")
            .sort((a: number, b: number) => a - b);
          const median = transport[Math.floor(transport.length / 2)] ?? 400;
          const budgetMs = 400,
            samples = Math.max(
              1,
              Math.min(48, Math.floor((budgetMs * 0.7) / median)),
            );
          const started = performance.now();
          await command({
            type: "render",
            mode: "path",
            samples,
            denoise: true,
          });
          const wallMs = performance.now() - started;
          const image = decode(
            await page
              .locator("canvas:visible")
              .first()
              .screenshot({
                path: path.join(output, `${label}-gallery-budget.png`),
              }),
          );
          report.equalBudget = {
            targetWallMs: budgetMs,
            samples,
            wallMs,
            withinBudget: wallMs <= budgetMs,
            mseToOwn64Reference: mse(image, reference),
            scope:
              "Warm fixed-pose render after pipeline preparation; actual wall time includes filtering/presentation. Sample estimate is conservative and exceeding the target is reported.",
          };
          await save();
        } else {
          await command({
            type: "render",
            mode: "path",
            samples: 512,
            denoise: false,
          });
          const reference = decode(
            await page
              .locator("canvas:visible")
              .first()
              .screenshot({
                path: path.join(output, `${label}-reference512.png`),
              }),
          );
          for (const denoise of [false, true])
            for (const samples of [1, 16, 64]) {
              await command({ type: "render", mode: "path", samples, denoise });
              const image = decode(
                await page
                  .locator("canvas:visible")
                  .first()
                  .screenshot({
                    path: path.join(
                      output,
                      `${label}-room-${samples}-${denoise}.png`,
                    ),
                  }),
              );
              report.room.push({
                samples,
                denoise,
                mseToOwn512Reference: mse(image, reference),
              });
              await save();
            }
        }
        assert.deepEqual(errors, []);
        report.errors = errors;
      } finally {
        await page.close();
        service.kill();
        if (service.exitCode === null) await once(service, "exit");
        await writeFile(path.join(output, `${label}-${name}-server.log`), log);
      }
    }
  }
  console.log(
    JSON.stringify({
      output,
      packages: result.packages.map((item: any) => ({
        label: item.label,
        version: item.version,
        errors: item.errors,
      })),
    }),
  );
} finally {
  await browser.close();
  await save();
}
