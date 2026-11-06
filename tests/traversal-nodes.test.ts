import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import {
  packTraversalNodes,
  packTraversalData,
} from "../packages/renderer/src/traversal-nodes.ts";
import { packSurfaceGeometry } from "../packages/renderer/src/surface-gpu.ts";
test("threaded GPU nodes retain exact bounds/leaves and escape every complete subtree without a private stack", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.position.set(i % 4, Math.floor(i / 4), 0);
    scene.add(mesh);
  }
  const acceleration = createSurfaceAcceleration();
  try {
    const frame = acceleration.update(extractSurfaceScene(scene)),
      packed = packTraversalNodes(frame.nodes);
    assert.equal(packed.length, frame.nodes.length);
    let leaves = 0,
      triangles = 0;
    for (let index = 0; index < packed.length / 8; index++) {
      const offset = index * 8;
      assert.deepEqual(
        Array.from(packed.subarray(offset, offset + 3)),
        Array.from(frame.nodes.subarray(offset, offset + 3)),
      );
      assert.deepEqual(
        Array.from(packed.subarray(offset + 4, offset + 7)),
        Array.from(frame.nodes.subarray(offset + 4, offset + 7)),
      );
      if (packed[offset + 7] > 0) {
        leaves++;
        triangles += packed[offset + 7];
        assert.equal(packed[offset + 3], frame.nodes[offset + 3]);
      } else
        assert.ok(
          packed[offset + 3] > index && packed[offset + 3] <= packed.length / 8,
        );
    }
    assert.ok(leaves > 1);
    assert.equal(triangles, frame.metrics.triangles);
    assert.equal(packed[3], packed.length / 8);
    packed[0] = 99;
    assert.notEqual(frame.nodes[0], 99);
  } finally {
    acceleration.dispose();
  }
});
test("threaded node conversion rejects malformed pointers before publishing a buffer", () => {
  assert.equal(packTraversalNodes(new Float32Array()).length, 0);
  assert.throws(
    () => packTraversalNodes(new Float32Array(3)),
    /TC_TRACE_NODE_LAYOUT/,
  );
  const bad = new Float32Array([
    0, 0, 0, 0, 1, 1, 1, -1, 0, 0, 0, 0, 1, 1, 1, 1,
  ]);
  assert.throws(() => packTraversalNodes(bad), /TC_TRACE_NODE_LAYOUT/);
});

test("compact intersection geometry retains only exact positions, material and mirrored orientation", () => {
  const scene = new THREE.Scene(),
    mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshStandardMaterial(),
    );
  mesh.scale.x = -1;
  scene.add(mesh);
  const surface = extractSurfaceScene(scene),
    acceleration = createSurfaceAcceleration();
  try {
    const frame = acceleration.update(surface),
      geometry = packSurfaceGeometry(surface, frame.orderedTriangles),
      data = packTraversalData(frame.nodes, geometry);
    assert.equal(
      data.length,
      frame.nodes.length + frame.metrics.triangles * 12,
    );
    const first = data.subarray(frame.nodes.length, frame.nodes.length + 12);
    assert.deepEqual(
      Array.from(first.subarray(0, 4)),
      Array.from(geometry.subarray(0, 4)),
    );
    assert.equal(first[7], -1);
    assert.deepEqual(
      Array.from(first.subarray(8, 11)),
      Array.from(geometry.subarray(8, 11)),
    );
  } finally {
    acceleration.dispose();
  }
});
