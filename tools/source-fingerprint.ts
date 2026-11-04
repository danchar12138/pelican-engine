import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
const excluded = new Set([
  "node_modules",
  ".git",
  ".threecat",
  "dist",
  "release",
  "evidence",
  "public",
  "docs",
  "games",
]);
/** Fingerprint executable source + locked build configuration; reports/docs are versioned separately. */
export async function sourceFingerprint(root: string) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      if (excluded.has(name)) continue;
      const file = path.join(directory, name),
        info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(file);
      else if (
        (/\.(ts|json|ps1|html|yml|glb|gltf|png|jpe?g|webp|wav|ogg|mp3|ktx2|hdr|exr|bin|dat)$/i.test(
          name,
        ) ||
          (path.relative(root, file).split(path.sep)[0] === "examples" &&
            path.relative(root, file).split(path.sep).includes("assets"))) &&
        !name.endsWith("evidence.json")
      ) {
        const bytes = await readFile(file);
        files.push({
          path: path.relative(root, file).split(path.sep).join("/"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        });
      }
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    algorithm: "sha256",
    scope: "executable-source-and-lockfiles",
    sha256: hash,
    files,
  };
}
