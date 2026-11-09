import { renderQuality, type RenderSettings } from "../../sdk/src/index.ts";

/** Explicit player selection before GPU content initialization; never an automatic downgrade. */
export function startupRenderSettings(
  settings: Partial<RenderSettings>,
  search: string,
): Partial<RenderSettings> {
  const values = new URLSearchParams(search).getAll("quality");
  if (!values.length) return { ...settings };
  if (values.length !== 1 || !["high", "medium", "low"].includes(values[0]))
    throw new Error(
      "TC_RENDER_QUALITY: Use exactly one quality=high, medium or low. Default high/path requires WebGPU; quality=low explicitly selects raster.",
    );
  const preset = renderQuality(values[0] as "high" | "medium" | "low");
  return {
    ...settings,
    mode: preset.mode,
    samplesPerFrame: preset.samplesPerFrame,
    maxBounces: preset.maxBounces,
    denoise: preset.denoise,
    denoiseIterations: preset.denoiseIterations,
  };
}
