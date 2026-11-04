/** Manifest-driven milestone gates and portable ZIP packaging. Never invokes Git, gh, or a shell. */
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, brotliDecompressSync, gunzipSync } from "node:zlib";

import { sourceFingerprint } from "./source-fingerprint.ts";

export const PROTOCOL_VERSION = "0.1.0" as const;
/** Legacy fixture version; live releases use engine.manifest.json. */
export const M0_VERSION = "0.0.1-m0.0";
export const REQUIRED_CHECKS = [
  "environment",
  "compiler",
  "render",
  "simulation",
  "ai-workflow",
  "typecheck",
  "unit-tests",
  "deploy",
] as const;
export type Milestone =
  | "M0"
  | "M1"
  | "M2"
  | "M3"
  | "M4"
  | "M5"
  | "M6"
  | "M7"
  | "M8";
export const M1_REQUIRED_CHECKS = [
  "environment",
  "typecheck",
  "unit-tests",
  "compiler",
  "runtime",
  "resources",
  "scheduler",
  "protocol",
  "unattended",
  "render",
  "deploy",
  "ai-workflow",
] as const;
/** Gate IDs emitted by tools/verify-m2.ts, including its final source freeze. */
export const M2_REQUIRED_CHECKS = [
  "environment",
  "typecheck",
  "unit-tests",
  "compiler",
  "assets",
  "physics",
  "runtime",
  "ui-prototype",
  "dev-server",
  "protocol",
  "unattended",
  "render",
  "deploy",
  "ai-workflow",
  "source-freeze",
] as const;
interface ReleaseProfile {
  scope: string;
  requiredChecks: readonly string[];
  requireSourceIdentity: boolean;
}
/** Add later profiles only alongside their implemented verifier and release-rule tests. */
export const RELEASE_PROFILES: Readonly<
  Partial<Record<Milestone, Readonly<ReleaseProfile>>>
> = Object.freeze({
  M0: Object.freeze({
    scope: "risk-prototypes",
    requiredChecks: REQUIRED_CHECKS,
    requireSourceIdentity: false,
  }),
  M1: Object.freeze({
    scope: "runtime-foundation",
    requiredChecks: M1_REQUIRED_CHECKS,
    requireSourceIdentity: true,
  }),
  M2: Object.freeze({
    scope: "playable-game-slice",
    requiredChecks: M2_REQUIRED_CHECKS,
    requireSourceIdentity: true,
  }),
});
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILES = 60_000;
const NOTICE_PATHS = [
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_NOTICES.txt",
  "THIRD_PARTY_NOTICES",
  "docs/THIRD_PARTY_NOTICES.md",
  "docs/THIRD-PARTY-NOTICES.md",
];
const OMIT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".threecat",
  "release",
  ".cache",
  ".vite",
  "coverage",
  "playwright-report",
  "test-results",
  "tmp",
  "temp",
  ".ssh",
  ".aws",
  ".azure",
  ".codex",
  "secrets",
  "credentials",
]);
const OMIT_FILES =
  /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.DS_Store|Thumbs\.db)$|(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:[._-][^.]+)*\.(?:json|ya?ml|toml|ini|conf|txt|env)$|^(?:secrets?|credentials?|tokens?)$|\.(?:pem|key|pfx|p12|keystore|log|tmp|temp|bak|swp|tsbuildinfo|zip|7z|tar|gz)$/i;
const PRIVATE_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;

export interface ReleaseOptions {
  projectRoot?: string;
}
export interface ReleaseDiagnostic {
  code: string;
  severity: "error";
  message: string;
  remediation: string;
}
export interface ReleaseEnvelope<T> {
  protocolVersion: typeof PROTOCOL_VERSION;
  taskId: `${Milestone}-release` | "release";
  status: "succeeded" | "failed";
  diagnostics: ReleaseDiagnostic[];
  artifacts: { type: string; path: string }[];
  data: T | null;
}
export interface FileDigest {
  path: string;
  bytes: number;
  sha256: string;
}
export interface CheckRecord {
  id: string;
  status: "passed";
  evidence: string[];
}
export interface ReleaseInfo {
  engineVersion: string;
  milestone: Milestone;
  scope: string;
  prerelease: boolean;
  checks: CheckRecord[];
  limitations: string[];
  sourceFileCount: number;
  distFileCount: number;
  thirdPartyNotice: string;
  sourceIdentity?: { sha256: string };
}
interface Entry {
  path: string;
  content: Buffer;
}
interface Inventory {
  root: string;
  source: Entry[];
  dist: Entry[];
  info: ReleaseInfo;
}
export interface ArchiveManifest extends FileDigest {
  kind: "source" | "dist";
  entries: FileDigest[];
}
export interface ReleaseManifest {
  protocolVersion: typeof PROTOCOL_VERSION;
  engineVersion: string;
  milestone: Milestone;
  scope: string;
  prerelease: boolean;
  archives: ArchiveManifest[];
  artifacts: FileDigest[];
}
export interface PackedRelease extends ReleaseInfo {
  directory: string;
  manifest: string;
  checksums: string;
}
class ReleaseError extends Error {
  constructor(
    public code: string,
    message: string,
    public remediation = "Read docs/RELEASING.md, correct the input, and rerun release:check.",
  ) {
    super(message);
  }
}
function fail(code: string, message: string): never {
  throw new ReleaseError(code, message);
}
function ensure(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) fail(code, message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function digest(entry: Entry): FileDigest {
  return {
    path: entry.path,
    bytes: entry.content.length,
    sha256: createHash("sha256").update(entry.content).digest("hex"),
  };
}
function ok<T>(
  data: T,
  artifacts: ReleaseEnvelope<T>["artifacts"] = [],
  milestone?: Milestone,
): ReleaseEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: milestone ? `${milestone}-release` : "release",
    status: "succeeded",
    diagnostics: [],
    artifacts,
    data,
  };
}
function failed<T>(error: unknown): ReleaseEnvelope<T> {
  const detail =
    error instanceof ReleaseError
      ? error
      : new ReleaseError(
          "TCREL_IO",
          "Release input or output could not be accessed safely.",
          "Check project file permissions and available disk space; rerun without changing the release inputs.",
        );
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: "release",
    status: "failed",
    diagnostics: [
      {
        code: detail.code,
        severity: "error",
        message: detail.message,
        remediation: detail.remediation,
      },
    ],
    artifacts: [],
    data: null,
  };
}
/** Project-relative only, normalized for both Windows and ZIP names. */
function relativeName(input: unknown): string {
  ensure(
    typeof input === "string" && input.length > 0,
    "TCREL_PATH",
    "An evidence path must be a nonempty project-relative string.",
  );
  const name = input.replaceAll("\\", "/");
  ensure(
    !name.startsWith("/") &&
      !/[:<>"|?*\x00-\x1f\x7f]/.test(name) &&
      name.split("/").every((p) => p && p !== "." && p !== ".."),
    "TCREL_PATH",
    "A release path is absolute, ambiguous, or escapes the project.",
  );
  return name;
}
function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    Boolean(rel) &&
    !path.isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`)
  );
}
function redactedText(text: string, root: string): string {
  let output = text;
  for (const [target, token] of [
    [root, "<project>"],
    [homedir(), "<home>"],
  ] as const) {
    output = output
      .split(target)
      .join(token)
      .split(target.replaceAll("\\", "/"))
      .join(token);
  }
  return output
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, "<home>")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "<home>");
}
function parseJson(
  entry: Entry | undefined,
  label: string,
): Record<string, unknown> {
  ensure(
    entry,
    "TCREL_REQUIRED_FILE",
    `Required release file is missing or excluded: ${label}.`,
  );
  try {
    const data: unknown = JSON.parse(
      entry.content.toString("utf8").replace(/^\uFEFF/, ""),
    );
    ensure(object(data), "TCREL_JSON", `${label} must contain a JSON object.`);
    return data;
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    fail("TCREL_JSON", `${label} is not valid JSON.`);
  }
}
async function collect(
  root: string,
  dist: boolean,
  budget: { bytes: number; files: number },
): Promise<Entry[]> {
  const base = dist ? path.join(root, "dist") : root;
  if (dist) {
    const stat = await lstat(base).catch(() => null);
    ensure(
      stat?.isDirectory() && !stat.isSymbolicLink(),
      "TCREL_DIST",
      "dist/ must be a real build directory.",
    );
  }
  const entries: Entry[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const lower = name.toLowerCase();
      // Prune before lstat/readdir: never traverse dependencies, caches, credentials or output.
      const runtimeEncoding =
        dist && /\.(html|js|json|css|wasm|glb|wav)\.gz$/i.test(name);
      if (
        OMIT_DIRS.has(lower) ||
        (OMIT_FILES.test(name) && !runtimeEncoding) ||
        lower === "dist"
      )
        continue;
      const relative = relativeName(prefix ? `${prefix}/${name}` : name);
      if (!dist && relative === "public/generated") continue;
      const file = path.join(directory, name);
      ensure(
        inside(base, file),
        "TCREL_PATH",
        "A discovered path escapes the archive root.",
      );
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) continue; // Includes Windows directory junctions.
      if (stat.isDirectory()) {
        await walk(file, relative);
        continue;
      }
      ensure(
        stat.isFile(),
        "TCREL_FILE_TYPE",
        `Unsupported filesystem entry: ${relative}.`,
      );
      ensure(
        stat.size <= MAX_FILE &&
          budget.bytes + stat.size <= MAX_TOTAL &&
          budget.files < MAX_FILES,
        "TCREL_SIZE",
        "Release exceeds the bounded ZIP32 file/size budget.",
      );
      const resolved = await realpath(file);
      ensure(
        inside(base, resolved),
        "TCREL_PATH",
        "A resolved file escapes the archive root.",
      );
      const content = await readFile(file);
      ensure(
        content.length === stat.size,
        "TCREL_INPUT_CHANGED",
        `File changed while collecting: ${relative}.`,
      );
      ensure(
        !PRIVATE_CONTENT.test(content.toString("utf8")),
        "TCREL_SECRET",
        `Credential-like content detected in ${dist ? "dist/" : ""}${relative}.`,
      );
      budget.bytes += content.length;
      budget.files++;
      entries.push({ path: relative, content });
    }
  };
  await walk(base, "");
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
function validateGpuEvidence(entries: Entry[]): void {
  // Inspect recorded evidence only. This gate never invents GPU results or reruns a CPU substitute.
  let found = false;
  for (const entry of entries.filter((e) =>
    e.path.toLowerCase().endsWith(".json"),
  )) {
    const report = parseJson(entry, entry.path);
    let backend = false,
      nonFallback = false,
      identity = false,
      software = false;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!object(value)) return;
      for (const [key, item] of Object.entries(value)) {
        if (
          key === "backend" &&
          typeof item === "string" &&
          /^(?:WebGPUBackend|webgpu)$/i.test(item)
        )
          backend = true;
        if (key === "isFallbackAdapter") {
          if (item === false) nonFallback = true;
          if (item === true) software = true;
        }
        if (
          [
            "vendor",
            "device",
            "description",
            "renderer",
            "architecture",
          ].includes(key) &&
          typeof item === "string"
        ) {
          if (item.trim()) identity = true;
          if (
            /swiftshader|llvmpipe|lavapipe|software adapter|microsoft basic render|\bwarp\b/i.test(
              item,
            )
          )
            software = true;
        }
        if (key === "hardware" && item === false) software = true;
        visit(item);
      }
    };
    visit(report);
    ensure(
      !software,
      "TCREL_GPU_SOFTWARE",
      "Render evidence reports a software/fallback GPU and cannot establish hardware acceptance.",
    );
    if (backend && nonFallback && identity) found = true;
  }
  ensure(
    found,
    "TCREL_GPU_EVIDENCE",
    "render.evidence must include a JSON report with a WebGPU backend, adapter identity, and isFallbackAdapter: false.",
  );
}
function validateM2DistNotices(entries: Entry[]): void {
  const dist = new Map(entries.map((entry) => [entry.path, entry]));
  for (const [name, code] of [
    ["THREE-LICENSE.txt", "TCREL_LICENSE"],
    ["RAPIER-LICENSE.txt", "TCREL_LICENSE"],
    ["THIRDPARTY-NOTICES.txt", "TCREL_NOTICE"],
    ["generated/asset-notices.json", "TCREL_NOTICE"],
  ] as const)
    ensure(
      dist.get(name)?.content.toString("utf8").trim(),
      code,
      `M2 dist/${name} must contain the existing distribution license or notice.`,
    );
  const notices = parseJson(
    dist.get("generated/asset-notices.json"),
    "dist/generated/asset-notices.json",
  );
  // This is the compiler's notice envelope, not an invented acceptance artifact.
  ensure(
    notices.format === "threecat.asset-notices" &&
      notices.version === 1 &&
      Array.isArray(notices.assets) &&
      notices.assets.every(
        (asset) =>
          object(asset) &&
          typeof asset.id === "string" &&
          asset.id.trim() &&
          typeof asset.path === "string" &&
          asset.path.trim() &&
          (asset.license === null ||
            (typeof asset.license === "string" && asset.license.trim())) &&
          ["source", "attribution"].every(
            (key) => asset[key] === undefined || typeof asset[key] === "string",
          ),
      ),
    "TCREL_NOTICE",
    "M2 asset notices must retain the compiler's format, version and asset declarations (including null for undeclared licenses).",
  );
  const compressed = dist.get("compression-manifest.json");
  if (compressed) {
    const report = parseJson(compressed, "dist/compression-manifest.json");
    ensure(
      report.format === "threecat.dist-compression" &&
        report.version === 1 &&
        Array.isArray(report.entries),
      "TCREL_DIST_COMPRESSION",
      "Invalid compression manifest.",
    );
    for (const record of report.entries as unknown[]) {
      ensure(
        object(record) &&
          typeof record.path === "string" &&
          object(record.encodings),
        "TCREL_DIST_COMPRESSION",
        "Invalid compression record.",
      );
      const source = dist.get(relativeName(record.path));
      ensure(
        source &&
          digest(source).sha256 === record.sha256 &&
          source.content.length === record.bytes,
        "TCREL_DIST_COMPRESSION",
        "Compression source does not match its content hash.",
      );
      for (const [encoding, raw] of Object.entries(record.encodings)) {
        ensure(
          ["br", "gz"].includes(encoding) &&
            object(raw) &&
            raw.path === record.path + "." + encoding,
          "TCREL_DIST_COMPRESSION",
          "Invalid compression encoding/path.",
        );
        const encoded = dist.get(relativeName(raw.path));
        ensure(
          encoded &&
            digest(encoded).sha256 === raw.sha256 &&
            encoded.content.length === raw.bytes,
          "TCREL_DIST_COMPRESSION",
          "Compressed file is absent or stale.",
        );
        let decoded: Buffer;
        try {
          decoded =
            encoding === "br"
              ? brotliDecompressSync(encoded.content, {
                  maxOutputLength: MAX_FILE,
                })
              : gunzipSync(encoded.content, { maxOutputLength: MAX_FILE });
        } catch {
          fail(
            "TCREL_DIST_COMPRESSION",
            "Compressed file cannot be decoded within the release budget.",
          );
        }
        ensure(
          decoded!.equals(source.content),
          "TCREL_DIST_COMPRESSION",
          "Compressed runtime differs from the original.",
        );
      }
    }
  }
}
async function inspect(options: ReleaseOptions): Promise<Inventory> {
  const root = await realpath(
    path.resolve(
      options.projectRoot ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  );
  ensure(
    (await lstat(root)).isDirectory(),
    "TCREL_ROOT",
    "Project root must be a directory.",
  );
  // Manifest selects the phase before reading acceptance; never fall back to an older report.
  const manifestContent = await readFile(
    path.join(root, "engine.manifest.json"),
  );
  const initialEngine = parseJson(
    { path: "engine.manifest.json", content: manifestContent },
    "engine.manifest.json",
  );
  ensure(
    typeof initialEngine.milestone === "string" &&
      /^M[0-8]$/.test(initialEngine.milestone),
    "TCREL_MILESTONE",
    "engine.manifest.json must declare a milestone from M0 through M8.",
  );
  const milestone = initialEngine.milestone as Milestone;
  const acceptanceName = `evidence/${milestone.toLowerCase()}/acceptance.json`;
  const evidenceDirectory = `evidence/${milestone.toLowerCase()}/`;
  ensure(
    milestone === "M0" ||
      (typeof initialEngine.releaseScope === "string" &&
        /^[a-z][a-z0-9-]*$/.test(initialEngine.releaseScope)),
    "TCREL_RELEASE_SCOPE",
    "M1 and later milestones require an explicit releaseScope in engine.manifest.json.",
  );
  const profile = RELEASE_PROFILES[milestone];
  ensure(
    profile,
    "TCREL_PROFILE",
    `Release gates for ${milestone} are not implemented; no earlier profile may substitute.`,
  );
  ensure(
    (milestone === "M0" && initialEngine.releaseScope === undefined) ||
      initialEngine.releaseScope === profile.scope,
    "TCREL_RELEASE_SCOPE",
    `Manifest releaseScope for ${milestone} must be ${profile.scope}.`,
  );
  // A missing gate fails before enumerating the workspace.
  const acceptancePath = path.join(root, acceptanceName);
  for (const segment of [
    "evidence",
    evidenceDirectory.slice(0, -1),
    acceptanceName,
  ]) {
    const stat = await lstat(path.join(root, segment)).catch(() => null);
    ensure(
      stat && !stat.isSymbolicLink(),
      "TCREL_ACCEPTANCE_MISSING",
      `${acceptanceName} must exist inside the project without links.`,
    );
  }
  const acceptanceStat = await lstat(acceptancePath);
  ensure(
    acceptanceStat.isFile() && acceptanceStat.size <= MAX_FILE,
    "TCREL_SIZE",
    "Acceptance must be a bounded regular file.",
  );
  const initialAcceptance = await readFile(acceptancePath);
  const budget = { bytes: 0, files: 0 };
  const source = await collect(root, false, budget);
  const map = new Map(source.map((e) => [e.path, e]));
  ensure(
    map.get(acceptanceName)?.content.equals(initialAcceptance),
    "TCREL_INPUT_CHANGED",
    "Acceptance changed while collecting release inputs.",
  );
  ensure(
    map.get("engine.manifest.json")?.content.equals(manifestContent),
    "TCREL_INPUT_CHANGED",
    "Engine manifest changed while collecting release inputs.",
  );
  const pkg = parseJson(map.get("package.json"), "package.json");
  const engine = parseJson(
    map.get("engine.manifest.json"),
    "engine.manifest.json",
  );
  const lock = parseJson(map.get("package-lock.json"), "package-lock.json");
  ensure(
    pkg.name === "threecat" &&
      typeof pkg.version === "string" &&
      VERSION_PATTERN.test(pkg.version) &&
      engine.name === "threecat" &&
      engine.version === pkg.version &&
      engine.milestone === milestone,
    "TCREL_VERSION",
    `Package and engine must declare matching valid versions for ${milestone}.`,
  );
  ensure(
    lock.version === pkg.version &&
      object(lock.packages) &&
      object(lock.packages[""]) &&
      lock.packages[""].version === pkg.version,
    "TCREL_VERSION",
    "Lockfile root versions must match the engine version.",
  );
  ensure(
    pkg.license === "MIT" &&
      engine.license === "MIT" &&
      map.get("LICENSE")?.content.toString("utf8").includes("MIT License") &&
      map
        .get("LICENSE")
        ?.content.toString("utf8")
        .includes("Permission is hereby granted"),
    "TCREL_LICENSE",
    "An MIT LICENSE and matching package/engine declarations are required.",
  );
  const notice = NOTICE_PATHS.find(
    (p) => (map.get(p)?.content.toString("utf8").trim().length ?? 0) > 20,
  );
  ensure(
    notice,
    "TCREL_NOTICE",
    "A nonempty third-party license notice is required; release tools do not create license claims.",
  );
  for (const key of ["AGENTS.md", "README.md"])
    ensure(
      map.has(key),
      "TCREL_REQUIRED_FILE",
      `Source distribution requires ${key}.`,
    );
  const acceptance = parseJson(map.get(acceptanceName), acceptanceName);
  ensure(
    acceptance.milestone === milestone && acceptance.scope === profile.scope,
    "TCREL_ACCEPTANCE_SCOPE",
    `Acceptance must identify ${milestone} and scope: ${profile.scope}.`,
  );
  ensure(
    acceptance.status === "passed",
    "TCREL_ACCEPTANCE_STATUS",
    `${milestone} acceptance has not passed.`,
  );
  if (
    profile.requireSourceIdentity ||
    acceptance.sourceIdentity !== undefined
  ) {
    ensure(
      object(acceptance.sourceIdentity) &&
        typeof acceptance.sourceIdentity.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(acceptance.sourceIdentity.sha256),
      "TCREL_SOURCE_IDENTITY",
      "Acceptance must record a valid sourceIdentity.sha256 for the accepted executable sources and lockfiles.",
    );
    ensure(
      acceptance.sourceIdentity.sha256 ===
        (await sourceFingerprint(root)).sha256,
      "TCREL_EVIDENCE_STALE",
      `Executable sources changed after ${milestone} acceptance; rerun hardware and external AI validation.`,
    );
  }
  if (milestone !== "M0")
    ensure(
      acceptance.engineVersion === pkg.version,
      "TCREL_VERSION",
      "Current-phase acceptance must explicitly record the matching engineVersion.",
    );
  for (const record of [engine, acceptance]) {
    if (record.protocolVersion !== undefined)
      ensure(
        record.protocolVersion === PROTOCOL_VERSION,
        "TCREL_PROTOCOL",
        "Release input protocolVersion must be 0.1.0.",
      );
  }
  for (const key of ["version", "engineVersion"])
    if (acceptance[key] !== undefined)
      ensure(
        acceptance[key] === pkg.version,
        "TCREL_VERSION",
        "Acceptance engine version does not match package.json.",
      );
  ensure(
    Array.isArray(acceptance.limitations) &&
      acceptance.limitations.length > 0 &&
      acceptance.limitations.every((v) => typeof v === "string" && v.trim()),
    "TCREL_LIMITATIONS",
    `${milestone} must explicitly document nonempty release limitations.`,
  );
  ensure(
    Array.isArray(acceptance.checks),
    "TCREL_CHECKS",
    "Acceptance checks must be an array.",
  );
  const dist = await collect(root, true, budget);
  ensure(
    dist.some((e) => e.path === "index.html" && e.content.length > 0),
    "TCREL_DIST",
    "dist/index.html must be a nonempty built entrypoint.",
  );
  const all = new Map(
    [...source, ...dist.map((e) => ({ ...e, path: `dist/${e.path}` }))].map(
      (e) => [e.path, e],
    ),
  );
  const checks: CheckRecord[] = [];
  const used = new Set<string>();
  for (const record of acceptance.checks) {
    ensure(
      object(record) &&
        typeof record.id === "string" &&
        /^[a-z][a-z0-9-]*$/.test(record.id) &&
        !used.has(record.id),
      "TCREL_CHECKS",
      "Check IDs must be unique stable names.",
    );
    used.add(record.id);
    ensure(
      record.status === "passed",
      "TCREL_CHECK_STATUS",
      `Acceptance check has not passed: ${record.id}.`,
    );
    const declared = record.evidence ?? record.files;
    ensure(
      Array.isArray(declared) && declared.length > 0,
      "TCREL_EVIDENCE_FILES",
      `Check ${record.id} must reference evidence files.`,
    );
    const files = declared.map(relativeName);
    if (record.evidence !== undefined && record.files !== undefined) {
      ensure(
        Array.isArray(record.files) &&
          JSON.stringify(record.files.map(relativeName)) ===
            JSON.stringify(files),
        "TCREL_EVIDENCE_FILES",
        "evidence and legacy files must not disagree.",
      );
    }
    for (const file of files)
      ensure(
        all.has(file) && all.get(file)!.content.length > 0,
        "TCREL_EVIDENCE_MISSING",
        `Missing, empty or excluded evidence file: ${file}.`,
      );
    ensure(
      !files.includes(acceptanceName),
      "TCREL_EVIDENCE_FILES",
      "Acceptance cannot serve as its own evidence.",
    );
    checks.push({ id: record.id, status: "passed", evidence: files });
  }
  ensure(
    profile.requiredChecks.every((id) => used.has(id)),
    "TCREL_CHECKS",
    `Required ${milestone} checks: ${profile.requiredChecks.join(", ")}.`,
  );
  validateGpuEvidence(
    checks
      .find((c) => c.id === "render")!
      .evidence.map((file) => all.get(file)!),
  );
  if (milestone === "M2") validateM2DistNotices(dist);
  return {
    root,
    source,
    dist,
    info: {
      engineVersion: pkg.version,
      milestone,
      scope: profile.scope,
      prerelease: true,
      checks,
      ...(object(acceptance.sourceIdentity)
        ? {
            sourceIdentity: {
              sha256: acceptance.sourceIdentity.sha256 as string,
            },
          }
        : {}),
      limitations: (acceptance.limitations as string[]).map((v) =>
        redactedText(v, root),
      ),
      sourceFileCount: source.length,
      distFileCount: dist.length,
      thirdPartyNotice: notice,
    },
  };
}

export async function checkRelease(
  options: ReleaseOptions = {},
): Promise<ReleaseEnvelope<ReleaseInfo>> {
  try {
    const { info } = await inspect(options);
    return ok(info, [], info.milestone);
  } catch (error) {
    return failed(error);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP32, UTF-8 names, deflate, fixed 1980 timestamps, no machine-specific attributes. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(relativeName(entry.path), "utf8");
    ensure(name.length <= 65535, "TCREL_SIZE", "ZIP entry name is too long.");
    const compressed = deflateRawSync(entry.content, { level: 6 });
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function outputRoot(root: string): Promise<string> {
  const directory = path.join(root, "release");
  ensure(
    inside(root, directory),
    "TCREL_PATH",
    "Release output escapes the project.",
  );
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  ensure(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      inside(root, await realpath(directory)),
    "TCREL_OUTPUT_LINK",
    "release/ must be an ordinary directory inside the project.",
  );
  return directory;
}
export async function packRelease(
  options: ReleaseOptions = {},
): Promise<ReleaseEnvelope<PackedRelease>> {
  let staging: string | undefined;
  let parent: string | undefined;
  try {
    const { root, source, dist, info } = await inspect(options);
    parent = await outputRoot(root);
    const directory = path.join(parent, `v${info.engineVersion}`);
    ensure(
      !(await lstat(directory).catch(() => null)),
      "TCREL_OUTPUT_EXISTS",
      "This release output already exists. Preserve it or move it aside before repacking.",
    );
    const prefix = `threecat-${info.engineVersion}`;
    const sourceEntries = source.map((e) => ({
      path: `${prefix}/${e.path}`,
      content: e.content,
    }));
    const distEntries = [...dist];
    // License material is embedded without modifying the build directory or inventing notices.
    for (const [name, content] of [
      ["LICENSE", source.find((e) => e.path === "LICENSE")!.content],
      [
        "THIRD_PARTY_NOTICES.md",
        source.find((e) => e.path === info.thirdPartyNotice)!.content,
      ],
    ] as const) {
      const existing = distEntries.find((e) => e.path === name);
      if (existing)
        ensure(
          existing.content.equals(content),
          "TCREL_LICENSE",
          `dist/${name} differs from the checked release notice.`,
        );
      else distEntries.push({ path: name, content });
    }
    distEntries.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const sourceZip: Entry = {
      path: `${prefix}-source.zip`,
      content: zip(sourceEntries),
    };
    const distZip: Entry = {
      path: `${prefix}-dist.zip`,
      content: zip(distEntries),
    };
    const evidenceFiles = source
      .filter((e) =>
        e.path.startsWith(`evidence/${info.milestone.toLowerCase()}/`),
      )
      .map(digest);
    const evidence: Entry = {
      path: `${prefix}-evidence.json`,
      content: json({
        protocolVersion: PROTOCOL_VERSION,
        ...info,
        evidenceFiles,
      }),
    };
    const releaseDescription =
      info.milestone === "M0"
        ? "Prerelease: this is a risk-prototype milestone, not a complete game engine.\n\nIncludes compiler, dynamic WebGPU rendering, interactive simulation and external AI workflow evidence."
        : info.milestone === "M2"
          ? "Prerelease: M2 playable-game-slice is a playable game slice and asset pipeline, not a complete game engine. Textured GLB content currently uses raster; full glTF material hybrid/path tracing belongs to M3. M3-M8 capabilities are not complete. The acceptance-recorded scope limitations follow below."
          : `Prerelease: ${info.milestone} ${info.scope} delivers only the accepted phase gates below, not a complete game engine.`;
    const notes: Entry = {
      path: "RELEASE_NOTES.md",
      content: Buffer.from(
        `# threecat ${info.engineVersion} — ${info.milestone} ${info.scope}\n\n${releaseDescription} Software BVH tracing on a real GPU does not imply hardware ray-tracing unit support. No 1080p/60 or complete M1–M8 capability claim is made.\n\n## Accepted checks\n\n${info.checks.map((c) => `- ${c.id}: ${c.status}`).join("\n")}\n\n## Known limitations\n\n${info.limitations.map((v) => `- ${v}`).join("\n")}\n\n## Assets\n\n- Source ZIP: includes evidence/${info.milestone.toLowerCase()}, lockfile, MIT license and third-party notices; excludes dependencies, local secrets and caches.\n- Dist ZIP: deploy its extracted contents to a Web server.\n- Evidence summary, file-level manifest and SHA256SUMS: verify before use.\n\nSee docs/RELEASING.md in the source archive for reproduction and publishing rules.\n`,
        "utf8",
      ),
    };
    const payloads = [sourceZip, distZip, evidence, notes];
    const manifest: Entry = {
      path: `${prefix}-manifest.json`,
      content: json({
        protocolVersion: PROTOCOL_VERSION,
        engineVersion: info.engineVersion,
        milestone: info.milestone,
        scope: info.scope,
        prerelease: info.prerelease,
        archives: [
          {
            ...digest(sourceZip),
            kind: "source",
            entries: sourceEntries.map(digest),
          },
          {
            ...digest(distZip),
            kind: "dist",
            entries: distEntries.map(digest),
          },
        ],
        artifacts: payloads.map(digest),
      } satisfies ReleaseManifest),
    };
    payloads.push(manifest);
    const sums: Entry = {
      path: "SHA256SUMS",
      content: Buffer.from(
        payloads.map((e) => `${digest(e).sha256}  ${e.path}`).join("\n") + "\n",
        "utf8",
      ),
    };
    staging = path.join(parent, `.staging-${randomUUID()}`);
    ensure(
      inside(parent, staging),
      "TCREL_PATH",
      "Staging path escapes release/.",
    );
    await mkdir(staging);
    for (const entry of [...payloads, sums])
      await writeFile(path.join(staging, entry.path), entry.content, {
        flag: "wx",
      });
    await rename(staging, directory);
    staging = undefined;
    const relative = `release/v${info.engineVersion}`;
    return ok(
      {
        ...info,
        directory: relative,
        manifest: `${relative}/${manifest.path}`,
        checksums: `${relative}/SHA256SUMS`,
      },
      [...payloads, sums].map((e) => ({
        type: e.path.endsWith(".zip") ? "archive" : "release-metadata",
        path: `${relative}/${e.path}`,
      })),
      info.milestone,
    );
  } catch (error) {
    return failed(error);
  } finally {
    if (
      staging &&
      parent &&
      inside(parent, staging) &&
      path.basename(staging).startsWith(".staging-")
    ) {
      const stat = await lstat(staging).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink())
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}
export async function releaseCli(
  args: string[],
): Promise<ReleaseEnvelope<ReleaseInfo | PackedRelease>> {
  try {
    ensure(
      args[0] === "check" || args[0] === "pack",
      "TCREL_USAGE",
      "Usage: tsx tools/release.ts <check|pack> [--root <project-directory>]",
    );
    ensure(
      args.length === 1 ||
        (args.length === 3 && args[1] === "--root" && Boolean(args[2])),
      "TCREL_USAGE",
      "Only an optional --root <project-directory> is supported.",
    );
    const options = { projectRoot: args[2] };
    return args[0] === "check" ? checkRelease(options) : packRelease(options);
  } catch (error) {
    return failed(error);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await releaseCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "succeeded" ? 0 : 1;
}
