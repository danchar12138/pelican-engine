import path from "node:path";

/** Stable source-map names even when Windows engine and game live on different drives. */
export function mapSourcePath(
  source: string,
  projectRoot: string,
  sdkPath: string,
  paths: typeof path = path,
): string {
  if (source.includes("threecat:m0-game-entry"))
    return "threecat-generated-entry";
  const absolute = paths.resolve(
    paths.isAbsolute(source)
      ? source
      : paths.resolve(projectRoot, "dist", source),
  );
  const sdk = paths.resolve(sdkPath);
  const same =
    paths === path.win32 || process.platform === "win32"
      ? absolute.toLowerCase() === sdk.toLowerCase()
      : absolute === sdk;
  if (same) return "threecat-sdk/index.ts";
  const relative = paths.relative(projectRoot, absolute);
  if (paths.isAbsolute(relative))
    throw new Error(
      "TC_SOURCE_MAP_EXTERNAL: Cannot map a non-SDK source on another drive.",
    );
  return relative.replaceAll("\\", "/");
}
