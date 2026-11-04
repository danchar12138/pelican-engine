import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { GLTF } from "@gltf-transform/core";
import {
  inspectAsset,
  AssetInspectionError,
  type AssetType,
  type AssetErrorCode,
} from "../packages/assets/src/index.ts";

const packageDir = fileURLToPath(
  new URL("../packages/assets/", import.meta.url),
);
let tempDir: string;
let serial = 0;
before(async () => {
  tempDir = await fs.mkdtemp(path.join(packageDir, ".test-"));
});
after(async () => {
  assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(packageDir));
  assert.ok(path.basename(tempDir).startsWith(".test-"));
  await fs.rm(tempDir, { recursive: true, force: true });
});
async function save(data: Uint8Array, extension: string): Promise<string> {
  const file = path.join(tempDir, `${serial++}.${extension}`);
  await fs.writeFile(file, data);
  return file;
}
async function inspect(
  data: Uint8Array,
  type: AssetType,
  extension = type === "model"
    ? "glb"
    : type === "texture"
      ? "png"
      : type === "audio"
        ? "wav"
        : "bin",
) {
  return inspectAsset(await save(data, extension), type);
}
async function rejects(
  data: Uint8Array,
  type: AssetType,
  code: AssetErrorCode,
  detail: RegExp,
  extension?: string,
) {
  const file = await save(
    data,
    extension ??
      (type === "model" ? "glb" : type === "texture" ? "png" : "wav"),
  );
  await assert.rejects(inspectAsset(file, type), (error: unknown) => {
    assert.ok(error instanceof AssetInspectionError);
    assert.equal(error.code, code);
    assert.ok(error.file.includes(file));
    assert.ok(error.resource);
    assert.ok(error.suggestion);
    assert.match(error.message, detail);
    return true;
  });
}
function floats(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}
function fixture(): { json: GLTF.IGLTF; bin: Buffer } {
  const bin = Buffer.concat([
    floats([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    floats([0, 1]),
    floats([0, 0, 0, 0, 1, 0]),
  ]);
  return {
    bin,
    json: {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        {
          bufferView: 1,
          componentType: 5126,
          count: 2,
          type: "SCALAR",
          min: [0],
          max: [1],
        },
        { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
      ],
      meshes: [
        { name: "triangle", primitives: [{ attributes: { POSITION: 0 } }] },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
      animations: [
        {
          name: "Move",
          channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
          samplers: [{ input: 1, output: 2 }],
        },
      ],
    },
  };
}
function pack(json: GLTF.IGLTF, bin?: Buffer): Buffer {
  const encoded = Buffer.from(JSON.stringify(json)),
    jsonBytes = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(jsonBytes);
  const binary = bin ? Buffer.alloc(Math.ceil(bin.length / 4) * 4) : undefined;
  if (bin) bin.copy(binary!);
  const data = Buffer.alloc(
    20 + jsonBytes.length + (binary ? 8 + binary.length : 0),
  );
  data.write("glTF");
  data.writeUInt32LE(2, 4);
  data.writeUInt32LE(data.length, 8);
  data.writeUInt32LE(jsonBytes.length, 12);
  data.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(data, 20);
  if (binary) {
    const offset = 20 + jsonBytes.length;
    data.writeUInt32LE(binary.length, offset);
    data.writeUInt32LE(0x004e4942, offset + 4);
    binary.copy(data, offset + 8);
  }
  return data;
}
const invalid = "TC_ASSET_INVALID",
  unsupported = "TC_ASSET_UNSUPPORTED";

test("real Fox: decoded geometry, skeleton, clips, durations, texture and JSON metadata contract", async () => {
  const file = fileURLToPath(
    new URL("../examples/m2/assets/Fox.glb", import.meta.url),
  );
  const result = await inspectAsset(file, "model");
  assert.equal(result.format, "glb");
  assert.equal(result.bytes, 162852);
  assert.equal(
    result.sha256,
    "d97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7",
  );
  assert.equal(result.vertexCount, 1728);
  assert.equal(result.triangleCount, 576);
  assert.equal(result.jointCount, 24);
  assert.equal(result.skinCount, 1);
  assert.equal(result.animationCount, 3);
  const clips = result.animations as Array<{
    name: string;
    duration: number;
    channelCount: number;
    start: number;
    end: number;
  }>;
  assert.deepEqual(
    clips.map((c) => c.name),
    ["Survey", "Walk", "Run"],
  );
  for (const [i, duration] of [
    3.4166667461395264, 0.7083333134651184, 1.1583333015441895,
  ].entries()) {
    assert.equal(clips[i].duration, duration);
    assert.equal(clips[i].start, 0);
    assert.equal(clips[i].end, duration);
    assert.equal(clips[i].channelCount, 21);
  }
  assert.equal(result.duration, undefined);
  assert.deepEqual(
    (result.images as Array<{ width: number; height: number }>).map((i) => [
      i.width,
      i.height,
    ]),
    [[1024, 1024]],
  );
  assert.deepEqual(result.bounds, {
    min: [-12.592718124389648, -0.12174476683139801, -88.09500122070312],
    max: [12.592718124389648, 78.90718841552734, 66.62486267089844],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("real WaterBottle: actual indexed triangles, four embedded textures and all PBR slots", async () => {
  const file = fileURLToPath(
    new URL("../examples/m2/assets/WaterBottle.glb", import.meta.url),
  );
  const result = await inspectAsset(file, "model");
  assert.equal(result.vertexCount, 2549);
  assert.equal(result.triangleCount, 4510);
  assert.equal(result.textureCount, 4);
  assert.equal(result.animationCount, 0);
  assert.deepEqual(result.animations, []);
  assert.equal(result.jointCount, 0);
  assert.equal(result.bytes, 8966700);
  assert.equal(
    result.sha256,
    "b337e526fd6a162013c2984aeec163f5fbb4f717252724dfc3f3458bd51df94b",
  );
  const images = result.images as Array<{
    format: string;
    width: number;
    height: number;
  }>;
  assert.deepEqual(
    images.map((i) => [i.format, i.width, i.height]),
    Array.from({ length: 4 }, () => ["png", 2048, 2048]),
  );
  const materials = result.materials as Array<{
    name: string;
    pbr: { metallicFactor: number };
    textures: unknown;
  }>;
  assert.equal(materials[0].name, "BottleMat");
  assert.equal(materials[0].pbr.metallicFactor, 1);
  assert.deepEqual(materials[0].textures, {
    baseColor: 0,
    metallicRoughness: 1,
    normal: 2,
    occlusion: 1,
    emissive: 3,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("GLB world bounds use vertex bytes and node transforms; unnamed clips match renderer names", async () => {
  const { json, bin } = fixture();
  json.nodes![0].translation = [10, 20, 30];
  delete json.animations![0].name;
  const result = await inspect(pack(json, bin), "model");
  assert.deepEqual(result.bounds, { min: [10, 20, 30], max: [11, 21, 30] });
  assert.equal(
    (result.animations as Array<{ name: string }>)[0].name,
    "animation_0",
  );
  assert.equal(result.boundsSpace, "world-static-default-pose");
});

test("GLB can contain a metadata-only empty scene without inventing geometry", async () => {
  const result = await inspect(
    pack({ asset: { version: "2.0" }, scenes: [{} as GLTF.IScene], scene: 0 }),
    "model",
  );
  assert.equal(result.vertexCount, 0);
  assert.equal(result.bounds, null);
});

const glbCases: Array<
  [string, (json: GLTF.IGLTF, bin: Buffer) => void, AssetErrorCode, RegExp]
> = [
  [
    "buffer view overrun",
    (j) => {
      j.bufferViews![0].byteLength = 999999;
    },
    invalid,
    /bufferViews\/0.*boundary/,
  ],
  [
    "accessor overrun",
    (j) => {
      j.accessors![0].count = 100;
    },
    invalid,
    /accessors\/0.*boundary/,
  ],
  [
    "misaligned accessor",
    (j) => {
      j.accessors![0].byteOffset = 1;
    },
    invalid,
    /misaligned/,
  ],
  [
    "wrong position bounds",
    (j) => {
      j.accessors![0].max = [9, 9, 9];
    },
    invalid,
    /bounds.*decoded/,
  ],
  [
    "nonfinite vertex",
    (_j, b) => {
      b.writeFloatLE(NaN, 0);
    },
    invalid,
    /non-finite/,
  ],
  [
    "missing buffer",
    (j) => {
      j.bufferViews![0].buffer = 1;
    },
    invalid,
    /Buffer reference/,
  ],
  [
    "missing BIN",
    (j) => {
      j.buffers![0].byteLength += 1000;
    },
    invalid,
    /BIN resource|buffer length/,
  ],
  [
    "external buffer",
    (j) => {
      j.buffers![0].uri = "missing.bin";
    },
    unsupported,
    /buffers\/0\/uri.*missing.bin/,
  ],
  [
    "external image",
    (j) => {
      j.images = [{ uri: "missing.png" }];
    },
    unsupported,
    /images\/0\/uri.*missing.png/,
  ],
  [
    "data URI resource",
    (j) => {
      j.buffers![0].uri = "data:application/octet-stream;base64,AAAA";
    },
    unsupported,
    /URI buffer/,
  ],
  [
    "missing image buffer view",
    (j) => {
      j.images = [{ mimeType: "image/png", bufferView: 99 }];
    },
    invalid,
    /images\/0\/bufferView/,
  ],
  [
    "missing texture image",
    (j) => {
      j.textures = [{ source: 0 }];
    },
    invalid,
    /textures\/0\/source/,
  ],
  [
    "missing PBR texture",
    (j) => {
      j.materials = [
        { pbrMetallicRoughness: { baseColorTexture: { index: 5 } } },
      ];
    },
    invalid,
    /baseColorTexture\/index/,
  ],
  [
    "bad PBR factor",
    (j) => {
      j.materials = [{ pbrMetallicRoughness: { roughnessFactor: -1 } }];
    },
    invalid,
    /roughnessFactor/,
  ],
  [
    "unknown required extension",
    (j) => {
      j.extensionsRequired = ["KHR_draco_mesh_compression"];
    },
    unsupported,
    /KHR_draco_mesh_compression/,
  ],
  [
    "optional extension payload",
    (j) => {
      j.meshes![0].primitives[0].extensions = {
        KHR_draco_mesh_compression: {},
      };
    },
    unsupported,
    /extensions.*KHR_draco/,
  ],
  [
    "unsupported sparse",
    (j) => {
      j.accessors![0].sparse = {
        count: 1,
        indices: { bufferView: 0, componentType: 5121 },
        values: { bufferView: 0 },
      };
    },
    unsupported,
    /sparse/,
  ],
  [
    "unknown glTF version",
    (j) => {
      j.asset.version = "1.0";
    },
    unsupported,
    /glTF 2.0/,
  ],
  [
    "missing mesh ref",
    (j) => {
      j.nodes![0].mesh = 10;
    },
    invalid,
    /nodes\/0\/mesh/,
  ],
  [
    "cyclic hierarchy",
    (j) => {
      j.nodes!.push({ children: [0] });
      j.nodes![0].children = [1];
    },
    invalid,
    /cycle/,
  ],
  [
    "multiple parents",
    (j) => {
      j.nodes!.push({ children: [0] }, { children: [0] });
    },
    invalid,
    /multiple parent/,
  ],
  [
    "scene root has parent",
    (j) => {
      j.nodes!.push({ children: [0] });
    },
    invalid,
    /root node has a parent/,
  ],
  [
    "invalid quaternion",
    (j) => {
      j.nodes![0].rotation = [0, 0, 0, 0];
    },
    invalid,
    /quaternion/,
  ],
  [
    "conflicting matrix and TRS",
    (j) => {
      j.nodes![0].matrix = Array(16).fill(0);
      j.nodes![0].scale = [1, 1, 1];
    },
    invalid,
    /combine matrix/,
  ],
  [
    "missing skin joints",
    (j) => {
      j.skins = [{ joints: [20] }];
    },
    invalid,
    /skins\/0\/joints/,
  ],
  [
    "duplicate skin joints",
    (j) => {
      j.skins = [{ joints: [0, 0] }];
    },
    invalid,
    /unique joint/,
  ],
  [
    "bad inverse bind count",
    (j) => {
      j.skins = [{ joints: [0], inverseBindMatrices: 0 }];
    },
    invalid,
    /inverseBindMatrices/,
  ],
  [
    "skinned mesh lacks attributes",
    (j) => {
      j.skins = [{ joints: [0] }];
      j.nodes![0].skin = 0;
    },
    invalid,
    /JOINTS_0/,
  ],
  [
    "missing animation node",
    (j) => {
      j.animations![0].channels[0].target.node = 8;
    },
    invalid,
    /target\/node/,
  ],
  [
    "missing animation sampler",
    (j) => {
      j.animations![0].channels[0].sampler = 8;
    },
    invalid,
    /channels\/0\/sampler/,
  ],
  [
    "animation time order",
    (j, b) => {
      b.writeFloatLE(0, 40);
      j.accessors![1].max = [0];
    },
    invalid,
    /strictly increasing/,
  ],
  [
    "negative animation time",
    (j, b) => {
      b.writeFloatLE(-1, 36);
      j.accessors![1].min = [-1];
    },
    invalid,
    /nonnegative/,
  ],
  [
    "animation output count",
    (j) => {
      j.accessors![2].count = 1;
    },
    invalid,
    /output type\/count/,
  ],
  [
    "animation output type",
    (j) => {
      j.accessors![2].type = "VEC2";
    },
    invalid,
    /output type\/count/,
  ],
  [
    "animation interpolation",
    (j) => {
      j.animations![0].samplers[0].interpolation =
        "BAD" as GLTF.AnimationSamplerInterpolation;
    },
    invalid,
    /interpolation/,
  ],
  [
    "animation duplicate target",
    (j) => {
      j.animations![0].channels.push({ ...j.animations![0].channels[0] });
    },
    invalid,
    /Duplicate animation/,
  ],
  [
    "animation morph target absent",
    (j) => {
      j.animations![0].channels[0].target.path = "weights";
    },
    invalid,
    /morph targets/,
  ],
  [
    "CUBICSPLINE output count",
    (j) => {
      j.animations![0].samplers[0].interpolation = "CUBICSPLINE";
    },
    invalid,
    /output type\/count/,
  ],
  [
    "no animation channels",
    (j) => {
      j.animations![0].channels = [];
    },
    invalid,
    /requires samplers and channels/,
  ],
  [
    "wrong schema",
    (j) => {
      j.animations![0].samplers = null as unknown as GLTF.IAnimationSampler[];
    },
    invalid,
    /Animation requires/,
  ],
];
for (const [name, mutate, code, pattern] of glbCases)
  test(`GLB rejects ${name}`, async () => {
    const { json, bin } = fixture();
    mutate(json, bin);
    await rejects(pack(json, bin), "model", code, pattern);
  });

for (const [name, change, pattern] of [
  [
    "declared length",
    (b: Buffer) => {
      b.writeUInt32LE(b.length + 4, 8);
    },
    /length/,
  ],
  [
    "chunk boundary",
    (b: Buffer) => {
      b.writeUInt32LE(b.length, 12);
    },
    /Chunk length/,
  ],
  [
    "JSON corruption",
    (b: Buffer) => {
      b[20] = 0xff;
    },
    /UTF-8 or JSON/,
  ],
] as const)
  test(`GLB rejects ${name}`, async () => {
    const { json, bin } = fixture();
    const b = pack(json, bin);
    change(b);
    await rejects(b, "model", invalid, pattern);
  });
test("GLB rejects truncated header", async () => {
  await rejects(Buffer.from("glTF"), "model", invalid, /header/);
});
test("GLB rejects trailing bytes", async () => {
  const { json, bin } = fixture();
  await rejects(
    Buffer.concat([pack(json, bin), Buffer.alloc(4)]),
    "model",
    invalid,
    /length/,
  );
});
test("GLB identifies JSON glTF as unsupported", async () => {
  await rejects(
    Buffer.from('{"asset":{"version":"2.0"}}'),
    "model",
    unsupported,
    /JSON .gltf/,
    "gltf",
  );
});

// Fixture CRC is independent of the production implementation.
function crc(data: Buffer): number {
  let n = 0xffffffff;
  for (const b of data) {
    n ^= b;
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  }
  return (n ^ 0xffffffff) >>> 0;
}
function chunk(type: string, payload: Buffer): Buffer {
  const b = Buffer.alloc(payload.length + 12);
  b.writeUInt32BE(payload.length);
  b.write(type, 4);
  payload.copy(b, 8);
  b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4);
  return b;
}
function png(
  pixels = Buffer.from([0, 255, 0, 0, 255]),
  mutateHeader?: (b: Buffer) => void,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  mutateHeader?.(header);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("PNG returns pixel dimensions and alpha from a verified stream", async () => {
  const b = png();
  const m = await inspect(b, "texture");
  assert.equal(m.format, "png");
  assert.equal(m.width, 1);
  assert.equal(m.height, 1);
  assert.equal(m.bitDepth, 8);
  assert.equal(m.channels, 4);
  assert.equal(m.hasAlpha, true);
  assert.equal(m.bytes, b.length);
  assert.equal(m.sha256, createHash("sha256").update(b).digest("hex"));
});
test("PNG rejects CRC corruption", async () => {
  const b = png();
  b[29] ^= 1;
  await rejects(b, "texture", invalid, /CRC/);
});
test("PNG rejects truncation", async () => {
  await rejects(png().subarray(0, -3), "texture", invalid, /Truncated|length/);
});
test("PNG rejects a valid-CRC image with missing pixel bytes", async () => {
  await rejects(
    png(Buffer.from([0, 255, 0])),
    "texture",
    invalid,
    /Pixel stream length/,
  );
});
test("PNG rejects invalid row filter with valid compression and CRC", async () => {
  await rejects(
    png(Buffer.from([5, 0, 0, 0, 0])),
    "texture",
    invalid,
    /row filter/,
  );
});
test("PNG rejects malformed zlib even with valid chunk CRC", async () => {
  const b = png();
  const head = b.subarray(0, 33);
  await rejects(
    Buffer.concat([
      head,
      chunk("IDAT", Buffer.from([1, 2, 3])),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    "texture",
    invalid,
    /zlib/,
  );
});
test("PNG rejects trailing compressed data", async () => {
  const b = png();
  await rejects(
    Buffer.concat([
      b.subarray(0, 33),
      chunk(
        "IDAT",
        Buffer.concat([
          deflateSync(Buffer.from([0, 1, 2, 3, 4])),
          Buffer.from([0]),
        ]),
      ),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    "texture",
    invalid,
    /Trailing compressed/,
  );
});
test("PNG rejects impossible color/bit-depth combination", async () => {
  await rejects(
    png(undefined, (b) => {
      b[8] = 1;
    }),
    "texture",
    invalid,
    /bit depth/,
  );
});
test("PNG reports Adam7 as unsupported", async () => {
  await rejects(
    png(undefined, (b) => {
      b[12] = 1;
    }),
    "texture",
    unsupported,
    /Adam7/,
  );
});
test("PNG rejects indexed pixels referencing a missing palette entry", async () => {
  const b = png(Buffer.from([0, 1]), (h) => {
    h[9] = 3;
  });
  await rejects(
    Buffer.concat([
      b.subarray(0, 33),
      chunk("PLTE", Buffer.from([0, 0, 0])),
      b.subarray(33),
    ]),
    "texture",
    invalid,
    /missing palette entry/,
  );
});
test("GLB validates embedded PNG payload rather than trusting image header", async () => {
  const { json, bin } = fixture();
  const image = png();
  image[29] ^= 1;
  json.bufferViews!.push({
    buffer: 0,
    byteOffset: bin.length,
    byteLength: image.length,
  });
  json.images = [{ mimeType: "image/png", bufferView: 3 }];
  const combined = Buffer.concat([bin, image]);
  json.buffers![0].byteLength = combined.length;
  await rejects(pack(json, combined), "model", invalid, /images\/0.*CRC/);
});

function segment(marker: number, payload: Buffer): Buffer {
  const b = Buffer.alloc(payload.length + 4);
  b[0] = 0xff;
  b[1] = marker;
  b.writeUInt16BE(payload.length + 2, 2);
  payload.copy(b, 4);
  return b;
}
function jpeg(): Buffer {
  const table = (kind: number) =>
    Buffer.from([kind, 1, ...Array(15).fill(0), 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])),
    segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    segment(0xc4, Buffer.concat([table(0), table(0x10)])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x3f, 0xff, 0xd9]),
  ]);
}
test("JPEG validates baseline Huffman coefficients and reports dimensions", async () => {
  const m = await inspect(jpeg(), "texture", "jpg");
  assert.equal(m.format, "jpeg");
  assert.equal(m.width, 1);
  assert.equal(m.height, 1);
  assert.equal(m.channels, 1);
  assert.equal(m.bitDepth, 8);
});
test("JPEG rejects missing entropy data despite valid SOF dimensions", async () => {
  const b = jpeg();
  await rejects(
    Buffer.concat([b.subarray(0, -3), b.subarray(-2)]),
    "texture",
    invalid,
    /entropy/,
  );
});
test("JPEG rejects truncated EOI", async () => {
  await rejects(jpeg().subarray(0, -1), "texture", invalid, /end marker/);
});
test("JPEG rejects invalid entropy coding", async () => {
  const b = jpeg();
  b[b.length - 3] = 0xbf;
  await rejects(b, "texture", invalid, /entropy|Entropy/);
});
test("JPEG rejects corrupt segment length", async () => {
  const b = jpeg();
  b.writeUInt16BE(65535, 4);
  await rejects(b, "texture", invalid, /Segment length/);
});
test("JPEG reports progressive encoding as unsupported", async () => {
  const b = jpeg();
  const at = b.indexOf(Buffer.from([0xff, 0xc0]));
  b[at + 1] = 0xc2;
  await rejects(b, "texture", unsupported, /not baseline/);
});
test("unknown image format is unsupported", async () => {
  await rejects(
    Buffer.from("GIF89a"),
    "texture",
    unsupported,
    /PNG or baseline JPEG/,
    "gif",
  );
});

function wav(encoding = 1, bits = 16): Buffer {
  const channels = 2,
    sampleRate = 8000,
    frames = 4,
    align = (channels * bits) / 8;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(encoding, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * align, 8);
  fmt.writeUInt16LE(align, 12);
  fmt.writeUInt16LE(bits, 14);
  const riffChunk = (id: string, payload: Buffer) => {
    const b = Buffer.alloc(8 + payload.length + (payload.length % 2));
    b.write(id);
    b.writeUInt32LE(payload.length, 4);
    payload.copy(b, 8);
    return b;
  };
  const fact = Buffer.alloc(4);
  fact.writeUInt32LE(frames);
  const content = Buffer.concat([
    Buffer.from("WAVE"),
    riffChunk("fmt ", fmt),
    ...(encoding === 3 ? [riffChunk("fact", fact)] : []),
    riffChunk("data", Buffer.alloc(frames * align)),
  ]);
  const b = Buffer.alloc(content.length + 8);
  b.write("RIFF");
  b.writeUInt32LE(content.length, 4);
  content.copy(b, 8);
  return b;
}
test("WAV PCM duration is seconds and frame count includes all channels", async () => {
  const m = await inspect(wav(), "audio");
  assert.equal(m.format, "wav");
  assert.equal(m.encoding, "pcm");
  assert.equal(m.channels, 2);
  assert.equal(m.sampleRate, 8000);
  assert.equal(m.bitsPerSample, 16);
  assert.equal(m.frameCount, 4);
  assert.equal(m.duration, 4 / 8000);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});
test("WAV IEEE float samples are checked", async () => {
  const m = await inspect(wav(3, 32), "audio");
  assert.equal(m.encoding, "ieee-float");
  assert.equal(m.duration, 4 / 8000);
});
test("WAV rejects nonfinite float samples", async () => {
  const b = wav(3, 32);
  const data = b.indexOf(Buffer.from("data")) + 8;
  b.writeFloatLE(NaN, data);
  await rejects(b, "audio", invalid, /Non-finite/);
});
test("WAV rejects mismatched fact count", async () => {
  const b = wav(3, 32);
  b.writeUInt32LE(100, b.indexOf(Buffer.from("fact")) + 8);
  await rejects(b, "audio", invalid, /Fact sample count/);
});
test("WAV rejects truncated file", async () => {
  await rejects(wav().subarray(0, -1), "audio", invalid, /RIFF length/);
});
test("WAV rejects inconsistent block alignment", async () => {
  const b = wav();
  b.writeUInt16LE(1, 32);
  await rejects(b, "audio", invalid, /alignment/);
});
test("WAV rejects inconsistent byte rate", async () => {
  const b = wav();
  b.writeUInt32LE(1, 28);
  await rejects(b, "audio", invalid, /byte rate/);
});
test("WAV rejects data overrun", async () => {
  const b = wav();
  b.writeUInt32LE(100000, 40);
  await rejects(b, "audio", invalid, /boundary/);
});
test("WAV rejects incomplete sample frame", async () => {
  const b = wav().subarray(0, -2);
  b.writeUInt32LE(b.length - 8, 4);
  b.writeUInt32LE(b.length - 44, 40);
  await rejects(b, "audio", invalid, /sample frame/);
});
test("WAV rejects missing data", async () => {
  const b = wav().subarray(0, 36);
  b.writeUInt32LE(b.length - 8, 4);
  await rejects(b, "audio", invalid, /fmt and data/);
});
test("WAV reports compressed encoding as unsupported", async () => {
  const b = wav();
  b.writeUInt16LE(2, 20);
  await rejects(b, "audio", unsupported, /format tag 2/);
});
test("MP3 is explicitly unsupported", async () => {
  await rejects(
    Buffer.from("ID3"),
    "audio",
    unsupported,
    /Only little-endian/,
    "mp3",
  );
});

test("binary is opaque, including zero bytes, and returns only JSON hash metadata", async () => {
  for (const b of [Buffer.alloc(0), Buffer.from([0, 255, 1, 13])]) {
    assert.deepEqual(await inspect(b, "binary"), {
      format: "binary",
      bytes: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
});
test("missing file gets TC_ASSET_MISSING with file path and remedy", async () => {
  const file = path.join(tempDir, "missing.glb");
  await assert.rejects(inspectAsset(file, "model"), (e: unknown) => {
    assert.ok(e instanceof AssetInspectionError);
    assert.equal(e.code, "TC_ASSET_MISSING");
    assert.equal(e.file, file);
    assert.match(e.message, /restore/);
    return true;
  });
});
test("directory read does not masquerade as a missing file", async () => {
  await assert.rejects(inspectAsset(tempDir, "binary"), (e: unknown) => {
    assert.ok(e instanceof AssetInspectionError);
    assert.equal(e.code, invalid);
    assert.equal(e.resource, "file");
    return true;
  });
});
test("damaged known format signatures get invalid diagnostics", async () => {
  for (const [type, ext] of [
    ["model", "glb"],
    ["texture", "png"],
    ["audio", "wav"],
  ] as const)
    await rejects(
      Buffer.from([0, 0, 0, 0]),
      type,
      invalid,
      /header|signature|magic/,
      ext,
    );
});

function rigFixture(): {
  json: GLTF.IGLTF;
  bin: Buffer;
  jointOffset: number;
  weightOffset: number;
} {
  const { json, bin } = fixture();
  const joints = Buffer.alloc(12),
    weights = floats([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const inverse = floats([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const combined = Buffer.concat([bin, joints, weights, inverse]);
  json.buffers![0].byteLength = combined.length;
  json.bufferViews!.push(
    { buffer: 0, byteOffset: bin.length, byteLength: joints.length },
    {
      buffer: 0,
      byteOffset: bin.length + joints.length,
      byteLength: weights.length,
    },
    {
      buffer: 0,
      byteOffset: bin.length + joints.length + weights.length,
      byteLength: inverse.length,
    },
  );
  json.accessors!.push(
    { bufferView: 3, type: "VEC4", componentType: 5121, count: 3 },
    { bufferView: 4, type: "VEC4", componentType: 5126, count: 3 },
    { bufferView: 5, type: "MAT4", componentType: 5126, count: 1 },
  );
  json.meshes![0].primitives[0].attributes.JOINTS_0 = 3;
  json.meshes![0].primitives[0].attributes.WEIGHTS_0 = 4;
  json.nodes!.push({ name: "bone" });
  json.nodes![0].skin = 0;
  json.scenes![0].nodes = [0, 1];
  json.skins = [
    { name: "rig", joints: [1], skeleton: 1, inverseBindMatrices: 5 },
  ];
  return {
    json,
    bin: combined,
    jointOffset: bin.length,
    weightOffset: bin.length + joints.length,
  };
}
test("GLB accepts a real one-joint skin with verified weights and inverse bind matrix", async () => {
  const { json, bin } = rigFixture();
  const result = await inspect(pack(json, bin), "model");
  assert.equal(result.skinCount, 1);
  assert.equal(result.jointCount, 1);
  assert.deepEqual((result.skins as Array<{ joints: number[] }>)[0].joints, [
    1,
  ]);
});
test("GLB rejects vertex joint outside skin", async () => {
  const { json, bin, jointOffset } = rigFixture();
  bin[jointOffset] = 1;
  await rejects(pack(json, bin), "model", invalid, /joint outside/);
});
test("GLB rejects invalid skin weight sum", async () => {
  const { json, bin, weightOffset } = rigFixture();
  bin.writeFloatLE(0.5, weightOffset);
  await rejects(pack(json, bin), "model", invalid, /sum to one/);
});
test("GLB accepts CUBICSPLINE animation and reports actual keyframe count", async () => {
  const { json, bin } = fixture();
  const combined = Buffer.concat([
    bin.subarray(0, 44),
    floats(Array(18).fill(0)),
  ]);
  json.buffers![0].byteLength = combined.length;
  json.bufferViews![2].byteLength = 72;
  json.accessors![2].count = 6;
  json.animations![0].samplers[0].interpolation = "CUBICSPLINE";
  const result = await inspect(pack(json, combined), "model");
  const clip = (
    result.animations as Array<{
      duration: number;
      keyframeCount: number;
      channels: Array<{ interpolation: string }>;
    }>
  )[0];
  assert.equal(clip.duration, 1);
  assert.equal(clip.keyframeCount, 2);
  assert.equal(clip.channels[0].interpolation, "CUBICSPLINE");
});
test("GLB rejects non-unit animated quaternion", async () => {
  const { json, bin } = fixture();
  const combined = Buffer.concat([
    bin.subarray(0, 44),
    floats([0, 0, 0, 1, 0, 0, 0, 0]),
  ]);
  json.buffers![0].byteLength = combined.length;
  json.bufferViews![2].byteLength = 32;
  json.accessors![2].type = "VEC4";
  json.animations![0].channels[0].target.path = "rotation";
  await rejects(pack(json, combined), "model", invalid, /rotation quaternion/);
});
test("GLB rejects geometry indices outside vertex range", async () => {
  const { json, bin } = fixture();
  const indices = Buffer.from([0, 0, 1, 0, 8, 0]);
  json.bufferViews!.push({
    buffer: 0,
    byteOffset: bin.length,
    byteLength: indices.length,
  });
  json.accessors!.push({
    bufferView: 3,
    type: "SCALAR",
    componentType: 5123,
    count: 3,
  });
  json.meshes![0].primitives[0].indices = 3;
  const combined = Buffer.concat([bin, indices]);
  json.buffers![0].byteLength = combined.length;
  await rejects(
    pack(json, combined),
    "model",
    invalid,
    /Index exceeds vertex count/,
  );
});
test("GLB rejects duplicate BIN chunks", async () => {
  const { json, bin } = fixture();
  const b = pack(json, bin);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(0x004e4942, 4);
  const duplicate = Buffer.concat([b, tail]);
  duplicate.writeUInt32LE(duplicate.length, 8);
  await rejects(duplicate, "model", invalid, /Duplicate BIN/);
});
test("GLB rejects missing BIN chunk", async () => {
  const { json } = fixture();
  await rejects(pack(json), "model", invalid, /Missing BIN resource/);
});
test("GLB rejects GLB header version 1 as unsupported", async () => {
  const { json, bin } = fixture();
  const b = pack(json, bin);
  b.writeUInt32LE(1, 4);
  await rejects(b, "model", unsupported, /GLB version 1/);
});
test("GLB rejects image MIME mismatch", async () => {
  const { json, bin } = fixture();
  const image = png();
  json.bufferViews!.push({
    buffer: 0,
    byteOffset: bin.length,
    byteLength: image.length,
  });
  json.images = [{ mimeType: "image/jpeg", bufferView: 3 }];
  const combined = Buffer.concat([bin, image]);
  json.buffers![0].byteLength = combined.length;
  await rejects(pack(json, combined), "model", invalid, /MIME does not match/);
});
test("PNG rejects trailing file bytes", async () => {
  await rejects(
    Buffer.concat([png(), Buffer.from([0])]),
    "texture",
    invalid,
    /trailing bytes/,
  );
});
test("PNG rejects noncontiguous IDAT chunks", async () => {
  const b = png();
  const payload = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
  await rejects(
    Buffer.concat([
      b.subarray(0, 33),
      chunk("IDAT", payload.subarray(0, 3)),
      chunk("tEXt", Buffer.from("key\0value")),
      chunk("IDAT", payload.subarray(3)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    "texture",
    invalid,
    /Non-contiguous/,
  );
});
test("WAV rejects float audio without required fact chunk", async () => {
  const b = wav(3, 32);
  const start = b.indexOf(Buffer.from("fact"));
  const noFact = Buffer.concat([b.subarray(0, start), b.subarray(start + 12)]);
  noFact.writeUInt32LE(noFact.length - 8, 4);
  await rejects(noFact, "audio", invalid, /requires a fact/);
});
test("WAV accepts an odd ancillary chunk with RIFF padding", async () => {
  const b = wav();
  const junk = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 7, 0]);
  const combined = Buffer.concat([b.subarray(0, 36), junk, b.subarray(36)]);
  combined.writeUInt32LE(combined.length - 8, 4);
  const result = await inspect(combined, "audio");
  assert.equal(result.frameCount, 4);
});

test("WAV rejects non-ASCII bytes masquerading as RIFF magic", async () => {
  const b = wav();
  b[0] |= 0x80;
  await rejects(b, "audio", invalid, /header/);
});
test("PNG rejects a non-ASCII chunk type even with a valid CRC", async () => {
  const b = png();
  b[12] |= 0x80;
  b.writeUInt32BE(crc(b.subarray(12, 29)), 29);
  await rejects(b, "texture", invalid, /chunk type/);
});
