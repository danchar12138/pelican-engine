import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { build, version as viteVersion } from "vite";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import { Extractor } from "./extract.ts";
import { hash, normalize } from "./normalize.ts";
import type { AssetCopy } from "./normalize.ts";
import type {
  BuildReport,
  CompileOptions,
  CompileResult,
  Diagnostic,
  SceneIR,
  SourceLocation,
} from "./types.ts";
export type * from "./types.ts";
interface Cache {
  format: 1;
  compilerVersion: string;
  bundlerVersion: string;
  inputs: BuildReport["inputs"];
  outputHashes: Record<string, string>;
  schemaHash: string;
  defaultsHash: string;
  ir: SceneIR;
}
const slash = (p: string) => p.replaceAll("\\", "/");
async function readJSON<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
function usableCache(value: Cache | undefined): value is Cache {
  return (
    !!value &&
    value.format === 1 &&
    Array.isArray(value.inputs) &&
    value.inputs.every(
      (i) =>
        typeof i.path === "string" &&
        ["project", "engine"].includes(i.root) &&
        typeof i.hash === "string",
    ) &&
    !!value.outputHashes &&
    typeof value.outputHashes === "object" &&
    !Array.isArray(value.outputHashes) &&
    Object.keys(value.outputHashes).includes("game.js") &&
    !!value.ir &&
    value.ir.format === "threecat.scene" &&
    typeof value.schemaHash === "string" &&
    typeof value.defaultsHash === "string"
  );
}
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? filesUnder(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    ),
  );
  return results.flat();
}
function projectLocation(
  projectRoot: string,
  sf: ts.SourceFile,
  start: number,
  length = 1,
): SourceLocation {
  const pos = sf.getLineAndCharacterOfPosition(start);
  return {
    file: slash(path.relative(projectRoot, sf.fileName)),
    line: pos.line + 1,
    column: pos.character + 1,
    length,
  };
}
// Vite sets NODE_ENV globally. Serialize build environment transactions and restore
// the caller's exact value on both success and failure (including an absent key).
let viteBuildQueue: Promise<void> = Promise.resolve();
async function productionBuild(config: Parameters<typeof build>[0]) {
  const previousBuild = viteBuildQueue;
  let release!: () => void;
  viteBuildQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousBuild;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    return await build(config);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    release();
  }
}
async function bundle(
  entry: string,
  sdkPath: string,
  projectRoot: string,
): Promise<{ code: string; map: string }> {
  const virtual = slash(
    path.join(projectRoot, "__threecat_m0_game_entry__.js"),
  );
  const virtualId = "\0threecat:m0-game-entry";
  const result = await productionBuild({
    configFile: false,
    envFile: false,
    mode: "production",
    root: projectRoot,
    publicDir: false,
    logLevel: "silent",
    resolve: { alias: { "@threecat/sdk": slash(sdkPath) } },
    plugins: [
      {
        name: "threecat-compiled-game",
        enforce: "pre",
        resolveId(id) {
          if (id === "@threecat/sdk") return slash(sdkPath);
          if (slash(id) === virtual) return virtualId;
        },
        load(id) {
          if (id === virtualId)
            return (
              "import game from " +
              JSON.stringify(slash(entry)) +
              "; import { instantiateGame } from " +
              JSON.stringify(slash(sdkPath)) +
              "; export function createGame(engine) { return instantiateGame(game, engine); }"
            );
        },
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: true,
      minify: false,
      lib: { entry: virtual, formats: ["es"], fileName: () => "game.js" },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as unknown as {
    output: {
      type: string;
      fileName: string;
      code?: string;
      source?: string | Uint8Array;
      map?: { toString(): string };
    }[];
  }[];
  const items = outputs.flatMap((o) => o.output ?? []);
  const chunk = items.find(
    (i) => i.type === "chunk" && i.fileName === "game.js",
  );
  if (!chunk?.code) throw new Error("Vite did not generate game.js.");
  const mapAsset = items.find((i) => i.fileName === "game.js.map");
  const raw =
    chunk.map?.toString() ??
    (mapAsset?.source ? String(mapAsset.source) : undefined);
  if (!raw) throw new Error("Vite did not generate a source map.");
  const map = JSON.parse(raw) as {
    file: string;
    sources: string[];
    sourceRoot?: string;
    sourcesContent?: string[];
  };
  map.file = "game.js";
  map.sourceRoot = "";
  // Rollup/Vite map paths are relative to its virtual output at projectRoot/dist.
  map.sources = map.sources.map((p) => {
    if (p.includes("threecat:m0-game-entry")) return "threecat-generated-entry";
    const absolute = path.isAbsolute(p)
      ? p
      : path.resolve(projectRoot, "dist", p);
    if (absolute === sdkPath) return "threecat-sdk/index.ts";
    return slash(path.relative(projectRoot, absolute));
  });
  return { code: chunk.code, map: JSON.stringify(map) };
}
/** Parse, typecheck and statically extract declarations; NEVER import a game source module. */
export async function compileProject(
  options: CompileOptions,
): Promise<CompileResult> {
  const start = performance.now();
  const projectRoot = path.resolve(options.projectRoot);
  const outDir = path.resolve(projectRoot, options.outDir);
  const engineRoot = options.engineRoot
    ? path.resolve(options.engineRoot)
    : fileURLToPath(new URL("../../", import.meta.url));
  const sdkPath = path.join(engineRoot, "packages/sdk/src/index.ts");
  const diagnostics: Diagnostic[] = [];
  const report: BuildReport = {
    format: "threecat.build-report",
    version: 1,
    success: false,
    engineVersion: SDK_VERSION,
    compilerVersion: ts.version,
    project: { id: "", entry: "game.ts" },
    diagnostics,
    inputs: [],
    outputs: [],
    incremental: {
      cacheHit: false,
      changedInputs: [],
      reused: [],
      schemaHash: "",
      defaultsHash: "",
    },
    hotReload: {
      strategy: "cold-start",
      preserveState: false,
      defaults: "new-entities-only",
      reason: "No previous successful build.",
    },
    modules: [],
    limitations: [
      "M0 static declaration subset; not arbitrary TypeScript compile-time execution.",
      "Graph IR validation is implemented; GPU lowering and dispatch belong to the renderer.",
      "Hot-reload policy is reported; live state migration is not implemented by this compiler.",
      "Declaration imports are conservatively included; full module tree-shaking analysis is not an M0 claim.",
    ],
    durationMs: 0,
  };
  const fail = async (): Promise<CompileResult> => {
    report.durationMs = performance.now() - start;
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(
        path.join(outDir, "build-report.json"),
        JSON.stringify(
          { ...report, artifactState: "previous-success-not-current" },
          null,
          2,
        ),
      );
    } catch {
      diagnostics.push({
        code: "TC_OUTPUT_WRITE",
        severity: "error",
        message: "Cannot write the build report to outDir.",
        suggestion:
          "Choose an output directory that is writable and is not an existing file.",
      });
    }
    return { success: false, diagnostics, report };
  };
  try {
    const manifestPath = path.join(projectRoot, "threecat.project.json");
    let manifest: { entry?: string } = {};
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({
          code: "TC_PROJECT_CONFIG",
          severity: "error",
          message: "Cannot read threecat.project.json as JSON.",
          suggestion:
            "Use a JSON object with an optional project-relative entry string.",
        });
        return await fail();
      }
    }
    if (
      !manifest ||
      typeof manifest !== "object" ||
      (manifest.entry !== undefined && typeof manifest.entry !== "string")
    ) {
      diagnostics.push({
        code: "TC_PROJECT_CONFIG",
        severity: "error",
        message: "Invalid project manifest.",
        suggestion: "Set entry to a project-relative TypeScript filename.",
      });
      return await fail();
    }
    const entry = path.resolve(projectRoot, manifest.entry ?? "game.ts");
    report.project.entry = slash(path.relative(projectRoot, entry));
    if (
      report.project.entry.startsWith("..") ||
      path.isAbsolute(report.project.entry)
    ) {
      diagnostics.push({
        code: "TC_PROJECT_ENTRY",
        severity: "error",
        message: "Entry must be inside projectRoot.",
        suggestion: "Use a project-relative entry path.",
      });
      return await fail();
    }
    try {
      await fs.access(entry);
      await fs.access(sdkPath);
    } catch {
      diagnostics.push({
        code: "TC_PROJECT_MISSING",
        severity: "error",
        message: "Missing game entry or public SDK source.",
        suggestion:
          "Supply game.ts (or a manifest entry) and a valid engineRoot.",
      });
      return await fail();
    }
    const cachePath = path.join(outDir, ".threecat-cache.json");
    const cacheCandidate = await readJSON<Cache>(cachePath);
    const previous = usableCache(cacheCandidate) ? cacheCandidate : undefined;
    const toolFiles = (
      await filesUnder(fileURLToPath(new URL(".", import.meta.url)))
    ).filter((p) => p.endsWith(".ts"));
    const sdkFiles = (
      await filesUnder(path.join(engineRoot, "packages/sdk/src"))
    ).filter((p) => p.endsWith(".ts"));
    const engineInputs = [...new Set([...toolFiles, ...sdkFiles])];
    const makeInput = async (
      file: string,
      root: "project" | "engine",
    ): Promise<BuildReport["inputs"][number]> => ({
      root,
      path: slash(
        path.relative(root === "project" ? projectRoot : engineRoot, file),
      ),
      hash: hash(await fs.readFile(file)),
    });
    const initialInputs = await Promise.all([
      ...engineInputs.map((p) => makeInput(p, "engine")),
      makeInput(entry, "project"),
    ]);
    try {
      await fs.access(manifestPath);
      initialInputs.push(await makeInput(manifestPath, "project"));
    } catch {
      /* optional manifest */
    }
    if (previous?.format === 1) {
      const sameTools = initialInputs.every((i) =>
        previous.inputs.some(
          (p) => p.root === i.root && p.path === i.path && p.hash === i.hash,
        ),
      );
      const changed: string[] = [];
      for (const input of previous.inputs) {
        try {
          const current = await makeInput(
            path.resolve(
              input.root === "project" ? projectRoot : engineRoot,
              input.path,
            ),
            input.root,
          );
          if (current.hash !== input.hash) changed.push(input.path);
        } catch {
          changed.push(input.path);
        }
      }
      report.incremental.changedInputs = [
        ...new Set([
          ...changed,
          ...initialInputs
            .filter(
              (i) =>
                !previous.inputs.some(
                  (p) =>
                    p.path === i.path && p.root === i.root && p.hash === i.hash,
                ),
            )
            .map((i) => i.path),
        ]),
      ];
      let outputsValid = true;
      for (const [file, fingerprint] of Object.entries(previous.outputHashes)) {
        try {
          if (hash(await fs.readFile(path.join(outDir, file))) !== fingerprint)
            outputsValid = false;
        } catch {
          outputsValid = false;
        }
      }
      if (
        previous.compilerVersion !== ts.version ||
        previous.bundlerVersion !== viteVersion
      )
        report.incremental.changedInputs.push("<tool-version>");
      if (
        sameTools &&
        previous.compilerVersion === ts.version &&
        previous.bundlerVersion === viteVersion &&
        !changed.length &&
        outputsValid &&
        previous.ir.engineVersion === SDK_VERSION &&
        previous.ir.version === 1
      ) {
        report.success = true;
        report.project.id = previous.ir.gameId;
        report.inputs = previous.inputs;
        report.outputs = [
          ...Object.keys(previous.outputHashes),
          "build-report.json",
        ];
        report.incremental = {
          cacheHit: true,
          changedInputs: [],
          reused: [
            "typecheck",
            "static-extraction",
            "graph-validation",
            "game-bundle",
            "assets",
          ],
          schemaHash: previous.schemaHash,
          defaultsHash: previous.defaultsHash,
        };
        report.hotReload = {
          strategy: "reuse",
          preserveState: true,
          defaults: "new-entities-only",
          reason:
            "All recorded source, SDK, compiler, asset and output hashes match.",
        };
        report.durationMs = performance.now() - start;
        report.modules = modulesFor(previous.ir);
        await fs.writeFile(
          path.join(outDir, "build-report.json"),
          JSON.stringify(report, null, 2),
        );
        return { success: true, diagnostics, report, ir: previous.ir };
      }
      if (!outputsValid)
        report.incremental.changedInputs.push("<generated-output>");
    } else report.incremental.changedInputs = initialInputs.map((i) => i.path);
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: [],
      lib: ["lib.es2023.d.ts"],
      paths: { "@threecat/sdk": [slash(sdkPath)] },
    };
    const program = ts.createProgram([entry], compilerOptions);
    program.getTypeChecker(); // Bind source parents before source-mapped static extraction.
    const extractor = new Extractor(program, projectRoot, sdkPath);
    const game = extractor.extract(entry);
    diagnostics.push(...extractor.diagnostics);
    for (const d of ts.getPreEmitDiagnostics(program)) {
      diagnostics.push({
        code: "TC_TS_" + d.code,
        severity:
          d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        suggestion:
          "Correct the TypeScript types or use a supported public SDK interface.",
        source:
          d.file && d.start !== undefined
            ? projectLocation(projectRoot, d.file, d.start, d.length ?? 1)
            : undefined,
      });
    }
    const sourceFiles = program
      .getSourceFiles()
      .filter((sf) => path.resolve(sf.fileName) !== path.resolve(sdkPath));
    const inputMap = new Map(
      initialInputs.map((i) => [i.root + ":" + i.path, i]),
    );
    for (const sf of sourceFiles) {
      const relative = path.relative(projectRoot, sf.fileName);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        const input = await makeInput(sf.fileName, "project");
        inputMap.set(input.root + ":" + input.path, input);
      }
    }
    report.inputs = [...inputMap.values()].sort((a, b) =>
      (a.root + a.path).localeCompare(b.root + b.path),
    );
    if (!game || diagnostics.some((d) => d.severity === "error"))
      return await fail();
    const normalized = await normalize(game, extractor, projectRoot);
    diagnostics.push(...normalized.diagnostics);
    if (!normalized.ir || diagnostics.some((d) => d.severity === "error"))
      return await fail();
    const ir = normalized.ir;
    report.project.id = ir.gameId;
    for (const asset of ir.assets)
      report.inputs.push({
        root: "project",
        path: asset.sourcePath,
        hash: asset.hash,
      });
    report.incremental.schemaHash = hash(
      JSON.stringify(
        ir.components.map((c) => ({
          id: c.id,
          fields: Object.fromEntries(
            Object.entries(c.schema).map(([k, f]) => [k, f.type]),
          ),
        })),
      ),
    );
    report.incremental.defaultsHash = hash(
      JSON.stringify(
        ir.components.map((c) => ({ id: c.id, schema: c.schema })),
      ),
    );
    if (previous?.format === 1) {
      const sameSchema = previous.schemaHash === report.incremental.schemaHash;
      const sameDefaults =
        previous.defaultsHash === report.incremental.defaultsHash;
      report.hotReload = {
        strategy: sameSchema ? "patch" : "restart",
        preserveState: sameSchema,
        defaults: "new-entities-only",
        reason: !sameSchema
          ? "Component field layout/type changed; restart required."
          : !sameDefaults
            ? "Only compatible changes; retain existing component values, apply new defaults to newly created entities."
            : "Compatible schema; runtime may patch logic/content at a safe boundary.",
      };
    }
    const bundled = await bundle(entry, sdkPath, projectRoot);
    const artifactData: Record<string, string | Uint8Array> = {
      "scene.ir.json": JSON.stringify(ir, null, 2),
      "game.js": bundled.code,
      "game.js.map": bundled.map,
      "version.json": JSON.stringify(
        {
          format: "threecat.version",
          version: 1,
          engineVersion: SDK_VERSION,
          compilerVersion: ts.version,
          irVersion: 1,
          schemaHash: report.incremental.schemaHash,
        },
        null,
        2,
      ),
    };
    for (const asset of normalized.assetCopies as AssetCopy[])
      artifactData[asset.output] = await fs.readFile(asset.source);
    await fs.mkdir(outDir, { recursive: true });
    for (const [file, data] of Object.entries(artifactData)) {
      const target = path.join(outDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
    report.success = true;
    report.outputs = [...Object.keys(artifactData), "build-report.json"];
    report.modules = modulesFor(ir);
    report.durationMs = performance.now() - start;
    await fs.writeFile(
      path.join(outDir, "build-report.json"),
      JSON.stringify(report, null, 2),
    );
    const cache: Cache = {
      format: 1,
      compilerVersion: ts.version,
      bundlerVersion: viteVersion,
      inputs: report.inputs,
      outputHashes: Object.fromEntries(
        Object.entries(artifactData).map(([file, data]) => [file, hash(data)]),
      ),
      schemaHash: report.incremental.schemaHash,
      defaultsHash: report.incremental.defaultsHash,
      ir,
    };
    await fs.writeFile(cachePath, JSON.stringify(cache));
    return { success: true, diagnostics, report, ir };
  } catch (error) {
    diagnostics.push({
      code: "TC_COMPILER_FAILURE",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      suggestion:
        "Read the build diagnostics; verify source paths, supported syntax and installed build dependencies.",
    });
    return await fail();
  }
}
function modulesFor(ir: SceneIR): string[] {
  return [
    "scene",
    ...(ir.components.length ? ["components"] : []),
    ...(ir.systems.length ? ["systems"] : []),
    ...(ir.materials.length ? ["materials"] : []),
    ...(ir.computes.length ? ["compute-graph-ir"] : []),
    ...(ir.assets.length ? ["assets"] : []),
  ];
}
