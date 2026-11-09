import type { RenderSettings } from "./index.ts";

export function qualitySettings(
  preset:
    | "high"
    | "medium"
    | "low"
    | "realtime"
    | "preview"
    | "capture" = "high",
): RenderSettings {
  if (
    !["high", "medium", "low", "realtime", "preview", "capture"].includes(
      preset,
    )
  )
    throw new Error(
      "TC_RENDER_QUALITY: Choose high (path), medium (hybrid), low (raster), or realtime/preview/capture; path and hybrid require WebGPU.",
    );
  return {
    mode:
      preset === "low"
        ? "raster"
        : ["medium", "preview"].includes(preset)
          ? "hybrid"
          : "path",
    samplesPerFrame: preset === "low" ? 1 : ["medium", "preview"].includes(preset) ? 2 : 4,
    maxBounces: preset === "capture" ? 12 : ["medium", "preview"].includes(preset) ? 4 : 8,
    denoise: preset !== "capture" && preset !== "low",
    denoiseIterations: 3,
    exposure: 1,
    directLighting: true,
    indirectLighting: true,
    debug: "beauty",
  };
}
