/** Read-only M0 environment baseline. Public reports never contain raw command output. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  remediation: string;
}
export interface Envelope<T> {
  protocolVersion: "0.1.0";
  taskId: string;
  status: "succeeded" | "failed";
  diagnostics: Diagnostic[];
  artifacts: { type: string; path: string }[];
  data: T;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  /** Never copied into a public report; npm stderr can contain credentials. */
  stderr?: string;
  failure?: "missing" | "timeout" | "aborted" | "failed";
}
export interface CommandOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;
export interface DoctorOptions {
  projectRoot?: string;
  taskId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Command boundary for tests and embedding; no shell strings are evaluated. */
  runCommand?: CommandRunner;
}
export interface DependencyRecord {
  name: string;
  requested: string | null;
  locked: string | null;
  installed: string | null;
}
export interface DependencyCheck {
  manifestPresent: boolean;
  lockPresent: boolean;
  lockUsable: boolean;
  ready: boolean;
  packages: DependencyRecord[];
  diagnostics: Diagnostic[];
}
export interface MachineData {
  manufacturer: string | null;
  model: string | null;
  ramBytes: number | null;
  os: {
    caption: string | null;
    version: string | null;
    build: string | null;
    architecture: string | null;
  };
  cpus: {
    name: string | null;
    cores: number | null;
    logicalProcessors: number | null;
    maxClockMHz: number | null;
  }[];
  gpus: {
    name: string | null;
    driverVersion: string | null;
    adapterRamReportedBytes: number | null;
    adapterRamReliable: false;
    dedicatedMemoryBytes: number | null;
    dedicatedMemorySource: "nvidia-smi" | null;
  }[];
}
export interface NvidiaGpu {
  name: string;
  driverVersion: string;
  memoryMiB: number;
  memoryBytes: number;
}
export interface BrowserData {
  provider: "playwright-chromium";
  installed: boolean;
  executablePath: string | null;
  cachePath: string;
  pathNotation: "project-and-home-tokens";
  /** Detection only; WebGPU/device capability is measured by the rendering prototype. */
  launched: false;
}
export interface EnvironmentData {
  capturedAt: string;
  platform: string;
  architecture: string;
  machine: MachineData | null;
  nvidia: NvidiaGpu[];
  runtime: { node: string; npm: string | null; nodeExecutable: string };
  dependencies: DependencyCheck;
  browser: BrowserData;
  git: { available: boolean; version: string | null; checkout: boolean };
}

export function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  remediation: string,
): Diagnostic {
  return { code, severity, message, remediation };
}
export function envelope<T>(
  taskId: string,
  diagnostics: Diagnostic[],
  data: T,
): Envelope<T> {
  return {
    protocolVersion: "0.1.0",
    taskId,
    status: diagnostics.some((d) => d.severity === "error")
      ? "failed"
      : "succeeded",
    diagnostics,
    artifacts: [],
    data,
  };
}

/** Redacts paths recursively, without serializing process.env or OS account properties. */
export function sanitizeReport<T>(value: T, projectRoot: string): T {
  const root = path.resolve(projectRoot);
  const home = homedir();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replacePath = (s: string, target: string, token: string) =>
    s.replace(new RegExp(`${escape(target)}(?=$|[\\\\/])`, "gi"), token);
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") {
      let s = replacePath(input, root, "<project>");
      s = replacePath(s, home, "<home>");
      return s
        .replace(/([A-Z]:[\\/]Users[\\/])[^\\/\s]+/gi, "$1<user>")
        .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1<credentials>@")
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "<email>");
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, visit(v)]),
      );
    return input;
  };
  return visit(value) as T;
}

export const runCommand: CommandRunner = async (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        signal: options.signal,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ exitCode: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: string | number;
        };
        resolve({
          exitCode: typeof err.code === "number" ? err.code : null,
          stdout,
          stderr,
          failure: options.signal?.aborted
            ? "aborted"
            : err.code === "ENOENT"
              ? "missing"
              : err.killed
                ? "timeout"
                : "failed",
        });
      },
    );
  });

/** Locate npm's JS CLI rather than passing unescaped directory names through cmd.exe. */
export function npmCommand(
  projectRoot: string,
): { file: string; prefix: string[] } | null {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    ),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, "node_modules/npm/bin/npm-cli.js")),
  ];
  for (const candidate of candidates) {
    if (candidate && /npm-cli\.js$/i.test(candidate) && existsSync(candidate))
      return { file: process.execPath, prefix: [candidate] };
  }
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    return {
      file: process.execPath,
      prefix: [require.resolve("npm/bin/npm-cli.js")],
    };
  } catch {
    return null;
  }
}

async function jsonFile(file: string): Promise<Record<string, any>> {
  const value = JSON.parse(
    (await readFile(file, "utf8")).replace(/^\uFEFF/, ""),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value;
}

/** Checks all direct locked dependencies, not merely package.json ranges or folder presence. */
export async function inspectDependencies(
  projectRoot: string,
): Promise<DependencyCheck> {
  const diagnostics: Diagnostic[] = [];
  const state: DependencyCheck = {
    manifestPresent: false,
    lockPresent: false,
    lockUsable: false,
    ready: false,
    packages: [],
    diagnostics,
  };
  let manifest: Record<string, any>;
  let lock: Record<string, any>;
  try {
    manifest = await jsonFile(path.join(projectRoot, "package.json"));
    state.manifestPresent = true;
  } catch {
    diagnostics.push(
      diagnostic(
        "TCENV_MANIFEST_INVALID",
        "error",
        "package.json is missing or invalid.",
        "Use an intact pelican directory containing package.json.",
      ),
    );
    return state;
  }
  try {
    lock = await jsonFile(path.join(projectRoot, "package-lock.json"));
    state.lockPresent = true;
  } catch {
    diagnostics.push(
      diagnostic(
        "TCENV_LOCK_INVALID",
        "error",
        "package-lock.json is missing or invalid.",
        "Restore the supplied lockfile; setup never generates or upgrades a lockfile.",
      ),
    );
    return state;
  }
  if (
    !lock.packages ||
    typeof lock.packages !== "object" ||
    !lock.packages[""] ||
    ![2, 3].includes(lock.lockfileVersion)
  ) {
    diagnostics.push(
      diagnostic(
        "TCENV_LOCK_FORMAT",
        "error",
        "The lockfile must contain npm v2/v3 package records.",
        "Restore the matching npm lockfile before setup.",
      ),
    );
    return state;
  }
  const requested = { ...manifest.dependencies, ...manifest.devDependencies };
  const lockedRoot = {
    ...lock.packages[""].dependencies,
    ...lock.packages[""].devDependencies,
  };
  const required = ["tsx", "typescript", "playwright", "three", "vite"];
  for (const name of [
    ...new Set([
      ...Object.keys(requested),
      ...Object.keys(lockedRoot),
      ...required,
    ]),
  ].sort()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
      diagnostics.push(
        diagnostic(
          "TCENV_DEPENDENCY_NAME",
          "error",
          "A dependency has an invalid package name.",
          "Correct package.json and its lockfile through the engine dependency workflow.",
        ),
      );
      continue;
    }
    const entry = lock.packages[`node_modules/${name}`];
    const version = typeof entry?.version === "string" ? entry.version : null;
    let installed: string | null = null;
    try {
      const found = (
        await jsonFile(
          path.join(projectRoot, "node_modules", name, "package.json"),
        )
      ).version;
      installed = typeof found === "string" ? found : null;
    } catch {
      /* Missing, truncated, or invalid installations all require repair. */
    }
    state.packages.push({
      name,
      requested: requested[name] ?? null,
      locked: version,
      installed,
    });
    if (
      !requested[name] ||
      requested[name] !== lockedRoot[name] ||
      !version ||
      (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(requested[name]) &&
        requested[name] !== version)
    ) {
      diagnostics.push(
        diagnostic(
          "TCENV_LOCK_MISMATCH",
          "error",
          `The lockfile does not match the requested dependency ${name}.`,
          "Restore matching package.json and package-lock.json; do not upgrade implicitly.",
        ),
      );
    } else if (installed !== version) {
      diagnostics.push(
        diagnostic(
          "TCENV_DEPENDENCY_NOT_READY",
          "error",
          `Dependency ${name} is missing or differs from its locked version.`,
          "Run setup to restore node_modules using npm ci.",
        ),
      );
    }
  }
  // npm records the complete installed tree; checking transitives catches incomplete cached installs.
  for (const [location, entry] of Object.entries(lock.packages) as [
    string,
    any,
  ][]) {
    if (
      !location ||
      !location.startsWith("node_modules/") ||
      entry.link ||
      entry.optional
    )
      continue;
    const resolved = path.resolve(projectRoot, location, "package.json");
    const relative = path.relative(projectRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      diagnostics.push(
        diagnostic(
          "TCENV_LOCK_PATH",
          "error",
          "A lockfile package path escapes the project.",
          "Restore the supplied lockfile.",
        ),
      );
      continue;
    }
    // Other-platform optional packages are skipped above; active required packages must exist.
    try {
      const actual = await jsonFile(resolved);
      if (actual.version !== entry.version) throw new Error("Version mismatch");
    } catch {
      if (!Object.hasOwn(requested, location.slice("node_modules/".length))) {
        diagnostics.push(
          diagnostic(
            "TCENV_TRANSITIVE_NOT_READY",
            "error",
            `A required locked transitive dependency is missing or inconsistent: ${location}.`,
            "Run setup to repair the dependency tree with npm ci.",
          ),
        );
      }
    }
  }
  state.lockUsable = !diagnostics.some((d) =>
    [
      "TCENV_LOCK_MISMATCH",
      "TCENV_LOCK_PATH",
      "TCENV_DEPENDENCY_NAME",
    ].includes(d.code),
  );
  state.ready = !diagnostics.some((d) => d.severity === "error");
  return state;
}

const numeric = (v: unknown): number | null =>
  (typeof v === "number" || typeof v === "string") &&
  String(v).trim() !== "" &&
  Number.isFinite(Number(v)) &&
  Number(v) >= 0
    ? Number(v)
    : null;
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const array = (v: unknown): any[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/** Projects selected hardware properties only: never computer name, serials, user or owner. */
export function parseCim(stdout: string): MachineData {
  const raw = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (
    !raw?.computer ||
    !raw?.os ||
    !numeric(raw.computer.TotalPhysicalMemory) ||
    !text(raw.os.Version) ||
    !array(raw.cpus).length
  )
    throw new Error("Incomplete CIM inventory");
  return {
    manufacturer: text(raw.computer.Manufacturer),
    model: text(raw.computer.Model),
    ramBytes: numeric(raw.computer.TotalPhysicalMemory),
    os: {
      caption: text(raw.os.Caption),
      version: text(raw.os.Version),
      build: text(raw.os.BuildNumber),
      architecture: text(raw.os.OSArchitecture),
    },
    cpus: array(raw.cpus).map((c) => ({
      name: text(c.Name),
      cores: numeric(c.NumberOfCores),
      logicalProcessors: numeric(c.NumberOfLogicalProcessors),
      maxClockMHz: numeric(c.MaxClockSpeed),
    })),
    gpus: array(raw.gpus).map((g) => ({
      name: text(g.Name),
      driverVersion: text(g.DriverVersion),
      adapterRamReportedBytes: numeric(g.AdapterRAM),
      adapterRamReliable: false,
      dedicatedMemoryBytes: null,
      dedicatedMemorySource: null,
    })),
  };
}

/** nvidia-smi memory.total uses MiB; do not round or substitute the advertised 12 GB. */
export function parseNvidiaSmi(stdout: string): NvidiaGpu[] {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("Empty NVIDIA inventory");
  return lines.map((line) => {
    const match = /^\s*("(?:[^"]|"")*"|[^,]+),\s*([^,]+),\s*([\d.]+)\s*$/.exec(
      line,
    );
    const memoryMiB = match ? Number(match[3]) : NaN;
    if (!match || !Number.isFinite(memoryMiB) || memoryMiB <= 0)
      throw new Error("Invalid NVIDIA inventory");
    return {
      name: match[1]!.trim().replace(/^"|"$/g, "").replace(/""/g, '"'),
      driverVersion: match[2]!.trim(),
      memoryMiB,
      memoryBytes: memoryMiB * 1024 * 1024,
    };
  });
}

const cimScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inventory = @{
 computer = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory
 os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
 cpus = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed)
 gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM)
}
$inventory | ConvertTo-Json -Depth 6 -Compress
`;

async function browserInfo(
  projectRoot: string,
  diagnostics: Diagnostic[],
): Promise<BrowserData> {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const cachePath =
    cache === "0"
      ? "<playwright-core>/.local-browsers"
      : cache
        ? path.resolve(projectRoot, cache)
        : path.join(
            process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData/Local"),
            "ms-playwright",
          );
  const data: BrowserData = {
    provider: "playwright-chromium",
    installed: false,
    executablePath: null,
    cachePath,
    pathNotation: "project-and-home-tokens",
    launched: false,
  };
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const playwright = require("playwright") as {
      chromium: { executablePath(): string };
    };
    data.executablePath = playwright.chromium.executablePath();
    await access(data.executablePath, constants.R_OK);
    data.installed = true;
  } catch {
    diagnostics.push(
      diagnostic(
        "TCENV_BROWSER_MISSING",
        "error",
        "The locked Playwright Chromium executable is unavailable.",
        "Install the bundled browser with node node_modules/playwright/cli.js install chromium, then rerun doctor.",
      ),
    );
  }
  return data;
}

/** Read-only. Defaults to cwd; the caller decides whether/where to persist the report. */
export async function doctor(
  options: DoctorOptions = {},
): Promise<Envelope<EnvironmentData>> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const diagnostics: Diagnostic[] = [];
  const runner = options.runCommand ?? runCommand;
  const commandOptions: CommandOptions = {
    cwd: projectRoot,
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const safeRun = async (
    file: string,
    args: string[],
  ): Promise<CommandResult> => {
    try {
      return await runner(file, args, commandOptions);
    } catch {
      return { exitCode: null, stdout: "", failure: "failed" };
    }
  };
  if (process.platform !== "win32")
    diagnostics.push(
      diagnostic(
        "TCENV_PLATFORM_UNSUPPORTED",
        "error",
        "The development toolchain currently supports Windows.",
        "Run development checks on Windows; this is not a player browser restriction.",
      ),
    );
  const npm = npmCommand(projectRoot);
  const [cim, nvidia, npmVersion, git, dependencies, browser] =
    await Promise.all([
      safeRun("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        cimScript,
      ]),
      safeRun("nvidia-smi", [
        "--query-gpu=name,driver_version,memory.total",
        "--format=csv,noheader,nounits",
      ]),
      npm
        ? safeRun(npm.file, [...npm.prefix, "--version"])
        : Promise.resolve({
            exitCode: null,
            stdout: "",
            failure: "missing",
          } as CommandResult),
      safeRun("git", ["--version"]),
      inspectDependencies(projectRoot),
      browserInfo(projectRoot, diagnostics),
    ]);
  diagnostics.push(...dependencies.diagnostics);
  let machine: MachineData | null = null;
  if (cim.exitCode === 0) {
    try {
      machine = parseCim(cim.stdout);
    } catch {
      diagnostics.push(
        diagnostic(
          "TCENV_CIM_INVALID",
          "error",
          "Windows returned an incomplete or invalid hardware inventory.",
          "Retry doctor; verify the Windows CIM service is available.",
        ),
      );
    }
  } else
    diagnostics.push(
      diagnostic(
        "TCENV_CIM_UNAVAILABLE",
        "error",
        "Windows CIM inventory could not be collected.",
        "Retry doctor with PowerShell and the local CIM service available; no administrator installation is performed.",
      ),
    );
  let nvidiaGpus: NvidiaGpu[] = [];
  if (nvidia.exitCode === 0) {
    try {
      nvidiaGpus = parseNvidiaSmi(nvidia.stdout);
    } catch {
      diagnostics.push(
        diagnostic(
          "TCENV_NVIDIA_INVALID",
          "warning",
          "nvidia-smi returned unsupported inventory data.",
          "Check nvidia-smi output locally; exact dedicated memory remains unknown.",
        ),
      );
    }
  } else
    diagnostics.push(
      diagnostic(
        "TCENV_NVIDIA_UNAVAILABLE",
        "warning",
        "nvidia-smi is unavailable; exact NVIDIA dedicated memory was not measured.",
        "Use the vendor inventory tool if applicable. Non-NVIDIA hardware is not rejected.",
      ),
    );
  if (machine) {
    for (const gpu of machine.gpus) {
      const exact = nvidiaGpus.find(
        (n) => n.name.toLowerCase() === gpu.name?.toLowerCase(),
      );
      if (exact) {
        gpu.dedicatedMemoryBytes = exact.memoryBytes;
        gpu.dedicatedMemorySource = "nvidia-smi";
      }
    }
    if (machine.gpus.length)
      diagnostics.push(
        diagnostic(
          "TCENV_ADAPTER_RAM_UNRELIABLE",
          "info",
          "CIM AdapterRAM is a 32-bit field and can truncate VRAM above 4 GiB; it is not used as dedicated memory.",
          "Use the separately recorded vendor memory measurement, not AdapterRAM.",
        ),
      );
  }
  const npmText =
    npmVersion.exitCode === 0 &&
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(npmVersion.stdout.trim())
      ? npmVersion.stdout.trim()
      : null;
  if (!npmText)
    diagnostics.push(
      diagnostic(
        "TCENV_NPM_UNAVAILABLE",
        "error",
        "The npm CLI is missing or did not return a valid version.",
        "Use a local or user-level Node distribution containing npm, then rerun setup.",
      ),
    );
  const gitText =
    git.exitCode === 0
      ? (/^git version [\w.+()-]+/m.exec(git.stdout)?.[0] ?? null)
      : null;
  if (!gitText)
    diagnostics.push(
      diagnostic(
        "TCENV_GIT_OPTIONAL",
        "info",
        "Git is unavailable; ZIP and directory workflows remain supported.",
        "No action required for ZIP or directory use.",
      ),
    );
  if (options.signal?.aborted)
    diagnostics.push(
      diagnostic(
        "TCENV_CANCELLED",
        "error",
        "Environment collection was cancelled.",
        "Rerun doctor when ready.",
      ),
    );
  const data: EnvironmentData = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    machine,
    nvidia: nvidiaGpus,
    runtime: {
      node: process.versions.node,
      npm: npmText,
      nodeExecutable: process.execPath,
    },
    dependencies,
    browser,
    git: {
      available: !!gitText,
      version: gitText,
      checkout: existsSync(path.join(projectRoot, ".git")),
    },
  };
  return sanitizeReport(
    envelope(options.taskId ?? "M0-00-environment", diagnostics, data),
    projectRoot,
  );
}

/** CLI helper used by both tools. Library calls never write evidence automatically. */
export async function printReport<T>(
  report: Envelope<T>,
  output: string | undefined,
  projectRoot: string,
): Promise<void> {
  if (output) {
    const destination = path.resolve(projectRoot, output);
    const rel = path.relative(projectRoot, destination);
    if (
      rel.startsWith(`..${path.sep}`) ||
      rel === ".." ||
      path.isAbsolute(rel)
    ) {
      report.diagnostics.push(
        diagnostic(
          "TCENV_OUTPUT_PATH",
          "error",
          "Report output must stay inside the project directory.",
          "Choose a project-relative output path.",
        ),
      );
      report.status = "failed";
    } else {
      report.artifacts.push({
        type: "application/json",
        path: rel.split(path.sep).join("/"),
      });
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(
          destination,
          `${JSON.stringify(report, null, 2)}\n`,
          "utf8",
        );
      } catch {
        report.artifacts.pop();
        report.status = "failed";
        report.diagnostics.push(
          diagnostic(
            "TCENV_OUTPUT_WRITE_FAILED",
            "error",
            "The report file could not be written.",
            "Check output directory permissions and rerun the command.",
          ),
        );
      }
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "succeeded" ? 0 : 1;
}
export function isDirectInvocation(metaUrl: string): boolean {
  return (
    !!process.argv[1] &&
    path.resolve(fileURLToPath(metaUrl)).toLowerCase() ===
      path.resolve(process.argv[1]).toLowerCase()
  );
}
export function parseArguments(
  args: string[],
  flags: string[] = [],
): { output?: string; projectRoot?: string; flags: Set<string> } {
  const result: { output?: string; projectRoot?: string; flags: Set<string> } =
    { flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--output" || arg === "--project") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing argument");
      if (arg === "--output") result.output = value;
      else result.projectRoot = value;
    } else if (flags.includes(arg)) result.flags.add(arg);
    else throw new Error("Unknown argument");
  }
  return result;
}
if (isDirectInvocation(import.meta.url)) {
  let projectRoot = process.cwd();
  try {
    const args = parseArguments(process.argv.slice(2));
    projectRoot = path.resolve(args.projectRoot ?? process.cwd());
    await printReport(await doctor({ projectRoot }), args.output, projectRoot);
  } catch {
    await printReport(
      envelope(
        "M0-00-environment",
        [
          diagnostic(
            "TCENV_ARGUMENT_OR_INTERNAL_ERROR",
            "error",
            "The command could not complete.",
            "Use doctor [--project directory] [--output relative-file.json] and check the project directory.",
          ),
        ],
        null,
      ),
      undefined,
      projectRoot,
    );
  }
}
