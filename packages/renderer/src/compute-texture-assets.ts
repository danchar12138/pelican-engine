import * as THREE from "three";
import type { Vec4 } from "../../sdk/src/index.ts";
import type { ComputeDriverOptions } from "../../runtime/src/compute-contract.ts";
import { createTexturePixelProvider } from "./texture-pixels.ts";

/** Borrows loaded assets, owns decoded CPU pixels only; never returns Three/GPU objects. */
export function createComputeTextureAssets(textures: ReadonlyMap<string, THREE.Texture>): NonNullable<ComputeDriverOptions["textureAssets"]> {
  const pixels = createTexturePixelProvider(), cache = new Map<string, { signature: readonly unknown[]; value: { width: number; height: number; data: readonly Vec4[] } }>();
  let disposed = false;
  const fail = (id: string, detail: string): never => { throw new Error("TC_COMPUTE_TEXTURE_ASSET: " + id + ": " + detail + " Repair: Use a declared loaded RGBA texture with a supported color space and readable pixels."); };
  return {
    resolve(id) {
      if (disposed) return fail(id, "Asset provider is disposed.");
      const texture = textures.get(id) ?? fail(id, "Unknown texture asset.");
      const signature = [texture, texture.version, texture.source, texture.source.version, texture.image, texture.colorSpace, texture.flipY];
      const old = cache.get(id); if (old && old.signature.every((v, i) => v === signature[i])) return old.value;
      if (![THREE.SRGBColorSpace, THREE.LinearSRGBColorSpace, THREE.NoColorSpace].includes(texture.colorSpace as never) || texture.format !== THREE.RGBAFormat || texture.premultiplyAlpha || texture.isRenderTargetTexture)
        return fail(id, "Unsupported format, color space or premultiplication.");
      const native = texture as THREE.DataTexture;
      const decoded = native.isDataTexture ? undefined : pixels.decode(texture);
      const width = decoded?.width ?? native.image?.width, height = decoded?.height ?? native.image?.height;
      const source = decoded?.data ?? (native.isDataTexture ? native.image?.data : undefined);
      const float = decoded?.encoding === "float32" || (native.isDataTexture && texture.type === THREE.FloatType);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 2 ** 24 || !source || source.length !== width * height * 4 || (native.isDataTexture && ![THREE.FloatType, THREE.UnsignedByteType].includes(texture.type as never)))
        return fail(id, "Expected readable RGBA8 or float32 pixels and valid dimensions.");
      const flip = decoded?.origin === "image" && texture.flipY, srgb = texture.colorSpace === THREE.SRGBColorSpace;
      const data: Vec4[] = [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = ((flip ? height - 1 - y : y) * width + x) * 4, rgba: number[] = [];
        for (let c = 0; c < 4; c++) {
          let value = Number(source[offset + c]) / (float ? 1 : 255);
          if (srgb && c < 3) value = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          value = Math.fround(value); if (!Number.isFinite(value)) return fail(id, "Decoded texels must fit finite f32.");
          rgba.push(value);
        }
        data.push(Object.freeze(rgba) as unknown as Vec4);
      }
      const value = Object.freeze({ width, height, data: Object.freeze(data) }); cache.set(id, { signature, value }); return value;
    },
    dispose() { if (disposed) return; disposed = true; cache.clear(); pixels.dispose(); },
  };
}
