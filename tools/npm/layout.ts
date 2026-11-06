import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile, lstat, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import { doctor } from "../doctor.ts";

export function cliLayout(url: string) {
  const directory = path.dirname(fileURLToPath(url));
  const installed = url.endsWith("/lib/tools/cli.js");
  const root = path.resolve(directory, installed ? "../.." : "..");
  return {
    installed,
    root,
    webRoot: installed ? path.join(root, "web") : root,
  };
}

export async function installedDiagnostics(root: string) {
  const diagnostics: {
    code: string;
    severity: "error";
    message: string;
    remediation: string;
  }[] = [];
  const fail = (code: string, message: string) =>
    diagnostics.push({
      code,
      severity: "error",
      message,
      remediation:
        "Install one exact pelican-engine version with npm install --save-exact pelican-engine@" +
        SDK_VERSION +
        "; do not mix package files or edit node_modules.",
    });
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const engine = JSON.parse(
    await readFile(path.join(root, "engine.manifest.json"), "utf8"),
  );
  const distribution = JSON.parse(
    await readFile(path.join(root, "distribution.json"), "utf8"),
  );
  if (
    manifest.name !== "pelican-engine" ||
    [manifest.version, engine.version, distribution.version].some(
      (v) => v !== SDK_VERSION,
    )
  )
    fail(
      "TC_ENGINE_SDK_VERSION",
      "Installed package, engine, API and compiler versions must match exactly: " +
        SDK_VERSION +
        ".",
    );
  const api = JSON.parse(
    await readFile(path.join(root, "docs/api/index.json"), "utf8"),
  );
  if (api.engineVersion !== SDK_VERSION)
    fail(
      "TC_ENGINE_SDK_VERSION",
      "Installed API index does not match SDK " + SDK_VERSION + ".",
    );
  for (const [name, expected] of Object.entries(distribution.files ?? {})) {
    if (!name.startsWith("lib/") && !name.startsWith("web/")) continue;
    const file = path.resolve(root, name);
    if (
      path.relative(root, file).startsWith("..") ||
      path.isAbsolute(path.relative(root, file))
    ) {
      fail(
        "TC_DISTRIBUTION_INTEGRITY",
        "Distribution fingerprint leaves the installed package.",
      );
      continue;
    }
    const actual = await readFile(file)
      .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
      .catch(() => null);
    if (actual !== expected)
      fail(
        "TC_DISTRIBUTION_INTEGRITY",
        "Installed compiled file is missing or changed: " + name + ".",
      );
  }
  const require = createRequire(path.join(root, "package.json"));
  const installRoot =
    path.basename(path.dirname(root)) === "node_modules"
      ? path.dirname(path.dirname(root))
      : root;
  for (const [name, expected] of Object.entries(manifest.dependencies ?? {})) {
    try {
      const entry = require.resolve(name);
      const relative = path.relative(installRoot, entry);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Dependency resolved outside this installation");
      let directory = path.dirname(entry);
      let found = false;
      while (true) {
        const candidate = path.join(directory, "package.json");
        if (existsSync(candidate)) {
          const pkg = JSON.parse(await readFile(candidate, "utf8"));
          if (pkg.name === name) {
            found = true;
            if (pkg.version !== expected)
              fail(
                "TC_DISTRIBUTION_DEPENDENCY_VERSION",
                name + " requires " + expected + ", found " + pkg.version + ".",
              );
            break;
          }
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (!found) throw new Error("Package metadata missing");
    } catch {
      fail(
        "TC_DISTRIBUTION_DEPENDENCY_MISSING",
        "Required installed tool dependency is unavailable: " + name + ".",
      );
    }
  }
  return diagnostics;
}

export async function installedDoctor(root: string, taskId: string) {
  const report = await doctor({ projectRoot: root, taskId });
  const obsolete = new Set(
    report.data.dependencies.diagnostics.map((d) => d.code),
  );
  const diagnostics = await installedDiagnostics(root);
  report.diagnostics = report.diagnostics.filter((d) => !obsolete.has(d.code));
  report.diagnostics.push(...diagnostics);
  report.data.dependencies = {
    manifestPresent: true,
    lockPresent: false,
    lockUsable: false,
    ready: !diagnostics.length,
    packages: [],
    diagnostics,
  };
  report.status = report.diagnostics.some((d) => d.severity === "error")
    ? "failed"
    : "succeeded";
  return report;
}

export async function writeAuthorEntry(
  projectRoot: string,
  engineRoot: string,
) {
  const docs = path
    .relative(projectRoot, path.join(engineRoot, "docs"))
    .replaceAll("\\", "/");
  await writeFile(
    path.join(projectRoot, "AGENTS.md"),
    [
      "# Pelican Engine Game Author",
      "",
      "Work only in this game project. Use named imports from pelican-engine and project-local modules.",
      `Read [game-author workflow](${docs}/npm/GAME-AUTHOR.md),`,
      `[API reference](${docs}/api/REFERENCE.md), and [API index](${docs}/api/index.json).`,
      "Use the engine's JSON CLI protocol for checks, builds, browser controls and capture.",
      "Do not edit engine internals or node_modules. Do not run engine milestone/evidence/release workflows.",
      "",
    ].join("\n"),
    { flag: "wx" },
  );
}

export async function createMinimalProject(
  root: string,
  engineRoot: string,
  installed: boolean,
) {
  // Check all destinations before the first write, including dangling symlinks.
  // Exclusive writes still protect a file created concurrently after preflight.
  for (const name of ["game.ts", "pelican.project.json", "AGENTS.md"])
    if (await pathPresent(path.join(root, name)))
      throw new Error(
        "TC_CREATE_EXISTS: Project files already exist; no files were overwritten.",
      );
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "pelican.project.json"),
    JSON.stringify(
      {
        entry: "game.ts",
        engineVersion: SDK_VERSION,
        engine: {
          version: SDK_VERSION,
          ...(!installed
            ? { path: path.relative(root, engineRoot).replaceAll("\\", "/") }
            : {}),
        },
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(root, "game.ts"),
    `import { defineGame, defineScene, defineMaterial, defineSystem } from "pelican-engine";
const material = defineMaterial({ id: "surface", color: "#38b8a4", roughness: 0.45 });
const scene = defineScene({
  id: "main", camera: { position: [4, 3, 6], target: [0, 0, 0], fov: 50 },
  entities: [
    { id: "shape", mesh: { geometry: { kind: "box" }, material } },
    { id: "sun", light: { kind: "directional", intensity: 4, castShadow: true }, transform: { position: [3, 6, 4] } },
  ],
});
const spin = defineSystem({ id: "spin", phase: "update", run(engine, dt) {
  const t = engine.getTransform("shape");
  engine.setTransform("shape", { rotation: [0, t.rotation[1] + dt, 0] });
} });
export default defineGame({ id: "game", scene, systems: [spin] });
`,
    { flag: "wx" },
  );
  await writeAuthorEntry(root, engineRoot);
}

async function pathPresent(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** First installed dev starts a game in an otherwise empty npm project. */
export async function prepareInstalledDevProject(
  root: string,
  engineRoot: string,
) {
  if (
    (await pathPresent(path.join(root, "pelican.project.json"))) ||
    (await pathPresent(path.join(root, "game.ts")))
  )
    return false;
  const installFiles = new Set([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "node_modules",
    ".git",
    ".gitignore",
    ".npmrc",
    ".pelican",
  ]);
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.some((name) => !installFiles.has(name)))
    throw new Error(
      "TC_DEV_PROJECT_MISSING: No pelican.project.json or game.ts was found, but this directory contains other files. Add a project manifest for your entry, or use pelican create --template minimal --project <new-directory>; existing files were preserved.",
    );
  await createMinimalProject(root, engineRoot, true);
  return true;
}
