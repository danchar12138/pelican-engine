import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decode } from "fast-png";
import * as THREE from "three";
import {
  associateEmbeddedImage,
  decodeEmbeddedPng,
  embeddedImagePixels,
  releaseEmbeddedImage,
} from "../packages/renderer/src/embedded-image-pixels.ts";

const passes = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
function chunk(name: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(name, 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function fixture(
  width: number,
  height: number,
  depth: number,
  indexed: boolean,
  filter: number,
  transparent = true,
) {
  const max = (1 << depth) - 1;
  const samples = Array.from(
    { length: width * height },
    (_, i) => (i * 7 + Math.floor(i / width) * 3) & max,
  );
  const lines: number[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const xs = Array.from(
      { length: Math.max(0, Math.ceil((width - x0) / dx)) },
      (_, i) => x0 + i * dx,
    );
    if (!xs.length) continue;
    let prev = new Uint8Array(Math.ceil((xs.length * depth) / 8));
    for (let y = y0; y < height; y += dy) {
      const row = new Uint8Array(prev.length);
      xs.forEach(
        (x, i) =>
          (row[Math.floor((i * depth) / 8)] |=
            samples[y * width + x] << (8 - depth - ((i * depth) % 8))),
      );
      lines.push(filter);
      row.forEach((v, i) => {
        const a = i ? row[i - 1] : 0,
          b = prev[i],
          c = i ? prev[i - 1] : 0;
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        const pred =
          filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : pa <= pb && pa <= pc
                    ? a
                    : pb <= pc
                      ? b
                      : c;
        lines.push((v - pred) & 255);
      });
      prev = row;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = indexed ? 3 : 0;
  header[12] = 1;
  const palette = Buffer.from(
    Array.from({ length: max + 1 }, (_, i) => [
      i * 13,
      255 - i * 11,
      i * 7,
    ]).flat(),
  );
  const alpha = Buffer.from(
    Array.from({ length: max + 1 }, (_, i) => (i * 255) / max),
  );
  const extras = indexed
    ? [chunk("PLTE", palette), ...(transparent ? [chunk("tRNS", alpha)] : [])]
    : transparent
      ? [chunk("tRNS", Buffer.from([0, max]))]
      : [];
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...extras,
    chunk("IDAT", deflateSync(Buffer.from(lines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const expected = samples.flatMap((v) =>
    indexed
      ? [
          palette[v * 3],
          palette[v * 3 + 1],
          palette[v * 3 + 2],
          transparent ? alpha[v] : 255,
        ]
      : [
          (v * 255) / max,
          (v * 255) / max,
          (v * 255) / max,
          transparent && v === max ? 0 : 255,
        ],
  );
  return { bytes, expected };
}

test("low-depth Adam7 matches original samples across dimensions, filters and transparency", () => {
  for (const depth of [1, 2, 4])
    for (const indexed of [false, true])
      for (const [w, h] of [
        [1, 1],
        [1, 9],
        [9, 1],
        [2, 3],
        [7, 8],
        [9, 11],
        [17, 13],
      ])
        for (const filter of [0, 1, 2, 3, 4])
          for (const transparent of [false, true]) {
            const { bytes, expected } = fixture(
              w,
              h,
              depth,
              indexed,
              filter,
              transparent,
            );
            assert.deepEqual(
              Array.from(decodeEmbeddedPng(bytes).data),
              expected,
              `depth=${depth} indexed=${indexed} ${w}x${h} filter=${filter} trns=${transparent}`,
            );
          }
});

test("fast-png 8 Adam7 does not decode packed samples correctly", () => {
  const { bytes } = fixture(9, 11, 2, false, 0, false);
  let wrong = false;
  try {
    const decoded = decode(bytes);
    wrong = decoded.data.length !== Math.ceil((9 * 2) / 8) * 11;
  } catch {
    wrong = true;
  }
  assert.equal(wrong, true);
});

test("cache shares decoded pixels, reports failures, source changes and disposal", () => {
  const { bytes, expected } = fixture(9, 3, 4, true, 4);
  const texture = new THREE.Texture({ src: "a" } as any),
    clone = texture.clone();
  associateEmbeddedImage(texture, bytes, "image/png");
  assert.equal(embeddedImagePixels(texture), embeddedImagePixels(clone));
  assert.deepEqual(Array.from(embeddedImagePixels(clone)!.data), expected);
  texture.source.data.src = "b";
  assert.throws(() => embeddedImagePixels(clone), /SOURCE_CHANGED/);
  releaseEmbeddedImage(texture);
  assert.throws(() => embeddedImagePixels(clone), /SOURCE_RELEASED/);
  const bad = new THREE.Texture();
  associateEmbeddedImage(bad, bytes.subarray(0, 33), "image/png");
  assert.throws(() => embeddedImagePixels(bad), /TC_TEXTURE_PNG_UNSUPPORTED/);
});

test("limits, CRC and invalid filters fail explicitly", () => {
  const { bytes } = fixture(9, 11, 2, false, 0);
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32BE(0x7fffffff, 16);
  assert.throws(() => decodeEmbeddedPng(oversized), /256 MiB/);
  const badCrc = Buffer.from(bytes);
  badCrc[29] ^= 1;
  assert.throws(() => decodeEmbeddedPng(badCrc), /CRC/);
  const invalid = fixture(9, 11, 2, false, 5).bytes;
  assert.throws(() => decodeEmbeddedPng(invalid), /Invalid PNG filter/);
});
