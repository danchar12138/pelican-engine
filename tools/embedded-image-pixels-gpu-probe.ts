import { deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { createServer } from "vite";
import { encode } from "fast-png";
import { automationLaunchOptions } from "./browser-session.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { decodeEmbeddedPng } from "../packages/renderer/src/embedded-image-pixels.ts";

function chunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let value = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, crc]);
}

function png(color: number, samples: number[][], key?: number[]): Buffer {
  const width = Math.min(samples.length, 256), height = samples.length / width;
  if (!Number.isInteger(height)) throw new Error("Samples must fill rows");
  const channels = samples[0].length, stride = 1 + width * channels * 2;
  const header = Buffer.alloc(13), raw = Buffer.alloc(height * stride);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 16; header[9] = color;
  samples.forEach((sample, i) => sample.forEach((value, channel) => raw.writeUInt16BE(value, Math.floor(i / width) * stride + 1 + ((i % width) * channels + channel) * 2)));
  const trns = key ? Buffer.alloc(key.length * 2) : undefined;
  key?.forEach((value, i) => trns!.writeUInt16BE(value, i * 2));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    ...(trns ? [chunk("tRNS", trns)] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function withMetadata(image: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  return Buffer.concat([image.subarray(0, 33), chunk(type, data), image.subarray(33)]);
}

if (!process.argv.includes("--exclusive-gpu")) throw new Error("Pass --exclusive-gpu after reserving the GPU");
const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0 && (!process.argv[outputFlag + 1] || process.argv[outputFlag + 1].startsWith("--"))) throw new Error("--output requires a directory");
const output = path.resolve(outputFlag < 0 ? `.pelican/png16-probe/${Date.now()}` : process.argv[outputFlag + 1]);
await mkdir(output, { recursive: true });
const identity = await sourceFingerprint(process.cwd());
const values = [0, 1, 127, 128, 255, 256, 257, 511, 512, 0x1200, 0x1233, 0x1234, 0x1235, 0x7f7f, 0x7fff, 0x8000, 0x8080, 0xfeff, 0xffff];
const key = [0x1234, 0x7fff, 0xfeff];
const baseCases = [
  { name: "gray", color: 0, samples: values.map(v => [v]) },
  { name: "gray-trns", color: 0, samples: values.map(v => [v]), key: [0x1234] },
  { name: "rgb", color: 2, samples: values.map(v => [v, 0x7fff, 0xfeff]) },
  { name: "rgb-trns", color: 2, samples: values.map(v => [v, key[1], key[2]]), key },
  { name: "gray-alpha", color: 4, samples: values.map(v => [0x9abc, v]) },
  { name: "rgba", color: 6, samples: values.map(v => [0x1234, 0x7fff, 0xfeff, v]) },
  { name: "rgba-opaque-ramp", color: 6, samples: values.map(v => [v, v, v, 65535]) },
  { name: "rgba-adam7", color: 6, samples: values.map(v => [0x1234, 0x7fff, 0xfeff, v]) },
  { name: "gray-all-65536", color: 0, samples: Array.from({ length: 65536 }, (_, v) => [v]) },
  { name: "rgba-all-alpha-65536", color: 6, samples: Array.from({ length: 65536 }, (_, v) => [0x1234, 0x7fff, 0xfeff, v]) },
];
const metadata = process.argv.includes("--metadata");
const chromaticities = Buffer.alloc(32);
[31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((value, i) => chromaticities.writeUInt32BE(value, i * 4));
const gamma = (value: number) => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return data; };
const metadataCases = [
  { name: "srgb", type: "sRGB", data: Buffer.from([0]) },
  { name: "gamma-srgb", type: "gAMA", data: gamma(45455) },
  { name: "gamma-linear", type: "gAMA", data: gamma(100000) },
  { name: "chromaticity-srgb", type: "cHRM", data: chromaticities },
  { name: "cicp-srgb", type: "cICP", data: Buffer.from([1, 13, 0, 1]) },
  { name: "cicp-bt2020-pq", type: "cICP", data: Buffer.from([9, 16, 0, 1]) },
].map(item => ({ ...item, color: 6, samples: values.map(v => [v, 0x7fff, 0xfeff, v]), key: undefined }));
const cases = metadata ? metadataCases : baseCases;
const fixtures = cases.map(c => {
  let image = c.name === "rgba-adam7" ? encode({ width: c.samples.length, height: 1, channels: 4, depth: 16, data: new Uint16Array(c.samples.flat()) }, { interlace: "Adam7" }) : png(c.color, c.samples, c.key);
  const marker = metadata ? metadataCases.find(item => item.name === c.name) : undefined;
  if (marker) image = withMetadata(image, marker.type, marker.data);
  return { ...c, bytes: [...image] };
});
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "silent", optimizeDeps: { noDiscovery: true }, server: { host: "127.0.0.1", port: 0 } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  browser = await chromium.launch(automationLaunchOptions());
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0]);
  const result = await page.evaluate(async (fixtures) => {
    const threeModule = "/node_modules/three/build/three.webgpu.js";
    const THREE = await import(threeModule);
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false });
    if (!adapter || adapter.info.isFallbackAdapter) throw new Error("Hardware WebGPU adapter unavailable");
    const device = await adapter.requestDevice();
    const renderer = new THREE.WebGPURenderer({ device });
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error("Three WebGPU backend unavailable");
    const results = [];
    for (const fixture of fixtures) {
      const url = URL.createObjectURL(new Blob([new Uint8Array(fixture.bytes)], { type: "image/png" }));
      const bitmap = await new THREE.ImageBitmapLoader().loadAsync(url);
      URL.revokeObjectURL(url);
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
      const gpuTexture = renderer.backend.get(texture).texture;
      const width = bitmap.width, height = bitmap.height, bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: gpuTexture }, { buffer, bytesPerRow }, { width, height });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const bytes = Array.from({ length: height }, (_, y) => [...mapped.slice(y * bytesPerRow, y * bytesPerRow + width * 4)]).flat();
      buffer.unmap(); buffer.destroy(); texture.dispose(); bitmap.close();
      results.push({ name: fixture.name, format: gpuTexture.format, samples: fixture.samples, bytes });
    }
    const info = adapter.info;
    renderer.dispose(); device.destroy();
    return { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter }, results };
  }, fixtures);
  for (const row of result.results) {
    const fixture = cases.find(c => c.name === row.name)!;
    const expected = fixture.samples.flatMap(sample => {
      const c = fixture.color, rgb = c === 0 || c === 4 ? [sample[0], sample[0], sample[0]] : sample.slice(0, 3);
      const alpha = c === 4 ? sample[1] : c === 6 ? sample[3] : fixture.key && fixture.key.every((v, i) => sample[i] === v) ? 0 : 65535;
      return [...rgb, alpha].map(v => v >>> 8);
    });
    const decoded = metadata && row.name === "cicp-bt2020-pq" ? undefined : decodeEmbeddedPng(new Uint8Array(fixtures.find(f => f.name === row.name)!.bytes)).data;
    const decoderErrors = decoded ? row.bytes.map((v, i) => Math.abs(v - decoded[i])) : [];
    const errors = row.bytes.map((v, i) => Math.abs(v - expected[i]));
    const mismatches = errors.filter(Boolean).length;
    const examples = row.samples.flatMap((s, i) => errors.slice(i * 4, i * 4 + 4).some(Boolean) ? [{ s, actual: row.bytes.slice(i * 4, i * 4 + 4), expected: expected.slice(i * 4, i * 4 + 4) }] : []).slice(0, 8);
    console.log(JSON.stringify({ name: row.name, format: row.format, pixels: row.samples.length, mismatches, maxByteError: errors.reduce((max, e) => Math.max(max, e), 0), decoderMaxByteError: decoded ? decoderErrors.reduce((max, e) => Math.max(max, e), 0) : null, examples }));
    if (decoded && (mismatches || decoderErrors.some(Boolean))) throw new Error(`GPU mismatch in ${row.name}`);
  }
  const cdp = await browser.newBrowserCDPSession();
  const system = await cdp.send("SystemInfo.getInfo");
  if ((await sourceFingerprint(process.cwd())).sha256 !== identity.sha256) throw new Error("Source changed during probe");
  await writeFile(path.join(output, metadata ? "png16-metadata-gpu.json" : "png16-gpu.json"), JSON.stringify({ sourceIdentity: identity.sha256, formalMilestoneAccepted: false, browser: browser.version(), adapter: result.adapter, devices: system.gpu.devices, results: result.results }, null, 2) + "\n");
  console.log(JSON.stringify({ browser: browser.version(), adapter: result.adapter, devices: system.gpu.devices }));
} finally {
  await browser?.close();
  await server.close();
}
