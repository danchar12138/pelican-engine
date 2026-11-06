import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { readdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export async function compressDist(root: string) {
  const entries: {
    path: string;
    bytes: number;
    sha256: string;
    encodings: Record<string, { path: string; bytes: number; sha256: string }>;
  }[] = [];
  const digest = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex");
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name),
        info = await lstat(file);
      if (info.isSymbolicLink())
        throw new Error(
          "TC_BUILD_SYMLINK: Compression input must be owned regular files.",
        );
      if (info.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!/\.(js|json|wasm|glb|wav|css|html)$/.test(name) || info.size < 256)
        continue;
      const original = await readFile(file),
        relative = path.relative(root, file).split(path.sep).join("/"),
        entry = {
          path: relative,
          bytes: original.length,
          sha256: digest(original),
          encodings: {} as Record<
            string,
            { path: string; bytes: number; sha256: string }
          >,
        };
      for (const [extension, compressed] of [
        [
          "br",
          brotliCompressSync(original, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
          }),
        ],
        ["gz", gzipSync(original, { level: 9 })],
      ] as const) {
        if (compressed.length >= original.length) continue;
        await writeFile(file + "." + extension, compressed);
        entry.encodings[extension] = {
          path: relative + "." + extension,
          bytes: compressed.length,
          sha256: digest(compressed),
        };
      }
      entries.push(entry);
    }
  }
  await walk(root);
  const report = {
    format: "pelican.dist-compression",
    version: 1,
    mode: "lossless-http-content-encoding",
    entries,
    notes: [
      "Identity originals remain available. Configure the Web server to negotiate .br/.gz with Content-Encoding and Vary: Accept-Encoding.",
      "Compressed files are never a required custom loader or engine service.",
    ],
  };
  await writeFile(
    path.join(root, "compression-manifest.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  return report;
}
