import * as THREE from "three";
import type { SurfacePixelData } from "./surface.ts";
import { embeddedImagePixels } from "./embedded-image-pixels.ts";

export interface TexturePixelDiagnostic {
  readonly code: string;
  readonly textureUuid: string;
  readonly message: string;
}
type Image = ImageBitmap | HTMLImageElement;
interface Pixels {
  image: Image;
  version: number;
  width: number;
  height: number;
  url: string;
  data: Uint8ClampedArray;
}
interface Seen {
  version: number;
  source: THREE.Texture["source"];
  sourceVersion: number;
  image: unknown;
}

/** Private, synchronous reader. It borrows images and owns only its canvas/cache. */
export function createTexturePixelProvider() {
  const sources = new Map<THREE.Texture["source"], Pixels>();
  const textures = new Map<THREE.Texture, Seen>();
  const diagnostics = new Map<string, TexturePixelDiagnostic>();
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  let context:
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | undefined;
  let disposed = false,
    requests = 0,
    reads = 0,
    hits = 0,
    delegated = 0;
  const report = (texture: THREE.Texture, code: string, message: string) => {
    diagnostics.set(texture.uuid, { code, textureUuid: texture.uuid, message });
    return undefined;
  };
  const clear = () => {
    sources.clear();
    textures.clear();
    diagnostics.clear();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    context = undefined;
    canvas = undefined;
    requests = reads = hits = delegated = 0;
  };
  return {
    decode(texture: THREE.Texture): SurfacePixelData | undefined {
      requests++;
      if (disposed)
        return report(
          texture,
          "TC_TEXTURE_PROVIDER_DISPOSED",
          "Create a new pixel provider after dispose().",
        );
      // Surface handles native DataTexture data, including float32, without DOM.
      if ((texture as THREE.DataTexture).isDataTexture) {
        delegated++;
        diagnostics.delete(texture.uuid);
        return undefined;
      }
      const flags = texture as THREE.Texture & {
        isCompressedTexture?: boolean;
        isDataArrayTexture?: boolean;
        isData3DTexture?: boolean;
        isVideoTexture?: boolean;
        isFramebufferTexture?: boolean;
      };
      if (
        texture.type !== THREE.UnsignedByteType ||
        texture.format !== THREE.RGBAFormat ||
        texture.premultiplyAlpha ||
        texture.mipmaps.length ||
        texture.isRenderTargetTexture ||
        flags.isCompressedTexture ||
        flags.isDataArrayTexture ||
        flags.isData3DTexture ||
        flags.isVideoTexture ||
        flags.isFramebufferTexture
      )
        return report(
          texture,
          "TC_TEXTURE_TYPE_UNSUPPORTED",
          "Use an unsigned-byte RGBA image without custom mips, premultiplication, or dynamic/compressed/array/render-target storage.",
        );
      try {
        const embedded = embeddedImagePixels(texture);
        if (embedded) {
          diagnostics.delete(texture.uuid);
          return Object.freeze({ ...embedded, data: embedded.data.slice() });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report(texture, message.split(":")[0], message);
        throw error;
      }
      if (
        typeof OffscreenCanvas === "undefined" &&
        typeof document === "undefined"
      )
        return report(
          texture,
          "TC_TEXTURE_DOM_UNAVAILABLE",
          "Decode browser images in a realm with Canvas2D; native DataTexture needs no DOM.",
        );
      const image: unknown = texture.image;
      const bitmap =
        typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
      const html =
        typeof HTMLImageElement !== "undefined" &&
        image instanceof HTMLImageElement;
      if (!bitmap && !html)
        return report(
          texture,
          "TC_TEXTURE_IMAGE_UNSUPPORTED",
          "Supply an ImageBitmap or a decoded HTMLImageElement from this realm.",
        );
      const input = image as Image;
      const width = html
        ? (input as HTMLImageElement).naturalWidth
        : input.width;
      const height = html
        ? (input as HTMLImageElement).naturalHeight
        : input.height;
      if (bitmap && (!width || !height))
        return report(
          texture,
          "TC_TEXTURE_BITMAP_CLOSED",
          "The borrowed ImageBitmap is closed; retain it until extraction completes.",
        );
      if (html && (!(input as HTMLImageElement).complete || !width || !height))
        return report(
          texture,
          "TC_TEXTURE_IMAGE_NOT_DECODED",
          "Await image.decode() before synchronous extraction.",
        );
      const url = html
        ? (input as HTMLImageElement).currentSrc ||
          (input as HTMLImageElement).src
        : "";
      const previous = textures.get(texture);
      const source = texture.source;
      // A texture-only revision also invalidates shared pixels, even if a caller
      // changed version without incrementing source.version.
      if (
        previous &&
        previous.source === source &&
        previous.version !== texture.version
      )
        sources.delete(source);
      textures.set(texture, {
        version: texture.version,
        source,
        sourceVersion: source.version,
        image,
      });
      let cached = sources.get(source);
      if (
        cached &&
        cached.image === input &&
        cached.version === source.version &&
        cached.width === width &&
        cached.height === height &&
        cached.url === url
      ) {
        hits++;
      } else {
        sources.delete(source);
        try {
          if (
            !Number.isSafeInteger(width * height * 4) ||
            width <= 0 ||
            height <= 0
          )
            return report(
              texture,
              "TC_TEXTURE_CAPACITY",
              "Image dimensions exceed addressable RGBA8 storage.",
            );
          if (!canvas) {
            canvas =
              typeof OffscreenCanvas !== "undefined"
                ? new OffscreenCanvas(width, height)
                : document.createElement("canvas");
          }
          canvas.width = width;
          canvas.height = height;
          // Resizing resets origin cleanliness, transforms and compositing.
          context = canvas.getContext("2d", {
            willReadFrequently: true,
            colorSpace: "srgb",
          }) as typeof context;
          if (!context)
            return report(
              texture,
              "TC_TEXTURE_CANVAS_UNAVAILABLE",
              "Canvas2D is unavailable in this realm.",
            );
          context.drawImage(input, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height, {
            colorSpace: "srgb",
          });
          if (pixels.data.length !== width * height * 4)
            return report(
              texture,
              "TC_TEXTURE_CAPACITY",
              "Canvas2D could not allocate the requested RGBA8 image.",
            );
          reads++;
          cached = {
            image: input,
            version: source.version,
            width,
            height,
            url,
            data: pixels.data,
          };
          sources.set(source, cached);
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          // A failed read never leaves a tainted or partially initialized canvas.
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          canvas = undefined;
          context = undefined;
          return report(
            texture,
            name === "SecurityError"
              ? "TC_TEXTURE_CROSS_ORIGIN"
              : name === "RangeError" || name === "IndexSizeError"
                ? "TC_TEXTURE_CAPACITY"
                : "TC_TEXTURE_READ_FAILED",
            name === "SecurityError"
              ? "Serve the image with CORS permission and set crossOrigin before src."
              : "Canvas2D could not read this image; check decoding, image lifetime and host memory/canvas capacity.",
          );
        }
      }
      diagnostics.delete(texture.uuid);
      // Typed arrays cannot be frozen. Never expose the cached buffer to callers.
      try {
        return Object.freeze({
          width,
          height,
          data: cached.data.slice(),
          channels: 4,
          encoding: "unorm8",
          origin: "image",
        });
      } catch {
        return report(
          texture,
          "TC_TEXTURE_CAPACITY",
          "The host could not allocate an independent RGBA8 result.",
        );
      }
    },
    inspect() {
      return {
        disposed,
        requests,
        canvasReads: reads,
        cacheHits: hits,
        nativeDelegations: delegated,
        textures: textures.size,
        sources: sources.size,
        capacity: {
          policy: "host" as const,
          maxBytes: null,
          retainedBytes: Array.from(sources.values()).reduce(
            (n, p) => n + p.data.byteLength,
            0,
          ),
          canvasBytes: canvas ? canvas.width * canvas.height * 4 : 0,
          unknownResources: diagnostics.size,
        },
        diagnostics: Array.from(diagnostics.values(), (d) => ({ ...d })),
      };
    },
    clear,
    dispose() {
      clear();
      disposed = true;
    },
  };
}
