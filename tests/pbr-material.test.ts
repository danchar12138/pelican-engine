import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setupPBRMaterial } from "../packages/renderer/src/pbr-material.ts";
import { createManagedGeometry } from "../packages/renderer/src/managed-geometry.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import { sampleSurfaceMaterial } from "../packages/renderer/src/surface.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
} from "../packages/renderer/src/surface-gpu.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
const definition = (): SceneIR["materials"][number] => ({
  id: "pbr",
  color: "white",
  roughness: 0.8,
  metalness: 0.6,
  texture: "shared",
  normalMap: "normal",
  roughnessMap: "shared",
  metalnessMap: "shared",
  aoMap: "shared",
  emissiveMap: "shared",
  normalScale: [0.25, 0.5],
  source: { file: "game.ts", line: 1, column: 1, length: 1 },
});
const texture = (values: number[], space: string) => {
  const t = new THREE.DataTexture(
    new Float32Array(values),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  t.colorSpace = space;
  t.needsUpdate = true;
  return t;
};
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
test("raster node maps survive real surface adaptation, trace sampling and GPU resource packing with per-slot color spaces", () => {
  for (const Material of [
    THREE.MeshStandardNodeMaterial,
    THREE.MeshPhysicalNodeMaterial,
  ]) {
    const source = texture([0.25, 0.5, 0.75, 1], THREE.SRGBColorSpace),
      normal = texture([1, 0.5, 1, 1], THREE.SRGBColorSpace);
    const textures = new Map([
        ["shared", source],
        ["normal", normal],
      ]),
      def = definition();
    const material = new Material({
      color: "white",
      roughness: 0.8,
      metalness: 0.6,
      emissive: "white",
      emissiveIntensity: 2,
    });
    const geometry = createManagedGeometry(
      {
        kind: "buffer",
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        uv: [0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2],
      },
      "shape",
    );
    const scene = new THREE.Scene(),
      capture = createSurfaceCapture();
    const counts = new Map<THREE.Texture, number>();
    let sourceDisposals = 0;
    source.addEventListener("dispose", () => sourceDisposals++);
    normal.addEventListener("dispose", () => sourceDisposals++);
    try {
      setupPBRMaterial(material, def, textures);
      for (const slot of [
        "map",
        "normalMap",
        "roughnessMap",
        "metalnessMap",
        "aoMap",
        "emissiveMap",
      ] as const) {
        const map = material[slot]!;
        counts.set(map, 0);
        map.addEventListener("dispose", () =>
          counts.set(map, counts.get(map)! + 1),
        );
        assert.notEqual(map, slot === "normalMap" ? normal : source);
        assert.equal(
          map.source,
          slot === "normalMap" ? normal.source : source.source,
        );
        assert.equal(
          map.colorSpace,
          slot === "map" || slot === "emissiveMap"
            ? THREE.SRGBColorSpace
            : THREE.NoColorSpace,
        );
      }
      assert.equal(source.colorSpace, THREE.SRGBColorSpace);
      assert.equal(normal.colorSpace, THREE.SRGBColorSpace);
      scene.add(new THREE.Mesh(geometry, material));
      const { surface } = capture.capture(scene),
        sample = sampleSurfaceMaterial(surface, 0, [0.2, 0.3, 0.5]);
      assert.equal(surface.textures.length, 6);
      near(sample.roughness, 0.4);
      near(sample.metalness, 0.45);
      near(sample.occlusion, 0.25);
      const decode = (v: number) => ((v + 0.055) / 1.055) ** 2.4;
      near(sample.baseColor[0], decode(0.25));
      near(sample.emissive[1], 2 * decode(0.5));
      near(sample.normal[0], 0.25 / Math.hypot(0.25, 1));
      near(sample.normal[2], 1 / Math.hypot(0.25, 1));
      assert.ok(packSurfaceGeometry(surface).length > 0);
      assert.ok(packSurfaceResources(surface).materials.length > 0);
      capture.dispose();
      assert.ok([...counts.values()].every((n) => n === 0));
      material.dispose();
      material.dispose();
      assert.ok([...counts.values()].every((n) => n === 1));
      assert.equal(sourceDisposals, 0);
      assert.equal(textures.get("shared"), source);
    } finally {
      capture.dispose();
      material.dispose();
      geometry.dispose();
      source.dispose();
      normal.dispose();
    }
  }
});
test("linear color assets keep their color space and failing setup rolls back owned views without disposing asset textures", () => {
  const source = texture([0.5, 0.5, 0.5, 1], THREE.LinearSRGBColorSpace),
    material = new THREE.MeshStandardNodeMaterial();
  let sourceDisposals = 0;
  source.addEventListener("dispose", () => sourceDisposals++);
  try {
    setupPBRMaterial(
      material,
      { ...definition(), normalMap: "shared" },
      new Map([["shared", source]]),
    );
    assert.equal(material.map!.colorSpace, THREE.LinearSRGBColorSpace);
    material.dispose();
    const failed = new THREE.MeshStandardNodeMaterial();
    let releases = 0;
    const clone = source.clone.bind(source);
    source.clone = () => {
      const view = clone();
      view.addEventListener("dispose", () => releases++);
      return view;
    };
    assert.throws(
      () =>
        setupPBRMaterial(failed, definition(), new Map([["shared", source]])),
      /TC_MATERIAL_TEXTURE: pbr.normalMap:.*normal.*Repair:/,
    );
    assert.equal(releases, 1);
    assert.equal(sourceDisposals, 0);
    failed.dispose();
    assert.equal(releases, 1);
    for (const invalid of [
      [NaN, 1],
      [1e40, 1],
      [1e-50, 1],
      [1],
      new Array(2),
      null,
    ]) {
      const m = new THREE.MeshStandardNodeMaterial();
      assert.throws(
        () =>
          setupPBRMaterial(
            m,
            {
              id: "bad",
              normalScale: invalid,
            } as unknown as SceneIR["materials"][number],
            new Map(),
          ),
        /TC_MATERIAL_NORMAL_SCALE: bad.normalScale:.*Repair:/,
      );
      m.dispose();
    }
  } finally {
    material.dispose();
    source.dispose();
  }
});
