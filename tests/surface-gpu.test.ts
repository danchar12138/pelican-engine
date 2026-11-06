import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  extractSurfaceScene,
  sampleSurfaceMaterial,
} from "../packages/renderer/src/surface.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
  packSurfaceMaterialTable,
  unpackSurfaceTexel,
  SURFACE_TRIANGLE_FLOATS,
  SURFACE_MATERIAL_FLOATS,
  SURFACE_TEXTURE_FLOATS,
} from "../packages/renderer/src/surface-gpu.ts";
import { surfaceGpuProbeBufferSizes } from "../tools/surface-gpu-probe.ts";
import { surfaceRayGpuProbeBufferSizes } from "../tools/surface-ray-gpu-probe.ts";
function fixture() {
  const scene = new THREE.Scene(),
    texture = new THREE.DataTexture(
      new Uint8Array([128, 64, 32, 255, 255, 0, 0, 128]),
      2,
      1,
    );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0x4080c0,
    roughness: 0.4,
    metalness: 0.7,
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { scene, texture, material };
}
test("surface GPU layout preserves real triangle material/normal/UV/color slots and separates geometry/resource payloads", () => {
  const { scene } = fixture(),
    snapshot = extractSurfaceScene(scene),
    triangles = packSurfaceGeometry(snapshot),
    resources = packSurfaceResources(snapshot);
  assert.equal(triangles.length, 2 * SURFACE_TRIANGLE_FLOATS);
  assert.equal(resources.materials.length, SURFACE_MATERIAL_FLOATS);
  assert.equal(resources.textures.length, SURFACE_TEXTURE_FLOATS);
  assert.equal(resources.texels.length, 2);
  assert.deepEqual(
    Array.from(triangles.subarray(0, 3)),
    snapshot.triangles[0].vertices[0].position,
  );
  assert.deepEqual(
    Array.from(triangles.subarray(24, 26)),
    snapshot.triangles[0].vertices[0].uv0,
  );
  assert.equal(triangles[3], 0);
  assert.equal(triangles[15], 1);
  assert.equal(resources.materials[12], 0);
  assert.equal(resources.materials[13], -1);
});
test("packed UNORM texels decode sRGB exactly once and preserve alpha", () => {
  const { scene } = fixture(),
    packed = packSurfaceResources(extractSurfaceScene(scene)),
    sample = unpackSurfaceTexel(packed, 0, 0, 0);
  assert.ok(Math.abs(sample[0] - ((128 / 255 + 0.055) / 1.055) ** 2.4) < 1e-10);
  assert.equal(sample[3], 1);
  assert.equal(unpackSurfaceTexel(packed, 0, 1, 0)[3], 128 / 255);
});
test("float32 texture storage preserves HDR values instead of clipping to UNORM", () => {
  const { scene, material } = fixture(),
    texture = new THREE.DataTexture(
      new Float32Array([3.5, 0.5, 0.25, 1]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  material.map = texture;
  const packed = packSurfaceResources(extractSurfaceScene(scene));
  assert.equal(packed.texels.length, 4);
  assert.deepEqual(unpackSurfaceTexel(packed, 0, 0, 0), [3.5, 0.5, 0.25, 1]);
});
test("packed texture rows follow the immutable surface and never apply flipY twice", () => {
  const { scene, material } = fixture(),
    texture = new THREE.DataTexture(
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
      1,
      2,
    );
  texture.flipY = true;
  texture.colorSpace = THREE.NoColorSpace;
  material.map = texture;
  const resources = packSurfaceResources(extractSurfaceScene(scene));
  assert.deepEqual(unpackSurfaceTexel(resources, 0, 0, 0), [0, 1, 0, 1]);
  assert.deepEqual(unpackSurfaceTexel(resources, 0, 0, 1), [1, 0, 0, 1]);
});
test("packing owns detached buffers, fails missing decoded pixels and honors BVH triangle ordering", () => {
  const { scene } = fixture(),
    snapshot = extractSurfaceScene(scene),
    a = packSurfaceResources(snapshot),
    b = packSurfaceResources(snapshot);
  a.texels[0] = 0;
  assert.notEqual(b.texels[0], 0);
  const ordered = [...snapshot.triangles].reverse(),
    geometry = packSurfaceGeometry(snapshot, ordered);
  assert.deepEqual(
    Array.from(geometry.subarray(0, 3)),
    ordered[0].vertices[0].position,
  );
  const missing = {
    ...snapshot,
    textures: snapshot.textures.map((t) => ({ ...t, pixels: undefined })),
  };
  assert.throws(() => packSurfaceResources(missing), /TC_SURFACE_GPU_PIXELS/);
  assert.throws(() => unpackSurfaceTexel(b, 3, 0, 0), /TC_SURFACE_GPU_TEXEL/);
});

test("probe buffers satisfy the WGSL ABI even for empty scenes and query batches", () => {
  assert.equal(SURFACE_TRIANGLE_FLOATS, 72);
  assert.equal(SURFACE_MATERIAL_FLOATS, 32);
  assert.equal(SURFACE_TEXTURE_FLOATS, 24);
  const snapshot = extractSurfaceScene(new THREE.Scene()),
    triangles = packSurfaceGeometry(snapshot),
    resources = packSurfaceResources(snapshot);
  assert.equal(triangles.byteLength, 0);
  assert.equal(resources.materials.byteLength, 0);
  assert.equal(resources.textures.byteLength, 0);
  assert.equal(resources.texels.byteLength, 0);
  const lengths = [
    triangles.length,
    resources.materials.length,
    resources.textures.length,
    resources.texels.length,
  ] as const;
  assert.deepEqual(
    surfaceGpuProbeBufferSizes([...lengths, 0]),
    [288, 128, 96, 4, 16, 16],
  );
  assert.deepEqual(
    surfaceRayGpuProbeBufferSizes([...lengths, 0, 0]),
    [288, 128, 96, 4, 16, 32, 16, 16],
  );
  assert.deepEqual(
    surfaceGpuProbeBufferSizes([144, 64, 48, 10, 12]),
    [576, 256, 192, 40, 48, 336],
  );
  assert.deepEqual(
    surfaceRayGpuProbeBufferSizes([144, 64, 48, 10, 20, 24]),
    [576, 256, 192, 40, 80, 96, 48, 16],
  );
});

test("textureless material buffers still occupy the full 128-byte physical ABI", () => {
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()),
  );
  const snapshot = extractSurfaceScene(scene),
    triangles = packSurfaceGeometry(snapshot),
    resources = packSurfaceResources(snapshot);
  assert.equal(resources.materials.byteLength, 128);
  assert.equal(resources.textures.byteLength, 0);
  assert.equal(resources.texels.byteLength, 0);
  assert.deepEqual(
    surfaceGpuProbeBufferSizes([
      triangles.length,
      resources.materials.length,
      resources.textures.length,
      resources.texels.length,
      4,
    ]),
    [576, 128, 96, 4, 16, 112],
  );
  assert.deepEqual(
    surfaceRayGpuProbeBufferSizes([
      triangles.length,
      resources.materials.length,
      resources.textures.length,
      resources.texels.length,
      8,
      8,
    ]),
    [576, 128, 96, 4, 32, 32, 16, 16],
  );
});

test("physical material rows preserve transmission, IOR, linear attenuation and infinite-distance sentinel", () => {
  const scene = new THREE.Scene(),
    tinted = new THREE.MeshPhysicalMaterial({
      transmission: 0.8,
      ior: 1.45,
      attenuationColor: 0x4080c0,
      attenuationDistance: 2,
      roughness: 0.15,
      opacity: 0.35,
      transparent: true,
      side: THREE.FrontSide,
    }),
    clear = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      ior: 1.33,
      attenuationDistance: Infinity,
      side: THREE.BackSide,
    }),
    standard = new THREE.MeshStandardMaterial();
  for (const material of [tinted, clear, standard])
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
  const snapshot = extractSurfaceScene(scene),
    resources = packSurfaceResources(snapshot);
  assert.equal(resources.materials.byteLength, 3 * 128);
  assert.deepEqual(resources.materials, packSurfaceMaterialTable(snapshot));
  const linear = [64, 128, 192].map(
    (byte) => ((byte / 255 + 0.055) / 1.055) ** 2.4,
  );
  for (const [source, expected] of [
    [tinted, [0.8, 1.45, 2, 0, ...linear, 0]],
    [clear, [1, 1.33, 0, 0, 1, 1, 1, 0]],
    [standard, [0, 1.5, 0, 0, 1, 1, 1, 0]],
  ] as const) {
    const row = resources.materialIds.indexOf(source.uuid);
    assert.ok(row >= 0);
    const offset = row * SURFACE_MATERIAL_FLOATS;
    assert.deepEqual(
      Array.from(resources.materials.subarray(offset + 24, offset + 32)),
      expected.map(Math.fround),
    );
    assert.equal(resources.materials[offset + 3], Math.fround(source.opacity));
    assert.equal(resources.materials[offset + 12], -1);
    assert.equal(resources.materials[offset + 18], -1);
  }
  for (const source of [tinted, clear]) {
    const index = snapshot.triangles.findIndex(
      (triangle) => triangle.materialUuid === source.uuid,
    );
    const front = sampleSurfaceMaterial(snapshot, index, [0.2, 0.3, 0.5], {
        frontFacing: true,
      }),
      back = sampleSurfaceMaterial(snapshot, index, [0.2, 0.3, 0.5], {
        frontFacing: false,
      });
    assert.equal(front.discarded, false);
    assert.equal(back.discarded, false);
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs(front.normal[axis] + back.normal[axis]) < 1e-12);
  }
});

test("triangle packing keeps per-object and per-instance volume IDs beside mirrored orientation through reordering", () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.PlaneGeometry(),
    material = new THREE.MeshPhysicalMaterial({ transmission: 1 }),
    regular = new THREE.Mesh(geometry, material),
    mirrored = new THREE.Mesh(geometry, material),
    instances = new THREE.InstancedMesh(geometry, material, 2);
  regular.scale.set(2, 3, 4);
  mirrored.scale.set(-2, 3, 4);
  instances.setMatrixAt(0, new THREE.Matrix4().makeScale(-2, 1, 1));
  instances.setMatrixAt(1, new THREE.Matrix4().makeScale(-2, -1, 1));
  scene.add(regular, mirrored, instances);
  const snapshot = extractSurfaceScene(scene),
    ordered = [...snapshot.triangles].reverse(),
    key = (objectUuid: string, instanceId = 0) =>
      JSON.stringify([objectUuid, instanceId]),
    volumes = new Map([
      [key(regular.uuid), 11],
      [key(mirrored.uuid), 13],
      [key(instances.uuid, 0), 17],
      [key(instances.uuid, 1), 19],
    ]),
    orientations = new Map([
      [key(regular.uuid), 1],
      [key(mirrored.uuid), -1],
      [key(instances.uuid, 0), -1],
      [key(instances.uuid, 1), 1],
    ]),
    packed = packSurfaceGeometry(snapshot, ordered, volumes),
    defaults = packSurfaceGeometry(snapshot, ordered);
  assert.equal(ordered.length, 8);
  assert.equal(packed.byteLength, 8 * 288);
  for (const [index, triangle] of ordered.entries()) {
    const offset = index * SURFACE_TRIANGLE_FLOATS,
      identity = key(triangle.objectUuid, triangle.instanceId);
    assert.equal(packed[offset + 63], orientations.get(identity));
    assert.equal(packed[offset + 67], volumes.get(identity));
    assert.equal(packed[offset + 71], 0);
    assert.equal(defaults[offset + 63], orientations.get(identity));
    assert.equal(defaults[offset + 67], 0);
    for (let column = 0; column < 3; column++)
      assert.deepEqual(
        Array.from(
          packed.subarray(offset + 60 + column * 4, offset + 63 + column * 4),
        ),
        triangle.normalMatrix
          .slice(column * 3, column * 3 + 3)
          .map(Math.fround),
      );
    assert.deepEqual(
      Array.from(packed.subarray(offset, offset + 3)),
      triangle.vertices[0].position.map(Math.fround),
    );
  }
});
