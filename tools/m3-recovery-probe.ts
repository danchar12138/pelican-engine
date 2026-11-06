import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { decode } from "fast-png";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
export async function runM3RecoveryProbe(url: string, output: string) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
            viewport: { width: 640, height: 360 },
          }),
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        const target = new URL(url);
        target.searchParams.set("automation", "1");
        target.searchParams.set("width", "640");
        target.searchParams.set("height", "360");
        await page.goto(target.href);
        await waitForEngine(page);
        const command = async (v: any) => {
          const r = await page.evaluate(
            async (v) => (window as any).__pelican.command(v),
            v,
          );
          assert.equal(r.status, "succeeded", JSON.stringify(r));
          return r.data;
        };
        await command({ type: "step", count: 3 });
        await command({ type: "mode", mode: "path" });
        const before = await command({ type: "inspect" });
        const after = await page.evaluate(
          async () => await (window as any).__pelican.exerciseDeviceLoss(),
        );
        assert.equal(after.tick, before.tick);
        assert.equal(after.mode, "path");
        assert.deepEqual(after.runtime.records, before.runtime.records);
        assert.equal(after.rendering.gpuRecovery.count, 1);
        await waitForEngine(page);
        await page.evaluate(
          async () => await (window as any).__pelican.accumulate(8),
        );
        const pixels = await page.evaluate(
          async () => await (window as any).__pelican.pixels(),
        );
        assert.equal(pixels.finite, true);
        assert.ok(pixels.nonBlack > 10000);
        const captureBefore = await command({ type: "inspect" });
        const png = await page.locator("canvas:visible").first().screenshot({ path: path.join(output, "recovered-path.png") });
        const captureAfter = await command({ type: "inspect" });
        const image = decode(png);
        assert.equal(image.depth, 8);
        assert.ok(image.channels >= 3);
        let nonBlack = 0;
        const colors = new Set<number>();
        for (let i = 0; i < image.width * image.height; i += 4) {
          const p = i * image.channels, d = image.data;
          if (d[p] + d[p + 1] + d[p + 2] > 12) nonBlack++;
          colors.add((d[p] >> 3) * 1024 + (d[p + 1] >> 3) * 32 + (d[p + 2] >> 3));
        }
        const capture = { before: captureBefore, after: captureAfter, pixels: { width: image.width, height: image.height, colors: colors.size, nonBlack } };
        const repetitions = [];
        for (const mode of ["hybrid", "raster"] as const) {
          await command({ type: "mode", mode });
          const previous = await command({ type: "inspect" });
          const result = await page.evaluate(
            async () => await (window as any).__pelican.exerciseDeviceLoss(),
          );
          assert.equal(result.mode, mode);
          assert.equal(result.tick, previous.tick);
          assert.deepEqual(result.runtime.records, previous.runtime.records);
          repetitions.push({ mode, before: previous, after: result, recovery: result.rendering.gpuRecovery });
        }
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(output, "recovery.json"),
          JSON.stringify(
            {
              passed: true,
              before: {
                tick: before.tick,
                mode: before.mode,
                records: before.runtime.records,
              },
              after: {
                tick: after.tick,
                mode: after.mode,
                records: after.runtime.records,
                recovery: after.rendering.gpuRecovery,
              },
              pixels,
              pathRecovery: { before, after },
              capture,
              repetitions,
              errors,
            },
            null,
            2,
          ),
        );
        return {
          passed: true,
          tick: after.tick,
          recovery: after.rendering.gpuRecovery,
          pixels,
          repetitions,
          errors,
        };
      },
      120000,
      "M3 GPU device loss and reconstruction",
    );
  } finally {
    await browser.close();
  }
}
