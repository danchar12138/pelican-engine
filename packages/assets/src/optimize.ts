import { NodeIO, Logger } from "@gltf-transform/core";
import { KHRMaterialsIOR, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { dedup, weld } from "@gltf-transform/functions";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { inspectAsset } from "./index.ts";
import { createHash } from "node:crypto";
import { parseGLB } from "./glb.ts";
import { InspectionContext } from "./errors.ts";

/** Explicit lossless preprocessing. Source files and existing outputs are never overwritten. */
export async function optimizeModel(input: string, output: string) {
  if (path.resolve(input).toLowerCase() === path.resolve(output).toLowerCase())
    throw new Error("TC_ASSET_OPTIMIZE_PATH: Choose a new GLB output path.");
  if (path.extname(output).toLowerCase() !== ".glb")
    throw new Error("TC_ASSET_OPTIMIZE_PATH: Output must use .glb.");
  const before = await inspectAsset(input, "model");
  const sourceBytes = await readFile(input);
  const io = new NodeIO().registerExtensions([KHRMaterialsIOR, KHRMaterialsSpecular]);
  const document = await io.readBinary(sourceBytes);
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
    const physicalExtensions = (metadata: Record<string, unknown>) => {
      const materials = metadata.materials as { name: string; specular?: { specularFactor?: number; specularColorFactor?: number[] }; ior?: { ior?: number } }[];
      return [...new Set(materials.filter(m => m.specular || m.ior).map(m => JSON.stringify({ name: m.name,
        ...(m.specular ? { specular: { intensity: m.specular.specularFactor ?? 1, color: m.specular.specularColorFactor ?? [1,1,1] } } : {}),
        ...(m.ior ? { ior: m.ior.ior ?? 1.5 } : {}) })))].sort();
    };
    const specularTextures = (bytes: Buffer) => {
      const { json, bin } = parseGLB(bytes, new InspectionContext("optimization.glb"));
      const binding = (info: { index: number; texCoord?: number } | undefined) => {
        if (!info) return null;
        const texture = json.textures![info.index];
        const image = json.images![texture.source!];
        const view = json.bufferViews![image.bufferView!];
        const sampler = json.samplers?.[texture.sampler!];
        const start = view.byteOffset ?? 0;
        return {
          hash: createHash("sha256").update(bin.subarray(start, start + view.byteLength)).digest("hex"),
          mimeType: image.mimeType,
          texCoord: info.texCoord ?? 0,
          magFilter: sampler?.magFilter ?? null,
          minFilter: sampler?.minFilter ?? null,
          wrapS: sampler?.wrapS ?? 10497,
          wrapT: sampler?.wrapT ?? 10497,
        };
      };
      return [...new Set((json.materials ?? []).filter(m => m.extensions?.KHR_materials_specular).map(m => {
        const specular = m.extensions!.KHR_materials_specular as { specularTexture?: { index: number; texCoord?: number }; specularColorTexture?: { index: number; texCoord?: number } };
        return JSON.stringify({ name: m.name ?? "", intensity: binding(specular.specularTexture), color: binding(specular.specularColorTexture) });
      }))].sort();
    };
    if (
      before.triangleCount !== after.triangleCount ||
      JSON.stringify(before.bounds) !== JSON.stringify(after.bounds) ||
      JSON.stringify(before.animations) !== JSON.stringify(after.animations) ||
      before.skinCount !== after.skinCount ||
      before.jointCount !== after.jointCount ||
      JSON.stringify(physicalExtensions(before)) !== JSON.stringify(physicalExtensions(after)) ||
      JSON.stringify(specularTextures(sourceBytes)) !== JSON.stringify(specularTextures(Buffer.from(content)))
    )
      throw new Error(
        "TC_ASSET_OPTIMIZE_INVARIANT: Geometry bounds, triangles, skin, animation or physical material extension metadata changed.",
      );
    return {
      format: "pelican.asset-optimization",
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
