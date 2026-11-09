import type { RenderMode, RenderPreparation } from "../../sdk/src/index.ts";

/** Transient renderer preparation is owned by the content instance, never part of a game save. */
export function createRenderPreparation(validate: (mode: RenderMode) => void) {
  const states = new Map<RenderMode, RenderPreparation>();
  let generation = 0,
    disposed = false;
  const check = (mode: RenderMode) => {
    if (disposed)
      throw new Error("TC_RENDER_DISPOSED: Preparation owner is disposed.");
    if (!["raster", "hybrid", "path"].includes(mode))
      throw new Error("TC_RENDER_SETTINGS: Unknown preparation mode.");
  };
  const state = (mode: RenderMode): RenderPreparation => {
    check(mode);
    return { ...(states.get(mode) ?? { mode, status: "idle" }) };
  };
  const request = (mode: RenderMode) => {
    check(mode);
    validate(mode);
    if (["queued", "preparing", "ready"].includes(state(mode).status)) return;
    states.set(mode, { mode, status: "queued" });
  };
  return {
    request,
    state,
    invalidate() {
      if (disposed) return;
      generation++;
      states.clear();
    },
    async flush(prepare: (mode: RenderMode) => Promise<void>) {
      const ownedGeneration = generation;
      for (const [mode, entry] of states) {
        if (disposed || generation !== ownedGeneration) return;
        if (entry.status !== "queued") continue;
        states.set(mode, { mode, status: "preparing" });
        const started = performance.now();
        try {
          await prepare(mode);
          if (!disposed && generation === ownedGeneration)
            states.set(mode, {
              mode,
              status: "ready",
              durationMs: performance.now() - started,
            });
        } catch (error) {
          if (!disposed && generation === ownedGeneration)
            states.set(mode, {
              mode,
              status: "failed",
              durationMs: performance.now() - started,
              error: String(error),
            });
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      states.clear();
    },
  };
}
