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
      response.writeHead(200, {
        "content-type": mime[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      response.end(
        request.method === "HEAD" ? undefined : await readFile(file),
      );
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
