export interface ViewportSize { width: number; height: number; cssWidth: number; cssHeight: number; pixelRatio: number; fixed: boolean }

/** Explicit capture dimensions are pixels; normal play follows CSS pixels and DPR. */
export function resolveViewport(search: string, cssWidth: number, cssHeight: number, pixelRatio: number): ViewportSize {
  const params = new URLSearchParams(search), fixed = params.has("width") || params.has("height");
  const ratio = fixed ? 1 : pixelRatio;
  const w = fixed ? Number(params.get("width")) : Math.max(1, Math.round(cssWidth));
  const h = fixed ? Number(params.get("height")) : Math.max(1, Math.round(cssHeight));
  if (![w, h].every(n => Number.isSafeInteger(n) && n >= 1) || !Number.isFinite(ratio) || ratio <= 0 || ratio > 8 || Math.max(w * ratio, h * ratio) > 16384)
    throw new Error("TC_VIEWPORT_SIZE: Provide both width and height in [1,16384], or a finite viewport and DPR in (0,8]. No resolution reduction was applied.");
  return { width: Math.round(w * ratio), height: Math.round(h * ratio), cssWidth: w, cssHeight: h, pixelRatio: ratio, fixed };
}
