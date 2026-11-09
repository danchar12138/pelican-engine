import { runProjectVerification } from "./verify-project.ts";
import { captureFacts } from "./capture-facts.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  readFile,
  writeFile,
  cp,
  access,
  realpath,
  lstat,
} from "node:fs/promises";
import { build as viteBuild, createServer } from "vite";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { readRecipe, readRecipeFiles, readRecipeAssets, prepareRecipeAssetCopy, recipeVerification, recipeDependencies, recipeIds } from "./npm/recipes.ts";
import { generateApiIndex, queryApi } from "./api-index.ts";
import { authorGuide, compactAuthorGuide, queryCapabilities } from "./author-guide.ts";
import { diagnoseRendering, type RenderDiagnosticInput } from "../packages/sdk/src/index.ts";
import { queryAssets } from "./asset-query.ts";
import { optimizeModel } from "../packages/assets/src/optimize.ts";
import { compressDist } from "./compress-dist.ts";
import { createBuildOutput } from "./build-output.ts";
import { doctor } from "./doctor.ts";
import { setup } from "./setup.ts";
import { attachControl } from "./control-server.ts";
import { createControlClient } from "./control-client.ts";
import { diagnosticCode } from "./diagnostic-code.ts";
import { discoveryRecovery } from "./discovery-recovery.ts";
import { listProjectManifestBackups, migrateProject, restoreProjectManifest } from "./migrate.ts";
import {
  cliLayout,
  createMinimalProject,
  prepareInstalledDevProject,
  installedDoctor,
} from "./npm/layout.ts";
import { result as protocolResult, normalizeDiagnostic, exitCodeFor, type InspectField, type TaskStatus, type ControlCommand } from "../packages/protocol/src/index.ts";
import {
  automationLaunchOptions,
  automationURL,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

const requestedLayout = cliLayout(import.meta.url);
const engineRoot = await realpath(requestedLayout.root);
const layout = { ...requestedLayout, root: engineRoot, webRoot: requestedLayout.installed ? path.join(engineRoot, "web") : engineRoot };
// --json is a compatibility no-op: every command already emits JSON.
const args = process.argv.slice(2).filter(arg => arg !== "--json");
const activeManifest = JSON.parse(
  await readFile(path.join(engineRoot, "engine.manifest.json"), "utf8"),
) as { stage: string };
const defaultProject = layout.installed
  ? process.cwd()
  : path.join(engineRoot, "examples/m2");
const command = args.includes("--help") || args.includes("-h") ? "help"
  : ["--version", "-v"].includes(args[0] ?? "") ? "version" : args[0] ?? "help";
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const requestedProjectRoot = path.resolve(
  command === "api" ? defaultProject : option("project", command === "create" ? process.cwd() : defaultProject)!,
);
const projectRoot = await realpath(requestedProjectRoot).catch(() => requestedProjectRoot);
const taskId = `${command}-${Date.now()}`;
const envelope = (status: TaskStatus, data: unknown, diagnostics: unknown[] = [], artifacts: string[] = []) => protocolResult(taskId, status, data, diagnostics.map(normalizeDiagnostic), artifacts.map(file => ({type:"file",path:file.replaceAll("\\","/")})));
const emit = (value: unknown) => {
  const response = value as ReturnType<typeof protocolResult>;
  if (Array.isArray(response.diagnostics)) response.diagnostics = response.diagnostics.map(normalizeDiagnostic);
  process.stdout.write(JSON.stringify(value, null, args.includes("--compact") || command === "dev" ? undefined : 2) + "\n");
  process.exitCode = exitCodeFor(response);
};
const target = path.join(projectRoot, ".pelican/public/generated");
async function compile() {
  await mkdir(target, { recursive: true });
  return compileProject({ projectRoot: requestedProjectRoot, outDir: target, engineRoot });
}
async function main() {
  if (command === "version") { emit(envelope("succeeded", { name: "pelican-engine", version: SDK_VERSION })); return; }
  if (command === "help") {
    emit(
      envelope("succeeded", {
        commands: [
          "doctor",
          "guide [--compact] [--goal <task-or-query>] [--tasks --limit 8 --offset 0] (project summary, discovery and continuation)",
          "capabilities [--feature <id-or-English/中文-query>] [--summary] [--limit 20 --offset 0]",
          "diagnose [--port 4173] (bounded live render observations with causes and repair queries; not FPS)",
          "assets [--id <declared-id>] [--limit 20 --offset 0] (validated asset costs and real model material slots)",
          "recipe --id <recipe-id>",
          "api [--symbol <Type-or-Type.member> | --search <query> [--member] [--limit 20]]",
          "setup [--install-browser] [--offline]",
          "create [--project <directory>] [--template minimal|<recipe-id>]",
          "migrate [--project <directory>] [--apply --from <version|unlocked>]",
          "migrate [--project <directory>] --list-backups",
          "migrate [--project <directory>] --restore <backup-name> --expect-current <sha256> --expect-backup <sha256>",
          "check --project <directory>",
          "compile --project <directory>",
          "dev --project <directory> [--port 4173]",
          "build --project <directory> [--base <path>]",
          "optimize --project <directory> --asset <id> [--output <new-project-relative.glb>]",
          "capture [--live] [--facts] [--mode raster|hybrid|path] [--output file.png]",
          "verify [--recipe <id>] [--baseline .pelican/baseline.png [--write-baseline]] [--port 4173] (owned headless smoke, or explicit recipe acceptance; writes .pelican/verify)",
          "render --samples <1..4096> [--mode path|hybrid] [--denoise true|false] [--port <dev-port>]",
          "pointer --x <css-x> --y <css-y> [--buttons <mask>] [--dx <px>] [--dy <px>] [--wheel-x <px>] [--wheel-y <px>]",
          "batch --file <commands.json> [--port <dev-port>] (preflighted; completed operations are not rolled back)",
          "inspect [--summary | --fields summary,rendering,...] [--limit 20 --offset 0] | step --count <n> | pause | resume [--port <dev-port>]",
          "reload [--restart] [--port <dev-port>] (preserve compatible state; restart explicitly discards it)",
          "prepare-render --mode path|hybrid|raster [--port <dev-port>] (prepare resources without switching mode)",
          "input --key ArrowRight [--pressed true] [--port <dev-port>]",
          "snapshot --output <file> | restore --file <file>",
          "record --action start|stop|cancel | replay --file <trace.json>",
          "status | cancel --task <id> | reset-session",
        ],
        stage: activeManifest.stage,
      }),
    );
    return;
  }
  if (command === "migrate") {
    const root = path.resolve(option("project", process.cwd())!);
    const restore = args.includes("--restore");
    const listBackups = args.includes("--list-backups");
    if ((restore && (args.includes("--apply") || args.includes("--from") || listBackups)) ||
        (listBackups && (args.includes("--apply") || args.includes("--from") || args.includes("--expect-current") || args.includes("--expect-backup"))) ||
        (!restore && (args.includes("--expect-current") || args.includes("--expect-backup"))))
      throw new Error("TC_MIGRATE_OPTIONS: Use plan, apply, list-backups or restore separately; hash options apply only to restore.");
    const result = listBackups ? await listProjectManifestBackups(root) : restore
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
    return;
  }
  if (command === "api") {
    const index = layout.installed
      ? JSON.parse(
          await readFile(path.join(engineRoot, "docs/api/index.json"), "utf8"),
        )
      : await generateApiIndex(engineRoot);
    const result = queryApi(index, args.slice(1));
    emit(
      envelope(
        "succeeded",
        { engineVersion: SDK_VERSION, ...result,
          ...(index.installedDeclarations ? { installedDeclarations: index.installedDeclarations, sourceProvenance: index.sourceProvenance } : {}) },
        [],
        ["docs/api/index.json", "docs/api/REFERENCE.md"].map((file) =>
          layout.installed ? path.join(engineRoot, file) : file,
        ),
      ),
    );
    return;
  }
  if (command === "guide") {
    const query = args.slice(1).filter(arg => arg !== "--compact" && arg !== "--project" && arg !== option("project"));
    emit(envelope("succeeded", args.includes("--compact") ? await compactAuthorGuide(query, projectRoot) : authorGuide(query)));
    return;
  }
  if (command === "assets") {
    const result = await compile();
    if (!result.success || !result.ir) { emit(envelope("failed", null, result.diagnostics)); return; }
    emit(envelope("succeeded", queryAssets(result.ir, option("id"), Number(option("limit", "20")), Number(option("offset", "0"))), result.diagnostics));
    return;
  }
  if (command === "capabilities") {
    emit(envelope("succeeded", queryCapabilities(args.slice(1))));
    return;
  }
  if (command === "recipe") {
    const id = option("id");
    if (!id) throw new Error("TC_RECIPE_ID: Supply --id; capabilities lists available recipes.");
    emit(envelope("succeeded", { id, source: await readRecipe(engineRoot, id, layout.installed), files: await readRecipeFiles(engineRoot, id, layout.installed), dependencies: recipeDependencies(id), assets: await readRecipeAssets(engineRoot,id,layout.installed), verification:recipeVerification(id), entry: "game.ts", create: `pelican create --template ${id}` }));
    return;
  }
  if (
    [
      "inspect",
      "diagnose",
      "render",
      "pointer",
      "batch",
      "step",
      "pause",
      "resume",
      "reload",
      "prepare-render",
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
      if (command === "capture") operation = { type: "capture", ...(args.includes("--facts") ? {facts:true} : {}) };
      else if (command === "prepare-render") operation = { type: "prepareRender", mode: option("mode", "path") as "path" | "hybrid" | "raster" };
      else if (command === "reload") operation = { type: "reload", restart: args.includes("--restart") };
      else if (command === "pointer") operation = { type: "pointer", x: Number(option("x")), y: Number(option("y")), buttons: Number(option("buttons", "0")),
        delta: [Number(option("dx", "0")), Number(option("dy", "0"))], wheel: [Number(option("wheel-x", "0")), Number(option("wheel-y", "0"))] };
      else if (command === "batch") {
        const file = option("file"); if (!file) throw new Error("TC_CLI_FILE: --file is required.");
        const contents = JSON.parse(await readFile(path.resolve(file), "utf8")); operation = { type: "batch", commands: Array.isArray(contents) ? contents : contents.commands };
      }
      else if (command === "render") {
        const denoise = option("denoise");
        if (denoise !== undefined && !["true", "false"].includes(denoise)) throw new Error("TC_CLI_RENDER: --denoise must be true or false.");
        operation = { type: "render", samples: Number(option("samples", "64")), mode: option("mode", "path") as "path" | "hybrid", ...(denoise === undefined ? {} : { denoise: denoise === "true" }) };
      }
      else if (command === "inspect" || command === "diagnose")
        operation = {
          type: "inspect",
          ...(command === "diagnose" ? { fields: ["assets", "rendering", "metrics", "viewport"] as InspectField[], limit: 1 } : {}),
          ...(command === "inspect" && args.includes("--summary") ? { summary: true } : {}),
          ...(command === "inspect" && option("fields") ? { fields: option("fields")!.split(",") as InspectField[] } : {}),
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
    if (command === "diagnose" && response.status === "succeeded") {
      const observed = response.data as RenderDiagnosticInput & { summary?: { mode?: string } };
      response.data = diagnoseRendering(observed);
    }
    if (command === "capture" && response.status === "succeeded") {
      const data = response.data as {
        format: string;
        base64: string;
        width: number;
        height: number;
        bytes: number;
        facts?: unknown;
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
        ...(data.facts ? {facts:data.facts} : {}),
      };
      response.artifacts.push({ type: "image", path: output });
    } else if (option("output") && response.status === "succeeded") {
      const output = path.resolve(option("output")!);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(response.data, null, 2) + "\n");
      response.artifacts.push({ type: "file", path: output });
    }
    emit(response);
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
        return;
    }
    const result = await setup({
      projectRoot: engineRoot,
      taskId,
      offline: args.includes("--offline"),
      installBrowser: args.includes("--install-browser"),
    });
    emit(result);
    return;
  }
  if (command === "create") {
    const template = option("template", "minimal");
    if (
      !["minimal", ...recipeIds].includes(template!)
    )
      throw new Error(
        "TC_CREATE_TEMPLATE: Use minimal or a recipe ID from capabilities.",
      );
    if (template === "minimal" || recipeIds.includes(template!)) {
      const source = template === "minimal" ? undefined : await readRecipe(engineRoot, template!, layout.installed);
      const files = template === "minimal" ? {} : await readRecipeFiles(engineRoot, template!, layout.installed);
      for (const filename of Object.keys(files)) if (path.basename(filename) !== filename || !filename.endsWith(".ts"))
        throw new Error("TC_RECIPE_PATH: Recipe helper must be a project-local TypeScript filename.");
      const copyAssets = await prepareRecipeAssetCopy(projectRoot, template === "minimal" ? [] : await readRecipeAssets(engineRoot,template!,layout.installed));
      for (const filename of ["game.ts", "pelican.project.json", "AGENTS.md", ...Object.keys(files)])
        try {
          await lstat(path.join(projectRoot, filename));
          throw new Error(
            "TC_CREATE_EXISTS: Project files already exist; no files were overwritten.",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      await createMinimalProject(projectRoot, engineRoot, layout.installed);
      await copyAssets();
      if (source !== undefined) await writeFile(path.join(projectRoot, "game.ts"), source, "utf8");
      for (const [file, text] of Object.entries(files)) await writeFile(path.join(projectRoot, file), text, { encoding: "utf8", flag: "wx" });
      emit(
        envelope(
          "succeeded",
          {
            project: path.basename(projectRoot),
            engineVersion: SDK_VERSION,
            template,
            dependencies: recipeDependencies(template!),
          },
          [],
          ["game.ts", "pelican.project.json", "AGENTS.md"],
        ),
      );
      return;
    }
  }
  if (
    ["check", "compile", "build", "dev", "capture", "verify", "optimize"].includes(
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
      const staged = await createBuildOutput(output);
      const stagingOutput = staged.staging;
      try {
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
              outDir: stagingOutput,
              emptyOutDir: false,
              target: "es2023",
              sourcemap: false,
            },
          });
        } finally {
          if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = previousNodeEnv;
        }
        await cp(path.join(engineRoot, "LICENSE"), path.join(stagingOutput, "LICENSE"));
        await writeFile(
          path.join(stagingOutput, "THIRDPARTY-NOTICES.txt"),
          "pelican runtime uses Three.js 0.187.0, fast-png 8.0.0, fflate 0.8.3, iobuffer 6.0.1 and ngraph.path 1.6.1 (MIT), a modified Rapier 3D 0.21.0 build (persistent-island bootstrap patch), and @dimforge/rapier2d-compat 0.21.0 (Apache-2.0). Full dependency licenses are distributed beside this notice. User asset declarations follow in generated/asset-notices.json.\n" +
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
          path.join(stagingOutput, "THREE-LICENSE.txt"),
        );
        await cp(
          path.join(
            engineRoot,
            layout.installed
              ? "licenses/@dimforge/rapier3d-compat/LICENSE"
              : "node_modules/@dimforge/rapier3d-compat/LICENSE",
          ),
          path.join(stagingOutput, "RAPIER-LICENSE.txt"),
        );
        await cp(
          path.join(engineRoot, layout.installed ? "licenses/@dimforge/rapier2d-compat/LICENSE" : "node_modules/@dimforge/rapier2d-compat/LICENSE"),
          path.join(stagingOutput, "RAPIER2D-LICENSE.txt"),
        );
        for (const dependency of ["fast-png", "fflate", "iobuffer", "ngraph.path"]) {
          await cp(
            path.join(engineRoot, layout.installed ? "licenses" : "node_modules", dependency, "LICENSE"),
            path.join(stagingOutput, `${dependency.toUpperCase()}-LICENSE.txt`),
          );
        }
        await writeFile(
          path.join(stagingOutput, "pelican-build.json"),
          JSON.stringify(
            {
              engineVersion: SDK_VERSION,
              stage: activeManifest.stage,
              game: result.ir?.gameId,
              entry: "index.html",
              renderer: "webgpu-with-webgl2-fallback",
              limitations: [
                "Render features are capability-dependent; inspect the active backend and diagnostics",
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
        await compressDist(stagingOutput);
      } catch (error) {
        throw new AggregateError([error], `TC_BUILD_STAGING: Build failed before replacing dist; partial files remain at '${stagingOutput}'. Inspect and remove them only when no longer needed.`);
      }
      const committed = await staged.commit();
      emit(
        envelope(
          "succeeded",
          { output: "dist", game: result.ir?.gameId, ...(committed.backup ? { previousOutput: committed.backup } : {}) },
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
      plugins: [
        { name: "pelican-author-iteration", handleHotUpdate(context) {
          const relative = path.relative(projectRoot, context.file);
          if (!relative.startsWith("..") && !path.isAbsolute(relative)) return [];
        } },
        ...(layout.installed
        ? [
            {
              name: "pelican-installed-browser-entry",
              transformIndexHtml: {
                order: "pre" as const,
                handler(html: string) {
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
        : []),
      ],
      publicDir: path.dirname(target),
      server: {
        port,
        host: "127.0.0.1",
        strictPort: true,
        watch: { ignored: ["**/.pelican/**", "**/dist/**"] },
        fs: { allow: [engineRoot, projectRoot] },
      },
      logLevel: "silent",
    });
    const controls = command === "dev" ? attachControl(server) : undefined;
    await server.listen();
    if (command === "capture" || command === "verify") {
      let browser: import("playwright").Browser | undefined;
      try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch(automationLaunchOptions());
        const page = await browser.newPage({
          viewport: { width: 960, height: 540 },
        });
        await withAutomationDeadline(() =>
          page.goto(automationURL(`http://127.0.0.1:${port}/${option("mode") === "raster" ? "?quality=low" : ""}`), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          }),
        );
        await waitForEngine(page);
        if (command === "verify") {
          if(args.includes("--write-baseline") && !option("baseline"))throw new Error("TC_CLI_BASELINE: --write-baseline requires --baseline .pelican/<file.png>.");
          if(option("baseline")) {
            const relative=path.relative(path.join(projectRoot,".pelican"),path.resolve(projectRoot,option("baseline")!));
            if(relative.startsWith("..")||path.isAbsolute(relative)||path.extname(relative)!==".png")throw new Error("TC_CLI_BASELINE: Baselines belong under the project's .pelican/ directory and must use .png.");
          }
          const report = await runProjectVerification(page, {recipe:option("recipe"), output:path.join(projectRoot,".pelican/verify"), ...(option("baseline")?{baseline:path.resolve(projectRoot,option("baseline")!),writeBaseline:args.includes("--write-baseline")}:{})});
          emit(envelope(report.passed ? "succeeded" : "failed", report, report.passed ? [] : [{code:"TC_VERIFY_ASSERTION",severity:"error",message:report.failure,remediation:"Inspect report and screenshot. Recipe acceptance applies to the selected original recipe; general verify is smoke only."}], report.artifacts));
          return;
        }
        const captureMode = await withAutomationDeadline(() =>
          page.evaluate(async (requested) => {
            const api=(window as any).__pelican;
            if(requested !== undefined)await api.mode(requested);
            const active=api.inspect().mode;
            if(active !== "raster")await api.accumulate(8);
            return active as string;
          }, option("mode")),
        );
        const output = path.resolve(
          option("output", path.join(projectRoot, ".pelican/capture.png"))!,
        );
        await mkdir(path.dirname(output), { recursive: true });
        const observation = args.includes("--facts") ? await page.evaluate(async () => (window as any).__pelican.command({type:"inspect",summary:true})) : undefined;
        const captured = await withAutomationDeadline(() => page.screenshot({ path: output, timeout: 30_000 }));
        emit(
          envelope(
            "succeeded",
            { mode: captureMode, ...(args.includes("--facts") ? {facts:captureFacts(captured, observation)} : {}) },
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
      dirty = false,
      reloadPending = false;
    server.watcher.on("all", async (event, filename) => {
      const relative = path.relative(projectRoot, filename);
      const firstSegment = relative.split(path.sep)[0];
      if (
        relative === ".." || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        firstSegment === ".pelican" || firstSegment === "dist" || firstSegment === "node_modules"
      )
        return;
      dirty = true;
      if (pending) return;
      pending = true;
      try {
        while (dirty) {
          dirty = false;
          try {
            const next = await compile();
            if (next.success && !next.report.incremental.cacheHit) reloadPending = true;
            if (next.success && !dirty && reloadPending) {
              server.ws.send({ type: "custom", event: "pelican:content", data: { policy: next.report.hotReload } });
              reloadPending = false;
            } else if (!next.success)
              emit(envelope("failed", next.report, next.diagnostics));
          } catch (error) {
            emit(
              envelope("failed", null, [
                { code: "TC_DEV_REBUILD", message: String(error) },
              ]),
            );
          }
        }
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
          "transactional logic reload with full state preservation; incompatible declarations keep the running game and require explicit restart",
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

        ...discoveryRecovery(error, process.argv.slice(2)),
      },
    ]),
  );
});
