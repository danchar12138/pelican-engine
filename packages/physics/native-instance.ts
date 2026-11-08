import { createRapierInstance } from "./rapier.ts";

const observers = new Set<(native: ReturnType<typeof createRapierInstance>) => void>();
/** Private adapter instrumentation; not exported by the gameplay SDK. */
export function observeNativeInstances(observer: (native: ReturnType<typeof createRapierInstance>) => void): () => void {
  observers.add(observer); return () => { observers.delete(observer); };
}
export function isolatedNativeInstance() {
  const native = createRapierInstance();
  for (const observer of observers) observer(native);
  return native;
}
