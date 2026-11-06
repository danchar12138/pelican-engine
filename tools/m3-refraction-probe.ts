import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

export const REFRACTION_SCENES = [
  "outside",
  "inside",
  "nested",
  "nested-inside",
  "optics",
  "rough-optics",
  "straight-optics",
  "small-optics",
  "translated-optics",
  "sphere-inside",
  "lit-clear",
  "lit-absorbing",
] as const;
export function linearAttenuation() {
  return [128, 192, 224].map((value) => ((value / 255 + 0.055) / 1.055) ** 2.4);
}
export function assertBeerSample(actual: readonly number[], distance: number) {
  assert.equal(actual.length, 3);
  assert.ok(Number.isFinite(distance) && distance >= 0);
  const expected = linearAttenuation().map((value) => value ** distance);
  actual.forEach((value, channel) => {
    assert.ok(Number.isFinite(value));
    assert.ok(
      Math.abs(value - expected[channel]) < 0.002,
      JSON.stringify({
        channel,
        actual: value,
        expected: expected[channel],
        distance,
      }),
    );
  });
  return expected;
}
export function refractionDifference(
  a: readonly number[],
  b: readonly number[],
  width: number,
  height: number,
) {
  assert.ok(
    Number.isSafeInteger(width) &&
      width > 0 &&
      Number.isSafeInteger(height) &&
      height > 0,
  );
  assert.equal(a.length, width * height * 4);
  assert.equal(b.length, a.length);
  let sum = 0,
    count = 0;
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.75); y++) {
    for (let x = Math.floor(width * 0.35); x < Math.ceil(width * 0.65); x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(
          Number.isFinite(a[offset + channel]) &&
            Number.isFinite(b[offset + channel]),
        );
        sum += Math.abs(a[offset + channel] - b[offset + channel]);
        count++;
      }
    }
  }
  return sum / count;
}

/** Actual image development evidence; never a release acceptance profile. */
export async function runM3RefractionProbe(
  url: string,
  output: string,
  options: { faultTarget?: number; faultSample?: number } = {},
) {
  await mkdir(output, { recursive: true });
  const width = 320,
    height = 180,
    cases: unknown[] = [],
    errors: string[] = [];
  const comparisons: unknown[] = [],
    recovery: unknown[] = [];
  const report = {
    formalMilestoneAccepted: false,
    scope: "closed-volume-refraction-development",
    viewport: [width, height],
    passed: false,
    cases,
    comparisons,
    recovery,
    errors,
    failure: null as string | null,
    activeCase: null as string | null,
  };
  const save = () =>
    writeFile(
      path.join(output, "refraction-transport.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(automationLaunchOptions());
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const target = new URL(url);
    target.searchParams.set("automation", "1");
    target.searchParams.set("width", String(width));
    target.searchParams.set("height", String(height));
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    await waitForEngine(page);
    for (const mode of ["path", "hybrid"] as const) {
      const images = new Map<string, number[]>();
      for (const scene of REFRACTION_SCENES) {
        report.activeCase = mode + "/" + scene;
        await withAutomationDeadline(
          async () => {
            await page.evaluate(
              async ({ scene, mode, options }) => {
                const api = (window as any).__pelican;
                await api.loadGame(scene);
                for (const command of [
                  { type: "step", count: 1 },
                  { type: "mode", mode },
                ]) {
                  const result = await api.command(command);
                  if (result.status !== "succeeded")
                    throw Error(JSON.stringify(result));
                }
                if (options.faultTarget !== undefined)
                  api.traceFaultTarget(
                    options.faultTarget,
                    options.faultSample ?? 0,
                  );
                await api.accumulate(32);
              },
              { scene, mode, options },
            );
            const result = await page.evaluate(async () => {
              const api = (window as any).__pelican;
              const stats = await api.pixels();
              const state = api.inspect();
              return {
                stats,
                state,
                primary:
                  state.mode === "hybrid" ? await api.primaryStats() : null,
                linear: Array.from(await api.linearPixels(false)) as number[],
              };
            });
            const filename = mode + "-" + scene;
            await writeFile(
              path.join(output, filename + ".f32"),
              Buffer.from(new Float32Array(result.linear).buffer),
            );
            await page.screenshot({
              path: path.join(output, filename + ".png"),
            });
            const center =
              (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
            const sample = result.linear.slice(center, center + 3);
            const medium = result.state.rendering.surface.volumeTransport;
            cases.push({
              mode,
              scene,
              backend: result.state.backend,
              adapter: result.state.adapter,
              stats: result.stats,
              primary: result.primary,
              medium,
              sample,
              files: [filename + ".f32", filename + ".png"],
            });
            await save();
            assert.equal(result.state.backend, "WebGPUBackend");
            assert.equal(result.stats.backend, "webgpu");
            assert.equal(result.state.adapter.isFallbackAdapter, false);
            assert.equal(result.state.mode, mode);
            assert.equal(result.linear.length, width * height * 4);
            assert.ok(result.linear.every(Number.isFinite));
            assert.equal(result.stats.finite, true);
            assert.ok(result.stats.nonBlack > (width * height) / 2);
            assert.ok(result.stats.samples >= 32);
            assert.equal(medium.faults, 0);
            const nested = scene === "nested" || scene === "nested-inside";
            assert.equal(medium.volumes, nested ? 2 : 1);
            const initial =
              scene === "nested-inside"
                ? 2
                : [
                      "inside",
                      "sphere-inside",
                      "lit-clear",
                      "lit-absorbing",
                    ].includes(scene)
                  ? 1
                  : 0;
            assert.equal(medium.initialMedia.length, initial);
            if (["outside", "inside", "nested-inside"].includes(scene))
              assertBeerSample(sample, 1);
            if (scene === "nested") assertBeerSample(sample, 2);
            images.set(scene, result.linear);
            assert.deepEqual(errors, []);
            console.log(
              JSON.stringify({
                probe: "refraction",
                mode,
                scene,
                samples: result.stats.samples,
                faults: medium.faults,
              }),
            );
          },
          120000,
          "Refraction " + mode + "/" + scene,
        );
      }
      const smooth = images.get("optics")!,
        straight = images.get("straight-optics")!,
        rough = images.get("rough-optics")!;
      const iorDifference = refractionDifference(
        smooth,
        straight,
        width,
        height,
      );
      const roughnessDifference = refractionDifference(
        smooth,
        rough,
        width,
        height,
      );
      const scaledMarkerDifference = refractionDifference(
        images.get("small-optics")!,
        straight,
        width,
        height,
      );
      const translatedMarkerDifference = refractionDifference(
        images.get("translated-optics")!,
        straight,
        width,
        height,
      );
      const center =
        (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      const ratio = [0, 1, 2].map(
        (channel) =>
          images.get("lit-absorbing")![center + channel] /
          images.get("lit-clear")![center + channel],
      );
      comparisons.push({
        mode,
        iorDifference,
        roughnessDifference,
        scaledMarkerDifference,
        translatedMarkerDifference,
        directRoundtripRatio: ratio,
      });
      await save();
      assert.ok(
        iorDifference > 0.03,
        "IOR must change actual marker transport: " + iorDifference,
      );
      assert.ok(
        roughnessDifference > 0.01,
        "Roughness must change actual marker transport: " + roughnessDifference,
      );
      assertBeerSample(ratio, 2);
      assert.ok(
        scaledMarkerDifference > 0.2,
        "Small sphere must retain actual refraction.",
      );
      assert.ok(
        translatedMarkerDifference > 0.2,
        "Translated sphere must retain actual refraction.",
      );
      await withAutomationDeadline(
        async () => {
          report.activeCase = mode + "/device-recovery";
          const before = await page.evaluate(() =>
            (window as any).__pelican.inspect(),
          );
          const after = await page.evaluate(
            async () => await (window as any).__pelican.exerciseDeviceLoss(),
          );
          await waitForEngine(page);
          assert.equal(after.tick, before.tick);
          assert.equal(after.mode, mode);
          assert.deepEqual(after.runtime.records, before.runtime.records);
          assert.equal(
            after.rendering.gpuRecovery.count,
            before.rendering.gpuRecovery.count + 1,
          );
          await page.evaluate(
            async () => await (window as any).__pelican.accumulate(32),
          );
          const result = await page.evaluate(async () => {
            const api = (window as any).__pelican;
            return {
              stats: await api.pixels(),
              state: api.inspect(),
              linear: Array.from(await api.linearPixels(false)) as number[],
            };
          });
          const recoveredRatio = [0, 1, 2].map(
            (channel) =>
              result.linear[center + channel] /
              images.get("lit-clear")![center + channel],
          );
          recovery.push({
            mode,
            tick: after.tick,
            recovery: after.rendering.gpuRecovery,
            stats: result.stats,
            medium: result.state.rendering.surface.volumeTransport,
            ratio: recoveredRatio,
          });
          await writeFile(
            path.join(output, mode + "-recovered.f32"),
            Buffer.from(new Float32Array(result.linear).buffer),
          );
          await page.screenshot({
            path: path.join(output, mode + "-recovered.png"),
          });
          await save();
          assert.equal(result.stats.finite, true);
          assert.equal(
            result.state.rendering.surface.volumeTransport.faults,
            0,
          );
          assert.equal(
            result.state.rendering.surface.volumeTransport.initialMedia.length,
            1,
          );
          assertBeerSample(recoveredRatio, 2);
          assert.deepEqual(errors, []);
        },
        120000,
        "Refractive medium device recovery " + mode,
      );
    }
    assert.deepEqual(errors, []);
    report.activeCase = null;
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    try {
      await save();
    } finally {
      await browser?.close();
    }
  }
}
