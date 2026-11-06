import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createSurfaceTextureCache, extractSurfaceScene, sampleSurfaceMaterial } from "../packages/renderer/src/surface.ts";

function texture(pixels: number[], colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(pixels), pixels.length / 4, 1);
  t.colorSpace = colorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}
function scene(material: THREE.Material): THREE.Scene {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.PlaneGeometry(), material));
  return s;
}
const sample = (s: ReturnType<typeof extractSurfaceScene>, uv0: [number, number] = [0.25, 0.5], uv1: [number, number] = [0.25, 0.5]) =>
  sampleSurfaceMaterial(s, 0, [1, 0, 0], { uv0, uv1 });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const linear = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;

test("physical specular textures sample alpha and decoded RGB with factors and UV transforms", () => {
  const intensity = texture([10, 20, 30, 64, 40, 50, 60, 192]);
  const color = texture([128, 64, 255, 0, 255, 128, 32, 255], THREE.SRGBColorSpace);
  intensity.channel = 1;
  intensity.wrapS = THREE.RepeatWrapping;
  intensity.offset.x = 0.5;
  const material = new THREE.MeshPhysicalMaterial({ specularIntensity: 0.5, specularColor: new THREE.Color().setRGB(0.2, 0.4, 0.8), specularIntensityMap: intensity, specularColorMap: color });
  const snapshot = extractSurfaceScene(scene(material));
  assert.equal(snapshot.materials[0].maps.specularIntensityMap, intensity.uuid);
  assert.equal(snapshot.materials[0].maps.specularColorMap, color.uuid);
  const result = sample(snapshot);
  close(result.specularIntensity, 0.5 * 192 / 255);
  [0.2 * linear(128 / 255), 0.4 * linear(64 / 255), 0.8].forEach((v, i) => close(result.specularColor[i], v));
  close(sample(snapshot, [0.75, 0.5], [0.75, 0.5]).specularIntensity, 0.5 * 64 / 255);
});

test("color filtering interpolates decoded texels and defaults preserve physical factors", () => {
  const color = texture([0, 0, 0, 9, 255, 128, 255, 240], THREE.SRGBColorSpace);
  color.magFilter = THREE.LinearFilter;
  const material = new THREE.MeshPhysicalMaterial({ specularIntensity: 0.7, specularColor: new THREE.Color().setRGB(0.5, 0.25, 1), specularColorMap: color });
  const result = sample(extractSurfaceScene(scene(material)), [0.5, 0.5]);
  close(result.specularIntensity, 0.7);
  [0.25, 0.25 * linear(128 / 255) / 2, 0.5].forEach((v, i) => close(result.specularColor[i], v));
  const standard = sample(extractSurfaceScene(scene(new THREE.MeshStandardMaterial())));
  assert.equal(standard.specularIntensity, 1);
  assert.deepEqual(standard.specularColor, [1, 1, 1]);
});

test("texture cache reuses snapshots and invalidates changed specular textures", () => {
  const intensity = texture([0, 0, 0, 128]);
  const material = new THREE.MeshPhysicalMaterial({ specularIntensityMap: intensity });
  const s = scene(material), cache = createSurfaceTextureCache();
  const a = extractSurfaceScene(s, { textureCache: cache });
  const b = extractSurfaceScene(s, { textureCache: cache });
  assert.equal(a.textures[0], b.textures[0]);
  intensity.offset.x = 0.2;
  const c = extractSurfaceScene(s, { textureCache: cache });
  assert.notEqual(c.textures[0], b.textures[0]);
  cache.dispose();
});

test("rejects transmissive maps and invalid color spaces, UVs, and missing pixels", () => {
  for (const slot of ["specularIntensityMap", "specularColorMap"] as const) {
    const t = texture([1, 2, 3, 4], slot === "specularColorMap" ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    const material = new THREE.MeshPhysicalMaterial({ transmission: 0.5, [slot]: t });
    assert.throws(() => extractSurfaceScene(scene(material)), /SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED/);
    material.transmission = 0;
    t.colorSpace = slot === "specularColorMap" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    assert.throws(() => extractSurfaceScene(scene(material)), /SURFACE_COLOR_SPACE_UNSUPPORTED/);
    t.colorSpace = slot === "specularColorMap" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.channel = 2;
    assert.throws(() => extractSurfaceScene(scene(material)), /SURFACE_UV_CHANNEL_UNSUPPORTED/);
  }
  const t = new THREE.Texture({ width: 1, height: 1 });
  const s = extractSurfaceScene(scene(new THREE.MeshPhysicalMaterial({ specularIntensityMap: t })));
  assert.throws(() => sample(s), /SURFACE_TEXTURE_PIXELS_UNAVAILABLE/);
  const uv = texture([1, 2, 3, 4]);
  uv.channel = 1;
  const noUv = extractSurfaceScene(scene(new THREE.MeshPhysicalMaterial({ specularIntensityMap: uv })));
  assert.throws(() => sampleSurfaceMaterial(noUv, 0, [1, 0, 0]), /SURFACE_UV_MISSING/);
});
