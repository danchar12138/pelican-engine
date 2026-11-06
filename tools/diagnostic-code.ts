export function diagnosticCode(error: unknown): string {
  return String(error).match(/\bTC[A-Z0-9]*_[A-Z0-9_]+\b/)?.[0] ?? "TC_CLI_FAILURE";
}
