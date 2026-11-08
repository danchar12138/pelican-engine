import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { outputPath, root } from "./build.ts";
import { npmCommand } from "../doctor.ts";
import {
  cliLayout,
  createMinimalProject,
  installedDiagnostics,
  prepareInstalledDevProject,
} from "./layout.ts";
import { compilerLayout } from "../../packages/compiler/src/distribution.ts";
import { validatePublishIdentity } from "./publish-gate.ts";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import { playwrightCli } from "./browser-cli.ts";
import { diagnosticCode } from "../diagnostic-code.ts";

test("CLI diagnostics preserve engine error codes", () => {
  assert.equal(diagnosticCode(new Error("TCSETUP_BROWSER_OFFLINE: offline")), "TCSETUP_BROWSER_OFFLINE");
  assert.equal(diagnosticCode(new Error("TC_RENDER_WEBGL2_UNAVAILABLE: unavailable")), "TC_RENDER_WEBGL2_UNAVAILABLE");
  assert.equal(diagnosticCode(new Error("unclassified failure")), "TC_CLI_FAILURE");
});

test("installed browser setup resolves and executes the Playwright CLI", () => {
  const cli = playwrightCli(root);
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /^Version\s+\d+\./);
});

test("explicit npm prefix installs in an empty child without modifying a parent project", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-npm-prefix-"));
  try {
    const parent = path.join(directory, "parent"), child = path.join(parent, "game"), dependency = path.join(directory, "fixture");
    await mkdir(child, { recursive: true });
    await mkdir(path.join(parent, "node_modules"));
    await mkdir(dependency);
    const original = JSON.stringify({ name: "parent-project", version: "1.0.0", private: true });
    await writeFile(path.join(parent, "package.json"), original);
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "pelican-prefix-fixture", version: "1.0.0" }));
    const npm = npmCommand(root);
    assert.ok(npm, "npm JS CLI must be available");
    const result = spawnSync(npm.file, [...npm.prefix, "--prefix", child, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", dependency], {
      cwd: child, env: { ...process.env, npm_config_offline: "true" }, encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(parent, "package.json"), "utf8"), original);
    assert.deepEqual(await readdir(path.join(parent, "node_modules")), []);
    const installed = JSON.parse(await readFile(path.join(child, "node_modules/pelican-prefix-fixture/package.json"), "utf8"));
    assert.equal(installed.name, "pelican-prefix-fixture");
    assert.ok(JSON.parse(await readFile(path.join(child, "package.json"), "utf8")).devDependencies["pelican-prefix-fixture"]);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith("pelican-npm-prefix-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled paths have no dependency on packages/*/src or .ts entrypoints", () => {
  assert.equal(
    outputPath(path.join(root, "packages/sdk/src/index.ts")),
    "lib/sdk/index.js",
  );
  assert.equal(
    outputPath(path.join(root, "packages/physics/index.ts")),
    "lib/physics/index.js",
  );
  assert.equal(outputPath(path.join(root, "tools/cli.ts")), "lib/tools/cli.js");
  assert.throws(
    () => outputPath(path.resolve(root, "../outside.ts")),
    /TC_DISTRIBUTION_PATH/,
  );
  const url = pathToFileURL(
    path.join(root, ".pelican/npm/package/lib/tools/cli.js"),
  ).href;
  assert.equal(cliLayout(url).root, path.join(root, ".pelican/npm/package"));
  assert.equal(
    path.resolve(
      compilerLayout(
        pathToFileURL(path.join(root, "lib/compiler/index.js")).href,
      ).root,
    ),
    path.resolve(root),
  );
});

test("repo and npm minimal templates have identical game source and normalized manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-template-"));
  try {
    const source = path.join(directory, "source"),
      installed = path.join(directory, "installed");
    await createMinimalProject(source, root, false);
    await createMinimalProject(installed, root, true);
    assert.equal(
      await readFile(path.join(source, "game.ts"), "utf8"),
      await readFile(path.join(installed, "game.ts"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(path.join(source, "pelican.project.json"), "utf8"),
    );
    delete manifest.engine.path;
    assert.deepEqual(
      manifest,
      JSON.parse(
        await readFile(path.join(installed, "pelican.project.json"), "utf8"),
      ),
    );
    for (const project of [source, installed]) {
      const agents = await readFile(path.join(project, "AGENTS.md"), "utf8");
      assert.match(agents, /GAME-AUTHOR\.md/);
      assert.match(agents, /api\/index\.json/);
      assert.match(agents, /Do not run engine milestone/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed mismatch and missing dependency diagnostics are stable", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pelican-install-diagnostic-"),
  );
  try {
    await mkdir(path.join(directory, "docs/api"), { recursive: true });
    await writeFile(
      path.join(directory, "docs/api/index.json"),
      JSON.stringify({ engineVersion: SDK_VERSION }),
    );
    await writeFile(
      path.join(directory, "engine.manifest.json"),
      JSON.stringify({ version: SDK_VERSION }),
    );
    await writeFile(
      path.join(directory, "distribution.json"),
      JSON.stringify({
        version: SDK_VERSION,
        files: { "lib/absent.js": "broken" },
      }),
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "pelican-engine",
        version: "0.0.0",
        dependencies: { "pelican-engine/nonexistent-internal": "0.0.0" },
      }),
    );
    const diagnostics = await installedDiagnostics(directory);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      [
        "TC_ENGINE_SDK_VERSION",
        "TC_DISTRIBUTION_INTEGRITY",
        "TC_DISTRIBUTION_DEPENDENCY_MISSING",
      ],
    );
    assert.ok(diagnostics.every((d) => d.remediation.includes("--save-exact")));
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "pelican-engine",
        version: SDK_VERSION,
        dependencies: { typescript: "6.0.3" },
      }),
    );
    const inherited = await installedDiagnostics(directory);
    assert.ok(
      inherited.some(
        (d) =>
          d.code === "TC_DISTRIBUTION_DEPENDENCY_MISSING" &&
          d.message.includes("typescript"),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("first installed dev scaffolds only an empty npm workspace and never overwrites project files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-first-dev-"));
  try {
    const empty = path.join(directory, "empty");
    await mkdir(path.join(empty, "node_modules"), { recursive: true });
    await writeFile(
      path.join(empty, "package.json"),
      JSON.stringify({ devDependencies: { "pelican-engine": SDK_VERSION } }),
    );
    assert.equal(await prepareInstalledDevProject(empty, root), true);
    const firstGame = await readFile(path.join(empty, "game.ts"), "utf8");
    assert.match(firstGame, /from "pelican-engine"/);
    assert.match(
      await readFile(path.join(empty, "AGENTS.md"), "utf8"),
      /Pelican Engine Game Author/,
    );
    assert.equal(await prepareInstalledDevProject(empty, root), false);
    assert.equal(
      await readFile(path.join(empty, "game.ts"), "utf8"),
      firstGame,
    );
    await assert.rejects(
      createMinimalProject(empty, root, true),
      /TC_CREATE_EXISTS/,
    );
    for (const [name, content] of [
      ["game.ts", "existing game"],
      ["pelican.project.json", "malformed manifest"],
    ]) {
      const project = path.join(directory, name);
      await mkdir(project);
      await writeFile(path.join(project, name), content);
      assert.equal(await prepareInstalledDevProject(project, root), false);
      assert.deepEqual(await readdir(project), [name]);
      assert.equal(await readFile(path.join(project, name), "utf8"), content);
    }
    for (const name of ["AGENTS.md", "custom-entry.ts", "assets"]) {
      const project = path.join(directory, "other-" + name);
      await mkdir(project);
      await writeFile(path.join(project, name), "preserve");
      await assert.rejects(
        prepareInstalledDevProject(project, root),
        /TC_DEV_PROJECT_MISSING/,
      );
      assert.deepEqual(await readdir(project), [name]);
      assert.equal(
        await readFile(path.join(project, name), "utf8"),
        "preserve",
      );
    }
    const instructions = path.join(directory, "explicit-conflict");
    await mkdir(instructions);
    await writeFile(
      path.join(instructions, "AGENTS.md"),
      "existing instructions",
    );
    await assert.rejects(
      createMinimalProject(instructions, root, true),
      /TC_CREATE_EXISTS/,
    );
    assert.deepEqual(await readdir(instructions), ["AGENTS.md"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const accepted = {
  eventName: "release",
  action: "published",
  draft: false,
  publishedAt: "2026-11-04T00:00:00Z",
  tag: "v0.3.32",
  milestone: "M3",
  version: "0.3.32",
  engineVersion: "0.3.32",
  sdkVersion: "0.3.32",
  head: "a".repeat(40),
  tagCommit: "a".repeat(40),
  eventCommit: "a".repeat(40),
};
test("publish identity accepts only a matching published milestone commit", () => {
  assert.doesNotThrow(() => validatePublishIdentity(accepted));
  assert.doesNotThrow(() =>
    validatePublishIdentity({
      ...accepted,
      tag: "v1.0.0",
      version: "1.0.0",
      engineVersion: "1.0.0",
      sdkVersion: "1.0.0",
      milestone: "M8",
    }),
  );
  for (const change of [
    { eventName: "push" },
    { action: "created" },
    { draft: true },
    { publishedAt: undefined },
  ])
    assert.throws(
      () => validatePublishIdentity({ ...accepted, ...change }),
      /TC_NPM_RELEASE_EVENT/,
    );
  for (const change of [
    { tag: "v0.2.0-m2.0" },
    { engineVersion: "0.2.0-m2.0" },
    { sdkVersion: "0.2.0-m2.0" },
    { milestone: "M9" },
  ])
    assert.throws(
      () => validatePublishIdentity({ ...accepted, ...change }),
      /TC_NPM_RELEASE_VERSION/,
    );
  assert.throws(
    () => validatePublishIdentity({ ...accepted, tagCommit: "b".repeat(40) }),
    /TC_NPM_RELEASE_COMMIT/,
  );
});

test("main-push publishing uses OIDC, tested source and the exact explicit-version tarball", async () => {
  const workflow = await readFile(
    path.join(root, ".github/workflows/npm-publish.yml"),
    "utf8",
  );
  assert.match(workflow, /'pelican-engine-'\s*\+\s*\$version\s*\+\s*'\.tgz'/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /--tag latest/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|next/);
});
