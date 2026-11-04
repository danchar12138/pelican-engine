import {
  cp,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { sourceFingerprint } from "./source-fingerprint.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "engine.manifest.json"), "utf8"),
) as { milestone: string; version: string };
const work = await mkdtemp(
  path.join(tmpdir(), `threecat ${manifest.milestone} ZIP 中文 `),
);
const snapshot = path.join(work, "snapshot", "threecat");
await mkdir(path.dirname(snapshot), { recursive: true });
const omit = new Set([
  ".git",
  "node_modules",
  ".threecat",
  "dist",
  "release",
  "evidence",
  "public",
  "games",
]);
await cp(root, snapshot, {
  recursive: true,
  filter: async (source) => {
    const relative = path.relative(root, source);
    if (
      relative
        .split(path.sep)
        .some((part) => omit.has(part) || part.startsWith(".env"))
    )
      return false;
    return !(await lstat(source)).isSymbolicLink();
  },
});
const fingerprint = await sourceFingerprint(root),
  copied = await sourceFingerprint(snapshot);
if (fingerprint.sha256 !== copied.sha256)
  throw new Error(
    "TC_ZIP_SOURCE_CHANGED: source must be frozen before ZIP validation",
  );
const archive = path.join(
  work,
  `threecat-${manifest.milestone.toLowerCase()}-input.zip`,
);
const script = path.join(work, "archive.ps1");
await writeFile(
  script,
  "param([string]$Source,[string]$Archive)\n$ErrorActionPreference='Stop'\nCompress-Archive -LiteralPath $Source -DestinationPath $Archive -CompressionLevel Optimal\n",
);
await promisify(execFile)(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    snapshot,
    archive,
  ],
  { timeout: 60000, maxBuffer: 1e6 },
);
const metadata = {
  milestone: manifest.milestone,
  engineVersion: manifest.version,
  archive,
  work,
  source: fingerprint,
  archiveSha256: createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
};
await mkdir(path.join(root, ".threecat"), { recursive: true });
await writeFile(
  path.join(root, ".threecat/zip-validation.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    archive,
    work,
    sourceSha256: fingerprint.sha256,
    archiveSha256: metadata.archiveSha256,
  }),
);
