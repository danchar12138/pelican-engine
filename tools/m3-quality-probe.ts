import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyM3QualityPixels } from "./m3-quality-pixels-verifier.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
export async function runM3QualityProbe(url: string, output: string, sourceRoot: string, sourceIdentity: string) {
  if ((await sourceFingerprint(sourceRoot)).sha256 !== sourceIdentity) throw new Error("TC_QUALITY_SOURCE: source fingerprint mismatch before capture");
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
          viewport: { width: 320, height: 180 },
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        const target = new URL(url);
        target.searchParams.set("automation", "1");
        target.searchParams.set("width", "320");
        target.searchParams.set("height", "180");
        await page.goto(target.href);
        await waitForEngine(page);
        await page.evaluate(
          async () =>
            await (window as any).__pelican.command({
              type: "mode",
              mode: "path",
            }),
        );
        const result = await page.evaluate(async () => {
          const api = (window as any).__pelican;
          await api.command({ type: "input", key: "n", pressed: true });
          await api.command({ type: "input", key: "n", pressed: false });
          await api.command({ type: "step", count: 1 });
          await api.accumulate(15);
          const beforeInspect = api.inspect();
          const before = { gameId: beforeInspect.compiledIR?.gameId, sceneId: beforeInspect.compiledIR?.scene?.id,
            tick: beforeInspect.tick, geometryHash: beforeInspect.geometryHash, camera: beforeInspect.objects?.camera, mode: beforeInspect.mode };
          const raw = await api.linearPixels(false),
            filtered = await api.linearPixels(true);
          await api.accumulate(240);
          const reference = await api.linearPixels(false);
          const afterInspect = api.inspect();
          const after = { gameId: afterInspect.compiledIR?.gameId, sceneId: afterInspect.compiledIR?.scene?.id,
            tick: afterInspect.tick, geometryHash: afterInspect.geometryHash, camera: afterInspect.objects?.camera, mode: afterInspect.mode };
          let rawError = 0,
            filteredError = 0,
            valid = 0,
            finite = true;
          for (let i = 0; i < raw.length; i += 4) {
            for (let channel = 0; channel < 3; channel++) {
              const r = raw[i + channel],
                f = filtered[i + channel],
                ref = reference[i + channel];
              finite =
                finite &&
                Number.isFinite(r) &&
                Number.isFinite(f) &&
                Number.isFinite(ref);
              rawError += (r / (1 + r) - ref / (1 + ref)) ** 2;
              filteredError += (f / (1 + f) - ref / (1 + ref)) ** 2;
              valid++;
            }
          }
          return {
            rawSamples: raw[3],
            referenceSamples: reference[3],
            rawMse: rawError / valid,
            filteredMse: filteredError / valid,
            finite,
            scene: { before, after },
            images: { raw: Array.from(raw) as number[], filtered: Array.from(filtered) as number[], reference: Array.from(reference) as number[] },
          };
        });
        const { images, ...metrics } = result;
        const files = {} as Record<string, { file: string; sha256: string }>;
        for (const name of ["raw", "filtered", "reference"] as const) {
          // Explicit little-endian float32, independent of the host endianness.
          const bytes = Buffer.alloc(images[name].length * 4);
          images[name].forEach((value, i) => bytes.writeFloatLE(value, i * 4));
          const file = `quality-${name}.f32`;
          await writeFile(path.join(output, file), bytes);
          files[name] = { file, sha256: createHash("sha256").update(bytes).digest("hex") };
        }
        await page.screenshot({ path: path.join(output, "reference-256.png") });
        const report = {
          sourceIdentity,
          passed: metrics.finite === true && metrics.filteredMse < metrics.rawMse && errors.length === 0 &&
            ["raw", "filtered", "reference"].every((name) => images[name as keyof typeof images].length === 320 * 180 * 4),
          ...metrics,
          pixels: { format: "rgba-f32le", width: 320, height: 180, files },
          errors,
          limitations: [
            "320x180 static gallery compressed radiance MSE; same integrator 256spp as reference, not an independent ground truth or complete quality matrix.",
          ],
        };
        const reportPath = path.join(output, "quality.json");
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        assert.equal(metrics.finite, true);
        assert.ok(metrics.filteredMse < metrics.rawMse, JSON.stringify(metrics));
        for (const name of ["raw", "filtered", "reference"] as const) assert.equal(images[name].length, 320 * 180 * 4);
        assert.deepEqual(errors, []);
        // Re-read the persisted bytes and independently recompute the quality metric.
        try { await verifyM3QualityPixels(output, sourceRoot); }
        catch (error) {
          await writeFile(reportPath, JSON.stringify({ ...report, passed: false, independentVerificationError: String(error) }, null, 2));
          throw error;
        }
        return { passed: true, ...metrics, errors };
      },
      120000,
      "M3 actual image denoising MSE",
    );
  } finally {
    await browser.close();
  }
}
