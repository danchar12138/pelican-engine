import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { BSDF_SHADER, bsdfPdf, evaluateBsdf, sampleBsdf } from "../packages/renderer/src/bsdf.ts";
import { VOLUME_SHADER } from "../packages/renderer/src/volume-shader.ts";
import { PATH_SHADER } from "../packages/renderer/src/path-shader.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import { packSurfaceMaterialTable } from "../packages/renderer/src/surface-gpu.ts";

const n = [0, 0, 1] as const, base = [0.2, 0.4, 0.6] as const;
test("opaque IOR controls dielectric F0, evaluation, proposal and weights", () => {
  const values = [1.1, 1.5, 2].map((ior) => {
    const f0 = ((ior - 1) / (ior + 1)) ** 2;
    const expected = f0 / (4 * Math.PI * 0.35 ** 4) + base[0] * (1 - f0) ** 2 / Math.PI;
    const value = evaluateBsdf(n, n, n, base, 0.35, 0, ior)[0];
    assert.ok(Math.abs(value - expected) < 1e-12);
    const sample = sampleBsdf(n, n, base, 0.35, 0, [0.02, 0.3, 0.4], ior);
    assert.ok(sample.pdf > 0);
    assert.ok(Math.abs(sample.pdf - bsdfPdf(n, n, sample.direction, base, 0.35, 0, ior)) < 1e-12);
    const f = evaluateBsdf(n, n, sample.direction, base, 0.35, 0, ior);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(sample.weight[c] - f[c] * sample.direction[2] / sample.pdf) < 1e-12);
    return value;
  });
  assert.ok(values[0] < values[1] && values[1] < values[2]);
  assert.deepEqual(evaluateBsdf(n, n, n, base, 0.35, 0), evaluateBsdf(n, n, n, base, 0.35, 0, 1.5));
  assert.deepEqual(evaluateBsdf(n, n, n, base, 0.35, 1, 1.1), evaluateBsdf(n, n, n, base, 0.35, 1, 2));
  for (const ior of [0, -1, NaN, Infinity]) assert.throws(() => evaluateBsdf(n, n, n, base, 0.35, 0, ior), /ior/);
});
test("opaque physical node capture packs IOR and shader uses it in evaluation, PDF and sampling", () => {
  const scene = new THREE.Scene(), capture = createSurfaceCapture();
  const materials = [1.1, 1.5, 2].map((ior) => new THREE.MeshPhysicalNodeMaterial({ ior, transmission: 0 }));
  const geometry = new THREE.PlaneGeometry();
  for (const material of materials) scene.add(new THREE.Mesh(geometry, material));
  try {
    const snapshot = capture.capture(scene).surface;
    const packed = packSurfaceMaterialTable(snapshot);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(packed[i * 32 + 25] - materials[i].ior) < 1e-6);
    for (const name of ["Evaluate", "Pdf", "Sample"]) {
      assert.match(BSDF_SHADER, new RegExp(`fn bsdf${name}Ior\\(`));
      assert.match(VOLUME_SHADER, new RegExp(`bsdf${name}Specular\\(`));
    }
    assert.match(VOLUME_SHADER, /select\(surface\.medium\.y,1\.5,surface\.medium\.x>0\.0\)/);
    assert.match(SURFACE_SHADER, /var medium=material\.physical;/);
    assert.match(SURFACE_SHADER, /SurfaceValue\(color\.rgb,color\.a,normal,roughness,emissive,metalness,ao,0u,medium,specular\)/);
    assert.doesNotMatch(SURFACE_SHADER, /medium\.y\s*=/, "IOR must pass through without reassignment");
    for (const name of ["traceEvaluate", "tracePdf", "traceScatter"]) assert.match(PATH_SHADER, new RegExp(`${name}\\(`));
  } finally { capture.dispose(); geometry.dispose(); materials.forEach((material) => material.dispose()); }
});
