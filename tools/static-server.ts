import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
export async function serveDist(root: string, port = 4274, basePath = "/") {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const directory = path.resolve(root);
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      if (!pathname.startsWith(base)) {
        response.writeHead(404).end();
        return;
      }
      const local = pathname.slice(base.length) || "index.html";
      const file = path.resolve(directory, local);
      const relative = path.relative(directory, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const accepted = new Map(
        (request.headers["accept-encoding"] ?? "")
          .toLowerCase()
          .split(",")
          .map((part) => {
            const [name, ...parameters] = part.trim().split(";");
            const quality = parameters.find((p) => p.trim().startsWith("q="));
            const q = quality ? Number(quality.trim().slice(2)) : 1;
            return [
              name,
              Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0,
            ] as const;
          }),
      );
      let selected = file,
        encoding: string | undefined;
      for (const candidate of ["br", "gzip"]
        .map((name) => ({
          name,
          q: accepted.get(name) ?? accepted.get("*") ?? 0,
        }))
        .filter((item) => item.q > 0)
        .sort((a, b) => b.q - a.q)) {
        const compressed = file + (candidate.name === "br" ? ".br" : ".gz");
        const compressedInfo = await stat(compressed).catch(() => null);
        if (compressedInfo?.isFile()) {
          selected = compressed;
          encoding = candidate.name;
          break;
        }
      }
      const content = await readFile(selected);
      response.writeHead(200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        vary: "Accept-Encoding",
        "content-length": content.length,
        ...(encoding ? { "content-encoding": encoding } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}${base}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
