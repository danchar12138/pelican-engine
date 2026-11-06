import path from "node:path";
import { inflateSync } from "node:zlib";
import { InspectionContext } from "./errors.ts";
import { inspectJPEG } from "./jpeg.ts";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data: Uint8Array): number {
  let n = 0xffffffff;
  for (const b of data) n = crcTable[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}

// A bounded, fully checked decode of the lossless pixel stream. No browser or native service.
function inspectPNG(
  data: Buffer,
  ctx: InspectionContext,
): Record<string, unknown> {
  let offset = 8,
    width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  let paletteEntries = 0,
    ended = false,
    idatClosed = false;
  const compressed: Buffer[] = [];
  const seen = new Set<string>();
  while (offset < data.length) {
    ctx.check(
      offset + 12 <= data.length,
      "PNG/chunk",
      "Truncated chunk header.",
    );
    const size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + size;
    ctx.check(
      end <= data.length &&
        /^[A-Za-z]{4}$/.test(type) &&
        type[2] === type[2].toUpperCase(),
      `PNG/${type}`,
      "Invalid chunk type or chunk length exceeds file.",
    );
    ctx.check(
      data.readUInt32BE(end - 4) === crc32(data.subarray(offset + 4, end - 4)),
      `PNG/${type}`,
      "Chunk CRC mismatch.",
    );
    const chunk = data.subarray(offset + 8, end - 4);
    ctx.check(
      seen.has("IHDR") || type === "IHDR",
      "PNG/IHDR",
      "IHDR must be first.",
    );
    if (type === "IHDR") {
      ctx.check(
        !seen.has(type) && size === 13,
        "PNG/IHDR",
        "Invalid or duplicate IHDR.",
      );
      width = ctx.integer(chunk.readUInt32BE(0), "PNG/width", 1, 0x7fffffff);
      height = ctx.integer(chunk.readUInt32BE(4), "PNG/height", 1, 0x7fffffff);
      bitDepth = chunk[8];
      colorType = chunk[9];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      ctx.check(
        depths[colorType]?.includes(bitDepth),
        "PNG/IHDR",
        "Invalid bit depth/color type.",
      );
      ctx.check(
        chunk[10] === 0 && chunk[11] === 0 && chunk[12] <= 1,
        "PNG/IHDR",
        "Invalid compression, filter or interlace method.",
      );
      interlace = chunk[12];
    } else if (type === "PLTE") {
      ctx.check(
        !seen.has(type) &&
          !compressed.length &&
          size > 0 &&
          size % 3 === 0 &&
          size <= 768 &&
          ![0, 4].includes(colorType),
        "PNG/PLTE",
        "Invalid, duplicate or misplaced palette.",
      );
      paletteEntries = size / 3;
      ctx.check(
        colorType !== 3 || paletteEntries <= 2 ** bitDepth,
        "PNG/PLTE",
        "Palette exceeds bit depth.",
      );
    } else if (type === "IDAT") {
      ctx.check(
        !idatClosed && (colorType !== 3 || paletteEntries > 0),
        "PNG/IDAT",
        "Non-contiguous IDAT or missing palette.",
      );
      compressed.push(chunk);
    } else if (type === "IEND") {
      ctx.check(
        size === 0 && compressed.length > 0 && end === data.length,
        "PNG/IEND",
        "Invalid end chunk, missing pixels or trailing bytes.",
      );
      ended = true;
    } else {
      if (compressed.length) idatClosed = true;
      if (type === "tRNS") {
        ctx.check(
          !seen.has(type) &&
            !compressed.length &&
            ((colorType === 0 && size === 2) ||
              (colorType === 2 && size === 6) ||
              (colorType === 3 && size > 0 && size <= paletteEntries)),
          "PNG/tRNS",
          "Invalid transparency chunk.",
        );
      } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
        ctx.unsupported(`PNG/${type}`, "Animated PNG is not implemented.");
      } else if (type[0] === type[0].toUpperCase()) {
        ctx.unsupported(`PNG/${type}`, "Unknown critical PNG chunk.");
      }
    }
    seen.add(type);
    offset = end;
  }
  ctx.check(ended, "PNG/IEND", "Missing IEND chunk.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
    colorType
  ];
  const patterns = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const passes = patterns.map(([x, y, dx, dy]) => {
    const passWidth = Math.max(0, Math.ceil((width - x) / dx));
    const passHeight = Math.max(0, Math.ceil((height - y) / dy));
    const rowBytes = Math.ceil((passWidth * channels * bitDepth) / 8);
    return { width: passWidth, height: passHeight, rowBytes };
  });
  const decodedSize = passes.reduce(
    (sum, pass) =>
      sum + (pass.width && pass.height ? (pass.rowBytes + 1) * pass.height : 0),
    0,
  );
  if (decodedSize > 256 * 1024 * 1024)
    ctx.unsupported(
      "PNG/pixels",
      "Decoded image exceeds the 256 MiB inspection limit.",
    );
  let pixels: Buffer;
  const encoded = Buffer.concat(compressed);
  try {
    const inflated = inflateSync(encoded, {
      maxOutputLength: decodedSize + 1,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    ctx.check(
      inflated.engine.bytesWritten === encoded.length,
      "PNG/IDAT",
      "Trailing compressed stream data.",
    );
    pixels = inflated.buffer;
  } catch (error) {
    if (error instanceof Error && error.name === "AssetInspectionError")
      throw error;
    ctx.invalid("PNG/IDAT", "Invalid or truncated zlib pixel stream.");
  }
  ctx.check(
    pixels.length === decodedSize,
    "PNG/IDAT",
    "Pixel stream length does not match dimensions.",
  );
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  let start = 0;
  for (const [passIndex, pass] of passes.entries()) {
    if (!pass.width || !pass.height) continue;
    const { rowBytes } = pass;
    let previous: Buffer = Buffer.alloc(rowBytes);
    for (let y = 0; y < pass.height; y++) {
      const resource = interlace
        ? `PNG/pass/${passIndex + 1}/row/${y}`
        : `PNG/row/${y}`;
      const filter = pixels[start];
      ctx.check(filter <= 4, resource, "Invalid PNG row filter.");
      const row = pixels.subarray(start + 1, start + 1 + rowBytes);
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? row[x - bpp] : 0,
          b = previous[x],
          c = x >= bpp ? previous[x - bpp] : 0;
        let predictor = 0;
        if (filter === 1) predictor = a;
        if (filter === 2) predictor = b;
        if (filter === 3) predictor = Math.floor((a + b) / 2);
        if (filter === 4) {
          const p = a + b - c,
            pa = Math.abs(p - a),
            pb = Math.abs(p - b),
            pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        row[x] = (row[x] + predictor) & 255;
      }
      if (colorType === 3)
        for (let x = 0; x < pass.width; x++) {
          const index =
            (row[Math.floor((x * bitDepth) / 8)] >>>
              (8 - bitDepth - ((x * bitDepth) % 8))) &
            ((1 << bitDepth) - 1);
          ctx.check(
            index < paletteEntries,
            resource,
            "Pixel references a missing palette entry.",
          );
        }
      previous = row;
      start += rowBytes + 1;
    }
  }
  return {
    format: "png",
    width,
    height,
    bitDepth,
    colorType,
    channels,
    hasAlpha: [4, 6].includes(colorType) || seen.has("tRNS"),
  };
}

export function inspectTexture(
  data: Buffer,
  ctx: InspectionContext,
): Record<string, unknown> {
  if (data.subarray(0, 8).equals(signature)) return inspectPNG(data, ctx);
  if (data[0] === 0xff && data[1] === 0xd8) return inspectJPEG(data, ctx);
  // Recognizable damaged signatures must not produce metadata.
  if (data.toString("latin1", 1, 4) === "PNG")
    ctx.invalid("PNG/signature", "Invalid PNG signature.");
  if ([".png", ".jpg", ".jpeg"].includes(path.extname(ctx.file).toLowerCase()))
    ctx.invalid("texture/signature", "Missing or damaged PNG/JPEG signature.");
  return ctx.unsupported(
    "texture/format",
    "Expected PNG or baseline JPEG image bytes.",
  );
}
