import path from "node:path";
import ts from "typescript";
import type { Diagnostic } from "./types.ts";

export interface ProjectManifest {
  entry?: string;
  engineVersion?: string;
  engine?: { version?: string; path?: string };
}

/** Parse a project manifest while accepting an optional UTF-8 BOM. */
export function parseProjectManifest(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** Absolute cross-drive Windows paths are retained; relative paths use the project root. */
export function resolveEnginePath(
  projectRoot: string,
  enginePath: string,
  paths: typeof path = path,
): string {
  return paths.resolve(projectRoot, enginePath);
}

/** Inspect the version declaration without importing/executing the selected SDK. */
export function readSDKVersion(text: string): string | undefined {
  const source = ts.createSourceFile(
    "sdk.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "SDK_VERSION"
      ) {
        let value = declaration.initializer;
        while (
          value &&
          (ts.isAsExpression(value) ||
            ts.isSatisfiesExpression(value) ||
            ts.isParenthesizedExpression(value))
        )
          value = value.expression;
        if (value && ts.isStringLiteral(value)) return value.text;
      }
    }
  }
  return undefined;
}

/** A lock is exact, including prerelease identifiers; semver ranges are not locks. */
export function validateManifest(
  value: unknown,
  sdkVersion: string,
): { manifest?: ProjectManifest; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string) =>
    diagnostics.push({
      code: "TC_PROJECT_CONFIG",
      severity: "error",
      message,
      suggestion:
        "Use entry, engineVersion and engine.{version,path} strings in pelican.project.json.",
    });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Project manifest must be an object.");
    return { diagnostics };
  }
  const manifest = value as ProjectManifest;
  for (const key of ["entry", "engineVersion"] as const)
    if (
      manifest[key] !== undefined &&
      (typeof manifest[key] !== "string" || !manifest[key]!.trim())
    )
      fail(key + " must be a non-empty string.");
  if (manifest.engine !== undefined) {
    if (
      !manifest.engine ||
      typeof manifest.engine !== "object" ||
      Array.isArray(manifest.engine)
    )
      fail("engine must be an object.");
    else
      for (const key of ["version", "path"] as const)
        if (
          manifest.engine[key] !== undefined &&
          (typeof manifest.engine[key] !== "string" ||
            !manifest.engine[key]!.trim())
        )
          fail("engine." + key + " must be a non-empty string.");
  }
  if (diagnostics.length) return { diagnostics };
  for (const [key, version] of [
    ["engineVersion", manifest.engineVersion],
    ["engine.version", manifest.engine?.version],
  ] as const) {
    if (version !== undefined && version !== sdkVersion)
      diagnostics.push({
        code: "TC_ENGINE_VERSION_MISMATCH",
        severity: "error",
        message:
          key +
          " locks " +
          version +
          " but the selected SDK is " +
          sdkVersion +
          ".",
        suggestion:
          "Migrate the project to the public API of " +
          sdkVersion +
          ", then explicitly update " +
          key +
          ". M0 0.0.1 projects require migration; no implicit upgrade is performed.",
      });
  }
  if (
    manifest.engineVersion === undefined &&
    manifest.engine?.version === undefined
  )
    diagnostics.push({
      code: "TC_ENGINE_VERSION_UNLOCKED",
      severity: "warning",
      message: "Legacy project has no engine version lock.",
      suggestion:
        "Add engineVersion: " +
        JSON.stringify(sdkVersion) +
        " to pelican.project.json for reproducible builds.",
    });
  return { manifest, diagnostics };
}
