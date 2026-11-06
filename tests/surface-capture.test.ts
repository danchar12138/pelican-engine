import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
test("private capture adapts known standard NodeMaterial and captures every declared light without source mutations", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardNodeMaterial({
      color: 0x60c0a0,
      roughness: 0.3,
      metalness: 0.6,
      emissive: 0x203010,
      emissiveIntensity: 2,
    }),
    mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  scene.add(mesh);
  const point = new THREE.PointLight(0xff8040, 20, 12, 2);
  point.position.set(2, 3, 4);
  const directional = new THREE.DirectionalLight(0x80c0ff, 3);
  directional.position.set(-3, 4, 2);
  directional.target.position.set(0, 0, 0);
  scene.add(
    point,
    directional,
    directional.target,
    new THREE.AmbientLight(0x102030, 0.4),
    new THREE.HemisphereLight(0xa0c0ff, 0x202010, 0.6),
  );
  const before = {
    uuid: material.uuid,
    type: material.type,
    color: material.color.toArray(),
    roughness: material.roughness,
  };
  const capture = createSurfaceCapture();
  try {
    const a = capture.capture(scene),
      b = capture.capture(scene);
    assert.equal(a.surface.triangles.length, 12);
    assert.equal(a.surface.materials[0].uuid, material.uuid);
    assert.equal(a.surface.materials[0].emissiveIntensity, 2);
    assert.equal(a.lights.length, 48);
    assert.deepEqual(Array.from(a.lights), Array.from(b.lights));
    assert.equal(capture.inspect().adaptedMaterials, 1);
    assert.deepEqual(
      {
        uuid: material.uuid,
        type: material.type,
        color: material.color.toArray(),
        roughness: material.roughness,
      },
      before,
    );
    point.intensity = 40;
    assert.notDeepEqual(
      Array.from(a.lights),
      Array.from(capture.capture(scene).lights),
    );
    capture.clear();
    assert.equal(capture.inspect().adaptedMaterials, 0);
  } finally {
    capture.dispose();
    mesh.geometry.dispose();
    material.dispose();
  }
  assert.throws(() => capture.capture(scene), /TC_TRACE_CAPTURE_DISPOSED/);
});
test("uniform graph conversion requires explicit engine registration; unknown node overrides remain rejected", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardNodeMaterial({ color: 0x00aaff }),
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  material.colorNode = uniform(new THREE.Color(0xff0000));
  scene.add(mesh);
  const capture = createSurfaceCapture();
  try {
    assert.throws(() => capture.capture(scene), /TC_TRACE_NODE_GRAPH/);
    const registered = capture.capture(scene, new Set([material]));
    assert.deepEqual(
      registered.surface.materials[0].baseColor.slice(0, 3),
      material.color.toArray(),
    );
    material.normalNode = uniform(new THREE.Vector3(0, 0, 1));
    assert.throws(
      () => capture.capture(scene, new Set([material])),
      /TC_TRACE_NODE_GRAPH/,
    );
  } finally {
    capture.dispose();
    mesh.geometry.dispose();
    material.dispose();
  }
});
test("capture rejects unsupported lights rather than losing a light contribution", () => {
  const scene = new THREE.Scene();
  scene.add(new THREE.SpotLight());
  const capture = createSurfaceCapture();
  try {
    assert.throws(() => capture.capture(scene), /TC_TRACE_LIGHT/);
  } finally {
    capture.dispose();
  }
});
