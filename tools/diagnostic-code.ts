export function diagnosticCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["ENOENT","EACCES","EPERM","ECONNREFUSED","ENOTFOUND","ETIMEDOUT","ENOSPC"].includes(code))return "TC_ENVIRONMENT_" + code;
  return String(error).match(/\bTC[A-Z0-9]*_[A-Z0-9_]+\b/)?.[0] ?? "TC_CLI_FAILURE";
}
