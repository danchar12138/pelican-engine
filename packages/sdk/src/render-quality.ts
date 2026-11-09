import type { RenderSettings } from "./index.ts";

export function qualitySettings(
  preset:
    | "high"
    | "medium"
    | "low"
    | "realtime"
    | "preview"
    | "capture" = "low",
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
    rasterAmbientOcclusion: true,
    mode:
      ["low", "realtime"].includes(preset)
        ? "raster"
        : ["medium", "preview"].includes(preset)
          ? "hybrid"
          : "path",
    samplesPerFrame: ["low","realtime"].includes(preset) ? 1 : ["medium", "preview"].includes(preset) ? 2 : 4,
    maxBounces: preset === "capture" ? 12 : ["medium", "preview"].includes(preset) ? 4 : 8,
    denoise: !["capture", "low", "realtime"].includes(preset),
    denoiseIterations: 3,
    exposure: 1,
    directLighting: true,
    indirectLighting: true,
    debug: "beauty",
  };
}
