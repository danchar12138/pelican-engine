import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssetInspectionError, InspectionContext } from "./errors.ts";
import { inspectModel } from "./model.ts";
import { inspectTexture } from "./texture.ts";
import { inspectWAV } from "./audio.ts";

export { AssetInspectionError } from "./errors.ts";
export type { AssetErrorCode } from "./errors.ts";
export type AssetType = "model" | "texture" | "audio" | "binary";

/** Read-only, offline inspection. Reject invalid assets before returning JSON metadata. */
export async function inspectAsset(
  file: string,
  type: AssetType,
): Promise<Record<string, unknown>> {
  const ctx = new InspectionContext(file);
  let data: Buffer;
  try {
    data = await fs.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new AssetInspectionError(
        "TC_ASSET_MISSING",
        file,
        "file",
        "Asset file does not exist.",
        "Correct the asset path or restore the source file.",
      );
    return ctx.invalid("file", `Cannot read asset (${code ?? "I/O error"}).`);
  }
  try {
    let metadata: Record<string, unknown>;
    switch (type) {
      case "model":
        metadata = await inspectModel(data, ctx);
        break;
      case "texture":
        metadata = inspectTexture(data, ctx);
        break;
      case "audio":
        metadata = inspectWAV(data, ctx);
        break;
      case "binary":
        metadata = { format: "binary" };
        break;
      default:
        return ctx.unsupported("type", `Unknown asset type ${String(type)}.`);
    }
    return {
      ...metadata,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof AssetInspectionError) throw error;
    // A recognizable supported format with a damaged schema must never leak a raw TypeError.
    const extension = path.extname(file).toLowerCase();
    return ctx.invalid(
      type,
      `Malformed ${extension || type} asset: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
