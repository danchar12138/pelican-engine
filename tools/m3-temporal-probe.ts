import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { temporalFilterReference } from "../packages/renderer/src/temporal-filter.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

export function compareTemporalPixels(
  actual: readonly number[],
  expected: ArrayLike<number>,
) {
  assert.equal(actual.length, expected.length);
  let maximum = 0,
    scaled = 0,
    worst = -1;
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Number.isFinite(actual[i]) && Number.isFinite(expected[i]),
      "Nonfinite temporal pixel " + i,
    );
    const difference = Math.abs(actual[i] - expected[i]);
    const normalized = difference / (2e-5 + 5e-5 * Math.abs(expected[i]));
    maximum = Math.max(maximum, difference);
    if (normalized > scaled) {
      scaled = normalized;
      worst = i;
    }
  }
  assert.ok(
    scaled <= 1,
    JSON.stringify({
      maximum,
      scaled,
      worst,
      actual: actual[worst],
      expected: expected[worst],
    }),
  );
  return { maximum, scaled, fields: actual.length };
}
export function temporalImageMse(
  input: readonly number[],
  reference: readonly number[],
) {
  assert.equal(input.length, reference.length);
  let error = 0,
    count = 0;
  for (let i = 0; i < input.length; i += 4)
    for (let c = 0; c < 3; c++) {
      assert.ok(
        Number.isFinite(input[i + c]) && Number.isFinite(reference[i + c]),
      );
      const a = Math.max(0, input[i + c]),
        b = Math.max(0, reference[i + c]);
      error += (a / (1 + a) - b / (1 + b)) ** 2;
      count++;
    }
  return error / count;
}
type Frame = {
  raw: number[];
  temporal: number[] | null;
  filtered: number[];
  motion: number[] | null;
  normal: number[];
  albedo: number[];
  stats: any;
  state: any;
};

/** Actual application motion sequences, numerical history parity and frozen-pose references. */
export async function runM3TemporalProbe(url: string, output: string) {
  await mkdir(output, { recursive: true });
  const width = 160,
    height = 90,
    cases: any[] = [],
    quality: any[] = [],
    errors: string[] = [];
  const report = {
    passed: false,
    backend: null as string | null,
    adapter: null as unknown,
    formalMilestoneAccepted: false,
    viewport: [width, height],
    cases,
    quality,
    errors,
    failure: null as string | null,
    activeCase: "boot",
  };
  const save = () =>
    writeFile(
      path.join(output, "temporal-integration.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  const pixels = async (name: string, data: ArrayLike<number>) => {
    const file = name + ".f32.gz";
    await writeFile(
      path.join(output, file),
      gzipSync(Buffer.from(new Float32Array(data).buffer)),
    );
    return file;
  };
  const browser = await chromium.launch(automationLaunchOptions());
  try {
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
    const command = async (value: any) => {
      const result = await page.evaluate(
        async (value) => await (window as any).__pelican.command(value),
        value,
      );
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      return result.data;
    };
    const tap = async (key: string) => {
      await command({ type: "input", key, pressed: true });
      await command({ type: "input", key, pressed: false });
      await command({ type: "step", count: 1 });
    };
    for (const mode of ["path", "hybrid"] as const)
      await withAutomationDeadline(
        async () => {
          await page.evaluate(
            async () => await (window as any).__pelican.loadGame("temporal"),
          );
          await command({ type: "mode", mode });
          await command({ type: "step", count: 1 });
          let previous: Frame | undefined,
            previousLabel: string | null = null;
          const capture = async (
            label: string,
            expect: {
              reuse?: boolean;
              reset?: boolean;
              progressive?: boolean;
              disocclusion?: boolean;
              missing?: boolean;
              enabled?: boolean;
            } = {},
          ) => {
            report.activeCase = mode + "/" + label;
            const frame: Frame = await page.evaluate(async () => {
              const api = (window as any).__pelican,
                state = api.inspect(),
                surface = state.rendering.surface;
              const guides = await api.guidePixels(),
                enabled = state.rendering.settings.denoise;
              return {
                raw: Array.from(await api.linearPixels(false)),
                temporal: enabled
                  ? Array.from(await api.temporalPixels())
                  : null,
                filtered: Array.from(await api.linearPixels(true)),
                motion: surface.motion.lastComputed
                  ? Array.from(await api.motionPixels())
                  : null,
                normal: Array.from(guides.normalDepth),
                albedo: Array.from(guides.albedoRoughness),
                stats: await api.pixels(),
                state: {
                  backend: state.backend,
                  adapter: state.adapter,
                  mode: state.mode,
                  tick: state.tick,
                  camera: state.objects.camera,
                  settings: state.rendering.settings,
                  surface,
                  recovery: state.rendering.gpuRecovery,
                  records: state.runtime.records,
                  animation: state.gameplay.models,
                },
              };
            });
            const prefix = mode + "-" + label,
              files: any = {};
            report.backend = frame.state.backend;
            report.adapter = frame.state.adapter;
            for (const key of [
              "raw",
              "temporal",
              "filtered",
              "motion",
              "normal",
              "albedo",
            ] as const)
              if (frame[key])
                files[key] = await pixels(prefix + "-" + key, frame[key]!);
            await page.screenshot({ path: path.join(output, prefix + ".png") });
            files.screenshot = prefix + ".png";
            const temporal = frame.state.surface.temporal;
            let reused = 0,
              missingHits = 0,
              depthRejected = 0,
              maximumWeight = 0;
            for (let i = 0; i < frame.raw.length; i += 4) {
              assert.ok(frame.raw.slice(i, i + 4).every(Number.isFinite));
              if (frame.temporal) {
                maximumWeight = Math.max(maximumWeight, frame.temporal[i + 3]);
                if (frame.temporal[i + 3] > frame.raw[i + 3] + 0.01) reused++;
                if (
                  frame.motion &&
                  frame.motion[i + 3] === 0 &&
                  frame.normal[i + 3] >= 0
                ) {
                  missingHits++;
                  assert.equal(frame.temporal[i + 3], frame.raw[i + 3]);
                }
                if (
                  previous &&
                  frame.motion &&
                  frame.motion[i + 3] > 0 &&
                  frame.normal[i + 3] >= 0
                ) {
                  const u = frame.motion[i],
                    v = frame.motion[i + 1],
                    depth = frame.motion[i + 2];
                  if (u >= 0 && v >= 0 && u < 1 && v < 1) {
                    const px = u * width - 0.5,
                      py = v * height - 0.5,
                      bx = Math.floor(px),
                      by = Math.floor(py),
                      fx = px - bx,
                      fy = py - by;
                    let support = 0,
                      allFail = true;
                    for (let y = 0; y < 2; y++)
                      for (let x = 0; x < 2; x++) {
                        const qx = bx + x,
                          qy = by + y,
                          w = (x ? fx : 1 - fx) * (y ? fy : 1 - fy);
                        if (
                          qx < 0 ||
                          qy < 0 ||
                          qx >= width ||
                          qy >= height ||
                          w < 1e-7
                        )
                          continue;
                        support += w;
                        const old = previous.normal[(qy * width + qx) * 4 + 3];
                        if (
                          old >= 0 &&
                          Math.abs(old - depth) <= 0.002 + 0.02 * depth
                        )
                          allFail = false;
                      }
                    if (support > 0.01 && allFail) {
                      depthRejected++;
                      assert.equal(frame.temporal[i + 3], frame.raw[i + 3]);
                    }
                  }
                }
              }
            }
            const entry: any = {
              mode,
              backend: frame.state.backend,
              adapter: frame.state.adapter,
              label,
              tick: frame.state.tick,
              samples: frame.stats.samples,
              previousLabel,
              reused,
              missingHits,
              depthRejected,
              maximumWeight,
              motion: frame.state.surface.motion,
              temporal,
              files,
              camera: frame.state.camera,
            };
            cases.push(entry);
            await save();
            assert.equal(frame.state.mode, mode);
            assert.equal(frame.state.backend, "WebGPUBackend");
            assert.equal(frame.state.adapter.isFallbackAdapter, false);
            assert.equal(frame.stats.finite, true);
            assert.equal(frame.raw.length, width * height * 4);
            assert.equal(frame.state.surface.mediumFaults, 0);
            if (
              frame.temporal &&
              (previous?.temporal ||
                temporal.lastReset ||
                temporal.lastProgressive)
            ) {
              const expected = temporalFilterReference({
                width,
                height,
                inputRadiance: frame.raw,
                normalDepth: frame.normal,
                albedoRoughness: frame.albedo,
                reprojection:
                  frame.motion ?? new Float32Array(frame.raw.length),
                previousRadiance: previous?.temporal ?? undefined,
                previousNormalDepth: previous?.normal,
                previousAlbedoRoughness: previous?.albedo,
                reset: temporal.lastReset,
                progressive: temporal.lastProgressive,
              });
              entry.reference = await pixels(
                prefix + "-cpu-reference",
                expected,
              );
              entry.numeric = compareTemporalPixels(frame.temporal, expected);
            }
            if (expect.reuse) {
              assert.equal(temporal.lastReset, false);
              assert.equal(temporal.lastProgressive, false);
              assert.ok(reused > 100, JSON.stringify(entry));
            }
            if (expect.reset) {
              assert.equal(temporal.lastReset, true);
              assert.deepEqual(frame.temporal, frame.raw);
            }
            if (expect.progressive) {
              assert.equal(temporal.lastProgressive, true);
              assert.deepEqual(frame.temporal, frame.raw);
            }
            if (expect.disocclusion) {
              assert.equal(temporal.lastReset, false);
              assert.ok(depthRejected > 10, JSON.stringify(entry));
            }
            if (expect.missing) {
              assert.ok(frame.state.surface.motion.missing > 0);
              assert.ok(missingHits > 10, JSON.stringify(entry));
            }
            if (expect.enabled === false) {
              assert.equal(frame.temporal, null);
              assert.equal(temporal.lastPasses, 0);
              assert.equal(temporal.historyValid, false);
              assert.deepEqual(frame.filtered, frame.raw);
            }
            assert.deepEqual(errors, []);
            previous = frame.temporal ? frame : undefined;
            previousLabel = frame.temporal ? label : null;
            console.log(
              JSON.stringify({
                probe: "temporal",
                mode,
                label,
                reused,
                depthRejected,
                reset: temporal.lastReset,
                progressive: temporal.lastProgressive,
                numeric: entry.numeric?.scaled,
              }),
            );
            await save();
            return frame;
          };
          await capture("initialized");
          await page.evaluate(
            async () => await (window as any).__pelican.accumulate(1),
          );
          await capture("static-progressive", { progressive: true });
          await tap("o");
          await capture("rigid-0", { reuse: true });
          for (let i = 1; i <= 3; i++) {
            await command({ type: "step", count: 1 });
            await capture("rigid-" + i, { reuse: true });
          }
          await tap("c");
          await capture("camera-0", { reuse: true });
          for (let i = 1; i <= 2; i++) {
            await command({ type: "step", count: 1 });
            await capture("camera-" + i, { reuse: true });
          }
          await tap("a");
          await capture("skin-0", { reuse: true });
          for (let i = 1; i <= 2; i++) {
            await command({ type: "step", count: 1 });
            await capture("skin-" + i, { reuse: true });
          }
          await tap("q");
          await capture("spp2-reset", { reset: true });
          await command({ type: "step", count: 1 });
          const two = await capture("independent-spp2", { reuse: true });
          assert.equal(two.raw[3], 2);
          await tap("f");
          await capture("stop");
          await command({ type: "step", count: 1 });
          await capture("static-spp2", { progressive: true });
          await tap("q");
          await capture("spp1-reset", { reset: true });
          await tap("b");
          await capture("disocclusion", { disocclusion: true });
          await tap("b");
          await capture("spawn", { missing: true });
          await tap("m");
          await capture("material-replacement", { missing: true });
          await tap("l");
          await capture("light-reset", { reset: true });
          await tap("n");
          await capture("disabled", { enabled: false });
          await tap("n");
          await capture("reenabled", { reset: true });
          const checkpoint = await command({ type: "snapshot" });
          await tap("o");
          await capture("before-restore", { reuse: true });
          const restored = await command({
            type: "restore",
            snapshot: checkpoint,
          });
          assert.equal(restored.tick, checkpoint.tick);
          previous = undefined;
          previousLabel = null;
          await capture("restored", { reset: true });
          const before = await command({ type: "inspect" });
          const recovered = await page.evaluate(
            async () => await (window as any).__pelican.exerciseDeviceLoss(),
          );
          await waitForEngine(page);
          assert.equal(recovered.tick, before.tick);
          assert.deepEqual(recovered.runtime.records, before.runtime.records);
          previous = undefined;
          previousLabel = null;
          await capture("recovered", { reset: true });
          await command({ type: "mode", mode: "raster" });
          const raster = await page.evaluate(
            async () => await (window as any).__pelican.pixels(),
          );
          assert.equal(raster.available, false);
          await command({ type: "mode", mode });
          previous = undefined;
          previousLabel = null;
          await capture("mode-return", { reset: true });
          await tap("c");
          await capture("quality-0", { reuse: true });
          let low: Frame | undefined;
          for (let i = 1; i <= 7; i++) {
            await command({ type: "step", count: 1 });
            low = await capture("quality-" + i, { reuse: true });
          }
          await page.evaluate(
            async () => await (window as any).__pelican.accumulate(255),
          );
          const reference = await page.evaluate(
            async () =>
              Array.from(
                await (window as any).__pelican.linearPixels(false),
              ) as number[],
          );
          assert.equal(reference[3], 256);
          const measurement = {
            mode,
            rawMse: temporalImageMse(low!.raw, reference),
            temporalMse: temporalImageMse(low!.temporal!, reference),
            filteredMse: temporalImageMse(low!.filtered, reference),
            reference: await pixels(mode + "-reference-256", reference),
          };
          quality.push(measurement);
          await save();
          assert.ok(
            measurement.temporalMse < measurement.rawMse,
            JSON.stringify(measurement),
          );
          assert.ok(
            measurement.filteredMse < measurement.rawMse,
            JSON.stringify(measurement),
          );
          await page.screenshot({
            path: path.join(output, mode + "-reference-256.png"),
          });
        },
        120000,
        "Actual temporal sequence " + mode,
      );
    assert.deepEqual(errors, []);
    report.activeCase = "complete";
    report.passed = true;
    return report;
  } catch (error) {
    report.failure = String(error);
    throw error;
  } finally {
    try {
      await save();
    } finally {
      await browser.close();
    }
  }
}
