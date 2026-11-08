export interface RuntimeDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  remediation: string;
  system?: string;
  entity?: string;
  resource?: string;
  source?: { file: string; line: number; column: number; length?: number };
  causeCodes?: string[];
  tick?: number;
  stage?: string;
  partialState?: boolean;
}
export function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const visit = (item: unknown, depth: number): string => {
    if (depth > 4 || seen.has(item)) return "";
    seen.add(item);
    const message = item instanceof Error ? item.message : String(item);
    const causes = item instanceof AggregateError ? item.errors : item instanceof Error && item.cause ? [item.cause] : [];
    return [message.slice(0, 2048), ...causes.slice(0, 8).map(cause => visit(cause, depth + 1))].filter(Boolean).join("; ");
  };
  return visit(error, 0).slice(0, 8192);
}
export function diagnosticFrom(
  error: unknown,
  context: Partial<RuntimeDiagnostic> = {},
): RuntimeDiagnostic {
  const message = errorMessage(error);
  return {
    code: message.match(/\bTC_[A-Z0-9_]+/)?.[0] ?? "TC_RUNTIME_FAILURE",
    severity: "error",
    message,
    causeCodes: [...new Set(message.match(/\bTC_[A-Z0-9_]+/g) ?? [])].slice(0, 16),
    ...(message.match(/tick=(\d+)/) ? { tick: Number(message.match(/tick=(\d+)/)![1]) } : {}),
    ...(message.match(/stage=([^,;\s]+)/) ? { stage: message.match(/stage=([^,;\s]+)/)![1] } : {}),
    ...(message.includes("partialState=true") ? { partialState: true } : {}),
    remediation:
      "Inspect the referenced entity, system or resource; correct the source and rerun the failing operation.",
    ...context,
  };
}
export function assertJSON(value: unknown, label = "state"): void {
  const ancestors = new Set<object>();
  function visit(item: unknown): void {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" ||
      !item ||
      (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item))
    )
      throw new Error(
        `TC_STATE_SERIALIZATION: ${label} must contain only finite JSON data.`,
      );
    if (ancestors.has(item))
      throw new Error(`TC_STATE_CYCLE: ${label} contains a cycle.`);
    ancestors.add(item);
    if (Array.isArray(item)) for (const child of item) visit(child);
    else
      for (const [key, child] of Object.entries(item)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error(`TC_STATE_KEY: Invalid key in ${label}.`);
        visit(child);
      }
    ancestors.delete(item);
  }
  visit(value);
}
