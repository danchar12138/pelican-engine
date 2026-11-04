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
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { generateApiIndex } from "./api-index.ts";
import { doctor } from "./doctor.ts";
import { setup } from "./setup.ts";
import { attachControl } from "./control-server.ts";
import { createControlClient } from "./control-client.ts";
import type { ControlCommand } from "../packages/protocol/src/index.ts";
import {
  automationLaunchOptions,
  automationURL,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

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
  option("project", path.join(engineRoot, "examples/m1"))!,
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
  artifacts: artifacts.map((path) => ({
    type: "file",
    path: path.replaceAll("\\", "/"),
  })),
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
          "inspect | step --count <n> | pause | resume [--port <dev-port>]",
          "input --key ArrowRight [--pressed true] [--port <dev-port>]",
          "snapshot --output <file> | restore --file <file>",
          "record --action start|stop|cancel | replay --file <trace.json>",
          "status | cancel --task <id> | reset-session | api",
        ],
        stage: "M1 runtime foundation; incomplete first-release feature set",
      }),
    );
    return;
  }
  if (command === "doctor") {
    const report = await doctor({ projectRoot: engineRoot, taskId });
    emit(report);
    if (report.status !== "succeeded") process.exitCode = 1;
    return;
  }
  if (command === "api") {
    const index = await generateApiIndex(engineRoot);
    emit(
      envelope(
        "succeeded",
        { engineVersion: SDK_VERSION, symbols: index.symbols.length },
        [],
        ["docs/api/index.json", "docs/api/REFERENCE.md"],
      ),
    );
    return;
  }
  if (
    [
      "inspect",
      "step",
      "pause",
      "resume",
      "input",
      "snapshot",
      "restore",
      "record",
      "replay",
      "status",
      "cancel",
      "reset-session",
    ].includes(command) ||
    (command === "capture" && args.includes("--live"))
  ) {
    const client = createControlClient({
      url: `http://127.0.0.1:${Number(option("port", "4173"))}/`,
    });
    let response;
    if (command === "status") response = await client.status();
    else if (command === "cancel") {
      const task = option("task");
      if (!task) throw new Error("TC_CLI_TASK: --task is required.");
      response = await client.cancel(task);
    } else if (command === "reset-session") response = await client.reset();
    else {
      let operation: ControlCommand;
      if (command === "capture") operation = { type: "capture" };
      else if (command === "inspect")
        operation = {
          type: "inspect",
          ...(option("entity") ? { entity: option("entity") } : {}),
          ...(option("offset") ? { offset: Number(option("offset")) } : {}),
          ...(option("limit") ? { limit: Number(option("limit")) } : {}),
        };
      else if (command === "step")
        operation = { type: "step", count: Number(option("count", "1")) };
      else if (command === "input") {
        const pressed = option("pressed", "true");
        if (!["true", "false"].includes(pressed!))
          throw new Error("TC_CLI_INPUT: --pressed must be true or false.");
        operation = {
          type: "input",
          key: option("key", "")!,
          pressed: pressed === "true",
        };
      } else if (command === "restore" || command === "replay") {
        const file = option("file");
        if (!file) throw new Error("TC_CLI_FILE: --file is required.");
        const data = JSON.parse(await readFile(path.resolve(file), "utf8"));
        operation =
          command === "restore"
            ? { type: "restore", snapshot: data.data ?? data }
            : { type: "replay", trace: data.data ?? data };
      } else if (command === "record") {
        const action = option("action", "start");
        if (!["start", "stop", "cancel"].includes(action!))
          throw new Error(
            "TC_CLI_RECORD: action must be start, stop or cancel.",
          );
        operation = {
          type:
            action === "start"
              ? "recordStart"
              : action === "stop"
                ? "recordStop"
                : "recordCancel",
        };
      } else
        operation = {
          type: command as "inspect" | "pause" | "resume" | "snapshot",
        };
      response = await client.send(
        operation,
        option("task") ? { taskId: option("task") } : {},
      );
    }
    if (command === "capture" && response.status === "succeeded") {
      const data = response.data as {
        format: string;
        base64: string;
        width: number;
        height: number;
        bytes: number;
      };
      const buffer = Buffer.from(data.base64, "base64");
      if (
        data.format !== "png" ||
        buffer.length !== data.bytes ||
        buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      )
        throw new Error("TC_CAPTURE_FORMAT: Invalid captured image.");
      const output = path.resolve(
        option("output", path.join(projectRoot, ".threecat/live-capture.png"))!,
      );
      if (path.extname(output).toLowerCase() !== ".png")
        throw new Error(
          "TC_CAPTURE_EXTENSION: Live capture output must be a PNG file.",
        );
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, buffer);
      response.data = {
        format: data.format,
        width: data.width,
        height: data.height,
        bytes: data.bytes,
      };
      response.artifacts.push({ type: "image", path: output });
    } else if (option("output") && response.status === "succeeded") {
      const output = path.resolve(option("output")!);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(response.data, null, 2) + "\n");
      response.artifacts.push({ type: "file", path: output });
    }
    emit(response);
    if (!["succeeded", "running", "queued"].includes(response.status))
      process.exitCode = 1;
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
    await cp(path.join(engineRoot, "examples/m1"), projectRoot, {
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
      version: SDK_VERSION,
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
        projectRoot === path.join(engineRoot, "examples/m1")
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
            engineVersion: SDK_VERSION,
            stage: "runtime-foundation",
            game: result.ir?.gameId,
            entry: "index.html",
            renderer: "webgpu-only",
            limitations: [
              "M1 runtime foundation, not the complete engine",
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
    const controls = command === "dev" ? attachControl(server) : undefined;
    await server.listen();
    if (command === "capture") {
      let browser: import("playwright").Browser | undefined;
      try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch(automationLaunchOptions());
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
        });
        await withAutomationDeadline(() =>
          page.goto(automationURL(`http://127.0.0.1:${port}/`), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
        );
        await waitForEngine(page);
        await withAutomationDeadline(() =>
          page.evaluate(
            async (mode) => {
              await (window as any).__threecat.mode(mode);
              if (mode !== "raster")
                await (window as any).__threecat.accumulate(8);
            },
            option("mode", "raster"),
          ),
        );
        const output = path.resolve(
          option("output", path.join(projectRoot, ".threecat/capture.png"))!,
        );
        await mkdir(path.dirname(output), { recursive: true });
        await withAutomationDeadline(() =>
          page.screenshot({ path: output, timeout: 30_000 }),
        );
        emit(
          envelope(
            "succeeded",
            { mode: option("mode", "raster") },
            [],
            [output],
          ),
        );
      } finally {
        try {
          await browser?.close();
        } finally {
          await server.close();
        }
      }
      return;
    }
    server.watcher.add(projectRoot);
    let pending = false,
      dirty = false;
    server.watcher.on("all", async (event, filename) => {
      const relative = path.relative(projectRoot, filename);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        filename.includes(`${path.sep}.threecat${path.sep}`) ||
        filename.includes(`${path.sep}dist${path.sep}`)
      )
        return;
      dirty = true;
      if (pending) return;
      pending = true;
      try {
        while (dirty) {
          dirty = false;
          const next = await compile();
          if (next.success && !dirty) server.ws.send({ type: "full-reload" });
          else if (!next.success)
            emit(envelope("failed", next.report, next.diagnostics));
        }
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
        void (controls?.close() ?? Promise.resolve())
          .then(() => server.close())
          .then(() => process.exit(0));
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
