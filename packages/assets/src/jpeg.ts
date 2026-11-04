import { InspectionContext } from "./errors.ts";

type Huffman = Map<number, number>;
type Component = {
  id: number;
  h: number;
  v: number;
  q: number;
  dc?: number;
  ac?: number;
};

// Baseline sequential Huffman JPEG: validate every coefficient in the entropy stream.
// Pixel reconstruction/IDCT is unnecessary for dimensions and integrity inspection.
export function inspectJPEG(
  data: Buffer,
  ctx: InspectionContext,
): Record<string, unknown> {
  let offset = 2,
    width = 0,
    height = 0,
    restartInterval = 0;
  const quantization = new Set<number>();
  const tables = new Map<string, Huffman>();
  const components: Component[] = [];
  while (offset < data.length) {
    ctx.check(
      data[offset++] === 0xff,
      "JPEG/marker",
      "Expected marker prefix.",
    );
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    ctx.check(
      marker !== undefined &&
        marker !== 0 &&
        marker !== 0xd8 &&
        marker !== 0xd9 &&
        !(marker >= 0xd0 && marker <= 0xd7),
      "JPEG/marker",
      "Unexpected marker before image scan.",
    );
    ctx.check(
      offset + 2 <= data.length,
      "JPEG/segment",
      "Truncated segment length.",
    );
    const length = data.readUInt16BE(offset),
      end = offset + length;
    ctx.check(
      length >= 2 && end <= data.length,
      "JPEG/segment",
      "Segment length exceeds file.",
    );
    const segment = data.subarray(offset + 2, end);
    offset = end;
    if (marker === 0xdb) {
      let p = 0;
      while (p < segment.length) {
        const spec = segment[p++],
          precision = spec >>> 4,
          id = spec & 15;
        ctx.check(
          precision <= 1 &&
            id <= 3 &&
            p + 64 * (precision + 1) <= segment.length,
          "JPEG/DQT",
          "Invalid quantization table.",
        );
        if (precision)
          ctx.unsupported(
            "JPEG/DQT",
            "16-bit quantization tables are not baseline JPEG.",
          );
        for (let i = 0; i < 64; i++)
          ctx.check(
            segment[p++] > 0,
            "JPEG/DQT",
            "Zero quantization coefficient.",
          );
        quantization.add(id);
      }
      ctx.check(segment.length > 0, "JPEG/DQT", "Empty quantization segment.");
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < segment.length) {
        ctx.check(
          p + 17 <= segment.length,
          "JPEG/DHT",
          "Truncated Huffman table.",
        );
        const spec = segment[p++],
          kind = spec >>> 4,
          id = spec & 15;
        ctx.check(
          kind <= 1 && id <= 3,
          "JPEG/DHT",
          "Invalid Huffman table selector.",
        );
        const counts = segment.subarray(p, p + 16);
        p += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        ctx.check(
          total > 0 && total <= 256 && p + total <= segment.length,
          "JPEG/DHT",
          "Invalid Huffman symbol count.",
        );
        const table: Huffman = new Map();
        let code = 0;
        for (let bits = 1; bits <= 16; bits++) {
          ctx.check(
            code + counts[bits - 1] < 2 ** bits,
            "JPEG/DHT",
            "Oversubscribed Huffman tree or forbidden all-ones code.",
          );
          for (let i = 0; i < counts[bits - 1]; i++) {
            const value = segment[p++];
            ctx.check(
              kind === 0
                ? value <= 11
                : value === 0 ||
                    value === 0xf0 ||
                    ((value & 15) > 0 && (value & 15) <= 10),
              "JPEG/DHT",
              "Invalid baseline Huffman symbol.",
            );
            table.set((1 << bits) + code++, value);
          }
          code *= 2;
        }
        tables.set(`${kind}/${id}`, table);
      }
      ctx.check(segment.length > 0, "JPEG/DHT", "Empty Huffman segment.");
    } else if (marker === 0xc0) {
      ctx.check(
        !components.length && segment.length >= 6 && segment[0] === 8,
        "JPEG/SOF0",
        "Invalid baseline frame or duplicate frame header.",
      );
      height = segment.readUInt16BE(1);
      width = segment.readUInt16BE(3);
      const count = segment[5];
      ctx.check(
        width > 0 &&
          height > 0 &&
          count > 0 &&
          segment.length === 6 + count * 3,
        "JPEG/SOF0",
        "Invalid dimensions or frame component count.",
      );
      if (![1, 3].includes(count))
        ctx.unsupported(
          "JPEG/components",
          "Only grayscale and three-component baseline JPEG are implemented.",
        );
      for (let i = 0; i < count; i++) {
        const p = 6 + i * 3,
          id = segment[p],
          h = segment[p + 1] >>> 4,
          v = segment[p + 1] & 15,
          q = segment[p + 2];
        ctx.check(
          !components.some((c) => c.id === id) &&
            h > 0 &&
            h <= 4 &&
            v > 0 &&
            v <= 4 &&
            q <= 3,
          "JPEG/SOF0",
          "Invalid frame component or sampling factor.",
        );
        components.push({ id, h, v, q });
      }
      ctx.check(
        components.reduce((n, c) => n + c.h * c.v, 0) <= 10,
        "JPEG/SOF0",
        "Too many blocks per MCU.",
      );
      if (count === 1 && (components[0].h !== 1 || components[0].v !== 1))
        ctx.unsupported(
          "JPEG/sampling",
          "Grayscale sampling factors other than 1x1 are not implemented.",
        );
    } else if (marker === 0xdd) {
      ctx.check(
        segment.length === 2,
        "JPEG/DRI",
        "Invalid restart interval segment.",
      );
      restartInterval = segment.readUInt16BE(0);
    } else if (marker === 0xda) {
      ctx.check(
        components.length && segment.length >= 4,
        "JPEG/SOS",
        "Missing frame or truncated scan header.",
      );
      const count = segment[0];
      ctx.check(
        count > 0 && segment.length === 1 + count * 2 + 3,
        "JPEG/SOS",
        "Invalid scan component count.",
      );
      if (count !== components.length)
        ctx.unsupported(
          "JPEG/SOS",
          "Multiple/non-interleaved scans are not implemented.",
        );
      ctx.check(
        segment[segment.length - 3] === 0 &&
          segment[segment.length - 2] === 63 &&
          segment[segment.length - 1] === 0,
        "JPEG/SOS",
        "Invalid baseline spectral selection.",
      );
      const scan: Component[] = [];
      for (let i = 0; i < count; i++) {
        const id = segment[1 + i * 2],
          spec = segment[2 + i * 2],
          c = components.find((c) => c.id === id);
        ctx.check(
          c && !scan.includes(c),
          "JPEG/SOS",
          "Unknown or duplicate scan component.",
        );
        c.dc = spec >>> 4;
        c.ac = spec & 15;
        ctx.check(
          quantization.has(c.q) &&
            tables.has(`0/${c.dc}`) &&
            tables.has(`1/${c.ac}`),
          "JPEG/SOS",
          "Missing quantization or Huffman table.",
        );
        scan.push(c);
      }
      const hmax = Math.max(...components.map((c) => c.h)),
        vmax = Math.max(...components.map((c) => c.v));
      const mcus =
        Math.ceil(width / (8 * hmax)) * Math.ceil(height / (8 * vmax));
      if (mcus * components.reduce((n, c) => n + c.h * c.v, 0) > 8_000_000)
        ctx.unsupported(
          "JPEG/scan",
          "Image exceeds the inspection block limit.",
        );
      let bitsLeft = 0,
        current = 0,
        restart = 0;
      const bit = (): number => {
        if (!bitsLeft) {
          ctx.check(
            offset < data.length,
            "JPEG/entropy",
            "Truncated entropy stream.",
          );
          current = data[offset++];
          if (current === 0xff)
            ctx.check(
              data[offset++] === 0,
              "JPEG/entropy",
              "Unexpected marker or truncated entropy stream.",
            );
          bitsLeft = 8;
        }
        return (current >>> --bitsLeft) & 1;
      };
      const symbol = (table: Huffman): number => {
        let code = 0;
        for (let n = 1; n <= 16; n++) {
          code = code * 2 + bit();
          const value = table.get((1 << n) + code);
          if (value !== undefined) return value;
        }
        return ctx.invalid(
          "JPEG/entropy",
          "Entropy code is absent from Huffman table.",
        );
      };
      const align = () => {
        ctx.check(
          (current & ((1 << bitsLeft) - 1)) === (1 << bitsLeft) - 1,
          "JPEG/entropy",
          "Invalid entropy padding bits.",
        );
        bitsLeft = 0;
      };
      for (let mcu = 0; mcu < mcus; mcu++) {
        if (mcu && restartInterval && mcu % restartInterval === 0) {
          align();
          ctx.check(
            data[offset++] === 0xff &&
              data[offset++] === 0xd0 + (restart++ % 8),
            "JPEG/restart",
            "Missing or out-of-order restart marker.",
          );
        }
        for (const c of scan)
          for (let block = 0; block < c.h * c.v; block++) {
            const dcBits = symbol(tables.get(`0/${c.dc}`)!);
            for (let i = 0; i < dcBits; i++) bit();
            let coefficient = 1;
            while (coefficient < 64) {
              const ac = symbol(tables.get(`1/${c.ac}`)!);
              if (ac === 0) break;
              if (ac === 0xf0) coefficient += 16;
              else {
                coefficient += ac >>> 4;
                ctx.check(
                  coefficient < 64,
                  "JPEG/entropy",
                  "AC run exceeds block boundary.",
                );
                for (let i = 0; i < (ac & 15); i++) bit();
                coefficient++;
              }
              ctx.check(
                coefficient <= 64,
                "JPEG/entropy",
                "AC run exceeds block boundary.",
              );
            }
          }
      }
      align();
      ctx.check(
        data[offset++] === 0xff,
        "JPEG/EOI",
        "Missing end marker or excess entropy data.",
      );
      while (data[offset] === 0xff) offset++;
      ctx.check(
        data[offset++] === 0xd9 && offset === data.length,
        "JPEG/EOI",
        "Missing end marker, extra scan or trailing data.",
      );
      return {
        format: "jpeg",
        width,
        height,
        bitDepth: 8,
        channels: components.length,
        encoding: "baseline-huffman",
      };
    } else if (
      (marker >= 0xc1 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)) ||
      marker === 0xcc
    ) {
      ctx.unsupported(
        "JPEG/encoding",
        `JPEG frame/coding marker 0x${marker.toString(16)} is not baseline Huffman (SOF0).`,
      );
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      ctx.unsupported(
        "JPEG/marker",
        `JPEG marker 0x${marker.toString(16)} is not implemented.`,
      );
    }
  }
  return ctx.invalid("JPEG/SOS", "Missing image scan or truncated JPEG.");
}
