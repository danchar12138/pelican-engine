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
import { generateApiIndex, queryApiSymbol } from "./api-index.ts";
import { optimizeModel } from "../packages/assets/src/optimize.ts";
import { compressDist } from "./compress-dist.ts";
import { doctor } from "./doctor.ts";
import { setup } from "./setup.ts";
import { attachControl } from "./control-server.ts";
import { createControlClient } from "./control-client.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { migrateProject, restoreProjectManifest } from "./migrate.ts";
import {
  cliLayout,
  createMinimalProject,
  prepareInstalledDevProject,
  installedDoctor,
  writeAuthorEntry,
} from "./npm/layout.ts";
import type { ControlCommand } from "../packages/protocol/src/index.ts";
import {
  automationLaunchOptions,
  automationURL,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

const layout = cliLayout(import.meta.url);
const engineRoot = layout.root;
const args = process.argv.slice(2);
const activeManifest = JSON.parse(
  await readFile(path.join(engineRoot, "engine.manifest.json"), "utf8"),
) as { milestone: string; stage: string };
const defaultProject = layout.installed
  ? process.cwd()
  : path.join(
      engineRoot,
      activeManifest.milestone === "M3" ? "examples/m3" : "examples/m2",
    );
const command = args[0] ?? "help";
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const projectRoot = path.resolve(
  command === "api" ? defaultProject : option("project", defaultProject)!,
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
const target = path.join(projectRoot, ".pelican/public/generated");
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
          "create --project <directory> [--template minimal|m2]",
          "migrate [--project <directory>] [--apply --from <version|unlocked>]",
          "migrate [--project <directory>] --restore <backup-name> --expect-current <sha256> --expect-backup <sha256>",
          "check --project <directory>",
          "compile --project <directory>",
          "dev --project <directory> [--port 4173]",
          "build --project <directory>",
          "optimize --project <directory> --asset <id> [--output <new-project-relative.glb>]",
          "capture [--mode raster|hybrid|path] [--output file.png]",
          "inspect | step --count <n> | pause | resume [--port <dev-port>]",
          "input --key ArrowRight [--pressed true] [--port <dev-port>]",
          "snapshot --output <file> | restore --file <file>",
          "record --action start|stop|cancel | replay --file <trace.json>",
          "status | cancel --task <id> | reset-session | api [--symbol <name>]",
        ],
        stage: activeManifest.stage,
      }),
    );
    return;
  }
  if (command === "migrate") {
    const root = path.resolve(option("project", process.cwd())!);
    const restore = args.includes("--restore");
    if (restore && (args.includes("--apply") || args.includes("--from")))
      throw new Error("TC_MIGRATE_OPTIONS: Use restore or apply, not both; run migrate without options to review the plan.");
    const result = restore
      ? await restoreProjectManifest(root, option("restore", "")!, option("expect-current", "")!, option("expect-backup", "")!)
      : await migrateProject(root, engineRoot, { apply: args.includes("--apply"), ...(option("from") === undefined ? {} : { from: option("from") }) });
    emit(envelope("succeeded", result, [], "backup" in result && typeof result.backup === "string" ? [path.join(root, result.backup)] : []));
    return;
  }
  if (command === "doctor") {
    const report = layout.installed
      ? await installedDoctor(engineRoot, taskId)
      : await doctor({ projectRoot: engineRoot, taskId });
    emit(report);
    if (report.status !== "succeeded") process.exitCode = 1;
    return;
  }
  if (command === "api") {
    const index = layout.installed
      ? JSON.parse(
          await readFile(path.join(engineRoot, "docs/api/index.json"), "utf8"),
        )
      : await generateApiIndex(engineRoot);
    const matches = queryApiSymbol(index.symbols, args.slice(1));
    emit(
      envelope(
        "succeeded",
        matches === undefined
          ? { engineVersion: SDK_VERSION, symbols: index.symbols.length }
          : { engineVersion: SDK_VERSION, symbols: matches },
        [],
        ["docs/api/index.json", "docs/api/REFERENCE.md"].map((file) =>
          layout.installed ? path.join(engineRoot, file) : file,
        ),
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
        option("output", path.join(projectRoot, ".pelican/live-capture.png"))!,
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
    if (layout.installed) {
      if (args.includes("--install-browser")) {
        const { chromium } = await import("playwright");
        try {
          await access(chromium.executablePath());
        } catch {
          if (args.includes("--offline"))
            throw new Error(
              "TCSETUP_BROWSER_OFFLINE: Install Chromium while online before offline capture.",
            );
          const { runCommand } = await import("./doctor.ts");
          const { playwrightCli } = await import("./npm/browser-cli.ts");
          const result = await runCommand(
            process.execPath,
            [playwrightCli(engineRoot), "install", "chromium"],
            { cwd: projectRoot, timeoutMs: 120_000 },
          );
          if (result.exitCode !== 0)
            throw new Error(
              "TCSETUP_BROWSER_INSTALL_FAILED: Chromium installation failed; retry setup --install-browser while online.",
            );
        }
      }
      const report = await installedDoctor(engineRoot, taskId);
      emit(report);
      if (report.status !== "succeeded") process.exitCode = 1;
      return;
    }
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
    const template = option("template", layout.installed ? "minimal" : "m2");
    if (
      !["minimal", "m2"].includes(template!) ||
      (layout.installed && template !== "minimal")
    )
      throw new Error(
        "TC_CREATE_TEMPLATE: Use minimal in either distribution; m2 sample assets are available in source checkouts only.",
      );
    if (!layout.installed && !option("project"))
      throw new Error("TC_CREATE_PATH: --project is required.");
    if (template === "minimal") {
      for (const filename of ["game.ts", "pelican.project.json", "AGENTS.md"])
        try {
          await access(path.join(projectRoot, filename));
          throw new Error(
            "TC_CREATE_EXISTS: Project files already exist; no files were overwritten.",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      await createMinimalProject(projectRoot, engineRoot, layout.installed);
      emit(
        envelope(
          "succeeded",
          {
            project: path.basename(projectRoot),
            engineVersion: SDK_VERSION,
            template,
          },
          [],
          ["game.ts", "pelican.project.json", "AGENTS.md"],
        ),
      );
      return;
    }
    try {
      await access(projectRoot);
      throw new Error(
        "TC_CREATE_EXISTS: Choose a new directory; existing files are never overwritten.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await cp(path.join(engineRoot, "examples/m2"), projectRoot, {
      recursive: true,
      filter: (source) =>
        !source.split(path.sep).includes(".pelican") &&
        !source.split(path.sep).includes("dist"),
    });
    const manifestPath = path.join(projectRoot, "pelican.project.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8").catch(() => "{}"),
    );
    manifest.engine = {
      path: path.relative(projectRoot, engineRoot).split(path.sep).join("/"),
      version: SDK_VERSION,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await writeAuthorEntry(projectRoot, engineRoot);
    emit(
      envelope(
        "succeeded",
        {
          project: path.basename(projectRoot),
          engineVersion: manifest.engine.version,
          template,
        },
        [],
        ["game.ts", "pelican.project.json", "AGENTS.md"],
      ),
    );
    return;
  }
  if (
    ["check", "compile", "build", "dev", "capture", "optimize"].includes(
      command,
    )
  ) {
    const scaffolded =
      command === "dev" && layout.installed
        ? await prepareInstalledDevProject(projectRoot, engineRoot)
        : false;
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
    if (command === "optimize") {
      const asset = result.ir?.assets.find(
        (item) => item.id === option("asset"),
      );
      if (!asset || asset.type !== "model")
        throw new Error(
          "TC_ASSET_OPTIMIZE_ID: --asset must reference a model asset.",
        );
      const output = path.resolve(
        projectRoot,
        option("output", path.join(".pelican/optimized", asset.id + ".glb"))!,
      );
      const relative = path.relative(projectRoot, output);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error(
          "TC_ASSET_OPTIMIZE_PATH: Output must stay inside the game project.",
        );
      const report = await optimizeModel(
        path.join(projectRoot, asset.sourcePath),
        output,
      );
      emit(envelope("succeeded", report, [], [output]));
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
        !layout.installed && projectRoot === defaultProject
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
          root: layout.webRoot,
          configFile: layout.installed
            ? false
            : path.join(engineRoot, "vite.config.ts"),
          envFile: false,
          publicDir: path.dirname(target),
          base: option("base", "./"),
          logLevel: "silent",
          build: {
            outDir: output,
            emptyOutDir: true,
            target: "es2023",
            sourcemap: false,
          },
        });
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
      }
      await cp(path.join(engineRoot, "LICENSE"), path.join(output, "LICENSE"));
      await writeFile(
        path.join(output, "THIRDPARTY-NOTICES.txt"),
        "pelican runtime uses Three.js 0.187.0, fast-png 8.0.0, fflate 0.8.3, iobuffer 6.0.1 and ngraph.path 1.6.1 (MIT), and @dimforge/rapier3d-compat 0.21.0 (Apache-2.0). Full dependency licenses are distributed beside this notice. User asset declarations follow in generated/asset-notices.json.\n" +
          JSON.stringify(result.ir?.assetNotices ?? [], null, 2) +
          "\n",
      );
      await cp(
        path.join(
          engineRoot,
          layout.installed
            ? "licenses/three/LICENSE"
            : "node_modules/three/LICENSE",
        ),
        path.join(output, "THREE-LICENSE.txt"),
      );
      await cp(
        path.join(
          engineRoot,
          layout.installed
            ? "licenses/@dimforge/rapier3d-compat/LICENSE"
            : "node_modules/@dimforge/rapier3d-compat/LICENSE",
        ),
        path.join(output, "RAPIER-LICENSE.txt"),
      );
      for (const dependency of ["fast-png", "fflate", "iobuffer", "ngraph.path"]) {
        await cp(
          path.join(engineRoot, layout.installed ? "licenses" : "node_modules", dependency, "LICENSE"),
          path.join(output, `${dependency.toUpperCase()}-LICENSE.txt`),
        );
      }
      await writeFile(
        path.join(output, "pelican-build.json"),
        JSON.stringify(
          {
            engineVersion: SDK_VERSION,
            stage: activeManifest.stage,
            game: result.ir?.gameId,
            entry: "index.html",
            renderer: "webgpu-with-webgl2-fallback",
            limitations: [
              "M3 rendering is in development; not the complete engine or an accepted M3 release",
              "Opaque textured surface transport is integrated; unsupported combinations report explicit diagnostics",
              "Physics snapshots replay operation history and are bounded to 100000 operations",
              "Compute BVH path tracer, no hardware ray tracing",
              "Spatial denoising is integrated; temporal motion reconstruction remains work in progress",
            ],
          },
          null,
          2,
        ) + "\n",
      );
      await compressDist(output);
      emit(
        envelope(
          "succeeded",
          { output: "dist", game: result.ir?.gameId },
          [],
          [
            "dist/index.html",
            "dist/generated/scene.ir.json",
            "dist/pelican-build.json",
          ],
        ),
      );
      return;
    }
    const port = Number(option("port", "4173"));
    const server = await createServer({
      root: layout.webRoot,
      configFile: layout.installed
        ? false
        : path.join(engineRoot, "vite.config.ts"),
      envFile: false,
      plugins: layout.installed
        ? [
            {
              name: "pelican-installed-browser-entry",
              transformIndexHtml: {
                order: "pre",
                handler(html) {
                  return html.replace(
                    "../lib/renderer/browser.js",
                    "/@fs/" +
                      path
                        .join(engineRoot, "lib/renderer/browser.js")
                        .replaceAll("\\", "/"),
                  );
                },
              },
            },
          ]
        : [],
      publicDir: path.dirname(target),
      server: {
        port,
        host: "127.0.0.1",
        strictPort: true,
        fs: { allow: [engineRoot, projectRoot] },
      },
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
              await (window as any).__pelican.mode(mode);
              if (mode !== "raster")
                await (window as any).__pelican.accumulate(8);
            },
            option("mode", "raster"),
          ),
        );
        const output = path.resolve(
          option("output", path.join(projectRoot, ".pelican/capture.png"))!,
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
        filename.includes(`${path.sep}.pelican${path.sep}`) ||
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
          if (next.success && !dirty && !next.report.incremental.cacheHit)
            server.ws.send({ type: "full-reload" });
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
        ...(scaffolded ? { scaffolded: true, template: "minimal" } : {}),
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
        code: diagnosticCode(error),
        severity: "error",
        message: String(error),
        remediation:
          "Inspect the referenced source or run doctor; preserve failure output before retrying.",
      },
    ]),
  );
  process.exitCode = 1;
});
