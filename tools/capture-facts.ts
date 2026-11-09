import { decode } from "fast-png";
import { createHash } from "node:crypto";
/** Final sRGB display image (including DOM); never linear HDR radiance. */
export function captureFacts(png: Uint8Array, observation: unknown = null) {
  const image = decode(png);
  if (image.depth !== 8)
    throw new Error("TC_CAPTURE_FACTS_FORMAT: Expected an 8-bit display PNG.");
  const bins = new Array<number>(256).fill(0);
  let dark = 0,
    saturated = 0,
    sum = 0,
    min = 1,
    max = 0;
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const count = image.width * image.height;
  for (let p = 0; p < count; p++) {
    const i = p * image.channels;
    const r = Number(image.data[i]) / 255,
      g = image.channels <= 2 ? r : Number(image.data[i + 1]) / 255,
      b = image.channels <= 2 ? r : Number(image.data[i + 2]) / 255;
    const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    bins[Math.min(255, Math.floor(y * 255))]++;
    sum += y;
    min = Math.min(min, y);
    max = Math.max(max, y);
    if (y <= 0.01) dark++;
    if (Math.max(r, g, b) >= 0.99) saturated++;
  }
  const quantile = (q: number) => {
    let n = 0;
    for (let i = 0; i < 256; i++) {
      n += bins[i];
      if (n >= Math.max(1, count * q)) return i / 255;
    }
    return 1;
  };
  const p01 = quantile(0.01),
    p99 = quantile(0.99);
  return {
    format: "pelican.capture-facts",
    evidence: {
      sha256: createHash("sha256").update(png).digest("hex"),
      bytes: png.byteLength,
      width: image.width,
      height: image.height,
    },
    colorSpace:
      "sRGB display PNG, decoded to relative linear-sRGB luminance; not scene radiance",
    thresholds: {
      darkLuminanceAtMost: 0.01,
      saturatedEncodedChannelAtLeast: 0.99,
    },
    luminance: {
      min,
      max,
      mean: sum / count,
      p01,
      p50: quantile(0.5),
      p99,
      histogram: bins,
    },
    darkPixelRatio: dark / count,
    upperSaturatedPixelRatio: saturated / count,
    displayDynamicRange: {
      min,
      max,
      span: max - min,
      p99ToP01: p01 > 0 ? p99 / p01 : null,
      zeroFloor: p01 === 0,
    },
    observation,
    scope:
      "Measured image facts only. Dark or saturated pixels are not errors or automatic material/light diagnoses. Observation is taken immediately before capture; playing sessions can advance.",
  };
}

/** Tolerant display-space comparison for explicit controlled baselines only. */
export function compareDisplayPixels(actual: Uint8Array, expected: Uint8Array) {
  const a = decode(actual),
    b = decode(expected);
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.depth !== 8 ||
    b.depth !== 8
  )
    throw new Error(
      "TC_BASELINE_DIMENSIONS: Display dimensions/depth must match.",
    );
  let absolute = 0,
    changed = 0;
  const count = a.width * a.height;
  for (let p = 0; p < count; p++) {
    let maxDelta = 0;
    for (let c = 0; c < 3; c++) {
      const av = Number(a.data[p * a.channels + (a.channels <= 2 ? 0 : c)]),
        bv = Number(b.data[p * b.channels + (b.channels <= 2 ? 0 : c)]);
      const delta = Math.abs(av - bv);
      absolute += delta / 255;
      maxDelta = Math.max(maxDelta, delta);
    }
    if (maxDelta > 16) changed++;
  }
  const meanAbsoluteError = absolute / (count * 3),
    changedPixelRatio = changed / count;
  return {
    passed: meanAbsoluteError <= 0.01 && changedPixelRatio <= 0.1,
    meanAbsoluteError,
    changedPixelRatio,
    tolerance: {
      meanAbsoluteError: 0.01,
      changedPixelRatio: 0.1,
      encodedChannelDelta: 16,
    },
    scope: "Display-sRGB tolerance, not cross-device pixel identity",
  };
}
