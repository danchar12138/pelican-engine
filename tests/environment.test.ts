import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  doctor,
  inspectDependencies,
  parseCim,
  parseNvidiaSmi,
  runCommand,
  sanitizeReport,
} from "../tools/doctor.ts";
import { setup } from "../tools/setup.ts";
import type { CommandRunner } from "../tools/doctor.ts";

const temporaryDirectories: string[] = [];
after(async () => {
  const base = path.resolve(tmpdir());
  for (const directory of temporaryDirectories) {
    const relative = path.relative(base, path.resolve(directory));
    assert.ok(
      relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        path.basename(directory).startsWith("pelican 环境 "),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
const required = ["tsx", "typescript", "playwright", "three", "vite"];
async function fixture(installed = false) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican 环境 "));
  temporaryDirectories.push(root);
  const deps = Object.fromEntries(required.map((name) => [name, "1.0.0"]));
  const packages: Record<string, any> = { "": { devDependencies: deps } };
  for (const name of required) {
    packages[`node_modules/${name}`] = { version: "1.0.0" };
    if (installed) {
      await mkdir(path.join(root, "node_modules", name), { recursive: true });
      await writeFile(
        path.join(root, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
      if (name === "playwright") {
        await writeFile(
          path.join(root, "node_modules", name, "index.js"),
          "module.exports = { chromium: { executablePath: () => require('node:path').join(__dirname, 'missing-browser') } };\n",
        );
      }
    }
  }
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", devDependencies: deps }),
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return root;
}
const cim = JSON.stringify({
  computer: {
    Manufacturer: "Test",
    Model: "Workstation",
    TotalPhysicalMemory: "34359738368",
    UserName: "private-user",
    Name: "private-host",
    SerialNumber: "private-serial",
  },
  os: {
    Caption: "Windows Test",
    Version: "10.0.test",
    BuildNumber: "test",
    OSArchitecture: "64-bit",
    RegisteredUser: "private@example.invalid",
  },
  cpus: [
    {
      Name: "Test CPU",
      NumberOfCores: 16,
      NumberOfLogicalProcessors: 32,
      MaxClockSpeed: 2500,
    },
  ],
  gpus: [
    {
      Name: "NVIDIA GeForce RTX 5070 Ti Laptop GPU",
      DriverVersion: "32.0.test",
      AdapterRAM: 4293918720,
    },
  ],
});
const environmentRunner: CommandRunner = async (file, args) => {
  if (file === "nvidia-smi")
    return {
      exitCode: 0,
      stdout: "NVIDIA GeForce RTX 5070 Ti Laptop GPU, 621.01, 12227\n",
    };
  if (file === "git") return { exitCode: null, stdout: "", failure: "missing" };
  if (args.at(-1) === "--version") return { exitCode: 0, stdout: "11.12.1\n" };
  throw new Error("Unexpected command");
};

test("vendor inventory preserves exact MiB and rejects unknown or malformed memory", () => {
  const result = parseNvidiaSmi(
    "NVIDIA GeForce RTX 5070 Ti Laptop GPU, 621.01, 12227\r\n",
  );
  assert.equal(result[0]?.memoryMiB, 12227);
  assert.equal(result[0]?.memoryBytes, 12820938752);
  assert.equal(result[0]?.driverVersion, "621.01");
  assert.equal(
    parseNvidiaSmi('"GPU, Test", 621.01, 8192')[0]?.name,
    "GPU, Test",
  );
  for (const invalid of [
    "",
    "GPU, 621.01, N/A",
    "GPU, 621.01, -1",
    "GPU, 621.01, 0",
    "GPU, 621.01, 1.2.3",
  ]) {
    assert.throws(() => parseNvidiaSmi(invalid));
  }
});

test("CIM projection excludes identity and never treats truncated AdapterRAM as dedicated VRAM", () => {
  const data = parseCim(`\uFEFF${cim}`);
  assert.equal(data.ramBytes, 34359738368);
  assert.equal(data.gpus[0]?.adapterRamReportedBytes, 4293918720);
  assert.equal(data.gpus[0]?.adapterRamReliable, false);
  assert.equal(data.gpus[0]?.dedicatedMemoryBytes, null);
  assert.doesNotMatch(
    JSON.stringify(data),
    /private-user|private-host|private-serial|private@example/,
  );
  assert.throws(() => parseCim('{"computer":{}}'));
  assert.throws(() => parseCim("not JSON"));
});

test("recursive path sanitization handles Chinese/spaces and user directories", () => {
  const root = path.join(homedir(), "项目 空格", "pelican");
  const report = sanitizeReport(
    {
      entries: [
        path.join(root, "工具.ts"),
        path.join(homedir(), "AppData", "browser.exe"),
        "C:\\Users\\AnotherAccount\\cache\\file",
      ],
    },
    root,
  );
  assert.ok(report.entries[0]?.startsWith("<project>"));
  assert.ok(report.entries[1]?.startsWith("<home>"));
  assert.doesNotMatch(JSON.stringify(report), /AnotherAccount/);
  assert.ok(report.entries[0]?.endsWith("工具.ts"));
});

test("missing lockfile fails read-only checks and setup never invokes npm or generates a lock", async () => {
  const root = await fixture();
  await rm(path.join(root, "package-lock.json"));
  let calls = 0;
  const result = await setup({
    projectRoot: root,
    runCommand: async () => {
      calls++;
      throw new Error("must not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.diagnostics.some((d) => d.code === "TCENV_LOCK_INVALID"));
  assert.equal(calls, 0);
  await assert.rejects(readFile(path.join(root, "package-lock.json")));
});

test("lockfile and manifest drift is rejected before installation", async () => {
  const root = await fixture(true);
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  manifest.devDependencies.three = "2.0.0";
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  const result = await inspectDependencies(root);
  assert.equal(result.ready, false);
  assert.equal(result.lockUsable, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TCENV_LOCK_MISMATCH"));
});

test("a missing required transitive cannot masquerade as a reusable dependency cache", async () => {
  const root = await fixture(true);
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  lock.packages["node_modules/required-transitive"] = { version: "1.2.3" };
  lock.packages["node_modules/optional-other-platform"] = {
    version: "1.2.3",
    optional: true,
  };
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const result = await inspectDependencies(root);
  assert.equal(result.ready, false);
  assert.equal(result.lockUsable, true);
  assert.equal(
    result.diagnostics.filter((d) => d.code === "TCENV_TRANSITIVE_NOT_READY")
      .length,
    1,
  );
});

test("doctor needs neither Git nor a platform shell and records vendor inventory separately", async () => {
  const root = await fixture(true);
  const result = await doctor({
    projectRoot: root,
    runCommand: environmentRunner,
  });
  assert.equal(result.protocolVersion, "0.1.0");
  assert.equal(result.data.git.available, false);
  assert.equal(result.data.git.checkout, false);
  assert.ok(result.data.machine!.ramBytes! > 0);
  assert.ok(result.data.machine!.cpus.length > 0);
  assert.equal(result.data.nvidia[0]?.memoryBytes, 12820938752);
  assert.equal(
    result.diagnostics.find((d) => d.code === "TCENV_GIT_OPTIONAL")?.severity,
    "info",
  );
  // The fixture explicitly points to a missing browser, independent of the host cache.
  assert.equal(result.data.browser.installed, false);
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "TCENV_BROWSER_MISSING" && d.severity === "error",
    ),
  );
  assert.equal(result.status, "failed");
});

test("missing tools produce stable actionable diagnostics without leaking stderr or accounts", async () => {
  const root = await fixture(true);
  const result = await doctor({
    projectRoot: root,
    runCommand: async () => ({
      exitCode: 1,
      stdout: "secret-token private@example.invalid",
      stderr: "password=private-sentinel",
    }),
  });
  const codes = new Set(result.diagnostics.map((d) => d.code));
  assert.ok(!codes.has("TCENV_PLATFORM_UNSUPPORTED"));
  assert.ok(codes.has("TCENV_NPM_UNAVAILABLE"));
  assert.ok(codes.has("TCENV_NVIDIA_UNAVAILABLE"));
  assert.ok(result.data.machine!.ramBytes! > 0);
  assert.equal(result.data.nvidia.length, 0);
  assert.ok(result.diagnostics.every((d) => d.code && d.remediation));
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret-token|private@example|private-sentinel/,
  );
});

test("doctor never invokes a platform shell for machine inventory", async () => {
  const root = await fixture(true);
  const calls: string[] = [];
  const result = await doctor({ projectRoot: root, runCommand: async (file, args, options) => {
    calls.push(file); return environmentRunner(file, args, options);
  } });
  assert.ok(!calls.some(file => /powershell|cmd\.exe|\/bin\/sh/.test(file)));
  assert.ok(result.data.machine!.ramBytes! > 0);
});

test("setup reuses a verified installation without invoking npm ci or installing browsers", async () => {
  const root = await fixture(true);
  const commands: string[][] = [];
  const result = await setup({
    projectRoot: root,
    runCommand: async (file, args, options) => {
      commands.push([...args]);
      return environmentRunner(file, args, options);
    },
  });
  assert.equal(result.data.actions[0]?.result, "reused");
  assert.ok(
    commands.every((args) => !args.includes("ci") && !args.includes("install")),
  );
  assert.equal(result.data.environment?.data.dependencies.ready, true);
  assert.equal(
    result.status,
    "failed",
    "missing browser is not silently marked ready",
  );
});

test("setup installation failure is bounded, does not upgrade, and omits raw npm output", async () => {
  const root = await fixture();
  const calls: string[][] = [];
  const result = await setup({
    projectRoot: root,
    offline: true,
    timeoutMs: 50,
    runCommand: async (_file, args, options) => {
      calls.push([...args]);
      assert.equal(options.timeoutMs, 50);
      return {
        exitCode: null,
        stdout: "secret-token",
        stderr: "private@example.invalid",
        failure: "timeout",
      };
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some((d) => d.code === "TCSETUP_INSTALL_TIMEOUT"),
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes("ci") && calls[0]?.includes("--offline"));
  assert.ok(
    calls[0]?.every(
      (arg) => arg !== "-g" && arg !== "update" && arg !== "upgrade",
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private@example/);
});

test("npm success without a valid installed tree is reported as incomplete", async () => {
  const root = await fixture();
  const result = await setup({
    projectRoot: root,
    runCommand: async () => ({ exitCode: 0, stdout: "" }),
  });
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some((d) => d.code === "TCSETUP_INSTALL_INCOMPLETE"),
  );
  assert.equal(result.data.environment, null);
});

test("cancelled setup makes no changes and executes no subprocess", async () => {
  const root = await fixture();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const result = await setup({
    projectRoot: root,
    signal: controller.signal,
    runCommand: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.diagnostics.some((d) => d.code === "TCSETUP_CANCELLED"));
  assert.equal(called, false);
});

test("real subprocess runner retains exit codes and reports missing commands and timeouts", async () => {
  const options = { cwd: process.cwd(), timeoutMs: 5_000 };
  const failure = await runCommand(
    process.execPath,
    ["-e", "process.exit(7)"],
    options,
  );
  assert.equal(failure.exitCode, 7);
  const missing = await runCommand(
    path.join(tmpdir(), "pelican-no-such-command.exe"),
    [],
    options,
  );
  assert.equal(missing.failure, "missing");
  const timedOut = await runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { ...options, timeoutMs: 100 },
  );
  assert.equal(timedOut.failure, "timeout");
});
test("an exact locked version cannot contradict the pinned manifest version", async () => {
  const root = await fixture(true);
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  lock.packages["node_modules/three"].version = "2.0.0";
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const result = await inspectDependencies(root);
  assert.equal(result.lockUsable, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TCENV_LOCK_MISMATCH"));
});

test("offline setup never downloads a missing browser even with installBrowser requested", async () => {
  const root = await fixture(true);
  const commands: string[][] = [];
  const result = await setup({
    projectRoot: root,
    offline: true,
    installBrowser: true,
    runCommand: async (file, args, options) => {
      commands.push([...args]);
      return environmentRunner(file, args, options);
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(
    result.diagnostics.some((d) => d.code === "TCSETUP_BROWSER_OFFLINE"),
  );
  assert.ok(commands.every((args) => !args.includes("install")));
});

test("report sanitization also removes email and credentials embedded in metadata", () => {
  const result = sanitizeReport(
    {
      account: "private@example.invalid",
      requested: "git+https://account:password@example.invalid/repo",
    },
    process.cwd(),
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private@example|account:password/,
  );
});
test("invalid NVIDIA measurements leave exact VRAM unknown instead of falling back to AdapterRAM", async () => {
  const root = await fixture(true);
  const result = await doctor({
    projectRoot: root,
    runCommand: async (file, args, options) =>
      file === "nvidia-smi"
        ? { exitCode: 0, stdout: "GPU, 621.01, N/A" }
        : environmentRunner(file, args, options),
  });
  assert.deepEqual(result.data.machine?.gpus, []);
  assert.deepEqual(result.data.nvidia, []);
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "TCENV_NVIDIA_INVALID" && d.severity === "warning",
    ),
  );
});

test("actual CLI persists an identical structured report at a Chinese path with spaces", async () => {
  const root = await fixture(true);
  const tool = fileURLToPath(new URL("../tools/doctor.ts", import.meta.url));
  const tsx = fileURLToPath(
    new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
  );
  const output = "报告 空间/环境.json";
  const result = await runCommand(
    process.execPath,
    [tsx, tool, "--project", root, "--output", output],
    { cwd: root, timeoutMs: 30_000 },
  );
  // The fixture explicitly points to a missing browser. Exit code and report must reflect this.
  assert.equal(result.exitCode, 1);
  const stdout = JSON.parse(result.stdout);
  const disk = JSON.parse(await readFile(path.join(root, output), "utf8"));
  assert.deepEqual(disk, stdout);
  assert.equal(disk.protocolVersion, "0.1.0");
  assert.equal(disk.status, "failed");
  assert.deepEqual(disk.artifacts, [
    { type: "application/json", path: output },
  ]);
  assert.ok(
    disk.diagnostics.some(
      (d: { code: string }) => d.code === "TCENV_BROWSER_MISSING",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(disk),
    /private-user|private-host|private-serial/,
  );
});
