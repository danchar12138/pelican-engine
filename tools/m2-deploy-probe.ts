import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { serveDist } from "./static-server.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
import { verifyUnattended } from "./verify-unattended.ts";
export async function runM2Deployment(dist: string, output: string) {
  await mkdir(output, { recursive: true });
  const server = await serveDist(path.resolve(dist), 0, "/games/m2/");
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
            viewport: { width: 960, height: 540 },
          }),
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        await page.goto(server.url, { waitUntil: "domcontentloaded" });
        await waitForEngine(page, 30000, { production: true });
        const hooks = await page.evaluate(() => ({
          control: typeof (window as any).__pelican,
          failure: typeof (window as any).__pelicanFailure,
        }));
        assert.equal(hooks.control, "undefined");
        assert.equal(hooks.failure, "undefined");
        const compressed = await page.request.get(
          server.url + "generated/game.js",
          { headers: { "accept-encoding": "br, gzip" } },
        );
        assert.equal(compressed.status(), 200);
        assert.equal(compressed.headers()["content-encoding"], "br");
        assert.equal(
          (await page.request.get(server.url + "__pelican/control")).status(),
          404,
        );
        await page.keyboard.down("w");
        await new Promise((r) => setTimeout(r, 1100));
        await page.keyboard.up("w");
        await page.keyboard.press("e");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-pelican-element="score"]')
              ?.textContent?.includes("Relics 1 / 3"),
          undefined,
          { polling: 100, timeout: 10000 },
        );
        await page.keyboard.press("F5");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-pelican-element="hint"]')
              ?.textContent?.includes("saved"),
          undefined,
          { polling: 100, timeout: 10000 },
        );
        await page.screenshot({ path: path.join(output, "dist.png") });
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForEngine(page, 30000, { production: true });
        await page.keyboard.press("F9");
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-pelican-element="hint"]')
              ?.textContent?.includes("loaded"),
          undefined,
          { polling: 100, timeout: 10000 },
        );
        const score = await page
          .locator('[data-pelican-element="score"]')
          .textContent();
        assert.ok(score!.includes("Relics 1 / 3"));
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(output, "deploy.json"),
          JSON.stringify(
            { passed: true, base: "/games/m2/", hooks, score, errors },
            null,
            2,
          ),
        );
        return { passed: true, base: "/games/m2/", hooks, score, errors };
      },
      120000,
      "M2 production keyboard/cold-load",
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
