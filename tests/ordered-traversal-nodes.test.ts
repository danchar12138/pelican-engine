import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  packOrderedTraversalData,
  packParentLinkedTraversalData,
} from "../packages/renderer/src/ordered-traversal-nodes.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { packSurfaceGeometry } from "../packages/renderer/src/surface-gpu.ts";
import {
  packTraversalData,
  packTraversalNodes,
} from "../packages/renderer/src/traversal-nodes.ts";

function bytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function fixture() {
  const nodes = new Float32Array([
    -0, 0, 0, 1, 1, 1, 1, -4, 0, 0, 0, 2, 1, 1, 1, -3, 0, 0, 0, 0, 1, 1, 1, 1,
    0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 5, 1, 1, 1, -6, 0, 0, 0, 2, 1, 1, 1, 1, 0,
    0, 0, 3, 1, 1, 1, 1,
  ]);
  const geometry = Float32Array.from(
    { length: 4 * 72 },
    (_, index) => ((index % 37) - 18) / 8,
  );
  return { nodes, geometry };
}

function verifyPacking(nodes: Float32Array, geometry: Float32Array) {
  const beforeNodes = nodes.slice(),
    beforeGeometry = geometry.slice(),
    packed = packOrderedTraversalData(nodes, geometry),
    count = nodes.length / 8,
    threaded = packTraversalNodes(nodes),
    legacy = packTraversalData(nodes, geometry),
    parents = new Uint32Array(count).fill(count),
    ends = new Uint32Array(count),
    visited = new Set<number>();
  const parentLinked = packParentLinkedTraversalData(nodes, geometry);
  assert.equal(parentLinked.length, packed.length);
  assert.deepEqual(
    bytes(parentLinked.subarray(0, legacy.length)),
    bytes(legacy),
  );
  for (let index = 0; index < count; index++) {
    assert.deepEqual(
      bytes(
        parentLinked.subarray(
          legacy.length + index * 4,
          legacy.length + index * 4 + 4,
        ),
      ),
      bytes(packed.subarray(index * 12 + 8, index * 12 + 12)),
    );
  }
  const stack = count ? [{ index: 0, parent: count, exit: false }] : [];
  while (stack.length) {
    const { index, parent, exit } = stack.pop()!;
    const source = index * 8;
    if (exit) {
      ends[index] = ends[-nodes[source + 7]];
      continue;
    }
    assert.ok(!visited.has(index));
    visited.add(index);
    parents[index] = parent;
    if (nodes[source + 7] > 0) ends[index] = index + 1;
    else
      stack.push(
        { index, parent, exit: true },
        { index: -nodes[source + 7], parent: index, exit: false },
        { index: nodes[source + 3], parent: index, exit: false },
      );
  }
  assert.equal(visited.size, count);
  assert.equal(packed.length, count * 12 + (geometry.length / 72) * 12);
  assert.notEqual(packed.buffer, nodes.buffer);
  assert.notEqual(packed.buffer, geometry.buffer);
  for (let index = 0; index < count; index++) {
    const source = index * 8,
      target = index * 12,
      leaf = nodes[source + 7] > 0;
    assert.deepEqual(
      bytes(packed.subarray(target, target + 8)),
      bytes(nodes.subarray(source, source + 8)),
    );
    assert.deepEqual(Array.from(packed.subarray(target + 8, target + 12)), [
      parents[index],
      leaf ? count : nodes[source + 3],
      leaf ? count : -nodes[source + 7],
      ends[index],
    ]);
    assert.equal(packed[target + 11], leaf ? index + 1 : threaded[source + 3]);
  }
  assert.deepEqual(
    bytes(packed.subarray(count * 12)),
    bytes(legacy.subarray(nodes.length)),
  );
  assert.deepEqual(bytes(nodes), bytes(beforeNodes));
  assert.deepEqual(bytes(geometry), bytes(beforeGeometry));
  return packed;
}

function realScene() {
  const scene = new THREE.Scene(),
    geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshStandardMaterial(),
    meshes: THREE.Mesh[] = [];
  for (let index = 0; index < 12; index++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((index % 4) * 3, Math.floor(index / 4) * 2, index % 3);
    meshes.push(mesh);
    scene.add(mesh);
  }
  return { scene, meshes, geometry, material };
}

test("ordered packing returns an independent empty buffer", () => {
  const nodes = new Float32Array(),
    geometry = new Float32Array(),
    packed = packOrderedTraversalData(nodes, geometry);
  assert.equal(packed.length, 0);
  assert.notEqual(packed.buffer, nodes.buffer);
  assert.notEqual(packed.buffer, geometry.buffer);
});

test("ordered links preserve a real Three SAH tree and its compact payload", () => {
  const source = realScene(),
    acceleration = createSurfaceAcceleration();
  try {
    const surface = extractSurfaceScene(source.scene),
      frame = acceleration.update(surface),
      geometry = packSurfaceGeometry(surface, frame.orderedTriangles);
    assert.ok(frame.metrics.nodes > 3);
    const packed = verifyPacking(frame.nodes, geometry);
    assert.equal(packed[8], frame.metrics.nodes);
    assert.equal(packed[11], frame.metrics.nodes);
    assert.equal(
      packed[(frame.metrics.nodes - 1) * 12 + 11],
      frame.metrics.nodes,
    );
    assert.equal(frame.nodes[3], 1);
    assert.equal(
      packed[3],
      1,
      "must preserve the CPU pointer, not the root escape",
    );
  } finally {
    acceleration.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

test("mirrored compact geometry is byte-identical to the existing payload", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material),
    acceleration = createSurfaceAcceleration();
  mesh.scale.set(-2, 3, 1);
  mesh.position.set(0.25, -0.5, 2);
  scene.add(mesh);
  try {
    const surface = extractSurfaceScene(scene),
      frame = acceleration.update(surface),
      geometry = packSurfaceGeometry(surface, frame.orderedTriangles),
      packed = verifyPacking(frame.nodes, geometry),
      prefix = frame.metrics.nodes * 12;
    for (let index = 0; index < frame.metrics.triangles; index++) {
      const offset = prefix + index * 12,
        source = index * 72;
      assert.deepEqual(Array.from(packed.subarray(offset, offset + 12)), [
        ...geometry.subarray(source, source + 4),
        ...geometry.subarray(source + 4, source + 7),
        -1,
        ...geometry.subarray(source + 8, source + 11),
        0,
      ]);
      assert.equal(geometry[source + 63], -1);
    }
  } finally {
    acceleration.dispose();
    mesh.geometry.dispose();
    material.dispose();
  }
});

test("single-leaf sentinels, fractional bounds and detached copies retain exact bits", () => {
  const nodes = new Float32Array([-0, -0.25, 0, 0, 0.5, 1.25, 2, 1]),
    geometry = new Float32Array(72),
    packed = verifyPacking(nodes, geometry),
    saved = packed.slice(),
    another = packOrderedTraversalData(nodes, geometry);
  assert.deepEqual(Array.from(packed.subarray(8, 12)), [1, 1, 1, 1]);
  assert.ok(Object.is(packed[0], -0));
  nodes[0] = -100;
  geometry[0] = 200;
  assert.deepEqual(bytes(packed), bytes(saved));
  packed[0] = -300;
  packed[12] = 400;
  assert.equal(nodes[0], -100);
  assert.equal(geometry[0], 200);
  assert.deepEqual(bytes(another), bytes(saved));
});

test("refits refresh bounds, rebuilds refresh links, and empty transitions retain snapshots", () => {
  const source = realScene(),
    acceleration = createSurfaceAcceleration();
  const capture = () => {
    const surface = extractSurfaceScene(source.scene),
      frame = acceleration.update(surface),
      packed = verifyPacking(
        frame.nodes,
        packSurfaceGeometry(surface, frame.orderedTriangles),
      );
    return { frame, packed };
  };
  const links = (packed: Float32Array, count: number) =>
    Array.from({ length: count }, (_, index) =>
      Array.from(packed.subarray(index * 12 + 8, index * 12 + 12)),
    );
  try {
    const first = capture(),
      original = first.packed.slice();
    assert.equal(first.frame.changes.kind, "rebuild");
    source.meshes[0].position.set(-100, -50, 20);
    const refitted = capture();
    assert.equal(refitted.frame.changes.kind, "refit");
    assert.notDeepEqual(refitted.frame.nodes, first.frame.nodes);
    assert.ok(refitted.packed[0] < first.packed[0]);
    assert.deepEqual(
      links(refitted.packed, refitted.frame.metrics.nodes),
      links(first.packed, first.frame.metrics.nodes),
    );
    const refitSnapshot = refitted.packed.slice();
    for (const mesh of source.meshes.slice(1)) source.scene.remove(mesh);
    const rebuilt = capture();
    assert.equal(rebuilt.frame.changes.kind, "rebuild");
    assert.ok(rebuilt.frame.metrics.nodes < first.frame.metrics.nodes);
    assert.equal(rebuilt.packed[8], rebuilt.frame.metrics.nodes);
    const rebuildSnapshot = rebuilt.packed.slice();
    source.scene.clear();
    const empty = capture();
    assert.equal(empty.frame.changes.kind, "rebuild");
    assert.equal(empty.packed.length, 0);
    source.scene.add(source.meshes[0]);
    const restored = capture();
    assert.equal(restored.frame.changes.kind, "rebuild");
    assert.deepEqual(restored.packed, rebuilt.packed);
    assert.deepEqual(bytes(first.packed), bytes(original));
    assert.deepEqual(bytes(refitted.packed), bytes(refitSnapshot));
    assert.deepEqual(bytes(rebuilt.packed), bytes(rebuildSnapshot));
  } finally {
    acceleration.dispose();
    source.geometry.dispose();
    source.material.dispose();
  }
});

test("rejects incomplete layouts and incompatible empty inputs", () => {
  assert.throws(
    () => packOrderedTraversalData(new Float32Array(7), new Float32Array()),
    /TC_TRACE_NODE_LAYOUT/,
  );
  assert.throws(
    () => packOrderedTraversalData(new Float32Array(), new Float32Array(71)),
    /TC_TRACE_TRIANGLE_LAYOUT/,
  );
  assert.throws(
    () => packOrderedTraversalData(new Float32Array(), new Float32Array(72)),
    /TC_TRACE_NODE_LAYOUT/,
  );
  assert.throws(
    () => packOrderedTraversalData(fixture().nodes, new Float32Array()),
    /TC_TRACE_NODE_LAYOUT/,
  );
});

test("rejects non-finite/inverted bounds and non-integer or inexact pointers/counts", () => {
  const mutations: [number, number][] = [
    [0, NaN],
    [1, Infinity],
    [2, -Infinity],
    [4, NaN],
    [5, Infinity],
    [6, -Infinity],
    [0, 2],
    [5, -1],
    [3, NaN],
    [3, Infinity],
    [3, -1],
    [3, 1.5],
    [3, 2 ** 24 + 2],
    [7, NaN],
    [7, -Infinity],
    [7, -4.5],
    [7, -(2 ** 24 + 2)],
    [2 * 8 + 3, -1],
    [2 * 8 + 3, 0.5],
    [2 * 8 + 3, 2 ** 24 + 2],
    [2 * 8 + 7, 0.5],
    [2 * 8 + 7, Infinity],
    [2 * 8 + 7, 2 ** 24 + 2],
  ];
  for (const [offset, value] of mutations) {
    const { nodes, geometry } = fixture();
    nodes[offset] = value;
    const before = nodes.slice();
    assert.throws(
      () => packOrderedTraversalData(nodes, geometry),
      /TC_TRACE_NODE_LAYOUT/,
      "offset " + offset + ": " + value,
    );
    assert.deepEqual(bytes(nodes), bytes(before));
  }
});

test("rejects leaf ranges beyond triangle count, including exact-boundary overflow", () => {
  for (const [start, count] of [
    [4, 1],
    [3, 2],
    [0, 5],
    [2 ** 24, 1],
  ]) {
    const { nodes, geometry } = fixture();
    nodes[2 * 8 + 3] = start;
    nodes[2 * 8 + 7] = count;
    assert.throws(
      () => packOrderedTraversalData(nodes, geometry),
      /TC_TRACE_NODE_LAYOUT/,
    );
  }
  const { nodes, geometry } = fixture();
  nodes[2 * 8 + 3] = 3;
  verifyPacking(nodes, geometry);
});

test("existing validation rejects cycles, shared children, unreachable nodes and non-preorder trees", () => {
  const mutations: [number, number][] = [
    [3, 0], // Root self-cycle.
    [7, -1], // Shared child.
    [7, -7], // Child outside the array.
    [3, 2], // Left child is not next in preorder.
    [7, -3], // Right child overlaps the left subtree.
    [7, -5], // Right child skips a node.
    [8 + 7, -1], // Nested self-cycle.
    [8 + 7, 0], // Cycle to root through a zero right pointer.
    [4 * 8 + 7, -2], // Right subtree cycles back to an earlier leaf.
    [2 * 8 + 7, 0], // Zero leaf count becomes a malformed internal node.
  ];
  for (const [offset, value] of mutations) {
    const { nodes, geometry } = fixture();
    nodes[offset] = value;
    assert.throws(
      () => packOrderedTraversalData(nodes, geometry),
      /TC_TRACE_NODE_LAYOUT/,
    );
  }
  const { nodes, geometry } = fixture(),
    unreachable = new Float32Array(nodes.length + 8);
  unreachable.set(nodes);
  unreachable.set(nodes.subarray(2 * 8, 3 * 8), nodes.length);
  assert.throws(
    () => packOrderedTraversalData(unreachable, geometry),
    /TC_TRACE_NODE_LAYOUT/,
  );
});

test("valid 256-level synthetic preorder tree adds no 64-level limit", () => {
  const depth = 256,
    count = depth * 2 + 1,
    nodes = new Float32Array(count * 8),
    geometry = new Float32Array((depth + 1) * 72);
  for (let index = 0; index < count; index++) {
    const internal = index < depth;
    nodes.set(
      [
        0,
        0,
        0,
        internal ? index + 1 : index - depth,
        1,
        1,
        1,
        internal ? -(count - index - 1) : 1,
      ],
      index * 8,
    );
  }
  const packed = verifyPacking(nodes, geometry);
  for (let index = 0; index < depth; index++) {
    assert.equal(packed[index * 12 + 8], index ? index - 1 : count);
    assert.equal(packed[index * 12 + 11], count - index);
  }
  let index = depth,
    levels = 0;
  while (index !== count) {
    levels++;
    index = packed[index * 12 + 8];
  }
  assert.equal(levels, depth + 1);
  assert.ok(levels > 64);
});
