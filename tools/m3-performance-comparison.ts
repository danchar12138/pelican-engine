import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runM3PerformanceProbe } from "./m3-performance-probe.ts";

/** Summaries describe observed GPU values only; unknown samples are never wall timings. */
export function summarizeGpu(samples: unknown) {
  const raw: unknown[] = Array.isArray(samples) ? samples : [samples];
  const values = raw
    .filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
    )
    .sort((a, b) => a - b);
  const count = values.length;
  return {
    count,
    unknownCount: raw.length - count,
    min: count ? values[0] : null,
    max: count ? values[count - 1] : null,
    mean: count ? values.reduce((sum, v) => sum + v / count, 0) : null,
    median: count
      ? values[Math.floor((count - 1) / 2)] / 2 +
        values[Math.floor(count / 2)] / 2
      : null,
    p95: count ? values[Math.ceil(count * 0.95) - 1] : null,
  };
}

type ProbeReport = Awaited<ReturnType<typeof runM3PerformanceProbe>>;
type Side = "baseline" | "candidate";
const modes = ["path", "hybrid"] as const;
const metrics = ["frameMs", "transportMs"] as const;
function gpuSamples(
  report: ProbeReport,
  mode: string,
  metric: (typeof metrics)[number],
) {
  const entry = report.modes.find((entry) => entry.mode === mode);
  assert.ok(entry?.samples.length, "Missing GPU samples for " + mode);
  return entry.samples.map(({ gpu }) => {
    if (gpu == null) return null;
    assert.equal(
      gpu.source,
      "timestamp-query",
      "GPU timings must be actual timestamps",
    );
    return gpu[metric];
  });
}

export async function runM3PerformanceComparison(
  baselineURL: string,
  candidateURL: string,
  output: string,
  identities: { baseline: string; candidate: string },
) {
  const order: Side[] = ["baseline", "candidate", "candidate", "baseline"];
  const runs: {
    index: number;
    side: Side;
    directory: string;
    report: ProbeReport;
    distributions?: unknown;
  }[] = [];
  const result = {
    developmentOnly: true,
    formalMilestoneAccepted: false,
    passed: false,
    identities,
    urls: { baseline: baselineURL, candidate: candidateURL },
    order,
    runs,
    comparisons: [] as unknown[],
    failure: null as null | {
      index: number;
      side: Side;
      directory: string;
      message: string;
      stack?: string;
    },
    limitations: [
      "Development evidence for these source identities, adapter and workload only; no universal performance claim.",
      "GPU timestamp-query samples only; missing/invalid timings remain unknown, never replaced with wall time.",
      "Ratios are candidate/baseline pooled medians; unavailable or incomplete timings and zero denominators yield null.",
    ],
  };
  await mkdir(output, { recursive: true });
  const persist = () =>
    writeFile(
      path.join(output, "performance-comparison.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  let index = 0;
  try {
    assert.ok(
      identities.baseline.trim() && identities.candidate.trim(),
      "Source identities are required",
    );
    for (; index < order.length; index++) {
      const side = order[index],
        directory = path.join(output, `run-${index}-${side}`);
      // The probe owns browser cleanup, including when it rejects.
      const report = await runM3PerformanceProbe(
        side === "baseline" ? baselineURL : candidateURL,
        directory,
      );
      const run = {
        index,
        side,
        directory,
        report,
        distributions: [] as unknown[],
      };
      runs.push(run);
      assert.equal(report.passed, true);
      assert.equal(report.backend, "WebGPUBackend");
      assert.ok(report.adapter, "Hardware adapter metadata is required");
      assert.equal(report.adapter.isFallbackAdapter, false);
      assert.deepEqual(report.viewport, [1920, 1080]);
      assert.ok(Math.abs(report.devicePixelRatio - 1) < 1e-6);
      assert.equal(report.triangles, 5494);
      const settings = report.renderSettings;
      assert.ok(settings, "Render settings are required");
      assert.equal(settings.maxBounces, 5);
      assert.equal(settings.samplesPerFrame, 1);
      assert.equal(settings.denoise, false);
      assert.equal(settings.directLighting, true);
      assert.equal(settings.indirectLighting, true);
      assert.deepEqual(report.renderSettings, runs[0].report.renderSettings);
      assert.deepEqual(
        { ...report.adapter, features: [...report.adapter.features].sort() },
        {
          ...runs[0].report.adapter,
          features: [...runs[0].report.adapter.features].sort(),
        },
      );
      assert.equal(report.scene, runs[0].report.scene);
      for (const mode of modes)
        for (const metric of metrics)
          run.distributions.push({
            mode,
            metric,
            ...summarizeGpu(gpuSamples(report, mode, metric)),
          });
      await persist();
    }
    for (const mode of modes)
      for (const metric of metrics) {
        const pooled = (side: Side) =>
          summarizeGpu(
            runs
              .filter((run) => run.side === side)
              .flatMap((run) => gpuSamples(run.report, mode, metric)),
          );
        const baseline = pooled("baseline"),
          candidate = pooled("candidate");
        const ratio =
          baseline.unknownCount === 0 &&
          candidate.unknownCount === 0 &&
          baseline.median !== null &&
          baseline.median > 0 &&
          candidate.median !== null
            ? candidate.median / baseline.median
            : null;
        result.comparisons.push({
          mode,
          metric,
          baseline,
          candidate,
          candidateBaselineMedianRatio:
            ratio !== null && Number.isFinite(ratio) ? ratio : null,
        });
      }
    result.passed = true;
  } catch (error) {
    const side = order[Math.min(index, order.length - 1)];
    result.failure = {
      index,
      side,
      directory: path.join(output, `run-${index}-${side}`),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }
  await persist();
  return result;
}
