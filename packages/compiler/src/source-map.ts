import path from "node:path";

/** Stable source-map names even when Windows engine and game live on different drives. */
export function mapSourcePath(
  source: string,
  projectRoot: string,
  sdkPath: string,
  paths: typeof path = path,
  sourceRoot = "",
): string {
  if (
    source.includes("pelican:m0-game-entry") ||
    source.includes("pelican:game-entry")
  )
    return "pelican-generated-entry";
  const absolute = paths.resolve(
    paths.isAbsolute(source)
      ? source
      : paths.resolve(projectRoot, "dist", sourceRoot, source),
  );
  const sdk = paths.resolve(sdkPath);
  const same =
    paths === path.win32 || (paths === path && process.platform === "win32")
      ? absolute.toLowerCase() === sdk.toLowerCase()
      : absolute === sdk;
  if (same) return "pelican-sdk/index.ts";
  const sdkRelative = paths.relative(paths.dirname(sdk), absolute);
  if (
    sdkRelative &&
    !sdkRelative.startsWith("..") &&
    !paths.isAbsolute(sdkRelative)
  )
    return "pelican-sdk/" + sdkRelative.replaceAll("\\", "/");
  const relative = paths.relative(projectRoot, absolute);
  if (paths.isAbsolute(relative))
    throw new Error(
      "TC_SOURCE_MAP_EXTERNAL: Cannot map a non-SDK source on another drive.",
    );
  return relative.replaceAll("\\", "/");
}
