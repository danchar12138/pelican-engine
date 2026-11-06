import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

export function linearImageDifference(
  a: readonly number[],
  b: readonly number[],
) {
  assert.ok(a.length > 0 && a.length % 4 === 0);
  assert.equal(b.length, a.length);
  let squared = 0,
    absolute = 0,
    total = 0,
    maximum = 0,
    fields = 0;
  for (let pixel = 0; pixel < a.length; pixel += 4) {
    assert.ok(Number.isFinite(a[pixel + 3]) && a[pixel + 3] >= 1);
    assert.equal(a[pixel + 3], b[pixel + 3], "Accumulation counts must match.");
    for (let channel = 0; channel < 3; channel++) {
      const x = a[pixel + channel],
        y = b[pixel + channel];
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0);
      const difference = Math.abs(x - y);
      absolute += difference;
      total += Math.abs(x);
      maximum = Math.max(maximum, difference);
      squared += (x / (1 + x) - y / (1 + y)) ** 2;
      fields++;
    }
  }
  return {
    maximumAbsolute: maximum,
    meanAbsolute: absolute / fields,
    relativeL1: absolute / Math.max(total, 1e-30),
    reinhardRmse: Math.sqrt(squared / fields),
    fields,
  };
}

/** Same seeded public scene, raw linear image parity across two executable sources. */
export async function runM3ParityProbe(
  baselineURL: string,
  candidateURL: string,
  output: string,
) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions());
  const captures: {
    side: string;
    mode: string;
    settings: unknown;
    samples: number;
    triangles: number;
    adapter: unknown;
  }[] = [];
  const images = new Map<string, number[]>(),
    errors: string[] = [];
  const report = {
    formalMilestoneAccepted: false,
    passed: false,
    viewport: [320, 180],
    captures,
    comparisons: [] as unknown[],
    errors,
    failure: null as string | null,
  };
  try {
    for (const [side, url] of [
      ["baseline", baselineURL],
      ["candidate", candidateURL],
    ]) {
      await withAutomationDeadline(
        async () => {
          const page = await browser.newPage({
            viewport: { width: 320, height: 180 },
          });
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          try {
            const target = new URL(url);
            target.searchParams.set("automation", "1");
            target.searchParams.set("width", "320");
            target.searchParams.set("height", "180");
            await page.goto(target.href, { waitUntil: "domcontentloaded" });
            await waitForEngine(page);
            for (const mode of ["path", "hybrid"]) {
              await page.evaluate(async (mode) => {
                const api = (window as any).__pelican;
                const result = await api.command({ type: "mode", mode });
                if (result.status !== "succeeded")
                  throw Error(JSON.stringify(result));
                await api.accumulate(63);
              }, mode);
              const result = await page.evaluate(async () => {
                const api = (window as any).__pelican;
                return {
                  stats: await api.pixels(),
                  state: api.inspect(),
                  linear: Array.from(await api.linearPixels(false)) as number[],
                };
              });
              assert.equal(result.state.backend, "WebGPUBackend");
              assert.equal(result.state.adapter.isFallbackAdapter, false);
              assert.equal(result.state.width, 320);
              assert.equal(result.state.height, 180);
              assert.equal(result.state.triangleCount, 5494);
              assert.equal(result.linear.length, 320 * 180 * 4);
              assert.ok(result.stats.finite && result.stats.samples >= 64);
              const key = side + "-" + mode;
              images.set(key, result.linear);
              captures.push({
                side,
                mode,
                settings: result.state.rendering.settings,
                samples: result.stats.samples,
                triangles: result.state.triangleCount,
                adapter: result.state.adapter,
              });
              await writeFile(
                path.join(output, key + ".f32"),
                Buffer.from(new Float32Array(result.linear).buffer),
              );
              await page.screenshot({ path: path.join(output, key + ".png") });
            }
          } finally {
            await page.close();
          }
        },
        120000,
        "Linear image parity " + side,
      );
    }
    for (const mode of ["path", "hybrid"]) {
      const pair = captures.filter((capture) => capture.mode === mode);
      assert.deepEqual(pair[0].settings, pair[1].settings);
      const difference = linearImageDifference(
        images.get("baseline-" + mode)!,
        images.get("candidate-" + mode)!,
      );
      report.comparisons.push({ mode, ...difference });
      assert.ok(
        difference.reinhardRmse < 0.002,
        JSON.stringify({ mode, ...difference }),
      );
    }
    assert.deepEqual(errors, []);
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    try {
      await writeFile(
        path.join(output, "parity.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
    } finally {
      await browser.close();
    }
  }
}
