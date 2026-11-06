import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

/** Raw timing observations for this exact small scene, never a universal graphics-quality verdict. */
export async function runM2Performance(url: string, output: string) {
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
          viewport: { width: 1920, height: 1080 },
          deviceScaleFactor: 1,
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const target = new URL(url);
        target.searchParams.delete("automation");
        target.searchParams.set("width", "1920");
        target.searchParams.set("height", "1080");
        const start = performance.now();
        await page.goto(target.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const startupWallMs = performance.now() - start;
        const frameIntervals = await page.evaluate<number[]>(
          "new Promise((resolve) => {let previous;const samples=[];function sample(now){if(previous!==undefined)samples.push(now-previous);previous=now;if(samples.length>=180)resolve(samples);else requestAnimationFrame(sample);}requestAnimationFrame(sample);})",
        );
        const state = await page.evaluate(() =>
          (window as any).__pelican.inspect(),
        );
        assert.equal(state.backend, "WebGPUBackend");
        assert.equal(state.adapter.isFallbackAdapter, false);
        assert.ok(state.tick > 60);
        assert.deepEqual(errors, []);
        const percentile = (values: number[], p: number) => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted[Math.floor((sorted.length - 1) * p)];
        };
        const draws = state.metrics
          .slice(20)
          .map((metric: any) => metric.wallMs) as number[];
        const simulation = state.metrics
          .slice(20)
          .map((metric: any) => metric.simulationMs) as number[];
        const report = {
          passed: true,
          load: {
            scene: "m2-fox-journey/courtyard",
            viewport: [1920, 1080],
            devicePixelRatio: 1,
            mode: state.mode,
            triangles: state.triangleCount,
            models: state.gameplay.models.instances,
            shadowMap: 2048,
          },
          backend: state.backend,
          adapter: state.adapter,
          startupWallMs,
          frameIntervals,
          drawCpuMs: draws,
          simulationCpuMs: simulation,
          summary: {
            rafIntervalP50: percentile(frameIntervals, 0.5),
            rafIntervalP95: percentile(frameIntervals, 0.95),
            drawCpuP50: percentile(draws, 0.5),
            drawCpuP95: percentile(draws, 0.95),
            simulationCpuP95: percentile(simulation, 0.95),
          },
          gpuTimestampMs: null,
          gpuTimestampReason:
            "No GPU timestamp readback in this M2 raster adapter; RAF intervals are presentation observations, not GPU execution durations.",
          errors,
          limitations: [
            "Small fixed scene, no movement input, no universal throughput or graphics-quality claim.",
            "Timings include the recorded desktop/browser and may be affected by other workloads.",
            "Long-session memory and operation-history checkpoint costs remain M7 optimization work.",
          ],
        };
        await page.screenshot({ path: path.join(output, "native-1080p.png") });
        await writeFile(
          path.join(output, "performance.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      60000,
      "M2 native 1080p timing observation",
    );
  } finally {
    await browser.close();
  }
}
