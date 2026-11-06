import { lstat } from "node:fs/promises";
import path from "node:path";

const omitDirectories = new Set([
  ".git", "node_modules", ".pelican", ".threecat", "dist", "release",
  "evidence", "public", "games", ".cache", ".vite", "coverage",
  "playwright-report", "test-results", "tmp", "temp", ".ssh", ".aws",
  ".azure", ".codex", "secrets", "credentials",
]);
const omitFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.DS_Store|Thumbs\.db)$|(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:[._-][^.]+)*\.(?:json|ya?ml|toml|ini|conf|txt|env)$|^(?:secrets?|credentials?|tokens?)$|\.(?:pem|key|pfx|p12|keystore|log|tmp|temp|bak|swp|tsbuildinfo|zip|7z|tar|gz)$/i;

/** Exclude local caches, links and credential-shaped names from ZIP validation input. */
export async function includeZipSnapshotPath(root: string, source: string): Promise<boolean> {
  const relative = path.relative(path.resolve(root), path.resolve(source));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("TC_ZIP_SOURCE_PATH: Snapshot input must stay within the engine root.");
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.some(part => omitDirectories.has(part.toLowerCase()) || omitFiles.test(part))) return false;
  const info = await lstat(source);
  if (info.isSymbolicLink()) return false;
  if (!info.isFile() && !info.isDirectory()) throw new Error("TC_ZIP_SOURCE_TYPE: Unsupported filesystem entry in snapshot.");
  return true;
}
