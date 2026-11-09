import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { appendEmissiveLights, createEmissiveLightCache } from "../packages/renderer/src/emissive-lights.ts";
test("emitter importance records preserve explicit lights and normalize area-radiance probabilities", () => {
  const scene = new THREE.Scene(),
    a = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        emissive: 0xffffff,
        emissiveIntensity: 2,
      }),
    ),
    b = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshStandardMaterial({
        emissive: 0xffffff,
        emissiveIntensity: 1,
      }),
    );
  scene.add(
    a,
    b,
    new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()),
  );
  const surface = extractSurfaceScene(scene),
    explicit = new Float32Array([0, 3, 0, 0, 1, 1, 1, 0, 0, 0, 0, 2]),
    packed = appendEmissiveLights(
      surface,
      [...surface.triangles].reverse(),
      explicit,
    );
  assert.deepEqual(
    Array.from(packed.data.subarray(0, 12)),
    Array.from(explicit),
  );
  assert.equal(packed.emitters, 4);
  assert.ok(Math.abs(packed.totalArea - 5) < 1e-10);
  let probability = 0,
    last = 0;
  for (let offset = 12; offset < packed.data.length; offset += 12) {
    assert.equal(packed.data[offset + 3], 4);
    probability += packed.data[offset + 2];
    assert.ok(packed.data[offset + 8] >= last);
    last = packed.data[offset + 8];
    const triangle = surface.triangles.at(-1 - packed.data[offset])!;
    assert.ok(
      surface.materials.find(
        (material) => material.uuid === triangle.materialUuid,
      )!.emissiveIntensity > 0,
    );
  }
  assert.ok(Math.abs(probability - 1) < 1e-6);
  assert.equal(last, 1);
  // Independently reconstruct probabilities from the alias table. This checks
  // every category exactly, without depending on a noisy random-frequency test.
  const reconstructed = new Float64Array(packed.emitters);
  for (let slot = 0; slot < packed.emitters; slot++) {
    const offset = 12 + slot * 12;
    const threshold = packed.data[offset + 9], alias = packed.data[offset + 10];
    assert.ok(threshold >= 0 && threshold <= 1 && Number.isInteger(alias));
    reconstructed[slot] += threshold / packed.emitters;
    reconstructed[alias] += (1 - threshold) / packed.emitters;
    const triangle = packed.data[offset];
    const lookup = packed.data.length + triangle * 12;
    assert.equal(packed.gpuData[lookup], packed.data[offset + 1]);
    assert.equal(packed.gpuData[lookup + 1], packed.data[offset + 2]);
  }
  reconstructed.forEach((probability, slot) => assert.ok(Math.abs(probability - packed.data[12 + slot * 12 + 2]) < 1e-7));
});

test("static emitting geometry is cached while opaque motion and tiny emitters preserve the PDF", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 0.000001 })));
  const surface = extractSurfaceScene(scene), cache = createEmissiveLightCache();
  const first = cache.update(surface, surface.triangles, new Float32Array());
  assert.equal(cache.update(surface, surface.triangles, new Float32Array()), first);
  assert.equal(first.emitters, 2); assert.equal(cache.inspect().hits, 1);
  const reversed = cache.update(surface, [...surface.triangles].reverse(), new Float32Array());
  assert.equal(reversed.signature, first.signature);
  assert.equal(cache.inspect().builds, 2);
  assert.equal(reversed.emitters, first.emitters);
});

test("emitter history signature ignores traversal indices but detects actual light/material/geometry changes", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial({
      emissive: 0xffffff,
      emissiveIntensity: 2,
    });
  const emitter = new THREE.Mesh(new THREE.PlaneGeometry(), material),
    opaque = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
  scene.add(emitter, opaque);
  const explicit = new Float32Array([0, 3, 0, 0, 1, 1, 1, 0, 0, 0, 0, 2]);
  const capture = () => extractSurfaceScene(scene);
  const first = capture(),
    a = appendEmissiveLights(first, first.triangles, explicit),
    b = appendEmissiveLights(first, [...first.triangles].reverse(), explicit);
  assert.notDeepEqual(a.data, b.data);
  assert.equal(a.signature, b.signature);
  opaque.position.x = 2;
  const movedOpaque = capture();
  assert.equal(
    appendEmissiveLights(movedOpaque, movedOpaque.triangles, explicit)
      .signature,
    a.signature,
  );
  const light = explicit.slice();
  light[0] = 1;
  assert.notEqual(
    appendEmissiveLights(first, first.triangles, light).signature,
    a.signature,
  );
  material.emissiveIntensity = 3;
  const brighter = capture();
  assert.notEqual(
    appendEmissiveLights(brighter, brighter.triangles, explicit).signature,
    a.signature,
  );
  material.emissiveIntensity = 2;
  emitter.position.x = 1;
  const movedEmitter = capture();
  assert.notEqual(
    appendEmissiveLights(movedEmitter, movedEmitter.triangles, explicit)
      .signature,
    a.signature,
  );
  emitter.geometry.dispose();
  material.dispose();
  opaque.geometry.dispose();
  (opaque.material as THREE.Material).dispose();
});

test("explicit-only changes reuse emitter distributions and compact PDF equals legacy lookup", () => {
  const scene = new THREE.Scene(), material = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 2 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material); scene.add(mesh);
  const surface = extractSurfaceScene(scene), cache = createEmissiveLightCache(true);
  const explicit = new Float32Array([0, 2, 0, 0, 1, 1, 1, 0, 1, 0, 0, 2]);
  const first = cache.update(surface, surface.triangles, explicit);
  const changed = explicit.slice(); changed[4] = 2;
  const next = cache.update(surface, surface.triangles, changed);
  const full = appendEmissiveLights(surface, surface.triangles, changed);
  assert.deepEqual(next.data, full.data); assert.equal(next.signature, full.signature);
  assert.equal(next.probabilities, first.probabilities);
  assert.equal(next.gpuData.length, next.data.length);
  next.probabilities.forEach((probability, i) => assert.equal(probability, full.gpuData[full.data.length + i * 12 + 1]));
  assert.equal(cache.inspect().builds, 1); assert.equal(cache.inspect().explicitUpdates, 1);
  mesh.geometry.dispose(); material.dispose();
});
