import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("navigation runs in a browser with GPU disabled", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false, server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--disable-software-rasterizer"] });
    const page = await browser.newPage();
    await page.route("**/navigation-test.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>navigation</title>" }));
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    await page.goto(`http://127.0.0.1:${address.port}/navigation-test.html`);
    const result = await page.evaluate(async () => {
      const load = new Function("url", "return import(url)") as (url: string) => Promise<any>;
      const module = await load("/packages/navigation/src/index.ts");
      const plugin = module.createNavigationPlugin({});
      const n = plugin.services.navigation;
      n.createGrid({ id: "grid", owner: "level", width: 3, height: 2 });
      n.setBlocked("grid", { x: 1, y: 0 }, true);
      const path = n.findPath("grid", { x: 0, y: 0 }, { x: 2, y: 0 });
      plugin.dispose();
      return path;
    });
    assert.deepEqual(result, [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 0 }]);
  } finally {
    await browser?.close();
    await server.close();
  }
});
