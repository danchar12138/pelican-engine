import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
/** Exact native-1080p samples. Slow modes remain slow observations, never hidden by downscaling. */
export async function runM3PerformanceProbe(
  url: string,
  output: string,
  options: { denoise?: boolean } = {},
) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
          }),
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const target = new URL(url);
        target.searchParams.set("automation", "1");
        target.searchParams.set("width", "1920");
        target.searchParams.set("height", "1080");
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
        const initial = await command({ type: "inspect" });
        if (
          options.denoise !== undefined &&
          initial.rendering.settings.denoise !== options.denoise
        ) {
          await command({ type: "input", key: "n", pressed: true });
          await command({ type: "input", key: "n", pressed: false });
          const configured = await command({ type: "step", count: 1 });
          assert.equal(configured.rendering.settings.denoise, options.denoise);
        }
        assert.equal(initial.width, 1920);
        assert.equal(initial.height, 1080);
        const pixelRatio = await page.evaluate(() => devicePixelRatio);
        assert.ok(Math.abs(pixelRatio - 1) < 1e-6);
        const canvas = await page
          .locator("canvas")
          .first()
          .evaluate((canvas) => ({
            width: (canvas as HTMLCanvasElement).width,
            height: (canvas as HTMLCanvasElement).height,
          }));
        assert.deepEqual(canvas, { width: 1920, height: 1080 });
        const modes = [];
        for (const mode of ["raster", "path", "hybrid"] as const) {
          const start = performance.now();
          await command({ type: "mode", mode });
          const firstWallMs = performance.now() - start;
          const samples = [];
          for (let sample = 0; sample < 8; sample++) {
            const started = performance.now();
            const state = await command({ type: "step", count: 1 });
            const wallMs = performance.now() - started;
            const gpu =
              mode === "raster"
                ? null
                : await page.evaluate(
                    async () => await (window as any).__pelican.gpuTimeMs(),
                  );
            const frame = state.rendering.surface;
            samples.push({
              wallMs,
              gpu,
              captureMs: frame?.captureMs ?? null,
              uploadMs: frame?.uploadMs ?? null,
              uploadBytes: frame?.uploadBytes ?? null,
              refitKind: frame?.acceleration.changes.kind ?? null,
              frameMetrics: state.metrics.at(-1),
              ownedBytes: frame?.ownedBytes ?? null,
              temporalBytes: frame?.temporal?.bytes ?? null,
              spatialBytes: frame?.denoiser?.bytes ?? null,
              motionPasses: frame?.motion?.passes ?? null,
              temporalPasses: frame?.temporal?.passes ?? null,
            });
          }
          await page.screenshot({
            path: path.join(output, "native-1080p-" + mode + ".png"),
          });
          const primary =
            mode === "hybrid"
              ? await page.evaluate(
                  async () => await (window as any).__pelican.primaryStats(),
                )
              : null;
          modes.push({ mode, firstWallMs, samples, primary });
        }
        const last = await command({ type: "inspect" });
        assert.deepEqual(errors, []);
        const report = {
          passed: true,
          backend: initial.backend,
          adapter: initial.adapter,
          viewport: [1920, 1080],
          devicePixelRatio: pixelRatio,
          scene: "m3-surface-gallery",
          renderSettings: last.rendering.settings,
          triangles: last.triangleCount,
          modes,
          errors,
          limitations: [
            "Fixed recorded adapter and gallery content; this is raw native-size timing evidence, not universal throughput or complete M3 acceptance.",
            "Automation step wall time includes protocol, inspection and explicit GPU queue completion; it is not interchangeable with GPU execution time.",
            "Raster GPU timestamps are not integrated into this observation and remain null. Path/hybrid use actual timestamp-query when enabled.",
            "Frame timing includes intervening motion/temporal/spatial work when enabled; transportMs covers only the light-transport compute pass. Filter buffer bytes are separate from ownedBytes.",
          ],
        };
        await writeFile(
          path.join(output, "performance-1080p.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      120000,
      "M3 native 1080p exact-load timing samples",
    );
  } finally {
    await browser.close();
  }
}
