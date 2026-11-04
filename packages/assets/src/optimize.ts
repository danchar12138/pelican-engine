import { NodeIO, Logger } from "@gltf-transform/core";
import { dedup, weld } from "@gltf-transform/functions";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { inspectAsset } from "./index.ts";

/** Explicit lossless preprocessing. Source files and existing outputs are never overwritten. */
export async function optimizeModel(input: string, output: string) {
  if (path.resolve(input).toLowerCase() === path.resolve(output).toLowerCase())
    throw new Error("TC_ASSET_OPTIMIZE_PATH: Choose a new GLB output path.");
  if (path.extname(output).toLowerCase() !== ".glb")
    throw new Error("TC_ASSET_OPTIMIZE_PATH: Output must use .glb.");
  const before = await inspectAsset(input, "model");
  const io = new NodeIO();
  const document = await io.readBinary(await readFile(input));
  document.setLogger(new Logger(Logger.Verbosity.SILENT));
  // Weld compares the complete vertex stream bit-for-bit; names remain stable for animations and author references.
  await document.transform(dedup({ keepUniqueNames: true }), weld());
  const content = await io.writeBinary(document);
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  try {
    await writeFile(output, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "TC_ASSET_OPTIMIZE_EXISTS: Output already exists; choose a new path.",
      );
    throw error;
  }
  try {
    const after = await inspectAsset(output, "model");
    if (
      before.triangleCount !== after.triangleCount ||
      JSON.stringify(before.bounds) !== JSON.stringify(after.bounds) ||
      JSON.stringify(before.animations) !== JSON.stringify(after.animations) ||
      before.skinCount !== after.skinCount ||
      before.jointCount !== after.jointCount
    )
      throw new Error(
        "TC_ASSET_OPTIMIZE_INVARIANT: Geometry bounds, triangles, skin or animation metadata changed.",
      );
    return {
      format: "threecat.asset-optimization",
      version: 1,
      operations: [
        "dedup-unique-names-preserved",
        "weld-bitwise-identical-vertex-streams",
      ],
      before,
      after,
      bytesSaved: Number(before.bytes) - Number(after.bytes),
      ratio: Number(after.bytes) / Number(before.bytes),
      limitations: [
        "No quantization, mesh compression or texture transcoding. Explicit lossless preprocessing only.",
        "The source is unchanged. Update the game asset path explicitly to adopt this output.",
      ],
    };
  } catch (error) {
    await rm(output);
    throw error;
  }
}
