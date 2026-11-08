import type { SceneIR } from "../../compiler/src/types.ts";

/** Conservative logic-only reload. Saved services own stricter validation before candidate commit. */
export function contentIterationCompatibility(
  previous: SceneIR,
  next: SceneIR,
): { compatible: boolean; reason: string } {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonical(item)]),
    );
  };
  const declaration = (ir: SceneIR) =>
    canonical({
      ...ir,
      ...Object.fromEntries(
        (
          [
            "systems",
            "components",
            "materials",
            "computes",
            "assets",
            "postProcesses",
          ] as const
        ).map((key) => [
          key,
          ir[key]?.map(({ source: _source, ...item }) => item),
        ]),
      ),
    });
  const compatible =
    JSON.stringify(declaration(previous)) === JSON.stringify(declaration(next));
  return {
    compatible,
    reason: compatible
      ? "Identical declarations; replace logic and restore the full checkpoint transactionally."
      : "Declarations/assets/service contracts changed. Keep the running game; explicitly restart to apply incompatible content.",
  };
}
