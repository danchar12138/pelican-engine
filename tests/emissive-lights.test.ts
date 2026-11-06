import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { appendEmissiveLights } from "../packages/renderer/src/emissive-lights.ts";
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
