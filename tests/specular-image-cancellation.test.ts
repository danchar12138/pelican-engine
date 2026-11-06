import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

test("cancelled specular image decodes drain and release every bitmap", { timeout: 60000 }, async () => {
  const bytes = await readFile(new URL("../examples/specular-textures/assets/specular-textures.glb", import.meta.url));
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "silent", plugins: [{ name: "pelican-cancel-test-page", configureServer(server) { server.middlewares.use("/__cancel_test", (_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>cancel</title>"); }); } }], server: { host: "127.0.0.1", port: 0 } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
    const page = await browser.newPage();
    await page.addInitScript("globalThis.__name = (target) => target;");
    await page.goto(new URL("/__cancel_test", server.resolvedUrls!.local[0]).href);
    assert.equal(await page.title(), "cancel");
    const result = await page.evaluate(async (data) => {
      const modulePath = "/packages/renderer/src/models.ts";
      const { createModelLibrary } = await import(modulePath);
      const originalCreate = globalThis.createImageBitmap;
      const originalClose = ImageBitmap.prototype.close;
      const bitmaps: ImageBitmap[] = [], closed = new Map<ImageBitmap, number>();
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const pending = new Promise<void>(resolve => { started = resolve; });
      globalThis.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        const bitmap = await originalCreate(...args);
        bitmaps.push(bitmap); started(); await gate; return bitmap;
      }) as typeof createImageBitmap;
      ImageBitmap.prototype.close = function() { closed.set(this, (closed.get(this) ?? 0) + 1); originalClose.call(this); };
      const library = createModelLibrary({ asset: "fixture.glb" }, { fetch: async () => new Response(new Uint8Array(data)) });
      try {
        const controller = new AbortController();
        const preparing = library.prepare(undefined, { signal: controller.signal }).then(() => "unexpected success", (error: Error) => error.message);
        await pending;
        controller.abort();
        const error = await preparing;
        let disposed = false;
        const disposing = library.dispose().then(() => { disposed = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        const waited = !disposed;
        release(); await disposing;
        return { error, waited, bitmaps: bitmaps.length, closed: bitmaps.map(bitmap => closed.get(bitmap) ?? 0), templates: library.inspect().templates.length };
      } finally {
        release();
        await library.dispose();
        globalThis.createImageBitmap = originalCreate;
        ImageBitmap.prototype.close = originalClose;
      }
    }, [...bytes]);
    assert.match(result.error, /TC_MODEL_CANCELLED/);
    assert.equal(result.waited, true);
    assert.ok(result.bitmaps >= 1);
    assert.ok(result.closed.every(count => count === 1));
    assert.equal(result.templates, 0);
  } finally { await browser?.close(); await server.close(); }
});
