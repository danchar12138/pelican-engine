import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { encode } from "fast-png";
import * as THREE from "three";
import {
  associateEmbeddedImage,
  decodeEmbeddedPng,
} from "../packages/renderer/src/embedded-image-pixels.ts";
import { createTexturePixelProvider } from "../packages/renderer/src/texture-pixels.ts";

function chunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let value = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, crc]);
}
function png(
  width: number,
  depth: number,
  color: number,
  rows: number[],
  extra: Buffer[] = [],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header[8] = depth;
  header[9] = color;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(Buffer.from([0, ...rows]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function dataUriGLB(glb: Buffer, images: Uint8Array[]): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength));
  for (let i = 0; i < images.length; i++) {
    json.images[i].uri =
      `data:image/png;base64,${Buffer.from(images[i]).toString("base64")}`;
    delete json.images[i].bufferView;
  }
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20);
  jsonBytes.copy(padded);
  const header = Buffer.from(glb.subarray(0, 20));
  const tail = glb.subarray(20 + jsonLength);
  header.writeUInt32LE(20 + padded.length + tail.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, tail]);
}
const pixels = (data: Uint8Array) => Array.from(decodeEmbeddedPng(data).data);

test("16-bit PNG uses high bytes and compares tRNS before quantization", () => {
  const grayKey = chunk("tRNS", Buffer.from([0x12, 0x34]));
  const rgbKey = chunk("tRNS", Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]));
  assert.deepEqual(pixels(png(2, 16, 0, [0x12, 0x34, 0x12, 0x35], [grayKey])),
    [18, 18, 18, 0, 18, 18, 18, 255]);
  assert.deepEqual(pixels(png(2, 16, 2, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x12, 0x35, 0x56, 0x78, 0x9a, 0xbc], [rgbKey])),
    [18, 86, 154, 0, 18, 86, 154, 255]);
  const onePixel = png(1, 16, 2, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], [rgbKey]);
  assert.deepEqual(pixels(onePixel), [18, 86, 154, 0]);
  const badKeyCrc = Buffer.from(onePixel);
  badKeyCrc[47] ^= 1;
  assert.throws(() => decodeEmbeddedPng(badKeyCrc), /transparency CRC/);
  assert.throws(() => decodeEmbeddedPng(png(1, 16, 2, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc], [rgbKey, rgbKey])), /transparency key/);
  assert.deepEqual(pixels(png(2, 16, 4, [0x12, 0x34, 0, 0, 0x9a, 0xbc, 0x80, 0x01])),
    [18, 18, 18, 0, 154, 154, 154, 128]);
  assert.deepEqual(pixels(png(2, 16, 6, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0, 0, 0xff, 0xff, 0, 0xff, 0x80, 0, 0x80, 0])),
    [18, 86, 154, 0, 255, 0, 128, 128]);
  const oversized = png(1, 16, 0, [0x12, 0x34]);
  oversized.writeUInt32BE(0x7fffffff, 16);
  assert.throws(() => decodeEmbeddedPng(oversized), /256 MiB/);
  const inflated = png(1, 16, 6, [0, 0, 0, 0, 0, 0, 0, 0]);
  inflated.writeUInt32BE(8192, 16);
  inflated.writeUInt32BE(8192, 20);
  assert.throws(() => decodeEmbeddedPng(inflated), /inflated data exceeds the 256 MiB/);
  const bomb = png(1, 16, 6, new Array(1024 * 1024).fill(0));
  assert.throws(() => decodeEmbeddedPng(bomb), /inflated data exceeds IHDR/);
  const indexed = png(1, 16, 3, [0, 0]);
  assert.throws(() => decodeEmbeddedPng(indexed), /Unsupported PNG color type/);
  const chroma = Buffer.alloc(32);
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((value, i) => chroma.writeUInt32BE(value, i * 4));
  for (const [type, data] of [["gAMA", Buffer.from([0, 0, 177, 143])], ["gAMA", Buffer.from([0, 1, 134, 160])], ["cHRM", chroma], ["sRGB", Buffer.from([0])], ["cICP", Buffer.from([1, 13, 0, 1])]] as const)
    assert.deepEqual(pixels(png(1, 16, 6, [18, 52, 86, 120, 154, 188, 0, 0], [chunk(type, data)])), [18, 86, 154, 0]);
  for (const [type, data] of [["gAMA", [0, 0, 0, 1]], ["cHRM", new Array(32).fill(0)], ["sRGB", [1]], ["cICP", [9, 16, 0, 1]]] as const)
    assert.throws(() => decodeEmbeddedPng(png(1, 16, 0, [0, 0], [chunk(type, Buffer.from(data))])), /16-bit PNG .*unsupported/);
});

test("16-bit Adam7 and non-interlaced RGBA decode identically", () => {
  const data = new Uint16Array(Array.from({ length: 9 * 7 * 4 }, (_, i) => (i * 1237) & 65535));
  const image = { width: 9, height: 7, channels: 4, depth: 16 as const, data };
  const expected = Array.from(data, value => value >>> 8);
  assert.deepEqual(pixels(encode(image)), expected);
  assert.deepEqual(pixels(encode(image, { interlace: "Adam7" })), expected);
});

test("PNG preserves RGB at zero and partial alpha, including grayscale and indexed tRNS", () => {
  const rgba = png(2, 8, 6, [255, 64, 23, 0, 17, 91, 201, 128]);
  assert.deepEqual(pixels(rgba), [255, 64, 23, 0, 17, 91, 201, 128]);
  assert.deepEqual(
    pixels(png(2, 8, 4, [31, 0, 187, 128])),
    [31, 31, 31, 0, 187, 187, 187, 128],
  );
  assert.deepEqual(
    pixels(png(2, 8, 0, [31, 187], [chunk("tRNS", Buffer.from([0, 31]))])),
    [31, 31, 31, 0, 187, 187, 187, 255],
  );
  assert.deepEqual(
    pixels(
      png(
        3,
        8,
        2,
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
        [chunk("tRNS", Buffer.from([0, 1, 0, 2, 0, 3]))],
      ),
    ),
    [1, 2, 3, 0, 4, 5, 6, 255, 7, 8, 9, 255],
  );
  assert.deepEqual(
    pixels(
      png(
        3,
        2,
        3,
        [0x18],
        [
          chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])),
          chunk("tRNS", Buffer.from([0, 128, 255])),
        ],
      ),
    ),
    [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255],
  );
  assert.deepEqual(
    pixels(png(3, 2, 0, [0x1c])),
    [0, 0, 0, 255, 85, 85, 85, 255, 255, 255, 255, 255],
  );
});

test("unsupported metadata, malformed data, and changed sources cannot silently use canvas", () => {
  const unsupported = png(1, 16, 6, [255, 255, 0, 100, 0, 0, 0, 1], [chunk("iCCP", Buffer.from([0]))]);
  assert.throws(() => decodeEmbeddedPng(unsupported), /TC_TEXTURE_PNG_UNSUPPORTED.*ICC/);
  const damaged = png(1, 8, 6, [255, 1, 2, 0]);
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decodeEmbeddedPng(damaged), /TC_TEXTURE_PNG_UNSUPPORTED/);
  const lowInterlace = png(1, 1, 0, [0]);
  lowInterlace[28] = 1;
  assert.throws(() => decodeEmbeddedPng(lowInterlace), /TC_TEXTURE_PNG_UNSUPPORTED/);
  const hugeHeader = png(1, 8, 6, [0, 0, 0, 0]);
  hugeHeader.writeUInt32BE(0x7fffffff, 16);
  assert.throws(() => decodeEmbeddedPng(hugeHeader), /256 MiB/);
  const bomb = png(1, 8, 6, new Array(1024 * 1024).fill(0));
  assert.throws(() => decodeEmbeddedPng(bomb), /inflated data exceeds IHDR/);
  const texture = new THREE.Texture({ width: 1, height: 1 });
  associateEmbeddedImage(texture, unsupported, "image/png");
  const provider = createTexturePixelProvider();
  assert.throws(
    () => provider.decode(texture),
    /TC_TEXTURE_PNG_UNSUPPORTED.*ICC/,
  );
  assert.equal(
    provider.inspect().diagnostics[0].code,
    "TC_TEXTURE_PNG_UNSUPPORTED",
  );
  const good = new THREE.Texture({ width: 1, height: 1 });
  associateEmbeddedImage(good, png(1, 8, 6, [255, 1, 2, 0]), "image/png");
  const clone = good.clone();
  const first = provider.decode(clone)!;
  first.data[0] = 0;
  assert.equal(provider.decode(good)!.data[0], 255);
  assert.deepEqual(good.userData, {});
  good.source.needsUpdate = true;
  assert.equal(provider.decode(clone)!.data[0], 255);
  good.image = { width: 1, height: 1 };
  assert.throws(() => provider.decode(clone), /TC_TEXTURE_PNG_SOURCE_CHANGED/);
  provider.dispose();
});

test(
  "GLB and JPEG image sources are decoded in Chromium without GPU",
  { timeout: 60000 },
  async () => {
    const { createServer } = await import("vite");
    const { chromium } = await import("playwright");
    const glb = await readFile(
      new URL(
        "../examples/specular-textures/assets/specular-textures.glb",
        import.meta.url,
      ),
    );
    const ordinary16 = encode({
      width: 2,
      height: 1,
      channels: 4,
      depth: 16,
      data: new Uint16Array([65535, 0, 0, 0, 0, 65535, 0, 32768]),
    });
    const transparent = png(2, 8, 6, [240, 31, 11, 0, 33, 99, 180, 128]);
    const dataGlb = dataUriGLB(glb, [ordinary16, transparent]);
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      plugins: [{
        name: "pelican-cpu-image-test-page",
        configureServer(server) {
          server.middlewares.use("/__cpu_image_test", (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>CPU image test</title>");
          });
        },
      }],
      server: { host: "127.0.0.1", port: 0 },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-gpu"],
      });
      const page = await browser.newPage();
      await page.addInitScript("globalThis.__name = (target) => target;");
      await page.goto(
        new URL("/__cpu_image_test", server.resolvedUrls!.local[0]).href,
      );
      assert.equal(await page.title(), "CPU image test");
      const result = await page.evaluate(
        async ({ glbBytes, dataBytes }) => {
          const paths = [
            "/packages/renderer/src/models.ts",
            "/packages/renderer/src/texture-pixels.ts",
            "/packages/renderer/src/surface.ts",
            "/node_modules/three/build/three.module.js",
          ];
          const { createModelLibrary } = await import(paths[0]);
          const { createTexturePixelProvider } = await import(paths[1]);
          const { extractSurfaceScene } = await import(paths[2]);
          const THREE = await import(paths[3]);
          const bytes = new Uint8Array(glbBytes);
          const library = createModelLibrary(
            { asset: "fixture.glb" },
            { fetch: async () => new Response(bytes) },
          );
          await library.prepare();
          const root = library.instantiate("a", { asset: "asset" }).node;
          let material: any;
          root.traverse((o: any) => {
            if (o.material?.specularColorMap) material = o.material;
          });
          if (!material) throw new Error("missing specularColorMap");
          const texture = material.specularColorMap,
            clone = texture.clone();
          const provider = createTexturePixelProvider();
          const original = provider.decode(texture)!,
            cloned = provider.decode(clone)!;
          const before = [
            Array.from(original.data.slice(0, 4)),
            Array.from(original.data.slice(16 * 4, 17 * 4)),
            original.width,
            original.height,
          ];
          const same =
            clone.source === texture.source &&
            JSON.stringify(Array.from(original.data)) ===
              JSON.stringify(Array.from(cloned.data));
          const snapshot = extractSurfaceScene(root, {
            decodedTextureProvider: provider.decode,
          });
          const textureSnapshot = snapshot.textures.find(
            (t: any) => t.uuid === texture.uuid,
          );
          const bitmap = texture.image;
          const canvas = new OffscreenCanvas(2, 1),
            ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "rgb(200, 60, 30)";
          ctx.fillRect(0, 0, 2, 1);
          const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg" });
          const jpegBitmap = await createImageBitmap(jpegBlob);
          const jpeg = new THREE.Texture(jpegBitmap);
          const jpegPixels = provider.decode(jpeg)!;
          const jpegResult = [
            jpegPixels.width,
            jpegPixels.height,
            jpegPixels.data[3],
            provider.inspect().canvasReads,
          ];
          jpegBitmap.close();
          const userData = JSON.stringify(texture.userData);
          await library.dispose();
          const closed =
            bitmap instanceof ImageBitmap ? bitmap.width === 0 : true;
          let closedDiagnostic = "";
          if (bitmap instanceof ImageBitmap) {
            try {
              provider.decode(texture);
            } catch (error) {
              closedDiagnostic = String(error);
            }
          }
          const second = createModelLibrary(
            { asset: "data.glb" },
            { fetch: async () => new Response(new Uint8Array(dataBytes)) },
          );
          await second.prepare();
          const secondRoot = second.instantiate("b", { asset: "asset" }).node;
          let secondMaterial: any;
          secondRoot.traverse((o: any) => {
            if (o.material?.specularColorMap) secondMaterial = o.material;
          });
          const dataColor = Array.from(
            provider.decode(secondMaterial.specularColorMap)!.data,
          );
          const ordinary = provider.decode(
            secondMaterial.specularIntensityMap,
          )!;
          const ordinaryResult = [
            ordinary.width,
            ordinary.height,
            provider.inspect().canvasReads,
          ];
          await second.dispose();
          provider.dispose();
          return {
            before,
            same,
            userData,
            closed,
            closedDiagnostic,
            jpegResult,
            dataColor,
            ordinaryResult,
            snap: textureSnapshot?.pixels?.slice(0, 4),
            diagnostics: snapshot.diagnostics,
          };
        },
        { glbBytes: [...glb], dataBytes: [...dataGlb] },
      );
      assert.deepEqual(result.before, [
        [128, 128, 128, 0],
        [255, 0, 0, 0],
        64,
        4,
      ]);
      assert.equal(result.same, true);
      assert.equal(result.closed, true);
      assert.match(result.closedDiagnostic, /TC_TEXTURE_PNG_SOURCE_RELEASED/);
      assert.deepEqual(result.jpegResult, [2, 1, 255, 2]);
      assert.deepEqual(result.dataColor, [240, 31, 11, 0, 33, 99, 180, 128]);
      assert.deepEqual(result.ordinaryResult, [2, 1, 3]);
      assert.deepEqual(result.snap, [128 / 255, 128 / 255, 128 / 255, 0]);
      assert.equal(result.diagnostics.length, 0);
      assert.ok(!result.userData.includes("bytes"));
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
