import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import {
  extractSurfaceScene,
  sampleSurfaceMaterial,
} from "../packages/renderer/src/surface.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
  SURFACE_MATERIAL_FLOATS,
} from "../packages/renderer/src/surface-gpu.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
test("physical boundary snapshot retains transmission, IOR and linear volume attenuation without pretending alpha is refraction", () => {
  const material = new THREE.MeshPhysicalMaterial({
      transmission: 0.8,
      ior: 1.45,
      roughness: 0.1,
      metalness: 0,
      attenuationColor: 0x80c0ff,
      attenuationDistance: 2,
    }),
    scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  const surface = extractSurfaceScene(scene),
    snapshot = surface.materials[0];
  assert.equal(snapshot.transmission, 0.8);
  assert.equal(snapshot.ior, 1.45);
  assert.deepEqual(
    snapshot.attenuationColor,
    material.attenuationColor.toArray(),
  );
  assert.equal(snapshot.attenuationDistance, 2);
  assert.equal(snapshot.alphaMode, "opaque");
  const resources = packSurfaceResources(surface);
  assert.equal(resources.materials.length, SURFACE_MATERIAL_FLOATS);
  assert.ok(Math.abs(resources.materials[24] - 0.8) < 1e-6);
  assert.ok(Math.abs(resources.materials[25] - 1.45) < 1e-6);
  assert.equal(resources.materials[26], 2);
  assert.equal(resources.materials[30], 1);
  const a = sampleSurfaceMaterial(surface, 0, [0.2, 0.3, 0.5], {
      frontFacing: true,
    }),
    b = sampleSurfaceMaterial(surface, 0, [0.2, 0.3, 0.5], {
      frontFacing: false,
    });
  assert.equal(b.discarded, false);
  for (let axis = 0; axis < 3; axis++)
    assert.ok(Math.abs(a.normal[axis] + b.normal[axis]) < 1e-12);
});
test("known PhysicalNodeMaterial is privately adapted while unrelated extension maps remain explicit errors", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshPhysicalNodeMaterial({
      transmission: 1,
      ior: 1.5,
      metalness: 0,
      roughness: 0.05,
    });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material));
  const capture = createSurfaceCapture();
  try {
    const result = capture.capture(scene);
    assert.equal(result.surface.materials[0].kind, "physical");
    assert.equal(result.surface.materials[0].transmission, 1);
    assert.equal(material.type, "MeshPhysicalNodeMaterial");
    material.clearcoat = 0.2;
    assert.throws(
      () => capture.capture(scene),
      /SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED/,
    );
  } finally {
    capture.dispose();
  }
});
test("invalid or metallic dielectric parameters never silently enter a packed physical volume", () => {
  for (const patch of [
    { transmission: NaN },
    { transmission: 1, ior: 0 },
    { transmission: 1, metalness: 1 },
    { transmission: 1, attenuationDistance: -1 },
  ]) {
    const scene = new THREE.Scene(),
      material = new THREE.MeshPhysicalMaterial({ metalness: 0, ...patch });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    assert.throws(
      () => extractSurfaceScene(scene),
      /SURFACE_PHYSICAL_VALUE_INVALID/,
    );
  }
});
