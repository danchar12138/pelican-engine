import type { RenderCapabilities, RenderSettings } from "../../sdk/src/index.ts";

export function renderCapabilities(backend: RenderCapabilities["backend"]): RenderCapabilities {
  return {
    backend,
    compute: backend === "webgpu",
    availableModes: backend === "webgpu" ? ["raster", "hybrid", "path"] : backend === "webgl2" ? ["raster"] : [],
  };
}

export function requireCompute(capabilities: RenderCapabilities, feature: string): void {
  if (!capabilities.compute)
    throw new Error(`TC_RENDER_COMPUTE_UNAVAILABLE: ${feature} requires WebGPU compute; current backend: ${capabilities.backend}. Available modes: ${capabilities.availableModes.join(", ") || "none"}. Use raster without denoising, or enable WebGPU and reload.`);
}

export function validateRenderCapabilities(settings: RenderSettings, capabilities: RenderCapabilities): void {
  if (!capabilities.availableModes.includes(settings.mode))
    throw new Error(`TC_RENDER_MODE_UNAVAILABLE: Mode ${settings.mode} is unavailable on ${capabilities.backend}. Available modes: ${capabilities.availableModes.join(", ") || "none"}. Select an available mode, or enable WebGPU and reload.`);
  if (settings.denoise) requireCompute(capabilities, "Denoising");
}
