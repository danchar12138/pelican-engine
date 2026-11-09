import type { RenderDiagnosticInput, RenderDiagnosticReport } from "./index.ts";

/** Pure analysis of detached observations. Never changes quality or claims a GPU/FPS measurement. */
export function inspectRenderHealth(
  input: RenderDiagnosticInput,
): RenderDiagnosticReport {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error(
      "TC_RENDER_DIAGNOSTIC_INPUT: Supply a detached observation object.",
    );
  const findings: RenderDiagnosticReport["findings"] = [];
  const add = (code: string, message: string, repair: string) =>
    findings.push({ code, message, repair });
  const surface = input.rendering?.surface;
  const times = (input.metrics ?? [])
    .slice(-240)
    .map((frame) => frame.wallMs)
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    times.length
      ? times[Math.min(times.length - 1, Math.floor(times.length * fraction))]
      : null;
  if ((percentile(0.95) ?? 0) > 33.34)
    add(
      "TC_RENDER_FRAME_BUDGET",
      "Observed frame processing P95 exceeds 33.34 ms; this is wall time, not GPU time or measured display FPS.",
      "Inspect captureMs/uploadMs and a GPU timestamp measurement separately. Optimize dirty work, batching and sampling before changing quality.",
    );
  if (surface?.temporal?.lastReset)
    add(
      "TC_RENDER_HISTORY_INVALIDATED",
      `Temporal history was reset: ${(surface.temporal.resetReasons ?? []).join(", ") || "unspecified"}.`,
      "Compare consecutive observations. Check changes to material structure, textures, modes and scene ownership; a single reset at startup is normal.",
    );
  if ((surface?.captureMs ?? 0) > 8 || (surface?.uploadMs ?? 0) > 8)
    add(
      "TC_RENDER_CONTENT_COST",
      "Last captured-content update exceeded 8 ms. These fields can describe the last update, not every current frame.",
      "Keep static geometry/materials stable; use managed parameter and resource updates. Inspect animation, emitter changes and duplicate data.",
    );
  if ((surface?.uploadBytes ?? 0) > 1048576)
    add(
      "TC_RENDER_UPLOAD_VOLUME",
      "The last capture uploaded more than 1 MiB.",
      "Inspect changed objects and buffer ranges. Avoid rebuilding a scene or recreating resources to change a light or uniform.",
    );
  if (surface && (surface.samples ?? 0) <= 2)
    add(
      "TC_RENDER_LOW_ACCUMULATION",
      "The latest image has at most two progressive samples; moving scenes need valid temporal history, not just higher bounce limits.",
      "Check temporal reset reasons and dynamic-light response. Compare a fixed animated sequence against a high-sample reference; do not hide noise by lowering resolution.",
    );
  const pixels = (input.viewport?.width ?? 0) * (input.viewport?.height ?? 0);
  if (input.mode !== "raster" && pixels * 64 + 16 > 128 * 1048576)
    add(
      "TC_RENDER_STORAGE_PREFLIGHT",
      "The pixel storage exceeds 128 MiB, a common single-binding budget; the actual device limit may differ.",
      "Query the actual adapter limit before preparation. Preserve authored resolution; report unsupported budgets instead of silently reducing it.",
    );
  const assets = input.assets ?? input.compiledIR?.assets ?? [];
  const hashes = new Map<string, string[]>();
  for (const asset of assets)
    if (asset.hash)
      hashes.set(asset.hash, [...(hashes.get(asset.hash) ?? []), asset.id]);
  const duplicates = [...hashes.values()].filter((ids) => ids.length > 1);
  for (const ids of duplicates)
    add(
      "TC_ASSET_DUPLICATE_CONTENT",
      `Identical declared asset bytes: ${ids.join(", ")}.`,
      "Reuse a declared asset ID where semantics match; retain separate material slot color spaces and ownership.",
    );
  return {
    format: "pelican.render-diagnostics",
    mode: input.mode ?? null,
    frameProcessingMs: {
      samples: times.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
    },
    findings,
    queries: [
      "pelican check --project <game-directory>",
      "pelican guide --goal render-diagnostics",
      "pelican api --symbol onEngineStartup",
      "pelican api --symbol ModelDefinition.materialSlots",
    ],
    scope:
      "Heuristics from bounded observations, not physical correctness, sustained FPS, mobile acceptance or a recommendation to reduce resolution. Static compile diagnostics come from check; this report analyzes the running revision.",
  };
}
