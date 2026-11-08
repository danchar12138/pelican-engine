import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { npmCommand } from "../doctor.ts";
import { serveDist } from "../static-server.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "../browser-session.ts";
import { artifacts, root, staging } from "./build.ts";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import { verifyRegistryInstallLock } from "./verify-registry.ts";

const execute = promisify(execFile);
const npm = npmCommand(root);
if (!npm) throw new Error("npm JS CLI is required for package smoke tests");
const directory = await mkdtemp(
  path.join(tmpdir(), "pelican npm \u6e38\u620f-"),
);
const probeRoot = path.join(directory, ".pelican/npm-probe");
const artifact = (name: string) => path.join(probeRoot, name);
const offline = {
  ...process.env,
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:9",
  npm_config_audit: "false",
  npm_config_fund: "false",
};
const run = async (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = offline,
) => {
  try {
    return (
      await execute(file, args, {
        cwd: directory,
        env,
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${file} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? result.message}`,
    );
  }
};
const npmRun = (args: string[], env: NodeJS.ProcessEnv = offline) =>
  run(npm.file, [...npm.prefix, "--prefix", directory, ...args], env);

try {
  const tarball = path.join(artifacts, `pelican-engine-${SDK_VERSION}.tgz`);
  const packed = JSON.parse(
    await execute(
      npm.file,
      [...npm.prefix, "pack", staging, "--dry-run", "--json"],
      { cwd: root, env: offline },
    ).then((r) => r.stdout),
  )[0];
  assert.equal(packed.name, "pelican-engine");
  assert.equal(packed.filename, `pelican-engine-${SDK_VERSION}.tgz`);
  for (const item of packed.files) {
    assert.ok(
      !/\.map$|(^|\/)(?:evidence|examples)\//.test(item.path),
      item.path,
    );
    assert.ok(
      !item.path.endsWith(".ts") || item.path.endsWith(".d.ts"),
      item.path,
    );
    assert.ok(
      !/\.(?:glb|gltf|png|jpg|jpeg|webp|hdr|exr|wav|ogg|mp3|bin|wasm)$/i.test(
        item.path,
      ),
      item.path,
    );
  }
  assert.ok(packed.files.some((f: { path: string }) => f.path === "LICENSE"));
  assert.ok(
    packed.files.some(
      (f: { path: string }) => f.path === "licenses/three/LICENSE",
    ),
  );
  assert.ok(
    packed.files.some(
      (f: { path: string }) =>
        f.path === "licenses/@dimforge/rapier3d-compat/LICENSE",
    ),
  );
  for (const name of ["fast-png", "fflate", "iobuffer", "ngraph.path"])
    assert.ok(packed.files.some((f: { path: string }) => f.path === `licenses/${name}/LICENSE`));
  assert.deepEqual(await readdir(directory), []);
  const registryInstall = process.argv.includes("--registry-install");
  const installEnv = process.argv.includes("--online-install") || registryInstall
    ? { ...process.env, npm_config_offline: "false", npm_config_registry: "https://registry.npmjs.org", npm_config_audit: "false", npm_config_fund: "false" }
    : { ...offline, npm_config_registry: "https://registry.npmjs.org" };
  await npmRun(
    [
      "install",
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      registryInstall ? `pelican-engine@${SDK_VERSION}` : tarball,
    ],
    installEnv,
  );
  const installed = path.join(directory, "node_modules/pelican-engine");
  if (registryInstall) {
    const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
    verifyRegistryInstallLock(lock, SDK_VERSION, await readFile(tarball));
  }
  const bin = path.join(installed, "lib/tools/npm/entry.js");
  const cli = async (...args: string[]) =>
    JSON.parse(await run(process.execPath, [bin, ...args]));
  const api = await cli("api");
  const apiSymbol = await cli("api", "--symbol", "defineGame");
  const installedIndex = JSON.parse(
    await readFile(path.join(installed, "docs/api/index.json"), "utf8"),
  );
  assert.equal(api.data.symbols, installedIndex.symbols.length);
  assert.deepEqual(
    apiSymbol.data.symbols,
    installedIndex.symbols.filter((symbol: { name: string }) => symbol.name === "defineGame"),
  );
  assert.ok(apiSymbol.data.symbols.length > 0);
  try {
    await execute(process.execPath, [bin, "api", "--symbol", "NotAPublicSymbol"], {
      cwd: directory, env: offline, timeout: 120_000,
    });
    assert.fail("Unknown API symbols must fail");
  } catch (error) {
    const output = JSON.parse(String((error as { stdout?: string }).stdout ?? ""));
    assert.equal(output.status, "failed");
    assert.equal(output.diagnostics[0].code, "TC_API_SYMBOL_UNKNOWN");
  }
  const gamePackage = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  assert.ok(gamePackage.devDependencies["pelican-engine"]);
  assert.equal(gamePackage.dependencies?.["pelican-engine"], undefined);
  const installedPackage = JSON.parse(
    await readFile(path.join(installed, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(installedPackage.exports), ["."]);
  assert.deepEqual(installedPackage.bin, {
    pelican: "./lib/tools/npm/entry.js",
  });
  assert.equal(
    installedPackage.repository.url,
    "https://github.com/danchar12138/pelican-engine.git",
  );

  async function startDev(viaNpm: boolean) {
    const { createServer } = await import("node:net");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const invocation = viaNpm
      ? [
          ...npm!.prefix,
          "--prefix",
          directory,
          "exec",
          "--offline",
          "--no",
          "--",
          "pelican",
          "dev",
          "--port",
          String(port),
        ]
      : [bin, "dev", "--port", String(port)];
    const child = spawn(process.execPath, invocation, {
      cwd: directory,
      env: offline,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        if (viaNpm && process.platform === "win32")
          await execute(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { timeout: 15_000, windowsHide: true },
          );
        else child.kill();
      }
      await withAutomationDeadline(
        () => exited,
        15_000,
        "Installed dev server shutdown",
      );
    };
    try {
      await withAutomationDeadline(
        async () => {
          while (!stdout.includes('"running"')) {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(stdout + stderr);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
        30_000,
        "Installed dev server startup",
      );
      return {
        port,
        url: `http://127.0.0.1:${port}/`,
        report: JSON.parse(stdout),
        errors: () => stderr,
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  }
  // npm exec is npx's local-command path. No init, create, source checkout, or
  // pre-existing project files precede this first installed invocation.
  const firstDev = await startDev(true);
  try {
    assert.equal(firstDev.report.data.scaffolded, true);
    assert.equal(firstDev.report.data.template, "minimal");
    assert.equal((await fetch(firstDev.url)).status, 200);
    assert.equal(
      (await cli("status", "--port", String(firstDev.port))).status,
      "succeeded",
    );
  } finally {
    await firstDev.stop();
  }
  assert.equal(
    JSON.parse(
      await npmRun(["exec", "--offline", "--no", "--", "pelican", "help"]),
    ).status,
    "succeeded",
  );
  assert.equal(
    JSON.parse(
      await run(process.execPath, [
        "--input-type=module",
        "--eval",
        "import {SDK_VERSION,defineGame} from 'pelican-engine'; console.log(JSON.stringify({version:SDK_VERSION,api:typeof defineGame}));",
      ]),
    ).version,
    SDK_VERSION,
  );
  const gameSource = await readFile(path.join(directory, "game.ts"), "utf8");
  const manifestSource = await readFile(
    path.join(directory, "pelican.project.json"),
    "utf8",
  );
  await mkdir(probeRoot, { recursive: true });
  await run(process.execPath, [
    path.join(directory, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--project",
    "tsconfig.json",
  ]);
  assert.equal((await cli("api")).data.engineVersion, SDK_VERSION);
  assert.ok((await cli("api")).data.symbols >= 76);
  const installedAPI = JSON.parse(
    await readFile(path.join(installed, "docs/api/index.json"), "utf8"),
  );
  const sourceAPI = JSON.parse(
    await readFile(path.join(root, "docs/api/index.json"), "utf8"),
  );
  assert.deepEqual(installedAPI.symbols, sourceAPI.symbols);
  assert.equal(installedAPI.installedDeclarations, "lib/sdk/index.d.ts");
  assert.equal((await cli("doctor")).status, "succeeded");
  assert.equal((await cli("setup", "--offline")).status, "succeeded");
  assert.match(
    await readFile(path.join(directory, "AGENTS.md"), "utf8"),
    /GAME-AUTHOR\.md/,
  );
  const checked = await cli("check");
  assert.equal(checked.status, "succeeded");
  assert.ok(!(checked.data.diagnostics ?? []).some((item: { code: string }) => item.code === "TC_ENGINE_INPUT_MISSING"), JSON.stringify(checked));
  assert.equal((await cli("check")).data.incremental.cacheHit, true);
  assert.equal((await cli("build")).status, "succeeded");
  const build = JSON.parse(
    await readFile(path.join(directory, "dist/pelican-build.json"), "utf8"),
  );
  assert.equal(build.renderer, "webgpu-with-webgl2-fallback");
  for (const name of [
    "LICENSE",
    "THREE-LICENSE.txt",
    "RAPIER-LICENSE.txt",
    "FAST-PNG-LICENSE.txt",
    "FFLATE-LICENSE.txt",
    "IOBUFFER-LICENSE.txt",
    "NGRAPH.PATH-LICENSE.txt",
    "THIRDPARTY-NOTICES.txt",
  ])
    assert.ok(
      (await readFile(path.join(directory, "dist", name))).length > 100,
    );
  assert.ok(
    (await readFile(path.join(directory, "dist/index.html"), "utf8")).includes(
      "script",
    ),
  );
  const rejected = async (args: string[], code: string) => {
    const result = await execute(process.execPath, [bin, ...args], {
      cwd: directory,
      env: offline,
      timeout: 60_000,
    }).then(
      (r) => ({ ...r, code: 0 }),
      (e) => e,
    );
    assert.notEqual(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.diagnostics.some((d: { code: string }) => d.code === code),
      JSON.stringify(report),
    );
  };
  for (const specifier of [
    "three",
    "three/tsl",
    "@dimforge/rapier3d-compat",
    "pelican-engine/lib/renderer/browser.js",
    "./node_modules/pelican-engine/lib/sdk/index.js",
  ]) {
    await writeFile(
      path.join(directory, "game.ts"),
      `import type {} from ${JSON.stringify(specifier)};\n` + gameSource,
    );
    await rejected(["check"], "TC_PUBLIC_API");
  }
  await writeFile(path.join(directory, "game.ts"), gameSource);
  await writeFile(
    path.join(directory, "pelican.project.json"),
    JSON.stringify({ ...JSON.parse(manifestSource), engineVersion: "0.0.0" }),
  );
  await rejected(["check"], "TC_ENGINE_VERSION_MISMATCH");
  await writeFile(path.join(directory, "pelican.project.json"), manifestSource);
  const packagePath = path.join(installed, "package.json"),
    packageSource = await readFile(packagePath, "utf8");
  await writeFile(
    packagePath,
    JSON.stringify({ ...JSON.parse(packageSource), version: "0.0.0" }),
  );
  await rejected(["help"], "TC_ENGINE_SDK_VERSION");
  await writeFile(packagePath, packageSource);
  const vitePackage = path.join(directory, "node_modules/vite/package.json"),
    viteSource = await readFile(vitePackage, "utf8");
  await writeFile(
    vitePackage,
    JSON.stringify({ ...JSON.parse(viteSource), version: "0.0.0" }),
  );
  await rejected(["help"], "TC_DISTRIBUTION_DEPENDENCY_VERSION");
  await writeFile(vitePackage, viteSource);
  const viteDirectory = path.dirname(vitePackage),
    missingVite = viteDirectory + ".smoke-missing";
  await rename(viteDirectory, missingVite);
  try {
    await rejected(["help"], "TC_DISTRIBUTION_DEPENDENCY_MISSING");
  } finally {
    await rename(missingVite, viteDirectory);
  }
  const declarationPath = path.join(installed, "lib/sdk/index.d.ts"),
    declarationSource = await readFile(declarationPath, "utf8");
  await writeFile(
    declarationPath,
    declarationSource + "\n// changed fixture\n",
  );
  try {
    await rejected(["help"], "TC_DISTRIBUTION_INTEGRITY");
  } finally {
    await writeFile(declarationPath, declarationSource);
  }
  const sdkPath = path.join(installed, "lib/sdk/index.js");
  const missingSdk = sdkPath + ".smoke-missing";
  await rename(sdkPath, missingSdk);
  try {
    await rejected(["help"], "TC_DISTRIBUTION_INSTALLATION");
  } finally {
    await rename(missingSdk, sdkPath);
  }
  await rejected(["create"], "TC_CREATE_EXISTS");

  const dev = await startDev(false);
  const port = dev.port;
  let gpu: unknown = "not requested; CPU packaging/dev/deploy validation only";
  try {
    assert.equal(dev.report.data.scaffolded, undefined);
    assert.equal(
      await readFile(path.join(directory, "game.ts"), "utf8"),
      gameSource,
    );
    assert.equal(
      await readFile(path.join(directory, "pelican.project.json"), "utf8"),
      manifestSource,
    );
    const url = `http://127.0.0.1:${port}/`;
    assert.equal((await fetch(url)).status, 200);
    const servedHTML = await fetch(url).then((response) => response.text());
    const runtimeURL = /src="([^"]*\/lib\/renderer\/browser\.js)"/.exec(
      servedHTML,
    )?.[1];
    assert.ok(runtimeURL, servedHTML);
    assert.equal((await fetch(new URL(runtimeURL, url))).status, 200);
    const automationHTML = await fetch(url + "?automation=1").then((response) =>
      response.text(),
    );
    assert.ok(automationHTML.includes("/@fs/"), automationHTML);
    assert.equal(
      (await cli("status", "--port", String(port))).status,
      "succeeded",
    );
    if (process.argv.includes("--gpu")) {
      const require = createRequire(path.join(directory, "package.json"));
      const { chromium } = require("playwright") as typeof import("playwright");
      const browser = await chromium.launch(automationLaunchOptions());
      try {
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
        });
        const browserErrors: string[] = [];
        page.on("pageerror", (error) => browserErrors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") browserErrors.push(message.text());
        });
        page.on("requestfailed", (request) =>
          browserErrors.push(
            request.url() + ": " + request.failure()?.errorText,
          ),
        );
        await page.route("**/*", (route) =>
          new URL(route.request().url()).hostname === "127.0.0.1"
            ? route.continue()
            : route.abort(),
        );
        await page.goto(url + "?automation=1", {
          waitUntil: "domcontentloaded",
        });
        try {
          await waitForEngine(page);
        } catch (error) {
          await page
            .screenshot({ path: artifact("startup-failed.png") })
            .catch(() => undefined);
          throw new Error(
            String(error) +
              "\n" +
              JSON.stringify({
                browserErrors,
                status: await page.locator("body").innerText(),
                server: dev.errors(),
              }),
          );
        }
        const state = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        assert.equal(state.backend, "WebGPUBackend", JSON.stringify(state));
        const documentGeneration = await page.evaluate(() => {
          const marker = Math.random().toString();
          (window as any).__pelicanSmokeDocument = marker;
          return marker;
        });
        await writeFile(path.join(directory, "automation-note.json"), JSON.stringify({ note: "Unrelated evidence must not reset live gameplay." }));
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(await page.evaluate(() => (window as any).__pelicanSmokeDocument), documentGeneration, "Writing unrelated JSON must not reload the game.");
        const image = await page
          .locator("canvas")
          .first()
          .screenshot({ path: artifact("canvas.png") });
        const pixels = await page.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const bitmap = await createImageBitmap(
            new Blob([bytes], { type: "image/png" }),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const data = context.getImageData(
            0,
            0,
            bitmap.width,
            bitmap.height,
          ).data;
          const colors = new Set<number>();
          for (let i = 0; i < data.length; i += 4)
            colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
          return {
            width: bitmap.width,
            height: bitmap.height,
            colors: colors.size,
          };
        }, image.toString("base64"));
        assert.ok(pixels.colors > 16, JSON.stringify(pixels));
        const modes: string[] = [];
        for (const mode of ["path", "hybrid", "raster"]) {
          await withAutomationDeadline(
            () =>
              page.evaluate(async (next) => {
                await (window as any).__pelican.mode(next);
                if (next !== "raster")
                  await (window as any).__pelican.accumulate(2);
              }, mode),
            60_000,
            "Installed render mode " + mode,
          );
          const current = await page.evaluate(() =>
            (window as any).__pelican.inspect(),
          );
          assert.equal(current.mode, mode);
          modes.push(mode);
        }
        const capture = await cli(
          "capture",
          "--live",
          "--port",
          String(port),
          "--output",
          artifact("capture.png"),
        );
        assert.equal(capture.status, "succeeded");
        assert.ok((await readFile(artifact("capture.png"))).length > 1000);
        const fallback = await browser.newContext({
          viewport: { width: 960, height: 540 },
        });
        try {
          await fallback.addInitScript(() => {
            Object.defineProperty(navigator, "gpu", {
              configurable: true,
              value: undefined,
            });
          });
          const fallbackPage = await fallback.newPage();
          await fallbackPage.goto(url + "?automation=1", {
            waitUntil: "domcontentloaded",
          });
          await waitForEngine(fallbackPage);
          const fallbackState = await fallbackPage.evaluate(() =>
            (window as any).__pelican.inspect(),
          );
          assert.equal(fallbackState.backend, "WebGLBackend");
          const error = await fallbackPage.evaluate(async () => {
            try {
              await (window as any).__pelican.mode("path");
              return null;
            } catch (failure) {
              return String(failure);
            }
          });
          assert.match(error ?? "", /TC_RENDER_MODE_UNAVAILABLE/);
          assert.equal(
            (
              await fallbackPage.evaluate(() =>
                (window as any).__pelican.inspect(),
              )
            ).mode,
            "raster",
          );
          await fallbackPage.screenshot({
            path: artifact("fallback.png"),
          });
          gpu = {
            backend: state.backend,
            adapter: state.adapter,
            capabilities: state.capabilities,
            pixels,
            modes,
            fallback: fallbackState.backend,
            capture: "live CLI succeeded",
          };
        } finally {
          await fallback.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (process.argv.includes("--gpu"))
      await cli("reset-session", "--port", String(port)).catch(() => undefined);
    await dev.stop();
  }
  assert.equal((await cli("build", "--base", "/game/")).status, "succeeded");
  const server = await serveDist(path.join(directory, "dist"), 0, "/game/");
  try {
    assert.equal((await fetch(server.url)).status, 200);
    if (process.argv.includes("--gpu")) {
      const require = createRequire(path.join(directory, "package.json"));
      const { chromium } = require("playwright") as typeof import("playwright");
      const browser = await chromium.launch(automationLaunchOptions());
      try {
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
        });
        await page.route("**/*", (route) =>
          new URL(route.request().url()).hostname === "127.0.0.1"
            ? route.continue()
            : route.abort(),
        );
        await page.goto(server.url, { waitUntil: "domcontentloaded" });
        await waitForEngine(page, 30_000, { production: true });
        assert.equal(
          await page.evaluate(() => typeof (window as any).__pelican),
          "undefined",
        );
        await page.screenshot({ path: artifact("production.png") });
        const first = await page.evaluate(
          () => document.documentElement.dataset.pelicanFrameSerial,
        );
        await page.waitForFunction(
          (previous) =>
            Number(document.documentElement.dataset.pelicanFrameSerial) >
            Number(previous),
          first,
        );
        assert.equal(
          (await fetch(new URL("__pelican/status", server.url))).status,
          404,
        );
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  if (process.argv.includes("--gpu")) {
    assert.equal(
      (
        await cli(
          "capture",
          "--port",
          String(port),
          "--output",
          artifact("standalone.png"),
        )
      ).status,
      "succeeded",
    );
    assert.ok((await readFile(artifact("standalone.png"))).length > 1000);
  }
  const summary = {
    status: "succeeded",
    directory,
    package: "pelican-engine",
    version: SDK_VERSION,
    install: registryInstall ? "published registry version; offline after installation" : process.argv.includes("--online-install")
      ? "network allowed for initial dependencies only"
      : "offline cache only",
    operations:
      "real npm pack/install --save-dev into empty OS temp, npx pelican dev auto-scaffold, repeat dev preserves files, SDK/API, doctor/setup offline, check/cache, build/licenses, misuse/version/dependency errors, dev/status, HTTP deployment",
    gpu,
  };
  await writeFile(
    path.join(artifacts, registryInstall ? "registry-smoke.json" : "smoke.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        directory,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
