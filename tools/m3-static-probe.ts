import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { serveDist } from "./static-server.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
/** Standalone production image/control boundary; no renderer internals or control hooks. */
export async function runM3StaticProbe(dist: string, output: string) {
  await mkdir(output, { recursive: true });
  const server = await serveDist(path.resolve(dist), 0, "/render/gallery/"),
    browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
            viewport: { width: 640, height: 360 },
          }),
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const url = new URL(server.url);
        url.searchParams.set("width", "640");
        url.searchParams.set("height", "360");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page, 30000, { production: true });
        assert.equal(
          await page.evaluate(() => typeof (window as any).__pelican),
          "undefined",
        );
        assert.equal(
          (await page.request.get(server.url + "__pelican/control")).status(),
          404,
        );
        await page.keyboard.press(" ");
        await page.keyboard.press("3");
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.pelicanMode === "path" &&
            document.documentElement.dataset.pelicanFrameState === "idle",
          undefined,
          { polling: 100, timeout: 30000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(
          await page.evaluate(
            () => document.documentElement.dataset.pelicanFailure ?? null,
          ),
          null,
        );
        await page.screenshot({
          path: path.join(output, "production-path.png"),
        });
        await page.keyboard.press("n");
        await page.keyboard.press("2");
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.pelicanMode === "hybrid" &&
            document.documentElement.dataset.pelicanFrameState === "idle",
          undefined,
          { polling: 100, timeout: 10000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(
          await page.evaluate(
            () => document.documentElement.dataset.pelicanFailure ?? null,
          ),
          null,
        );
        await page.screenshot({
          path: path.join(output, "production-hybrid.png"),
        });
        await page.keyboard.press("1");
        await page.waitForFunction(
          () => document.documentElement.dataset.pelicanMode === "raster",
          undefined,
          { polling: 100, timeout: 10000 },
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForEngine(page, 30000, { production: true });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.dataset.pelicanMode,
          ),
          "raster",
        );
        assert.deepEqual(errors, []);
        const report = {
          passed: true,
          base: "/render/gallery/",
          productionControlAbsent: true,
          controlRouteStatus: 404,
          actualKeyboardModeChanges: ["raster", "path", "hybrid", "raster"],
          reloadColdStart: true,
          errors,
          limitations: [
            "Static deployment and native-input mode switching proof only, not complete M3 acceptance or image-quality comparison.",
          ],
        };
        await writeFile(
          path.join(output, "static-integration.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      120000,
      "M3 independent static deployment",
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
