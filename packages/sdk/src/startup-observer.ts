import type { EngineStartupSnapshot } from "./index.ts";

const key = Symbol.for("pelican.engine.startup.v1");
type State = {
  snapshot: EngineStartupSnapshot;
  listeners: Set<(value: EngineStartupSnapshot) => void>;
};
function state(): State {
  const realm = globalThis as unknown as Record<symbol, State>;
  return (realm[key] ??= {
    snapshot: { stage: "idle", message: "Waiting for engine", sequence: 0 },
    listeners: new Set(),
  });
}
export function readStartup(): EngineStartupSnapshot {
  return { ...state().snapshot };
}
export function observeStartup(
  listener: (value: EngineStartupSnapshot) => void,
  signal?: AbortSignal,
): () => void {
  if (typeof listener !== "function")
    throw Error("TC_STARTUP_LISTENER: Supply a callback.");
  const owner = state();
  const remove = () => {
    owner.listeners.delete(listener);
    signal?.removeEventListener("abort", remove);
  };
  if (signal?.aborted) return remove;
  owner.listeners.add(listener);
  signal?.addEventListener("abort", remove, { once: true });
  try {
    listener(readStartup());
  } catch {
    remove();
  }
  return remove;
}
/** Renderer-owned progress; observers cannot mutate the engine or interrupt startup. */
export function publishStartup(
  patch: Omit<EngineStartupSnapshot, "sequence">,
): void {
  const owner = state();
  owner.snapshot = { ...patch, sequence: owner.snapshot.sequence + 1 };
  for (const listener of [...owner.listeners]) {
    try {
      listener(readStartup());
    } catch {
      /* Third-party UI must not fail engine startup. */
    }
  }
}
