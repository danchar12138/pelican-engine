import path from "node:path";
import { InspectionContext } from "./errors.ts";

export function inspectWAV(
  data: Buffer,
  ctx: InspectionContext,
): Record<string, unknown> {
  if (data.toString("latin1", 0, 4) !== "RIFF") {
    const magic = data.toString("latin1", 0, 4);
    if (
      path.extname(ctx.file).toLowerCase() === ".wav" &&
      !["RF64", "RIFX"].includes(magic)
    )
      ctx.invalid("WAV/header", "Missing or damaged RIFF header.");
    ctx.unsupported(
      "audio/format",
      "Only little-endian RIFF/WAVE PCM and IEEE float audio are implemented.",
    );
  }
  ctx.check(
    data.length >= 12 && data.toString("latin1", 8, 12) === "WAVE",
    "WAV/header",
    "Missing or truncated WAVE header.",
  );
  ctx.check(
    data.readUInt32LE(4) + 8 === data.length,
    "WAV/length",
    "RIFF length does not match the file.",
  );
  let offset = 12;
  let format:
    | {
        encoding: number;
        channels: number;
        sampleRate: number;
        bitsPerSample: number;
        blockAlign: number;
      }
    | undefined;
  let samples: Buffer | undefined;
  let factFrames: number | undefined;
  while (offset < data.length) {
    ctx.check(
      offset + 8 <= data.length,
      "WAV/chunk",
      "Truncated chunk header.",
    );
    const id = data.toString("latin1", offset, offset + 4),
      size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size,
      padded = end + (size % 2);
    ctx.check(
      padded <= data.length,
      `WAV/${id}`,
      "Chunk exceeds RIFF boundary or is missing padding.",
    );
    const chunk = data.subarray(offset + 8, end);
    if (id === "fmt ") {
      ctx.check(
        !format && !samples && size >= 16,
        "WAV/fmt",
        "Missing, duplicate, misplaced or truncated format chunk.",
      );
      const encoding = chunk.readUInt16LE(0),
        channels = chunk.readUInt16LE(2),
        sampleRate = chunk.readUInt32LE(4);
      const byteRate = chunk.readUInt32LE(8),
        blockAlign = chunk.readUInt16LE(12),
        bitsPerSample = chunk.readUInt16LE(14);
      if (![1, 3].includes(encoding))
        ctx.unsupported(
          "WAV/encoding",
          `WAVE format tag ${encoding} is not implemented (PCM=1, float=3).`,
        );
      ctx.check(
        size === 16 || (size >= 18 && chunk.readUInt16LE(16) === size - 18),
        "WAV/fmt",
        "Invalid format extension length.",
      );
      ctx.check(
        channels > 0 &&
          sampleRate > 0 &&
          (encoding === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bitsPerSample),
        "WAV/fmt",
        "Invalid channels, sample rate or sample size.",
      );
      ctx.check(
        blockAlign === (channels * bitsPerSample) / 8 &&
          byteRate === sampleRate * blockAlign,
        "WAV/fmt",
        "Inconsistent block alignment or byte rate.",
      );
      format = { encoding, channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === "fact") {
      ctx.check(
        factFrames === undefined && size >= 4,
        "WAV/fact",
        "Duplicate or truncated fact chunk.",
      );
      factFrames = chunk.readUInt32LE(0);
    } else if (id === "data") {
      ctx.check(
        format && !samples,
        "WAV/data",
        "Missing format chunk or duplicate data chunk.",
      );
      ctx.check(
        size > 0 && size % format.blockAlign === 0,
        "WAV/data",
        "Empty or incomplete sample frame.",
      );
      samples = chunk;
    }
    offset = padded;
  }
  ctx.check(
    format && samples,
    "WAV/chunks",
    "Both fmt and data chunks are required.",
  );
  if (format.encoding === 3) {
    const step = format.bitsPerSample / 8;
    for (let i = 0; i < samples.length; i += step)
      ctx.check(
        Number.isFinite(
          step === 4 ? samples.readFloatLE(i) : samples.readDoubleLE(i),
        ),
        "WAV/data",
        "Non-finite floating point sample.",
      );
  }
  const frameCount = samples.length / format.blockAlign;
  ctx.check(
    format.encoding !== 3 || factFrames !== undefined,
    "WAV/fact",
    "IEEE float WAVE requires a fact sample count.",
  );
  if (factFrames !== undefined)
    ctx.check(
      factFrames === frameCount,
      "WAV/fact",
      "Fact sample count does not match data frames.",
    );
  return {
    format: "wav",
    encoding: format.encoding === 1 ? "pcm" : "ieee-float",
    channels: format.channels,
    sampleRate: format.sampleRate,
    bitsPerSample: format.bitsPerSample,
    frameCount,
    duration: frameCount / format.sampleRate,
    dataBytes: samples.length,
  };
}
