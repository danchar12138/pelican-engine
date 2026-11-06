import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

/** End-to-end development evidence. Not an M3 release verifier. */
export async function runM3ImageProbe(url: string, output: string) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions()),
    errors: string[] = [];
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
          viewport: { width: 640, height: 360 },
        });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const target = new URL(url);
        target.searchParams.set("automation", "1");
        target.searchParams.set("width", "640");
        target.searchParams.set("height", "360");
        await page.goto(target.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const command = async (value: unknown) => {
          const result = await page.evaluate(
            async (value) => (window as any).__pelican.command(value),
            value,
          );
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          return result.data;
        };
        const inspect = () => command({ type: "inspect" });
        const tap = async (key: string) => {
          await command({ type: "input", key, pressed: true });
          await command({ type: "input", key, pressed: false });
          return command({ type: "step", count: 1 });
        };
        await page.screenshot({ path: path.join(output, "raster.png") });
        await command({ type: "mode", mode: "path" });
        const read = async () =>
          await page.evaluate(async () => ({
            pixels: await (window as any).__pelican.pixels(),
            timing: await (window as any).__pelican.gpuTimeMs(),
          }));
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(15),
        );
        const raw = await read();
        assert.equal(raw.pixels.finite, true);
        assert.ok(raw.pixels.nonBlack > 10000);
        await page.screenshot({ path: path.join(output, "path-16.png") });
        const staticBefore = await inspect();
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(2),
        );
        const staticAfter = await inspect();
        assert.ok(
          staticAfter.rendering.surface.samples >
            staticBefore.rendering.surface.samples,
        );
        assert.equal(
          staticAfter.rendering.surface.historyResets,
          staticBefore.rendering.surface.historyResets,
        );
        await tap("n");
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(15),
        );
        const filtered = await read();
        await page.screenshot({ path: path.join(output, "denoised-16.png") });
        const before = await inspect();
        assert.ok(before.rendering.surface.denoiser.passes > 0);
        await command({ type: "step", count: 1 });
        const moved = await inspect();
        assert.equal(
          moved.rendering.surface.acceleration.changes.kind,
          "refit",
        );
        assert.equal(moved.rendering.surface.samples, 1);
        assert.ok(
          moved.rendering.surface.historyResets >
            before.rendering.surface.historyResets,
        );
        await tap(" ");
        const checkpoint = await command({ type: "snapshot" });
        await command({ type: "mode", mode: "hybrid" });
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(8),
        );
        const hybrid = await read();
        assert.equal(hybrid.pixels.finite, true);
        await page.screenshot({
          path: path.join(output, "hybrid-denoised.png"),
        });
        await command({ type: "mode", mode: "raster" });
        const restored = await command({
          type: "restore",
          snapshot: checkpoint,
        });
        assert.equal(restored.mode, "path");
        await page.screenshot({ path: path.join(output, "restored-path.png") });
        await tap("d");
        await tap("i");
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(8),
        );
        const lightDisabled = await read();
        await page.screenshot({
          path: path.join(output, "lights-disabled.png"),
        });
        assert.ok(
          lightDisabled.pixels.meanLuminance < raw.pixels.meanLuminance * 0.6,
          JSON.stringify({
            before: raw.pixels.meanLuminance,
            after: lightDisabled.pixels.meanLuminance,
          }),
        );
        const repaired = await command({
          type: "restore",
          snapshot: checkpoint,
        });
        assert.equal(repaired.rendering.settings.directLighting, true);
        assert.equal(repaired.rendering.settings.indirectLighting, true);
        assert.deepEqual(errors, []);
        const report = {
          passed: true,
          backend: restored.backend,
          adapter: restored.adapter,
          viewport: [640, 360],
          raw,
          filtered,
          staticHistory: {
            before: staticBefore.rendering.surface.samples,
            after: staticAfter.rendering.surface.samples,
            resets: staticAfter.rendering.surface.historyResets,
          },
          moved: {
            samples: moved.rendering.surface.samples,
            changes: moved.rendering.surface.acceleration.changes,
            historyResets: moved.rendering.surface.historyResets,
          },
          hybrid,
          restored: restored.rendering,
          lightDisabled,
          repaired: repaired.rendering,
          errors,
          limitations: [
            "Development image evidence, not full M3 acceptance.",
            "Opaque BRDF and captured HDR environments are integrated. Transmission, temporal motion reconstruction and broader device-loss fault coverage remain work in progress.",
            "Measured viewport/load only; no native 1080p or universal throughput claim.",
          ],
        };
        await writeFile(
          path.join(output, "image-integration.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      120000,
      "M3 image integration/history/light causality",
    );
  } finally {
    await browser.close();
  }
}
