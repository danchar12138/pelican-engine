import { InspectionContext } from "./errors.ts";

/** Validate the RGBE subset supported by Three's HDRLoader before allocation. */
export function inspectHDR(data: Buffer, ctx: InspectionContext): Record<string, unknown> {
  const headerLimit = Math.min(data.length, 65536);
  let offset = 0;
  const line = (): string => {
    const end = data.indexOf(10, offset);
    ctx.check(end >= offset && end < headerLimit, "HDR/header", "Header is truncated or exceeds 64 KiB.");
    const text = data.toString("latin1", offset, end).replace(/\r$/, "");
    offset = end + 1;
    return text;
  };
  ctx.check(/^#\?(RADIANCE|RGBE)$/.test(line()), "HDR/signature", "Expected a Radiance RGBE signature.");
  let format = false, dimensions: RegExpMatchArray | null = null;
  const metadata: Record<string, number> = {};
  while (offset < headerLimit) {
    const text = line();
    if (text.startsWith("FORMAT=")) {
      ctx.check(!format && text === "FORMAT=32-bit_rle_rgbe", "HDR/format", "Expected one 32-bit_rle_rgbe format declaration.");
      format = true;
    }
    const value = text.match(/^\s*(GAMMA|EXPOSURE)\s*=\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*$/);
    if (value) {
      const number = Number(value[2]);
      ctx.check(Number.isFinite(number) && number > 0, `HDR/${value[1]}`, "Expected positive finite metadata.");
      if (metadata[value[1]] !== undefined) ctx.invalid(`HDR/${value[1]}`, "Duplicate metadata declaration.");
      metadata[value[1]] = number;
      if (number !== 1) ctx.unsupported(`HDR/${value[1]}`, "Non-default gamma/exposure metadata is not applied by the linear RGBE runtime decoder.");
    } else if (/^\s*(GAMMA|EXPOSURE)\s*=/.test(text)) {
      ctx.invalid("HDR/header", "Malformed GAMMA or EXPOSURE metadata.");
    }
    const match = text.match(/^-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/);
    if (match) { dimensions = match; break; }
  }
  ctx.check(format && dimensions, "HDR/header", "Missing RGBE format or -Y/+X dimensions.");
  const height = Number(dimensions[1]), width = Number(dimensions[2]);
  ctx.check(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= 16777216,
    "HDR/dimensions", "Dimensions must be positive and contain at most 16777216 pixels.");
  const hasModernRleMarker = width >= 8 && width <= 32767 && data[offset] === 2 && data[offset + 1] === 2 && (data[offset + 2] & 128) === 0;
  if (hasModernRleMarker && ((data[offset + 2] << 8) | data[offset + 3]) !== width)
    ctx.invalid("HDR/scanline", "RLE scanline width differs from the declared image width.");
  const rle = hasModernRleMarker;
  if (!rle) {
    ctx.check(data.length - offset === width * height * 4, "HDR/pixels", "Uncompressed RGBE data must exactly match the image dimensions.");
  } else {
    for (let row = 0; row < height; row++) {
      ctx.check(offset + 4 <= data.length && data[offset] === 2 && data[offset + 1] === 2 &&
        ((data[offset + 2] << 8) | data[offset + 3]) === width, `HDR/row/${row}`, "Invalid scanline header.");
      offset += 4;
      for (let channel = 0; channel < 4; channel++) {
        let count = 0;
        while (count < width) {
          ctx.check(offset < data.length, `HDR/row/${row}`, "Truncated scanline.");
          const token = data[offset++], run = token > 128 ? token - 128 : token;
          ctx.check(run > 0 && count + run <= width, `HDR/row/${row}`, "Invalid scanline run.");
          const bytes = token > 128 ? 1 : run;
          ctx.check(offset + bytes <= data.length, `HDR/row/${row}`, "Truncated scanline data.");
          offset += bytes;
          count += run;
        }
      }
    }
    ctx.check(offset === data.length, "HDR/pixels", "Unexpected bytes after the final scanline.");
  }
  return { format: "hdr", width, height, channels: 3, encoding: "rgbe", colorSpace: "linear" };
}
