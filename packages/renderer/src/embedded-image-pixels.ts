import { decode, hasPngSignature } from "fast-png";
import { Unzlib, zlibSync } from "fflate";
import type * as THREE from "three";
import type { SurfacePixelData } from "./surface.ts";

type Source = THREE.Texture["source"];
type Entry = {
  image: unknown;
  imageUrl: string;
  pixels?: SurfacePixelData;
  error?: string;
};
// Weak keys let decoded pixels die with Three's shared source.
const embedded = new WeakMap<Source, Entry>();
const MAX_BYTES = 256 * 1024 * 1024;
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function pngChunk(type: Uint8Array, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < chunk.length - 4; i++) {
    crc ^= chunk[i];
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

function unpackAdam7(
  data: Uint8Array,
  width: number,
  height: number,
  depth: number,
): Uint8Array {
  const rowBytes = Math.ceil((width * depth) / 8);
  const rows = new Uint8Array((rowBytes + 1) * height);
  let offset = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const w = Math.max(0, Math.ceil((width - x0) / dx));
    const h = Math.max(0, Math.ceil((height - y0) / dy));
    if (!w || !h) continue;
    const size = Math.ceil((w * depth) / 8);
    let previous = new Uint8Array(size);
    for (let y = 0; y < h; y++) {
      const filter = data[offset++];
      if (filter > 4) throw new Error("Invalid PNG filter");
      const line = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        const left = i ? line[i - 1] : 0,
          up = previous[i],
          upperLeft = i ? previous[i - 1] : 0;
        const p = left + up - upperLeft;
        const a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - upperLeft);
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : a <= b && a <= c
                    ? left
                    : b <= c
                      ? up
                      : upperLeft;
        line[i] = (data[offset++] + predictor) & 255;
      }
      for (let x = 0; x < w; x++) {
        const value =
          (line[Math.floor((x * depth) / 8)] >>
            (8 - depth - ((x * depth) % 8))) &
          ((1 << depth) - 1);
        const targetX = x0 + x * dx;
        rows[
          (y0 + y * dy) * (rowBytes + 1) + 1 + Math.floor((targetX * depth) / 8)
        ] |= value << (8 - depth - ((targetX * depth) % 8));
      }
      previous = line;
    }
  }
  return rows;
}

function imageUrl(image: unknown): string {
  const value = image as { src?: string; currentSrc?: string } | null;
  return `${value?.src ?? ""}\n${value?.currentSrc ?? ""}`;
}

export function decodeEmbeddedPng(bytes: Uint8Array): SurfacePixelData {
  try {
    if (!hasPngSignature(bytes) || bytes.length < 33)
      throw new Error("Invalid PNG signature or header");
    if (bytes.length > MAX_BYTES)
      throw new Error("PNG input exceeds 256 MiB limit");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
      throw new Error("Invalid PNG IHDR");
    const depth = bytes[24],
      color = bytes[25],
      interlace = bytes[28];
    const width = view.getUint32(16),
      height = view.getUint32(20);
    if (
      !width ||
      !height ||
      width > 0x7fffffff ||
      height > 0x7fffffff ||
      width * height * 4 > MAX_BYTES
    )
      throw new Error("PNG dimensions exceed the 256 MiB RGBA limit");
    if (
      ![0, 2, 3, 4, 6].includes(color) ||
      ![1, 2, 4, 8, 16].includes(depth) ||
      (depth < 8 && color !== 0 && color !== 3) ||
      (depth === 16 && color === 3)
    )
      throw new Error(`Unsupported PNG color type ${color} / depth ${depth}`);
    if (interlace !== 0 && interlace !== 1)
      throw new Error("Invalid PNG interlace method");
    const channels =
      color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : 4;
    const rowBytes = Math.ceil((width * channels * depth) / 8);
    let expected = (rowBytes + 1) * height;
    if (interlace === 1) {
      expected = 0;
      for (const [x, y, dx, dy] of ADAM7) {
        const w = Math.max(0, Math.ceil((width - x) / dx)),
          h = Math.max(0, Math.ceil((height - y) / dy));
        if (w && h) expected += (Math.ceil((w * channels * depth) / 8) + 1) * h;
      }
    }
    if (expected > MAX_BYTES)
      throw new Error("PNG inflated data exceeds the 256 MiB limit");
    const lowAdam7 = interlace === 1 && depth < 8;
    const idat: Uint8Array[] = [];
    const chunks: { offset: number; length: number; type: number }[] = [];
    let ended = false,
      headers = 0,
      smallRgbTransparency: { offset: number; key: Uint16Array } | undefined;
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12)
        throw new Error("Truncated PNG chunk");
      const type = view.getUint32(offset + 4);
      if (lowAdam7) {
        let crc = 0xffffffff;
        for (let i = offset + 4; i < offset + 8 + length; i++) {
          crc ^= bytes[i];
          for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(offset + 8 + length))
          throw new Error("Invalid PNG chunk CRC");
        chunks.push({ offset, length, type });
      }
      if (type === 0x49484452 && ++headers !== 1)
        throw new Error("Multiple PNG headers");
      if (type === 0x504c5445 && (length === 0 || length > 768))
        throw new Error("Invalid PNG palette size");
      if (type === 0x74524e53 && length > 256)
        throw new Error("Invalid PNG transparency size");
      // fast-png incorrectly rejects an RGB tRNS key when there are fewer than
      // three pixels. Validate and remove just that chunk before decoding.
      if (
        depth === 16 &&
        color === 2 &&
        width * height < 3 &&
        type === 0x74524e53
      ) {
        if (smallRgbTransparency || length !== 6)
          throw new Error("Invalid PNG transparency key");
        let crc = 0xffffffff;
        for (let i = offset + 4; i < offset + 8 + length; i++) {
          crc ^= bytes[i];
          for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        if ((crc ^ 0xffffffff) >>> 0 !== view.getUint32(offset + 8 + length))
          throw new Error("Invalid PNG transparency CRC");
        smallRgbTransparency = {
          offset,
          key: new Uint16Array([
            view.getUint16(offset + 8),
            view.getUint16(offset + 10),
            view.getUint16(offset + 12),
          ]),
        };
      }
      if (type === 0x6163544c) throw new Error("Animated PNG is unsupported");
      if (depth === 16) {
        const at = offset + 8;
        const srgbChroma = [
          31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000,
        ];
        if (
          type === 0x67414d41 &&
          (length !== 4 || ![45455, 100000].includes(view.getUint32(at)))
        )
          throw new Error("16-bit PNG gAMA value is unsupported");
        if (
          type === 0x6348524d &&
          (length !== 32 ||
            srgbChroma.some((value, i) => view.getUint32(at + 4 * i) !== value))
        )
          throw new Error("16-bit PNG cHRM values are unsupported");
        if (type === 0x73524742 && (length !== 1 || bytes[at] !== 0))
          throw new Error("16-bit PNG sRGB intent is unsupported");
        if (
          type === 0x63494350 &&
          (length !== 4 ||
            [1, 13, 0, 1].some((value, i) => bytes[at + i] !== value))
        )
          throw new Error("16-bit PNG cICP values are unsupported");
      }
      // fast-png inflates ICC profiles separately without an output bound.
      if (type === 0x69434350)
        throw new Error("Embedded PNG ICC profiles are unsupported");
      if (type === 0x49444154)
        idat.push(bytes.subarray(offset + 8, offset + 8 + length));
      if (
        (bytes[offset + 4] & 32) === 0 &&
        ![0x49484452, 0x504c5445, 0x49444154, 0x49454e44].includes(type)
      )
        throw new Error("Unknown critical PNG chunk");
      offset += length + 12;
      if (type === 0x49454e44) {
        ended = true;
        break;
      }
    }
    if (!ended || !idat.length) throw new Error("Missing PNG IDAT or IEND");
    // Bound streaming inflation before fast-png sees untrusted IDAT. Small
    // compressed pushes bound temporary output even for extreme ratios.
    let inflated = 0;
    const inflatedData = lowAdam7 ? new Uint8Array(expected) : undefined;
    const inflater = new Unzlib((part: Uint8Array) => {
      const start = inflated;
      inflated += part.length;
      if (inflated > expected)
        throw new Error("PNG inflated data exceeds IHDR size");
      inflatedData?.set(part, start);
    });
    for (const part of idat)
      for (let i = 0; i < part.length; i += 512)
        inflater.push(part.subarray(i, i + 512), false);
    inflater.push(new Uint8Array(0), true);
    if (inflated !== expected)
      throw new Error("PNG inflated data does not match IHDR size");
    let decoderBytes = bytes;
    if (inflatedData) {
      // fast-png 8 treats packed Adam7 samples as full bytes. Repack the
      // validated passes as ordinary scanlines before invoking its decoder.
      const packed = unpackAdam7(inflatedData, width, height, depth);
      const compressed = zlibSync(packed);
      const pieces: Uint8Array[] = [bytes.subarray(0, 8)];
      let wroteIdat = false;
      for (const { offset, length, type } of chunks) {
        if (type === 0x49484452) {
          const header = bytes.slice(offset + 8, offset + 8 + length);
          header[12] = 0;
          pieces.push(pngChunk(bytes.subarray(offset + 4, offset + 8), header));
        } else if (type === 0x49444154) {
          if (!wroteIdat)
            pieces.push(
              pngChunk(bytes.subarray(offset + 4, offset + 8), compressed),
            );
          wroteIdat = true;
        } else pieces.push(bytes.subarray(offset, offset + length + 12));
      }
      const size = pieces.reduce((sum, part) => sum + part.length, 0);
      if (size > MAX_BYTES)
        throw new Error("Repacked PNG exceeds the 256 MiB limit");
      decoderBytes = new Uint8Array(size);
      let at = 0;
      for (const part of pieces) {
        decoderBytes.set(part, at);
        at += part.length;
      }
    }
    if (smallRgbTransparency) {
      decoderBytes = new Uint8Array(bytes.length - 18);
      decoderBytes.set(bytes.subarray(0, smallRgbTransparency.offset));
      decoderBytes.set(
        bytes.subarray(smallRgbTransparency.offset + 18),
        smallRgbTransparency.offset,
      );
    }
    const png = decode(decoderBytes, { checkCrc: true });
    const { data, palette } = png;
    const transparency = smallRgbTransparency?.key ?? png.transparency;
    if (png.width !== width || png.height !== height)
      throw new Error("Inconsistent PNG dimensions");
    if (
      data.length !==
      (depth === 16 ? width * height * channels : rowBytes * height)
    )
      throw new Error("Invalid decoded PNG data length");
    if (
      transparency &&
      transparency.length !== (color === 0 ? 1 : color === 2 ? 3 : 0)
    )
      throw new Error("Invalid PNG transparency key");
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const out = (y * width + x) * 4,
          pos =
            depth === 16
              ? (y * width + x) * channels
              : y * rowBytes + x * channels;
        if (color === 3 || color === 0) {
          const raw =
            depth >= 8
              ? data[pos]
              : (data[y * rowBytes + Math.floor((x * depth) / 8)] >>
                  (8 - depth - ((x * depth) % 8))) &
                ((1 << depth) - 1);
          if (color === 3) {
            const entry = palette?.[raw];
            if (!entry || (entry.length !== 3 && entry.length !== 4))
              throw new Error("Invalid PNG palette index");
            rgba[out] = entry[0];
            rgba[out + 1] = entry[1];
            rgba[out + 2] = entry[2];
            rgba[out + 3] = entry[3] ?? 255;
          } else {
            const gray =
              depth === 16 ? raw >>> 8 : (raw * 255) / ((1 << depth) - 1);
            rgba[out] = rgba[out + 1] = rgba[out + 2] = gray;
            rgba[out + 3] = transparency?.[0] === raw ? 0 : 255;
          }
        } else {
          const r = data[pos],
            g = color === 4 ? r : data[pos + 1],
            b = color === 4 ? r : data[pos + 2];
          const alpha =
            color === 4
              ? data[pos + 1]
              : color === 6
                ? data[pos + 3]
                : transparency &&
                    transparency[0] === r &&
                    transparency[1] === g &&
                    transparency[2] === b
                  ? 0
                  : 255;
          rgba[out] = depth === 16 ? r >>> 8 : r;
          rgba[out + 1] = depth === 16 ? g >>> 8 : g;
          rgba[out + 2] = depth === 16 ? b >>> 8 : b;
          rgba[out + 3] =
            depth === 16 && (color === 4 || color === 6) ? alpha >>> 8 : alpha;
        }
      }
    return {
      width,
      height,
      data: rgba,
      channels: 4,
      encoding: "unorm8",
      origin: "image",
    };
  } catch (error) {
    throw new Error(
      `TC_TEXTURE_PNG_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Associates immutable decoded content with the shared source, never userData. */
export function associateEmbeddedImage(
  texture: THREE.Texture,
  bytes: Uint8Array,
  mime: string,
): void {
  const source = texture.source;
  if (embedded.has(source)) return;
  if (!hasPngSignature(bytes) && mime.toLowerCase() !== "image/png") return;
  const entry: Entry = { image: source.data, imageUrl: imageUrl(source.data) };
  try {
    entry.pixels = decodeEmbeddedPng(bytes);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  embedded.set(source, entry);
}

export function embeddedImagePixels(
  texture: THREE.Texture,
): SurfacePixelData | undefined {
  const source = texture.source,
    entry = embedded.get(source);
  if (!entry) return undefined;
  if (entry.error) throw new Error(entry.error);
  if (source.data !== entry.image || imageUrl(source.data) !== entry.imageUrl)
    throw new Error(
      "TC_TEXTURE_PNG_SOURCE_CHANGED: embedded PNG source changed after decoding; reload the model",
    );
  if (
    typeof ImageBitmap !== "undefined" &&
    source.data instanceof ImageBitmap &&
    !source.data.width
  )
    throw new Error(
      "TC_TEXTURE_PNG_IMAGE_CLOSED: retain the image until extraction completes",
    );
  return entry.pixels;
}

export function releaseEmbeddedImage(texture: THREE.Texture): void {
  const source = texture.source;
  if (embedded.has(source))
    embedded.set(source, {
      image: source.data,
      imageUrl: imageUrl(source.data),
      error: "TC_TEXTURE_PNG_SOURCE_RELEASED: model resources were disposed",
    });
}
