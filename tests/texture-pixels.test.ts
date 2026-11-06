import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { createTexturePixelProvider } from "../packages/renderer/src/texture-pixels.ts";
import {
  createSurfaceTextureCache,
  extractSurfaceScene,
  packSurfaceTextureRGBA8,
  sampleSurfaceMaterial,
  type SurfaceExtractionOptions,
} from "../packages/renderer/src/surface.ts";

function fixture(material: THREE.Material) {
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry();
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2, 0, 0));
  scene.add(mesh, new THREE.Mesh(geometry, material));
  return { scene, mesh };
}
function dataTexture() {
  return new THREE.DataTexture(
    new Uint8Array([255, 64, 16, 255, 0, 128, 255, 255]),
    2,
    1,
  );
}

test("Node imports and native byte/float DataTexture extraction need no browser or DOM", () => {
  assert.equal(typeof document, "undefined");
  const provider = createTexturePixelProvider();
  const texture = dataTexture();
  assert.equal(provider.decode(texture), undefined);
  assert.equal(provider.inspect().nativeDelegations, 1);
  const { scene } = fixture(new THREE.MeshStandardMaterial({ map: texture }));
  const snapshot = extractSurfaceScene(scene, {
    decodedTextureProvider: provider.decode,
  });
  assert.equal(
    provider.inspect().requests,
    1,
    "surface bypasses provider for native data",
  );
  assert.deepEqual(snapshot.diagnostics, []);
  assert.ok(Object.isFrozen(snapshot.textures[0].pixels));
  assert.deepEqual(
    sampleSurfaceMaterial(snapshot, 0, [1, 0, 0], { uv0: [0.25, 0.5] })
      .baseColor,
    [1, 64 / 255, 16 / 255],
  );
  const hdr = new THREE.DataTexture(
    new Float32Array([2, 0.5, 0.25, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const hdrSnapshot = extractSurfaceScene(
    fixture(new THREE.MeshStandardMaterial({ map: hdr })).scene,
    { decodedTextureProvider: provider.decode },
  );
  assert.deepEqual(hdrSnapshot.textures[0].pixels, [2, 0.5, 0.25, 1]);
  assert.throws(() => packSurfaceTextureRGBA8(hdrSnapshot.textures[0]), {
    code: "SURFACE_TEXTURE_PACK_UNSUPPORTED",
  });
});

test("provider reports unavailable DOM, unsupported types, disposal and JSON inspection", () => {
  const provider = createTexturePixelProvider();
  const texture = new THREE.Texture();
  assert.equal(provider.decode(texture), undefined);
  assert.equal(
    provider.inspect().diagnostics[0].code,
    "TC_TEXTURE_DOM_UNAVAILABLE",
  );
  texture.type = THREE.HalfFloatType;
  assert.equal(provider.decode(texture), undefined);
  assert.equal(
    provider.inspect().diagnostics[0].code,
    "TC_TEXTURE_TYPE_UNSUPPORTED",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(provider.inspect())),
    provider.inspect(),
  );
  provider.clear();
  assert.equal(provider.inspect().capacity.retainedBytes, 0);
  assert.equal(provider.inspect().diagnostics.length, 0);
  assert.equal(provider.inspect().disposed, false);
  provider.dispose();
  provider.dispose();
  assert.equal(provider.decode(texture), undefined);
  assert.equal(
    provider.inspect().diagnostics[0].code,
    "TC_TEXTURE_PROVIDER_DISPOSED",
  );
});

test("content-owned surface cache reuses frozen records and captures all sampler/UV changes", () => {
  const texture = dataTexture();
  const { scene } = fixture(new THREE.MeshStandardMaterial({ map: texture }));
  const textureCache = createSurfaceTextureCache();
  const options = { textureCache };
  let current = extractSurfaceScene(scene, options).textures[0];
  assert.strictEqual(extractSurfaceScene(scene, options).textures[0], current);
  assert.equal(textureCache.inspect().hits, 1);
  const edits: (() => void)[] = [
    () => {
      texture.wrapS = THREE.RepeatWrapping;
    },
    () => {
      texture.wrapT = THREE.MirroredRepeatWrapping;
    },
    () => {
      texture.offset.x = 0.1;
    },
    () => {
      texture.repeat.y = 2;
    },
    () => {
      texture.center.x = 0.25;
    },
    () => {
      texture.rotation = 0.3;
    },
    () => {
      texture.magFilter = THREE.LinearFilter;
    },
    () => {
      texture.minFilter = THREE.LinearFilter;
    },
    () => {
      texture.channel = 1;
    },
    () => {
      texture.flipY = true;
    },
    () => {
      texture.colorSpace = THREE.SRGBColorSpace;
    },
    () => {
      texture.anisotropy = 4;
    },
    () => {
      texture.generateMipmaps = true;
    },
    () => {
      texture.matrixAutoUpdate = false;
      texture.matrix.elements[6] = 0.75;
    },
  ];
  for (const edit of edits) {
    const saved = JSON.stringify(current);
    edit();
    const next = extractSurfaceScene(scene, options).textures[0];
    assert.notStrictEqual(next, current);
    assert.ok(Object.isFrozen(next) && Object.isFrozen(next.pixels));
    assert.equal(JSON.stringify(current), saved);
    assert.strictEqual(extractSurfaceScene(scene, options).textures[0], next);
    current = next;
  }
  const saved = current.pixels!.slice();
  texture.image.data![0] = 0;
  assert.strictEqual(
    extractSurfaceScene(scene, options).textures[0],
    current,
    "unannounced data edits are outside the cache contract",
  );
  texture.needsUpdate = true;
  const changed = extractSurfaceScene(scene, options).textures[0];
  assert.notStrictEqual(changed, current);
  assert.deepEqual(current.pixels, saved);
  assert.equal(changed.pixels![0], 0);
  texture.source.needsUpdate = true;
  const sourceChanged = extractSurfaceScene(scene, options).textures[0];
  assert.notStrictEqual(sourceChanged, changed);
  texture.version++;
  assert.notStrictEqual(
    extractSurfaceScene(scene, options).textures[0],
    sourceChanged,
  );
  const old = extractSurfaceScene(scene, options).textures[0];
  texture.image = {
    data: new Uint8Array([10, 20, 30, 255]),
    width: 1,
    height: 1,
  };
  const imageChanged = extractSurfaceScene(scene, options).textures[0];
  assert.notStrictEqual(imageChanged, old);
  texture.source = new THREE.Texture(texture.image).source;
  assert.notStrictEqual(
    extractSurfaceScene(scene, options).textures[0],
    imageChanged,
  );
  textureCache.clear();
  assert.equal(textureCache.inspect().entries, 0);
  assert.notStrictEqual(
    extractSurfaceScene(scene, options).textures[0],
    imageChanged,
  );
  textureCache.dispose();
  assert.equal(textureCache.inspect().entries, 0);
  assert.throws(() => extractSurfaceScene(scene, options), {
    code: "SURFACE_TEXTURE_CACHE_DISPOSED",
  });
});

test("surface cache includes provider identity, retries unavailable pixels, and preserves diagnostics", () => {
  const texture = new THREE.Texture({
    width: 1,
    height: 1,
  } as unknown as HTMLImageElement);
  const { scene } = fixture(new THREE.MeshStandardMaterial({ map: texture }));
  const textureCache = createSurfaceTextureCache();
  let available = false,
    calls = 0;
  const decodedTextureProvider = () => {
    calls++;
    return available
      ? {
          width: 1,
          height: 1,
          channels: 4 as const,
          data: new Uint8Array([64, 0, 0, 255]),
          encoding: "unorm8" as const,
          origin: "image" as const,
        }
      : undefined;
  };
  const options = { textureCache, decodedTextureProvider };
  assert.ok(
    extractSurfaceScene(scene, options).diagnostics.some(
      (d) => d.code === "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
    ),
  );
  available = true;
  const first = extractSurfaceScene(scene, options);
  assert.strictEqual(
    extractSurfaceScene(scene, options).textures[0],
    first.textures[0],
  );
  assert.equal(calls, 2);
  const changed = extractSurfaceScene(scene, {
    textureCache,
    decodedTextureProvider: () => ({
      ...decodedTextureProvider()!,
      data: new Uint8Array([0, 255, 0, 255]),
    }),
  });
  assert.notStrictEqual(changed.textures[0], first.textures[0]);
  assert.equal(changed.textures[0].pixels![1], 1);
  texture.premultiplyAlpha = true;
  const unsupported = extractSurfaceScene(scene, options);
  assert.ok(
    unsupported.diagnostics.some(
      (d) => d.code === "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
    ),
  );
  assert.equal(unsupported.textures[0].pixels, undefined);
});

test("RGBA8 GPU packing uses one uint32 per texel and preserves encoded RGB/alpha", () => {
  const texture = dataTexture();
  texture.colorSpace = THREE.SRGBColorSpace;
  const snapshot = extractSurfaceScene(
    fixture(new THREE.MeshStandardMaterial({ map: texture })).scene,
  );
  const packed = packSurfaceTextureRGBA8(snapshot.textures[0]);
  assert.ok(packed instanceof Uint32Array);
  assert.equal(packed.byteLength, 8);
  assert.deepEqual(Array.from(packed), [0xff1040ff, 0xffff8000]);
  packed[0] = 0;
  assert.equal(snapshot.textures[0].pixels![0], 1);
});

test("adapter converts known engine NodeMaterial once per original, keeps instanced IDs and source ownership", () => {
  const original = new MeshStandardNodeMaterial({ color: 0x4080ff });
  original.map = dataTexture();
  const replacement = new THREE.MeshStandardMaterial({
    color: original.color,
    map: original.map,
  });
  const replacementUuid = replacement.uuid;
  const { scene, mesh } = fixture(original);
  assert.throws(() => extractSurfaceScene(scene), {
    code: "SURFACE_NODE_GRAPH_UNSUPPORTED",
  });
  let calls = 0;
  const materialAdapter = (material: THREE.Material) => {
    assert.strictEqual(material, original);
    calls++;
    return replacement;
  };
  const first = extractSurfaceScene(scene, { materialAdapter });
  assert.equal(calls, 1);
  assert.equal(first.materials.length, 1);
  assert.equal(first.materials[0].uuid, original.uuid);
  assert.ok(first.triangles.every((t) => t.materialUuid === original.uuid));
  assert.deepEqual(
    [
      ...new Set(
        first.triangles
          .filter((t) => t.objectUuid === mesh.uuid)
          .map((t) => t.instanceId),
      ),
    ],
    [0, 1],
  );
  assert.strictEqual(mesh.material, original);
  assert.strictEqual(original.map, replacement.map);
  assert.equal(replacement.uuid, replacementUuid);
  const second = extractSurfaceScene(scene, { materialAdapter });
  assert.equal(calls, 2);
  assert.deepEqual(first.triangles, second.triangles);
});

test("adapter replacements preserve validation of Node fields and shader hooks", () => {
  const original = new MeshStandardNodeMaterial();
  const { scene } = fixture(original);
  const replacement = new THREE.MeshStandardMaterial();
  const options = { materialAdapter: () => replacement };
  Object.assign(replacement, { colorNode: { isNode: true } });
  assert.throws(() => extractSurfaceScene(scene, options), {
    code: "SURFACE_NODE_GRAPH_UNSUPPORTED",
  });
  Object.assign(replacement, { colorNode: null });
  replacement.onBeforeCompile = () => {};
  assert.throws(() => extractSurfaceScene(scene, options), {
    code: "SURFACE_CUSTOM_SHADER_UNSUPPORTED",
  });
});

test("one replacement shared by two original materials preserves both original UUIDs", () => {
  const first = new MeshStandardNodeMaterial(),
    second = new MeshStandardNodeMaterial();
  const { scene } = fixture(first);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), second));
  const replacement = new THREE.MeshStandardMaterial();
  const replacementUuid = replacement.uuid;
  const calls = new Map<THREE.Material, number>();
  const snapshot = extractSurfaceScene(scene, {
    materialAdapter: (material) => {
      calls.set(material, (calls.get(material) ?? 0) + 1);
      return replacement;
    },
  });
  assert.deepEqual(
    snapshot.materials.map((material) => material.uuid),
    [first.uuid, second.uuid],
  );
  assert.ok(
    snapshot.triangles.some((triangle) => triangle.materialUuid === first.uuid),
  );
  assert.ok(
    snapshot.triangles.some(
      (triangle) => triangle.materialUuid === second.uuid,
    ),
  );
  assert.equal(calls.get(first), 1);
  assert.equal(calls.get(second), 1);
  assert.equal(replacement.uuid, replacementUuid);
});

for (const result of [null, undefined]) {
  test(`adapter ${result} falls back and unknown NodeGraph is still rejected`, () => {
    const materialAdapter: SurfaceExtractionOptions["materialAdapter"] = () =>
      result;
    const node = new MeshStandardNodeMaterial();
    assert.throws(
      () => extractSurfaceScene(fixture(node).scene, { materialAdapter }),
      { code: "SURFACE_NODE_GRAPH_UNSUPPORTED" },
    );
    const material = new THREE.MeshStandardMaterial();
    assert.equal(
      extractSurfaceScene(fixture(material).scene, { materialAdapter })
        .materials[0].uuid,
      material.uuid,
    );
  });
}

test(
  "Chromium: real images, CORS/lifetime/cache failures, Fox/WaterBottle surface colors and ORM",
  {
    skip: process.env.PELICAN_TEXTURE_BROWSER === "0",
    timeout: 120_000,
  },
  async () => {
    const { createServer } = await import("node:http");
    const { readFile } = await import("node:fs/promises");
    const { resolve, relative, sep } = await import("node:path");
    const { chromium } = await import("playwright");
    const ts = await import("typescript");
    const modules = new Map<string, string>(
      await Promise.all(
        ["surface", "texture-pixels", "embedded-image-pixels"].map(async (name) => {
          const source = await readFile(
            new URL(`../packages/renderer/src/${name}.ts`, import.meta.url),
            "utf8",
          );
          return [
            `/${name === "embedded-image-pixels" ? name + ".ts" : name + ".js"}`,
            ts.transpileModule(source, {
              compilerOptions: {
                target: ts.ScriptTarget.ES2023,
                module: ts.ModuleKind.ESNext,
              },
            }).outputText,
          ] as const;
        }),
      ),
    );
    const vendorRoot = resolve("node_modules/three");
    const npmRoot = resolve("node_modules");
    const assets = new Map<string, Buffer>(
      await Promise.all(
        ["Fox", "WaterBottle"].map(
          async (name) =>
            [
              `/${name}.glb`,
              await readFile(
                new URL(`../examples/m2/assets/${name}.glb`, import.meta.url),
              ),
            ] as const,
        ),
      ),
    );
    // A valid image served from a second random origin without CORS headers.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
      "base64",
    );
    const foreign = createServer((_request, response) => {
      response.setHeader("Content-Type", "image/png");
      response.end(png);
    });
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url!, "http://localhost").pathname;
        if (path === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<script type="importmap">{"imports":{"three":"/vendor/build/three.webgpu.js","three/webgpu":"/vendor/build/three.webgpu.js","three/tsl":"/vendor/build/three.tsl.js","three/addons/":"/vendor/examples/jsm/","fast-png":"/npm/fast-png/lib/index.js","fflate":"/npm/fflate/esm/browser.js","iobuffer":"/npm/iobuffer/lib/iobuffer.js"}}</script>',
          );
        } else if (modules.has(path)) {
          response.setHeader("Content-Type", "text/javascript");
          response.end(modules.get(path));
        } else if (assets.has(path)) {
          response.setHeader("Content-Type", "model/gltf-binary");
          response.end(assets.get(path));
        } else if (path === "/pixel.png") {
          response.setHeader("Content-Type", "image/png");
          response.end(png);
        } else if (path.startsWith("/vendor/") || path.startsWith("/npm/")) {
          const root = path.startsWith("/vendor/") ? vendorRoot : npmRoot;
          const target = resolve(root, path.slice(path.startsWith("/vendor/") ? 8 : 5));
          const within = relative(root, target);
          if (
            within === ".." ||
            within.startsWith(".." + sep) ||
            resolve(root, within) !== target
          ) {
            response.writeHead(403);
            response.end();
            return;
          }
          response.setHeader("Content-Type", "text/javascript");
          response.end(await readFile(target));
        } else {
          response.writeHead(404);
          response.end();
        }
      })().catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
    });
    for (const instance of [server, foreign]) instance.requestTimeout = 10_000;
    async function deadline<T>(
      operation: Promise<T>,
      ms: number,
      label: string,
    ): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Texture browser deadline: ${label}`)),
              ms,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let closing = false;
    try {
      await deadline(
        Promise.all(
          [server, foreign].map(
            (instance) =>
              new Promise<void>((resolve, reject) => {
                instance.once("error", reject);
                instance.listen(0, "127.0.0.1", resolve);
              }),
          ),
        ),
        10_000,
        "listen",
      );
      const address = server.address(),
        foreignAddress = foreign.address();
      assert.ok(
        address &&
          typeof address !== "string" &&
          foreignAddress &&
          typeof foreignAddress !== "string",
      );
      const launch = chromium.launch({ headless: true, timeout: 20_000 });
      // A launch that resolves after a Node timeout must still release its browser.
      void launch
        .then(
          (value) => (closing ? value.close() : ((browser = value), undefined)),
          () => {},
        )
        .catch(() => {});
      browser = await deadline(launch, 25_000, "launch");
      const page = await deadline(browser.newPage(), 10_000, "page");
      page.setDefaultTimeout(10_000);
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await deadline(
        page.evaluate<{
          models: {
            name: string;
            textures: number;
            reads: number;
            colors: number;
            orm: number;
            reused: boolean;
          }[];
          imageChecks: number;
        }>(`(async () => {
      const THREE = await import('three');
      const WEBGPU = await import('three/webgpu');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { createTexturePixelProvider } = await import('/texture-pixels.js');
      const { createSurfaceTextureCache, extractSurfaceScene, sampleSurfaceMaterial, packSurfaceTextureRGBA8 } = await import('/surface.js');
      const check = (value, message) => { if (!value) throw new Error(message); };
      check(THREE.Texture === WEBGPU.Texture && THREE.MeshStandardMaterial === WEBGPU.MeshStandardMaterial, 'namespace core identity');
      const owned = new Set();
      let imageChecks = 0;
      const provider = createTexturePixelProvider();
      const pixels = new ImageData(new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]), 2, 2);
      const bitmap = await createImageBitmap(pixels, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      owned.add(bitmap);
      try {
        const texture = new THREE.Texture(bitmap);
        const clone = texture.clone();
        clone.flipY = !texture.flipY;
        clone.colorSpace = THREE.SRGBColorSpace;
        const first = provider.decode(texture), shared = provider.decode(clone);
        check(first && shared && first.origin === 'image' && shared.origin === 'image' && first.encoding === shared.encoding, 'consistent source encoding/origin');
        check(first.data.every((n,i) => n === shared.data[i]), 'shared source rows unaffected by flip/colorSpace');
        check(provider.inspect().canvasReads === 1, 'shared source decoded once');
        check(first.data.every((n,i) => n === pixels.data[i]), 'Canvas2D preserves known RGBA texels');
        first.data.fill(0);
        check(provider.decode(texture).data[0] === 255, 'returned arrays cannot corrupt cached pixels');
        let reads = provider.inspect().canvasReads;
        texture.version++;
        provider.decode(texture);
        check(provider.inspect().canvasReads === ++reads, 'texture-only revision invalidates');
        texture.source.needsUpdate = true;
        provider.decode(texture);
        provider.decode(clone);
        check(provider.inspect().canvasReads === ++reads, 'source revision invalidates once for shared textures');
        const nextBitmap = await createImageBitmap(pixels); owned.add(nextBitmap);
        texture.image = nextBitmap;
        provider.decode(texture);
        check(provider.inspect().canvasReads === ++reads, 'image identity invalidates without needsUpdate');
        texture.source = new THREE.Texture(nextBitmap).source;
        provider.decode(texture);
        check(provider.inspect().canvasReads === ++reads, 'source identity invalidates');
        imageChecks += 9;

        const html = new Image();
        const imageTexture = new THREE.Texture(html);
        check(provider.decode(imageTexture) === undefined && provider.inspect().diagnostics.at(-1).code === 'TC_TEXTURE_IMAGE_NOT_DECODED', 'undecoded HTMLImageElement');
        html.src = '/pixel.png'; await html.decode();
        const decoded = provider.decode(imageTexture);
        check(decoded && decoded.width === 1 && decoded.data[3] === 255, 'real HTMLImageElement decode');
        const bad = new THREE.Texture({ width: 1, height: 1 });
        check(provider.decode(bad) === undefined && provider.inspect().diagnostics.at(-1).code === 'TC_TEXTURE_IMAGE_UNSUPPORTED', 'unknown image objects are not fabricated');
        bad.image = bitmap; bad.type = THREE.HalfFloatType;
        check(provider.decode(bad) === undefined && provider.inspect().diagnostics.at(-1).code === 'TC_TEXTURE_TYPE_UNSUPPORTED', 'unsupported texture type');
        const foreign = new Image();
        foreign.src = 'http://127.0.0.1:${foreignAddress.port}/pixel.png'; await foreign.decode();
        const foreignTexture = new THREE.Texture(foreign);
        check(provider.decode(foreignTexture) === undefined && provider.inspect().diagnostics.at(-1).code === 'TC_TEXTURE_CROSS_ORIGIN', 'CORS diagnostic');
        const cleanTexture = new THREE.Texture(bitmap);
        check(provider.decode(cleanTexture)?.data[0] === 255, 'tainted canvas recovery');
        // Inject a host allocation failure after drawing a real image, with no
        // synthetic pixel success path or arbitrary texture-size limit.
        const read = OffscreenCanvasRenderingContext2D.prototype.getImageData;
        const limited = createTexturePixelProvider();
        try {
          OffscreenCanvasRenderingContext2D.prototype.getImageData = () => { throw new RangeError('host allocation'); };
          check(limited.decode(new THREE.Texture(bitmap)) === undefined && limited.inspect().diagnostics[0].code === 'TC_TEXTURE_CAPACITY', 'explicit host capacity diagnostic');
          check(limited.inspect().capacity.retainedBytes === 0 && limited.inspect().capacity.unknownResources === 1, 'failed capacity never stores invented pixels');
        } finally { OffscreenCanvasRenderingContext2D.prototype.getImageData = read; limited.dispose(); }
        const offscreen = globalThis.OffscreenCanvas;
        const htmlCanvasProvider = createTexturePixelProvider();
        try {
          globalThis.OffscreenCanvas = undefined;
          check(htmlCanvasProvider.decode(new THREE.Texture(bitmap))?.data[0] === 255, 'private HTMLCanvasElement fallback');
        } finally { globalThis.OffscreenCanvas = offscreen; htmlCanvasProvider.dispose(); }
        const closed = await createImageBitmap(pixels); closed.close();
        check(provider.decode(new THREE.Texture(closed)) === undefined && provider.inspect().diagnostics.at(-1).code === 'TC_TEXTURE_BITMAP_CLOSED', 'closed bitmap diagnostic');
        // Closing an already cached bitmap must also invalidate surface reuse.
        const transient = await createImageBitmap(pixels);
        const transientTexture = new THREE.Texture(transient);
        const transientScene = new THREE.Scene();
        const transientGeometry = new THREE.PlaneGeometry();
        const transientMaterial = new THREE.MeshStandardMaterial({ map: transientTexture });
        transientScene.add(new THREE.Mesh(transientGeometry, transientMaterial));
        const surfaceCache = createSurfaceTextureCache();
        const opts = { textureCache: surfaceCache, decodedTextureProvider: provider.decode };
        const beforeClose = extractSurfaceScene(transientScene, opts);
        transient.close();
        const afterClose = extractSurfaceScene(transientScene, opts);
        check(beforeClose.textures[0].pixels && !afterClose.textures[0].pixels && afterClose.diagnostics.some(d => d.code === 'SURFACE_TEXTURE_PIXELS_UNAVAILABLE'), 'closed source invalidates frozen record');
        surfaceCache.dispose(); transientGeometry.dispose(); transientMaterial.dispose(); transientTexture.dispose();
        provider.clear();
        check(bitmap.width === 2 && nextBitmap.width === 2 && provider.inspect().sources === 0 && provider.inspect().textures === 0 && provider.inspect().capacity.canvasBytes === 0, 'clear releases owned storage without closing borrowed images');
        provider.decode(texture);
        provider.dispose();
        check(bitmap.width === 2 && nextBitmap.width === 2 && provider.inspect().capacity.retainedBytes === 0, 'dispose releases refs without closing images');
        check(provider.decode(texture) === undefined && provider.inspect().diagnostics[0].code === 'TC_TEXTURE_PROVIDER_DISPOSED', 'disposed provider');
        imageChecks += 14;
      } finally { provider.dispose(); for (const image of owned) image.close(); }

      const models = [];
      for (const name of ['Fox', 'WaterBottle']) {
        const gltf = await new GLTFLoader().loadAsync('/' + name + '.glb');
        const provider = createTexturePixelProvider();
        const cache = createSurfaceTextureCache();
        const textures = new Set(), materials = new Set(), geometries = new Set(), images = new Set();
        gltf.scene.traverse(object => {
          if (object.geometry) geometries.add(object.geometry);
          for (const material of object.material ? Array.isArray(object.material) ? object.material : [object.material] : []) {
            materials.add(material);
            for (const value of Object.values(material)) if (value?.isTexture) { textures.add(value); if (value.image instanceof ImageBitmap) images.add(value.image); }
          }
        });
        try {
          const options = { textureCache: cache, decodedTextureProvider: provider.decode };
          const snapshot = extractSurfaceScene(gltf.scene, options);
          check(snapshot.triangles.length > 0 && snapshot.textures.length > 0, name + ' actual parsed geometry/textures');
          check(!snapshot.diagnostics.some(d => d.code === 'SURFACE_TEXTURE_PIXELS_UNAVAILABLE'), name + ' no missingpixel diagnostic');
          check(snapshot.textures.every(t => t.pixels?.length === t.width * t.height * 4 && Object.isFrozen(t.pixels)), name + ' real immutable texels');
          const reads = provider.inspect().canvasReads;
          const repeated = extractSurfaceScene(gltf.scene, options);
          const reused = repeated.textures.every((t,i) => t === snapshot.textures[i]);
          check(reused && provider.inspect().canvasReads === reads, name + ' repeated extraction reuses frozen records');
          const colors = new Set(), orm = new Set();
          // Sample actual barycentrically interpolated model UVs across its mesh.
          const stride = Math.max(1, Math.floor(snapshot.triangles.length / 512));
          for (let i = 0; i < snapshot.triangles.length; i += stride) {
            const sample = sampleSurfaceMaterial(snapshot, i, [0.2, 0.3, 0.5]);
            colors.add(sample.baseColor.map(v => v.toFixed(3)).join(','));
            orm.add([sample.occlusion, sample.roughness, sample.metalness].map(v => v.toFixed(3)).join(','));
          }
          check(colors.size > 1, name + ' sampled texture color diversity: ' + colors.size);
          if (name === 'WaterBottle') {
            check(orm.size > 8, 'WaterBottle sampled ORM diversity');
            const material = snapshot.materials[0];
            check(material.maps.aoMap && material.maps.roughnessMap === material.maps.metalnessMap, 'actual ORM map assignments');
          }
          // Pack one real image for the GPU without a Float32Array staging copy.
          const packed = packSurfaceTextureRGBA8(snapshot.textures[0]);
          check(packed instanceof Uint32Array && packed.length === snapshot.textures[0].width * snapshot.textures[0].height, name + ' RGBA8 packing');
          models.push({ name, textures: snapshot.textures.length, reads, colors: colors.size, orm: orm.size, reused });
          cache.clear(); provider.clear();
          check([...images].every(image => image.width > 0), name + ' images remain caller-owned after clear');
        } finally {
          cache.dispose(); provider.dispose();
          check(cache.inspect().entries === 0 && provider.inspect().sources === 0 && provider.inspect().textures === 0, name + ' release cached refs');
          check([...images].every(image => image.width > 0), name + ' images remain caller-owned after dispose');
          for (const texture of textures) texture.dispose();
          for (const material of materials) material.dispose();
          for (const geometry of geometries) geometry.dispose();
          for (const image of images) image.close();
          check([...images].every(image => image.width === 0), name + ' only owner closes images');
        }
      }
      return { models, imageChecks };
    })()`),
        80_000,
        "image decoding / model extraction",
      );
      assert.equal(result.imageChecks, 23);
      assert.deepEqual(
        result.models.map((model) => model.name),
        ["Fox", "WaterBottle"],
      );
      for (const model of result.models) {
        assert.ok(
          model.textures > 0 &&
            model.reads > 0 &&
            model.colors > 1 &&
            model.reused,
        );
      }
      assert.ok(result.models[1].orm > 8);
      console.log("Texture browser evidence:", JSON.stringify(result));
    } finally {
      closing = true;
      await Promise.allSettled([
        browser
          ? deadline(browser.close(), 5_000, "browser close")
          : Promise.resolve(),
        ...[server, foreign].map((instance) => {
          instance.closeAllConnections();
          return deadline(
            new Promise<void>((resolve) => instance.close(() => resolve())),
            5_000,
            "server close",
          );
        }),
      ]);
    }
  },
);
