import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { parseProjectManifest, validateManifest } from "../packages/compiler/src/version.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

const MANIFEST = "pelican.project.json";
const BACKUP_PATTERN = /^pelican\.project\.json\.pelican-backup-\d+-[a-f0-9]{12}$/;
const MAX_BYTES = 1024 * 1024;
const fail = (code: string, message: string): never => { throw new Error(`TC_MIGRATE_${code}: ${message}`); };
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const limits = [
  "Updates only pelican.project.json version locks; game APIs, assets, dependencies, saves and replays are not migrated.",
  "No compile, runtime, compatibility or migration verification is performed by this command.",
  "Stop editors and development servers while applying or restoring; the concurrent-change guard is best effort, not a cross-process transaction.",
];
type Replacement = { start: number; end: number; value: string };
type ManifestInfo = { path: string; root: string; bytes: Buffer; source: string; sourceVersion: string; replacements: Replacement[]; insert: string | null };

async function regularFile(root: string, name: string): Promise<{ path: string; bytes: Buffer; mode: number }> {
  const file = path.join(root, name);
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return fail("FILE_MISSING", `Missing '${name}'; choose the correct project or backup.`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES)
    return fail("FILE", `'${name}' must be a regular non-link file no larger than ${MAX_BYTES} bytes.`);
  const resolved = await realpath(file);
  if (!samePath(path.dirname(resolved), root)) return fail("FILE", `'${name}' must resolve directly inside the project directory.`);
  const bytes = await readFile(file);
  if (bytes.length > MAX_BYTES) return fail("FILE", `'${name}' exceeded the size limit while reading.`);
  return { path: file, bytes, mode: metadata.mode & 0o777 };
}
function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isStringLiteral(node) ? node.text : undefined;
}
function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  const matches = object.properties.filter(item => ts.isPropertyAssignment(item) && propertyName(item.name) === name) as ts.PropertyAssignment[];
  if (matches.length > 1) return fail("DUPLICATE", `Duplicate '${name}' fields make the project lock ambiguous; resolve them manually.`);
  return matches[0];
}
async function inspectManifest(projectRoot: string, engineRoot: string): Promise<ManifestInfo> {
  const root = await realpath(projectRoot).catch(() => fail("PROJECT", "Project directory does not exist; provide --project <directory>."));
  const file = await regularFile(root, MANIFEST);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
  catch { return fail("CONFIG", "pelican.project.json must be valid UTF-8; repair it before migration."); }
  let raw: unknown;
  try { raw = parseProjectManifest(source); }
  catch { return fail("CONFIG", "pelican.project.json must contain valid UTF-8 JSON; repair it before migration."); }
  const checked = validateManifest(raw, SDK_VERSION);
  const structural = checked.diagnostics.filter(item => item.severity === "error" && item.code !== "TC_ENGINE_VERSION_MISMATCH");
  if (!checked.manifest || structural.length) return fail("CONFIG", "Project manifest fields are invalid; correct the configuration before migration.");
  const manifest = checked.manifest;
  if (manifest.engine?.path !== undefined) {
    const selected = await realpath(engineRoot);
    const locked = await realpath(path.resolve(root, manifest.engine.path)).catch(() => fail("ENGINE_PATH", "engine.path does not resolve; select the intended engine before changing the lock."));
    if (!samePath(selected, locked)) return fail("ENGINE_PATH", "engine.path points to a different engine; update the project configuration deliberately before changing the lock.");
  }
  const sourceFile = ts.parseJsonText(MANIFEST, source);
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression))
    return fail("CONFIG", "Expected a JSON object project manifest.");
  const object = statement.expression;
  const rootVersion = property(object, "engineVersion"), engine = property(object, "engine");
  let nestedVersion: ts.PropertyAssignment | undefined;
  if (engine) {
    if (!ts.isObjectLiteralExpression(engine.initializer)) return fail("CONFIG", "engine must be a JSON object.");
    property(engine.initializer, "path");
    nestedVersion = property(engine.initializer, "version");
  }
  const versions = [manifest.engineVersion, manifest.engine?.version].filter((item): item is string => item !== undefined);
  if (new Set(versions).size > 1) return fail("LOCK_CONFLICT", "engineVersion and engine.version disagree; reconcile the project locks manually.");
  const sourceVersion = versions[0] ?? "unlocked";
  const replacements: Replacement[] = [];
  for (const entry of [rootVersion, nestedVersion]) if (entry) {
    if (!ts.isStringLiteral(entry.initializer)) return fail("CONFIG", "Version locks must be JSON strings.");
    replacements.push({ start: entry.initializer.getStart(sourceFile), end: entry.initializer.getEnd(), value: JSON.stringify(SDK_VERSION) });
  }
  let insert: string | null = null;
  if (!replacements.length) {
    const first = object.properties[0];
    const leading = source.slice(object.getStart(sourceFile) + 1, first?.getStart(sourceFile) ?? object.getEnd() - 1);
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const multiline = leading.includes("\n");
    const indent = first && multiline ? (source.slice(source.lastIndexOf("\n", first.getStart(sourceFile) - 1) + 1, first.getStart(sourceFile)).match(/^[\t ]*$/)?.[0] ?? "  ") : "  ";
    insert = multiline ? `${eol}${indent}"engineVersion": ${JSON.stringify(SDK_VERSION)}${first ? "," : ""}` : `"engineVersion": ${JSON.stringify(SDK_VERSION)}${first ? ", " : ""}`;
    replacements.push({ start: object.getStart(sourceFile) + 1, end: object.getStart(sourceFile) + 1, value: insert });
  }
  return { path: file.path, root, bytes: file.bytes, source, sourceVersion, replacements, insert };
}
function replacementText(info: ManifestInfo): string {
  let value = info.source;
  for (const replacement of [...info.replacements].sort((a, b) => b.start - a.start))
    value = value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end);
  return value;
}
async function writeExclusive(file: string, bytes: Uint8Array, mode: number): Promise<void> {
  const handle = await open(file, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}
async function replaceWithBackup(root: string, original: Buffer, replacement: Buffer, mode: number) {
  const manifest = path.join(root, MANIFEST), suffix = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const backup = `${MANIFEST}.pelican-backup-${suffix}`, temp = path.join(root, `.${MANIFEST}.pelican-tmp-${suffix}`);
  const backupPath = path.join(root, backup);
  try { await writeExclusive(backupPath, original, mode); }
  catch (error) {
    throw new AggregateError([error], `TC_MIGRATE_BACKUP: Could not write backup '${backup}'; the original manifest was not replaced. Inspect any partial backup before retrying.`);
  }
  const saved = await regularFile(root, backup);
  if (!saved.bytes.equals(original)) return fail("BACKUP", `Backup '${backup}' differs from the source; original manifest was not replaced.`);
  let tempIdentity: { dev: number; ino: number } | undefined;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      const created = await handle.stat();
      tempIdentity = { dev: created.dev, ino: created.ino };
      await handle.writeFile(replacement);
      await handle.sync();
    } finally { await handle.close(); }
    const latest = await regularFile(root, MANIFEST);
    if (!latest.bytes.equals(original)) return fail("CHANGED", `Project manifest changed during the operation; it was not replaced. Backup '${backup}' was retained.`);
    await rename(temp, manifest);
    tempIdentity = undefined;
  } catch (error) {
    // Never remove a pre-existing or replaced temp file; unknown identity is retained.
    if (tempIdentity?.ino) {
      const current = await lstat(temp).catch(() => undefined);
      if (current?.isFile() && !current.isSymbolicLink() && current.ino === tempIdentity.ino && current.dev === tempIdentity.dev)
        await unlink(temp).catch(() => {});
    }
    throw error;
  }
  return { backup, backupSha256: hash(original), currentSha256: hash(replacement) };
}
export async function migrateProject(projectRoot: string, engineRoot: string, options: { apply: boolean; from?: string }) {
  const info = await inspectManifest(projectRoot, engineRoot);
  const changed = info.sourceVersion !== SDK_VERSION;
  const result = { operation: options.apply ? "apply" : "plan", project: info.root, manifest: MANIFEST,
    from: info.sourceVersion, to: SDK_VERSION, changed, currentSha256: hash(info.bytes), lockFields: info.insert === null ? info.replacements.length : 0,
    addsLock: info.insert !== null, compatibility: "not-checked", limitations: limits };
  if (!options.apply || !changed) return result;
  if (!options.from || options.from !== info.sourceVersion)
    return fail("EXPECTED_VERSION", `Pass --from ${JSON.stringify(info.sourceVersion)} to explicitly approve this exact lock change; run migrate without --apply to review the plan.`);
  const current = await regularFile(info.root, MANIFEST);
  if (!current.bytes.equals(info.bytes)) return fail("CHANGED", "Manifest changed after planning; retry the operation.");
  const updated = Buffer.from(replacementText(info), "utf8");
  if (updated.length > MAX_BYTES) return fail("FILE", `Updated manifest would exceed ${MAX_BYTES} bytes; reduce it before migrating.`);
  const recovery = await replaceWithBackup(info.root, info.bytes, updated, current.mode);
  return { ...result, ...recovery };
}
export async function restoreProjectManifest(projectRoot: string, backup: string, expectedCurrent: string, expectedBackup: string) {
  const root = await realpath(projectRoot).catch(() => fail("PROJECT", "Project directory does not exist; provide --project <directory>."));
  if (!BACKUP_PATTERN.test(backup)) return fail("BACKUP", "Use a backup filename produced by this command, without a path.");
  if (!/^[a-f\d]{64}$/i.test(expectedCurrent ?? "") || !/^[a-f\d]{64}$/i.test(expectedBackup ?? ""))
    return fail("EXPECTED_HASH", "Provide --expect-current and --expect-backup using the SHA-256 values from the prior report.");
  const current = await regularFile(root, MANIFEST), saved = await regularFile(root, backup);
  if (hash(current.bytes) !== expectedCurrent.toLowerCase() || hash(saved.bytes) !== expectedBackup.toLowerCase())
    return fail("EXPECTED_HASH", "Current manifest or backup differs from the supplied SHA-256; no files were replaced.");
  const recovery = await replaceWithBackup(root, current.bytes, saved.bytes, current.mode);
  return { operation: "restore", project: root, manifest: MANIFEST, restoredFrom: backup,
    restoredSha256: hash(saved.bytes), compatibility: "not-checked", limitations: limits, ...recovery };
}
