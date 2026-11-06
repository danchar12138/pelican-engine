import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { generateApiIndex } from "../api-index.ts";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const staging = path.resolve(root, ".pelican/npm/package");
export const artifacts = path.resolve(root, ".pelican/npm/artifacts");
const slash = (value: string) => value.replaceAll("\\", "/");

export function outputPath(source: string) {
  const relative = slash(path.relative(root, source));
  if (relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error("TC_DISTRIBUTION_PATH: Source leaves engine root.");
  return (
    "lib/" +
    relative
      .replace(/^packages\/([^/]+)\/src\//, "$1/")
      .replace(/^packages\//, "")
      .replace(/\.ts$/, ".js")
  );
}

async function put(name: string, content: string | Uint8Array) {
  const output = path.join(staging, name);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, content);
}

export async function buildDistribution() {
  if (staging !== path.resolve(root, ".pelican", "npm", "package"))
    throw new Error("Unsafe staging path");
  await mkdir(path.dirname(staging), { recursive: true });
  const parent = await realpath(path.dirname(staging));
  const relativeParent = path.relative(await realpath(root), parent);
  if (
    relativeParent.startsWith("..") ||
    path.isAbsolute(relativeParent) ||
    (await lstat(staging).catch(() => undefined))?.isSymbolicLink()
  )
    throw new Error(
      "TC_DISTRIBUTION_PATH: Staging must be a real directory inside the engine workspace.",
    );
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const engine = JSON.parse(
    await readFile(path.join(root, "engine.manifest.json"), "utf8"),
  );
  const compiler = JSON.parse(
    await readFile(path.join(root, "packages/compiler/package.json"), "utf8"),
  );
  if (
    [pkg.version, engine.version, compiler.version].some(
      (v) => v !== SDK_VERSION,
    )
  )
    throw new Error(
      "TC_ENGINE_SDK_VERSION: Package, compiler, engine and SDK versions must match.",
    );

  // Follow the actual CLI/browser/SDK graph, never copy source directories.
  const queue = [
    "tools/npm/entry.ts",
    "tools/cli.ts",
    "packages/renderer/src/browser.ts",
    "packages/sdk/src/index.ts",
    "packages/schema/src/index.ts",
  ].map((p) => path.join(root, p));
  const visited = new Set<string>();
  const rewrite =
    (
      source: string,
      imports: Set<string>,
    ): ts.TransformerFactory<ts.SourceFile> =>
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (ts.isStringLiteral(node) && imports.has(node.text)) {
          const dependency = path.resolve(path.dirname(source), node.text);
          queue.push(dependency);
          let relative = slash(
            path.relative(
              path.dirname(outputPath(source)),
              outputPath(dependency),
            ),
          );
          if (!relative.startsWith(".")) relative = "./" + relative;
          return context.factory.createStringLiteral(relative);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (file) => ts.visitNode(file, visit) as ts.SourceFile;
    };
  while (queue.length) {
    const source = queue.shift()!;
    if (visited.has(source)) continue;
    visited.add(source);
    const text = await readFile(source, "utf8");
    const imports = new Set(
      ts
        .preProcessFile(text, true, true)
        .importedFiles.map((i) => i.fileName)
        .filter((i) => /^\./.test(i) && /\.ts$/.test(i)),
    );
    const result = ts.transpileModule(text, {
      fileName: source,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
      },
      transformers: { before: [rewrite(source, imports)] },
    });
    if (
      result.diagnostics?.some(
        (d) => d.category === ts.DiagnosticCategory.Error,
      )
    )
      throw new Error("TC_DISTRIBUTION_TRANSPILE: " + source);
    await put(
      outputPath(source),
      (source.endsWith(`${path.sep}entry.ts`) ? "#!/usr/bin/env node\n" : "") +
        result.outputText,
    );
  }

  const sdk = path.join(root, "packages/sdk/src/index.ts");
  const program = ts.createProgram([sdk], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    strict: true,
    allowImportingTsExtensions: true,
    types: [],
    lib: ["lib.es2023.d.ts"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error))
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  const declarations: Promise<void>[] = [];
  const emitted = program.emit(
    undefined,
    (filename, text, _bom, _error, sources) => {
      const source = sources?.[0]?.fileName;
      if (!source) throw new Error("Missing declaration source: " + filename);
      declarations.push(
        put(
          outputPath(source).replace(/\.js$/, ".d.ts"),
          text.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2"),
        ),
      );
    },
  );
  await Promise.all(declarations);
  if (emitted.emitSkipped) throw new Error("SDK declarations were not emitted");

  const dependencyNames = [
    "three",
    "fast-png",
    "fflate",
    "ngraph.path",
    "@dimforge/rapier3d-compat",
    "@gltf-transform/core",
    "@gltf-transform/extensions",
    "@gltf-transform/functions",
    "typescript",
    "vite",
    "playwright",
  ];
  const dependencies = Object.fromEntries(
    dependencyNames.map((name) => [
      name,
      pkg.dependencies?.[name] ?? pkg.devDependencies[name],
    ]),
  );
  await put(
    "package.json",
    JSON.stringify(
      {
        name: "pelican-engine",
        version: pkg.version,
        description: "Pelican Engine public SDK and offline development CLI",
        type: "module",
        license: "MIT",
        engines: pkg.engines,
        repository: {
          type: "git",
          url: "https://github.com/danchar12138/pelican-engine.git",
        },
        exports: {
          ".": { types: "./lib/sdk/index.d.ts", import: "./lib/sdk/index.js" },
        },
        types: "./lib/sdk/index.d.ts",
        bin: { pelican: "./lib/tools/npm/entry.js" },
        files: [
          "lib",
          "web",
          "docs",
          "licenses",
          "AGENTS.md",
          "CONTRIBUTING.md",
          "README.md",
          "LICENSE",
          "engine.manifest.json",
          "distribution.json",
        ],
        publishConfig: { access: "public" },
        dependencies,
      },
      null,
      2,
    ) + "\n",
  );
  await put(
    "engine.manifest.json",
    JSON.stringify(
      {
        ...engine,
        name: "pelican-engine",
        publicApi: "lib/sdk/index.d.ts",
        workflow: "docs/npm/GAME-AUTHOR.md",
        releasePolicy: "docs/npm/DISTRIBUTION.md",
      },
      null,
      2,
    ) + "\n",
  );
  const html = await readFile(path.join(root, "index.html"), "utf8");
  await put(
    "web/index.html",
    html.replace(
      "/packages/renderer/src/browser.ts",
      "../lib/renderer/browser.js",
    ),
  );
  await cp(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));
  await cp(path.join(root, "CONTRIBUTING.md"), path.join(staging, "CONTRIBUTING.md"));
  for (const name of [
    "docs/GETTING-STARTED.md",
    "docs/assets/pelican-mark.svg",
    "docs/AI-WORKFLOW.md",
    "docs/CAPABILITIES.md",
    "docs/ARCHITECTURE.md",
    "docs/DECISIONS.md",
    "docs/ROADMAP.md",
    "docs/STATUS.md",
    "docs/RENDER-BACKENDS.md",
    "docs/PELICAN-MIGRATION.md",
    "docs/THIRD-PARTY-NOTICES.md",
    "docs/npm/DISTRIBUTION.md",
    "docs/npm/GAME-AUTHOR.md",
  ])
    await put(name, await readFile(path.join(root, name), "utf8"));
  await put(
    "AGENTS.md",
    await readFile(path.join(root, "docs/npm/GAME-AUTHOR.md"), "utf8"),
  );
  await put(
    "README.md",
    await readFile(path.join(root, "docs/npm/DISTRIBUTION.md"), "utf8"),
  );
  // Generate current API documentation without editing the repository's tracked index.
  const apiRoot = path.join(staging, ".api-input");
  await mkdir(path.join(apiRoot, "packages/sdk/src"), { recursive: true });
  await cp(sdk, path.join(apiRoot, "packages/sdk/src/index.ts"));
  const apiIndex = await generateApiIndex(apiRoot);
  await cp(path.join(apiRoot, "docs/api"), path.join(staging, "docs/api"), {
    recursive: true,
  });
  await put(
    "docs/api/index.json",
    JSON.stringify(
      {
        ...apiIndex,
        installedDeclarations: "lib/sdk/index.d.ts",
        sourceProvenance: {
          path: apiIndex.source,
          shipped: false,
          note: "Source lines describe build-time provenance only. Use installedDeclarations for authoring.",
        },
      },
      null,
      2,
    ) + "\n",
  );
  const reference = await readFile(
    path.join(staging, "docs/api/REFERENCE.md"),
    "utf8",
  );
  await put(
    "docs/api/REFERENCE.md",
    reference.replace(
      /^(# [^\n]+\n)/,
      "$1\nInstalled declarations: `lib/sdk/index.d.ts` (relative to the package root).\nThe signatures below come from the same public SDK source as repository games.\nSource-file paths and line numbers are build-time provenance only; TypeScript source is not shipped.\n",
    ),
  );
  await rm(apiRoot, { recursive: true, force: true });

  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const notices = [
    "# Third-party licenses",
    "",
    "Original pelican code is MIT. Dependencies retain their original licenses.",
    "",
    "## Installed dependency inventory",
    "",
  ];
  for (const [location, metadata] of Object.entries(lock.packages) as [
    string,
    any,
  ][]) {
    if (!location) continue;
    notices.push(
      `- ${location}: ${metadata.version}; ${metadata.license ?? "see upstream package"}`,
    );
    const directory = path.join(root, location);
    for (const item of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (
        item.isFile() &&
        /^(license|licence|copying|notice|copyright)(?:[.-]|$)/i.test(item.name)
      )
        await put(
          "licenses/" +
            location.replaceAll("node_modules/", "") +
            "/" +
            item.name,
          await readFile(path.join(directory, item.name)),
        );
    }
  }
  await put("licenses/THIRD-PARTY-NOTICES.md", notices.join("\n") + "\n");
  const hashes: Record<string, string> = {};
  async function fingerprint(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await fingerprint(file);
      else
        hashes[slash(path.relative(staging, file))] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
    }
  }
  await fingerprint(staging);
  await put(
    "distribution.json",
    JSON.stringify(
      {
        format: "pelican.npm-distribution",
        version: SDK_VERSION,
        files: hashes,
      },
      null,
      2,
    ) + "\n",
  );
  return staging;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  buildDistribution()
    .then((directory) =>
      console.log(
        JSON.stringify({
          status: "succeeded",
          package: "pelican-engine",
          directory,
        }),
      ),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
