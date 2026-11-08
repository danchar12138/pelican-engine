import type { RenderSettings } from "./index.ts";

export function qualitySettings(
  preset: "realtime" | "preview" | "capture" = "realtime",
): RenderSettings {
  if (!["realtime", "preview", "capture"].includes(preset))
    throw new Error(
      "TC_RENDER_QUALITY: Choose realtime, preview or capture; inspect capabilities before selecting WebGPU-only modes.",
    );
  return {
    mode:
      preset === "realtime"
        ? "raster"
        : preset === "preview"
          ? "hybrid"
          : "path",
    samplesPerFrame: preset === "capture" ? 4 : 2,
    maxBounces: preset === "capture" ? 12 : 8,
    denoise: preset === "preview",
    denoiseIterations: 3,
    exposure: 1,
    directLighting: true,
    indirectLighting: true,
    debug: "beauty",
  };
}
