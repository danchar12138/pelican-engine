import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  writeFile,
  cp,
  access,
  lstat,
} from "node:fs/promises";
import { build as viteBuild, createServer } from "vite";
import { compileProject } from "../experiments/compiler/index.ts";
import { doctor } from "./doctor.ts";
import { setup } from "./setup.ts";

const engineRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const projectRoot = path.resolve(
  option("project", path.join(engineRoot, "examples/m0"))!,
);
const taskId = `${command}-${Date.now()}`;
const envelope = (
  status: string,
  data: unknown,
  diagnostics: unknown[] = [],
  artifacts: string[] = [],
) => ({
  protocolVersion: "0.1.0",
  taskId,
  status,
  diagnostics,
  artifacts,
  data,
});
const emit = (result: unknown) =>
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
const target = path.join(projectRoot, ".threecat/public/generated");
async function compile() {
  await mkdir(target, { recursive: true });
  return compileProject({ projectRoot, outDir: target, engineRoot });
}
async function main() {
  if (command === "help") {
    emit(
      envelope("succeeded", {
        commands: [
          "doctor",
          "setup [--install-browser] [--offline]",
          "create --project <directory>",
          "check --project <directory>",
          "compile --project <directory>",
          "dev --project <directory> [--port 4173]",
          "build --project <directory>",
          "capture [--mode raster|hybrid|path] [--output file.png]",
        ],
        stage: "M0 prototypes; no complete engine claim",
      }),
    );
    return;
  }
  if (command === "doctor") {
    emit(await doctor({ projectRoot: engineRoot, taskId }));
    return;
  }
  if (command === "setup") {
    const result = await setup({
      projectRoot: engineRoot,
      taskId,
      offline: args.includes("--offline"),
      installBrowser: args.includes("--install-browser"),
    });
    emit(result);
    if (result.status !== "succeeded") process.exitCode = 1;
    return;
  }
  if (command === "create") {
    if (!option("project"))
      throw new Error("TC_CREATE_PATH: --project is required.");
    try {
      await access(projectRoot);
      throw new Error(
        "TC_CREATE_EXISTS: Choose a new directory; existing files are never overwritten.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await cp(path.join(engineRoot, "examples/m0"), projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.split(path.sep).includes(".threecat") &&
        !source.split(path.sep).includes("dist"),
    });
    const manifestPath = path.join(projectRoot, "threecat.project.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8").catch(() => "{}"),
    );
    manifest.engine = {
      path: path.relative(projectRoot, engineRoot).split(path.sep).join("/"),
      version: "0.0.1-m0.0",
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    emit(
      envelope(
        "succeeded",
        {
          project: path.basename(projectRoot),
          engineVersion: manifest.engine.version,
        },
        [],
        ["game.ts", "threecat.project.json"],
      ),
    );
    return;
  }
  if (["check", "compile", "build", "dev", "capture"].includes(command)) {
    const result = await compile();
    if (!result.success) {
      emit(
        envelope("failed", result.report, result.diagnostics, [
          path.relative(projectRoot, path.join(target, "build-report.json")),
        ]),
      );
      process.exitCode = 1;
      return;
    }
    if (command === "compile" || command === "check") {
      emit(
        envelope(
          "succeeded",
          result.report,
          [],
          [path.relative(projectRoot, target)],
        ),
      );
      return;
    }
    if (command === "build") {
      const output =
        projectRoot === path.join(engineRoot, "examples/m0")
          ? path.join(engineRoot, "dist")
          : path.join(projectRoot, "dist");
      try {
        if ((await lstat(output)).isSymbolicLink())
          throw new Error(
            "TC_BUILD_SYMLINK: dist must be a real output directory.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await viteBuild({
          root: engineRoot,
          configFile: path.join(engineRoot, "vite.config.ts"),
          publicDir: path.dirname(target),
          base: option("base", "./"),
          logLevel: "silent",
          build: { outDir: output, emptyOutDir: true },
        });
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
      await cp(path.join(engineRoot, "LICENSE"), path.join(output, "LICENSE"));
      await writeFile(
        path.join(output, "THIRDPARTY-NOTICES.txt"),
        "threecat M0 runtime uses Three.js (MIT). Copyright 2010-2026 three.js authors.\nSee the Three.js source LICENSE distributed with the source release.\n",
      );
      await cp(
        path.join(engineRoot, "node_modules/three/LICENSE"),
        path.join(output, "THREE-LICENSE.txt"),
      );
      await writeFile(
        path.join(output, "threecat-build.json"),
        JSON.stringify(
          {
            engineVersion: "0.0.1-m0.0",
            stage: "risk-prototype",
            game: result.ir?.gameId,
            entry: "index.html",
            renderer: "webgpu-only",
            limitations: [
              "M0 test scene and SDK subset, not the complete engine",
              "Compute BVH path tracer, no hardware ray tracing",
              "No production denoiser; hybrid is image-compositing prototype",
            ],
          },
          null,
          2,
        ) + "\n",
      );
      emit(
        envelope(
          "succeeded",
          { output: "dist", game: result.ir?.gameId },
          [],
          [
            "dist/index.html",
            "dist/generated/scene.ir.json",
            "dist/threecat-build.json",
          ],
        ),
      );
      return;
    }
    const port = Number(option("port", "4173"));
    const server = await createServer({
      root: engineRoot,
      configFile: path.join(engineRoot, "vite.config.ts"),
      publicDir: path.dirname(target),
      server: { port, host: "127.0.0.1", strictPort: true },
      logLevel: "silent",
    });
    await server.listen();
    if (command === "capture") {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: false,
        args: ["--use-angle=d3d11"],
      });
      try {
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
        });
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.waitForFunction(() =>
          Boolean(
            (window as any).__threecat || (window as any).__threecatFailure,
          ),
        );
        const failure = await page.evaluate(
          () => (window as any).__threecatFailure,
        );
        if (failure) throw new Error(failure);
        await page.evaluate(
          async (mode) => {
            await (window as any).__threecat.mode(mode);
            if (mode !== "raster")
              await (window as any).__threecat.accumulate(8);
          },
          option("mode", "raster"),
        );
        const output = path.resolve(
          option("output", path.join(projectRoot, ".threecat/capture.png"))!,
        );
        await mkdir(path.dirname(output), { recursive: true });
        await page.screenshot({ path: output });
        emit(
          envelope(
            "succeeded",
            { mode: option("mode", "raster") },
            [],
            [output],
          ),
        );
      } finally {
        await browser.close();
        await server.close();
      }
      return;
    }
    server.watcher.add(projectRoot);
    let pending = false;
    server.watcher.on("all", async (event, filename) => {
      if (
        !filename.startsWith(projectRoot) ||
        filename.includes(`${path.sep}.threecat${path.sep}`) ||
        filename.includes(`${path.sep}dist${path.sep}`) ||
        pending
      )
        return;
      if (!/\.(ts|json)$/.test(filename)) return;
      pending = true;
      try {
        const next = await compile();
        if (next.success) server.ws.send({ type: "full-reload" });
        else emit(envelope("failed", next.report, next.diagnostics));
      } catch (error) {
        emit(
          envelope("failed", null, [
            { code: "TC_DEV_REBUILD", message: String(error) },
          ]),
        );
      } finally {
        pending = false;
      }
    });
    emit(
      envelope("running", {
        url: `http://127.0.0.1:${port}/`,
        project: path.basename(projectRoot),
        hotUpdate:
          "full-reload; compatibility policy is reported but live patch is not implemented",
      }),
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        void server.close().then(() => process.exit(0));
      });
    return;
  }
  throw new Error(`TC_COMMAND_UNKNOWN: ${command}`);
}
main().catch((error) => {
  emit(
    envelope("failed", null, [
      {
        code: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "TC_CLI_FAILURE",
        severity: "error",
        message: String(error),
        remediation:
          "Inspect the referenced source or run doctor; preserve failure output before retrying.",
      },
    ]),
  );
  process.exitCode = 1;
});
