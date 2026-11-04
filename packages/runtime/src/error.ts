export interface RuntimeDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  remediation: string;
  system?: string;
  entity?: string;
  resource?: string;
  source?: { file: string; line: number; column: number; length?: number };
}
export function diagnosticFrom(
  error: unknown,
  context: Partial<RuntimeDiagnostic> = {},
): RuntimeDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: message.match(/\bTC_[A-Z0-9_]+/)?.[0] ?? "TC_RUNTIME_FAILURE",
    severity: "error",
    message,
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
