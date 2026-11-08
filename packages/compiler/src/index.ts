import { mapSourcePath } from "./source-map.ts";
import { compilerLayout } from "./distribution.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { build, version as viteVersion } from "vite";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import { Extractor } from "./extract.ts";
import { typescriptContent, ContentError } from "./typescript-content.ts";
import { hash, normalize } from "./normalize.ts";
import {
  readSDKVersion,
  resolveEnginePath,
  parseProjectManifest,
  validateManifest,
} from "./version.ts";
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
export { IR_VERSION, SYSTEM_PHASES } from "./types.ts";
export { readSDKVersion, resolveEnginePath } from "./version.ts";
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
    value.ir.format === "pelican.scene" &&
    typeof value.schemaHash === "string" &&
    typeof value.defaultsHash === "string"
  );
}
async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
  construction?: import("./extract.ts").ObjectValue,
): Promise<{ code: string; map: string; dependencies: string[] }> {
  const dependencies = new Set<string>();
  // Detect declarations which branch on Node/browser globals without running runtime.create.
  // This is a drift checksum, not a security signature. Function bodies belong to the runtime bundle.
  const fingerprintSource = `function fingerprint(value) {
    const text = JSON.stringify(value, (_, item) => typeof item === 'function' ? {__runtime:true} :
      item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
    let result = 2166136261;
    for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
    return result >>> 0;
  }`;
  const expected = construction === undefined ? undefined :
    (new Function(`${fingerprintSource}; return fingerprint;`)() as (value: unknown) => number)(construction);
  const virtual = slash(
    path.join(projectRoot, "__pelican_m0_game_entry__.js"),
  );
  const virtualId = "\0pelican:m0-game-entry";
  const result = await productionBuild({
    configFile: false,
    envFile: false,
    mode: "production",
    root: projectRoot,
    publicDir: false,
    logLevel: "silent",
    resolve: { alias: { "pelican-engine": slash(sdkPath) } },
    plugins: [
      {
        name: "pelican-compiled-game",
        enforce: "pre",
        resolveId(id) {
          if (id === "pelican-engine") return slash(sdkPath);
          if (slash(id) === virtual) return virtualId;
        },
        load(id) {
          const file = id.split("?")[0], relative = path.relative(projectRoot, file);
          if (path.isAbsolute(file) && !relative.startsWith("..") && !path.isAbsolute(relative)) dependencies.add(file);
          if (id === virtualId)
            return (
              "import game from " +
              JSON.stringify(slash(entry)) +
              "; import { instantiateGame } from " +
              JSON.stringify(slash(sdkPath)) +
              `; ${expected === undefined ? "" : fingerprintSource}
              export function createGame(engine) {
                ${expected === undefined ? "" : `if (fingerprint(game) !== ${expected}) throw new Error(${JSON.stringify(`TC_GAME_CONSTRUCTION_DRIFT: ${slash(path.relative(projectRoot, entry))}; Node content and browser declarations differ. Keep build metadata deterministic and move browser-only work/imports into runtime.create.`)});`}
                return instantiateGame(game, engine);
              }`
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
  const sourceRoot = map.sourceRoot ?? "";
  map.sourceRoot = "";
  // Rollup/Vite map paths are relative to its virtual output at projectRoot/dist.
  map.sources = map.sources.map((source) =>
    mapSourcePath(source, projectRoot, sdkPath, path, sourceRoot),
  );
  return { code: chunk.code, map: JSON.stringify(map), dependencies: [...dependencies] };
}
/** Typecheck and normalize declarations; trusted TypeScript construction runs in an owned process. */
export async function compileProject(
  options: CompileOptions,
): Promise<CompileResult> {
  const start = performance.now();
  // Windows TEMP and installed directories may use 8.3 aliases. Compare and
  // fingerprint one physical root, never an alias against a canonical child.
  const requestedRoot = path.resolve(options.projectRoot);
  const projectRoot = await fs.realpath(requestedRoot).catch(() => requestedRoot);
  const outDir = path.resolve(projectRoot, options.outDir);
  const requestedEngine = compilerLayout(import.meta.url, options.engineRoot).root;
  const layout = compilerLayout(import.meta.url, await fs.realpath(requestedEngine).catch(() => requestedEngine));
  const engineRoot = layout.root;
  const sdkPath = layout.sdk;
  const diagnostics: Diagnostic[] = [];
  const report: BuildReport = {
    format: "pelican.build-report",
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
      "Content mode is selected by the project manifest: trusted TypeScript construction or legacy nonexecuting static extraction.",
      "Graph IR validation is implemented; GPU lowering and dispatch belong to the renderer.",
      "Hot-reload policy is reported; live state migration is not implemented by this compiler.",
      "Construction and runtime modules must use stable IDs; arbitrary external side effects do not participate in incremental fingerprints.",
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
    const manifestPath = path.join(projectRoot, "pelican.project.json");
    let rawManifest: unknown = {};
    try {
      rawManifest = parseProjectManifest(await fs.readFile(manifestPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({
          code: "TC_PROJECT_CONFIG",
          severity: "error",
          message: "Cannot read pelican.project.json as JSON.",
          suggestion:
            "Use a JSON object with an optional project-relative entry string.",
        });
        return await fail();
      }
    }
    const validated = validateManifest(rawManifest, SDK_VERSION);
    diagnostics.push(...validated.diagnostics);
    if (!validated.manifest || diagnostics.some((d) => d.severity === "error"))
      return await fail();
    const manifest = validated.manifest;
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
    const selectedSDKVersion = readSDKVersion(
      await fs.readFile(layout.types, "utf8"),
    );
    if (selectedSDKVersion !== SDK_VERSION) {
      diagnostics.push({
        code: "TC_ENGINE_SDK_VERSION",
        severity: "error",
        message:
          "Selected engine SDK version " +
          String(selectedSDKVersion) +
          " differs from compiler SDK " +
          SDK_VERSION +
          ".",
        suggestion:
          "Run the compiler shipped with the selected engine; use matching engine and public SDK versions.",
      });
      return await fail();
    }
    if (manifest.engine?.path !== undefined) {
      try {
        const [locked, selected] = await Promise.all([
          fs.realpath(resolveEnginePath(requestedRoot, manifest.engine.path)),
          fs.realpath(engineRoot),
        ]);
        const equal =
          process.platform === "win32"
            ? locked.toLowerCase() === selected.toLowerCase()
            : locked === selected;
        if (!equal) throw new Error("Engine path mismatch");
      } catch {
        diagnostics.push({
          code: "TC_ENGINE_PATH_MISMATCH",
          severity: "error",
          message: "engine.path does not resolve to the selected engineRoot.",
          suggestion:
            "Use the correct project-relative or absolute engine directory, including its drive when on another Windows drive.",
        });
        return await fail();
      }
    }
    const cachePath = path.join(outDir, ".pelican-cache.json");
    const cacheCandidate = await readJSON<Cache>(cachePath);
    const previous = usableCache(cacheCandidate) ? cacheCandidate : undefined;
    const toolFiles = (
      await filesUnder(fileURLToPath(new URL(".", import.meta.url)))
    ).filter((p) => /\.(?:ts|js)$/.test(p));
    const sdkFiles = (await filesUnder(path.dirname(sdkPath))).filter((p) =>
      /\.(?:ts|js)$/.test(p),
    );
    const packageInputs: string[] = [];
    let assetPackageAvailable = true;
    for (const name of ["runtime", "schema", "assets"]) {
      const directory = path.join(
        engineRoot,
        layout.installed ? "lib" : "packages",
        name,
      );
      const files = (await filesUnder(directory)).filter(
        (p) =>
          /\.(?:ts|js|json)$/.test(p) &&
          !path
            .relative(engineRoot, p)
            .split(path.sep)
            .includes("node_modules"),
      );
      packageInputs.push(...files);
      if (name === "assets" && !files.length) assetPackageAvailable = false;
      if (!files.length)
        diagnostics.push({
          code: "TC_ENGINE_INPUT_MISSING",
          severity: "warning",
          message:
            "No hashable source files in packages/" +
            name +
            "; package may not yet be generated.",
          suggestion:
            "Generate the package before its runtime/schema functionality is used; a later file addition invalidates this cache.",
        });
    }
    const engineInputs = [
      ...new Set([...toolFiles, ...sdkFiles, ...packageInputs]),
    ];
    if (layout.installed)
      engineInputs.push(
        path.join(engineRoot, "distribution.json"),
        path.join(engineRoot, "package.json"),
      );
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
    if (manifest.libraries?.length && manifest.content !== "typescript") {
      for (const library of manifest.libraries) {
        const directory = path.join(projectRoot, "node_modules", library);
        const resolved = await fs.realpath(directory).catch(() => undefined);
        const relative = resolved && path.relative(projectRoot, resolved);
        if (!resolved || relative!.startsWith("..") || path.isAbsolute(relative!)) {
          diagnostics.push({ code: "TC_LIBRARY_LOCATION", severity: "error", message: `Runtime library '${library}' must be installed inside this game workspace.`, suggestion: "Install an exact package version in the game project; do not reference engine-private or external node_modules." });
          return await fail();
        }
      }
      for (const file of ["package.json", "package-lock.json", ...manifest.libraries.map(name => `node_modules/${name}/package.json`)]) {
        const filename = path.join(projectRoot, file);
        if (await fs.stat(filename).then(value => value.isFile()).catch(() => false)) initialInputs.push(await makeInput(filename, "project"));
      }
    }
    if (manifest.content === "typescript") {
      for (const file of ["package.json", "package-lock.json"]) {
        const filename = path.join(projectRoot, file);
        if (await fs.stat(filename).then(value => value.isFile()).catch(() => false)) initialInputs.push(await makeInput(filename, "project"));
      }
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
        (assetPackageAvailable ||
          !previous.ir.assets.some(
            (asset) => asset.type === "model" || asset.type === "audio",
          )) &&
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
      // The public lifecycle includes browser cancellation and browser-compatible dependencies.
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      paths: { "pelican-engine": [slash(layout.types)] },
    };
    const program = ts.createProgram([entry], compilerOptions);
    program.getTypeChecker(); // Bind source parents before source-mapped static extraction.
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
    let extractor: Pick<Extractor, "source" | "definitions">;
    let game: import("./extract.ts").ObjectValue | undefined;
    const contentDependencies: string[] = [];
    if (manifest.content === "typescript") {
      const checker = program.getTypeChecker();
      const inspectRuntime = (argument: ts.Expression): void => {
        const runtime = checker.getTypeAtLocation(argument).getProperty("runtime");
        const runtimeType = runtime && checker.getTypeOfSymbolAtLocation(runtime, argument).getNonNullableType();
        const factory = runtimeType?.getProperty("create");
        const callable = factory && checker.getTypeOfSymbolAtLocation(factory, argument);
        for (const signature of callable?.getCallSignatures() ?? []) {
          const result = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
          for (const state of result?.isUnion() ? result.types : result ? [result] : []) {
            const systems = state.getProperty("systems");
            const bindings = systems && checker.getTypeOfSymbolAtLocation(systems, argument).getNonNullableType();
            for (const binding of bindings?.getProperties() ?? []) {
              const run = checker.getTypeOfSymbolAtLocation(binding, argument);
              for (const runSignature of run.getCallSignatures()) {
                const returns = checker.getReturnTypeOfSignature(runSignature);
                if ((returns.isUnion() ? returns.types : [returns]).some(type => type.getProperty("then"))) {
                  const origin = binding.valueDeclaration ?? argument;
                  diagnostics.push({ code: "TC_SYSTEM_ASYNC", severity: "error", message: `Runtime system '${binding.name}' cannot return a Promise/thenable.`,
                    suggestion: "Await dependencies in runtime.create; return synchronous system functions.",
                    source: projectLocation(projectRoot, origin.getSourceFile(), origin.getStart(), origin.getWidth()) });
                }
              }
            }
          }
        }
      };
      const inspectSystems = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === "defineGame" &&
              path.resolve(declaration.getSourceFile().fileName) === path.resolve(layout.types) && node.arguments[0]) inspectRuntime(node.arguments[0]);
          if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === "defineSystem" &&
              path.resolve(declaration.getSourceFile().fileName) === path.resolve(layout.types) && node.arguments[0]) {
            const argument = node.arguments[0];
            const run = checker.getTypeAtLocation(argument).getProperty("run");
            const callable = run && checker.getTypeOfSymbolAtLocation(run, argument);
            for (const signature of callable?.getCallSignatures() ?? []) {
              const result = checker.getReturnTypeOfSignature(signature);
              if ((result.isUnion() ? result.types : [result]).some(type => type.getProperty("then")))
                diagnostics.push({ code: "TC_SYSTEM_ASYNC", severity: "error", message: "System run cannot return a Promise/thenable.",
                  suggestion: "Prepare asynchronous data separately; apply it synchronously during a system tick.",
                  source: projectLocation(projectRoot, node.getSourceFile(), node.getStart(), node.getWidth()) });
            }
          }
        }
        ts.forEachChild(node, inspectSystems);
      };
      for (const source of program.getSourceFiles()) if (!source.isDeclarationFile) inspectSystems(source);
      if (diagnostics.some(d => d.severity === "error")) return await fail();
      try {
        const content = await typescriptContent({ entry, sdk: sdkPath, projectRoot, timeoutMs: manifest.contentTimeoutMs ?? 10000, build: productionBuild });
        extractor = content;
        game = content.game;
        contentDependencies.push(...content.dependencies);
      } catch (error) {
        diagnostics.push({ code: error instanceof ContentError ? error.code : "TC_CONTENT_BUILD", severity: "error",
          message: error instanceof Error ? error.message : String(error),
          suggestion: error instanceof ContentError && error.code === "TC_CONTENT_BROWSER_GLOBAL"
            ? "Move browser-only imports and initialization into runtime.create(scope), using await import('./browser-runtime.ts'); keep declaration modules runnable in Node."
            : "Correct trusted TypeScript construction; use content: static for nonexecuting declarations.",
          source: error instanceof ContentError && error.source ? error.source : { file: slash(path.relative(projectRoot, entry)), line: 1, column: 1, length: 1 } });
        return await fail();
      }
    } else {
      const staticExtractor = new Extractor(program, projectRoot, layout.types, new Set(manifest.libraries ?? []));
      game = staticExtractor.extract(entry);
      diagnostics.push(...staticExtractor.diagnostics);
      extractor = staticExtractor;
    }
    const sourceFiles = program
      .getSourceFiles()
      .filter((sf) => path.resolve(sf.fileName) !== path.resolve(sdkPath));
    const inputMap = new Map(
      initialInputs.map((i) => [i.root + ":" + i.path, i]),
    );
    for (const sf of sourceFiles) {
      const relative = path.relative(projectRoot, sf.fileName);
      const engineRelative = path.relative(engineRoot, sf.fileName);
      const engineOwned = !engineRelative.startsWith("..") && !path.isAbsolute(engineRelative) && !engineRelative.split(path.sep).includes("node_modules");
      if ((!relative.startsWith("..") && !path.isAbsolute(relative)) ||
          (manifest.content === "typescript" && !program.isSourceFileDefaultLibrary(sf) && !engineOwned)) {
        const input = await makeInput(sf.fileName, "project");
        inputMap.set(input.root + ":" + input.path, input);
      }
    }
    for (const file of contentDependencies) {
      const input = await makeInput(file, "project");
      inputMap.set(input.root + ":" + input.path, input);
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
    const bundled = await bundle(entry, sdkPath, projectRoot, manifest.content === "typescript" ? game : undefined);
    for (const input of report.inputs) inputMap.set(input.root + ":" + input.path, input);
    for (const file of bundled.dependencies) {
      if (file === path.join(projectRoot, "__pelican_m0_game_entry__.js")) continue;
      const input = await makeInput(file, "project"); inputMap.set(input.root + ":" + input.path, input);
    }
    report.inputs = [...inputMap.values()].sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
    const artifactData: Record<string, string | Uint8Array> = {
      "scene.ir.json": JSON.stringify(ir, null, 2),
      "asset-notices.json": JSON.stringify(
        {
          format: "pelican.asset-notices",
          version: 1,
          assets: ir.assetNotices ?? [],
        },
        null,
        2,
      ),
      "game.js": bundled.code,
      "game.js.map": bundled.map,
      "version.json": JSON.stringify(
        {
          format: "pelican.version",
          version: 1,
          engineVersion: SDK_VERSION,
          sdkVersion: SDK_VERSION,
          compilerVersion: ts.version,
          irVersion: 1,
          systemMetadataVersion: 1,
          schemaHash: report.incremental.schemaHash,
        },
        null,
        2,
      ),
    };
    for (const asset of normalized.assetCopies as AssetCopy[]) {
      const bytes = await fs.readFile(asset.source);
      if (hash(bytes) !== asset.expectedHash) {
        diagnostics.push({
          code: "TC_ASSET_CHANGED",
          severity: "error",
          message:
            "Asset changed before output: " +
            slash(path.relative(projectRoot, asset.source)),
          suggestion: "Finish writing assets and rebuild.",
        });
        return await fail();
      }
      artifactData[asset.output] = bytes;
    }
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
    ...(ir.computeTextures?.length || ir.computes.some(kernel => kernel.textures?.length) ? ["compute-textures"] : []),
    ...(ir.postProcesses?.length ? ["postprocess-graph-ir"] : []),
    ...(ir.materials.some(material => material.vertex) ? ["vertex-graph-ir"] : []),
    ...(ir.materials.some(material => material.buffers?.length) ? ["render-buffer-bindings"] : []),
    ...(ir.assets.length ? ["assets"] : []),
  ];
}
