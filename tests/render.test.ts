import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { buildBVH, extractTriangles } from "../experiments/render/geometry.ts";
import { evaluateGraph } from "../experiments/render/graph.ts";

test("BVH includes every triangle exactly once inside valid parent bounds", () => {
  const scene = new THREE.Scene();
  for (let i = 0; i < 9; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xabcdef }),
    );
    mesh.position.set(i * 2, (i % 3) * 2, -i);
    scene.add(mesh);
  }
  const source = extractTriangles(scene),
    tree = buildBVH(source);
  assert.equal(tree.triangleCount, 108);
  assert.equal(tree.triangles.length, 108 * 20);
  const offsets: number[] = [];
  const visited = new Set<number>();
  const visit = (index: number, parent?: number[]) => {
    assert.ok(!visited.has(index));
    visited.add(index);
    const node = Array.from(tree.nodes.slice(index * 8, index * 8 + 8));
    if (parent)
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(node[axis] >= parent[axis]);
        assert.ok(node[axis + 4] <= parent[axis + 4]);
      }
    if (node[7] > 0)
      for (let id = node[3]; id < node[3] + node[7]; id++) {
        offsets.push(id);
        const triangle = tree.triangles.slice(id * 20, id * 20 + 20);
        for (const start of [0, 4, 8])
          for (let axis = 0; axis < 3; axis++) {
            assert.ok(triangle[start + axis] >= node[axis] - 1e-6);
            assert.ok(triangle[start + axis] <= node[axis + 4] + 1e-6);
          }
      }
    else {
      visit(node[3], node);
      visit(-node[7], node);
    }
  };
  visit(0);
  assert.equal(visited.size, tree.nodeCount);
  assert.deepEqual(
    offsets.sort((a, b) => a - b),
    Array.from({ length: 108 }, (_, i) => i),
  );
});
function assertTriangleVertices(
  triangle: { a: number[]; b: number[]; c: number[] },
  expected: number[][],
) {
  for (const [index, actual] of [
    triangle.a,
    triangle.b,
    triangle.c,
  ].entries()) {
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(
        Math.abs(actual[axis] - expected[index][axis]) < 1e-6,
        `vertex ${index}, axis ${axis}: expected ${expected[index][axis]}, got ${actual[axis]}`,
      );
    }
  }
}

function addTransformedMesh(scene: THREE.Scene, mesh: THREE.Mesh) {
  const parent = new THREE.Group();
  parent.position.set(10, 20, 30);
  parent.rotation.z = Math.PI / 2;
  parent.scale.set(2, 3, 4);
  mesh.position.set(1, 2, 3);
  mesh.rotation.z = Math.PI / 2;
  mesh.scale.set(2, 1, 0.5);
  parent.add(mesh);
  scene.add(parent);
  // These transforms map local (x,y,z) to world (4-6x,22-2y,42+2z).
  return parent;
}

test("geometry extraction excludes hidden ancestors and restores descendants when shown", () => {
  const scene = new THREE.Scene(),
    parent = new THREE.Group(),
    nested = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial(),
  );
  scene.add(parent);
  parent.add(nested);
  nested.add(mesh);
  assert.equal(extractTriangles(scene).length, 12);
  parent.visible = false;
  assert.equal(mesh.visible, true);
  assert.equal(extractTriangles(scene).length, 0);
  parent.visible = true;
  assert.equal(extractTriangles(scene).length, 12);
  nested.visible = false;
  assert.equal(extractTriangles(scene).length, 0);
  nested.visible = true;
  mesh.visible = false;
  assert.equal(extractTriangles(scene).length, 0);
  mesh.visible = true;
  mesh.userData.noTrace = true;
  assert.equal(extractTriangles(scene).length, 0);
  assert.throws(() => buildBVH([]), /TC_RENDER_EMPTY_GEOMETRY/);
});

test("morph influence alone changes extracted vertices in parent and mesh world space", () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 1, 1], 3),
  );
  geometry.morphAttributes.position = [
    new THREE.Float32BufferAttribute([0, 0, 2, 2, 0, 0, 2, 3, 1], 3),
  ];
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const parent = addTransformedMesh(scene, mesh);
  const base = extractTriangles(scene);
  assert.equal(base.length, 1);
  assertTriangleVertices(base[0], [
    [4, 22, 42],
    [-2, 22, 42],
    [-8, 20, 44],
  ]);
  const meshWorld = mesh.matrixWorld.clone(),
    parentWorld = parent.matrixWorld.clone();
  mesh.morphTargetInfluences![0] = 0.5;
  const changed = extractTriangles(scene);
  assert.equal(changed.length, 1);
  assert.notDeepEqual(changed, base);
  assertTriangleVertices(changed[0], [
    [4, 22, 44],
    [-5, 22, 42],
    [-8, 18, 44],
  ]);
  assert.deepEqual(mesh.matrixWorld.elements, meshWorld.elements);
  assert.deepEqual(parent.matrixWorld.elements, parentWorld.elements);
  assert.deepEqual(
    Array.from(geometry.getAttribute("position").array),
    [0, 0, 0, 1, 0, 0, 2, 1, 1],
  );
  mesh.morphTargetInfluences![0] = 0;
  assert.deepEqual(extractTriangles(scene), base);
});

test("bone rotation alone changes weighted indexed vertices in parent and mesh world space", () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 1, 1], 3),
  );
  geometry.setIndex([2, 0, 1]);
  geometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0.5, 0, 0],
      4,
    ),
  );
  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshStandardMaterial(),
  );
  const root = new THREE.Bone(),
    tip = new THREE.Bone();
  tip.position.x = 1;
  root.add(tip);
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, tip]));
  const parent = addTransformedMesh(scene, mesh);
  const base = extractTriangles(scene);
  assert.equal(base.length, 1);
  assertTriangleVertices(base[0], [
    [-8, 20, 44],
    [4, 22, 42],
    [-2, 22, 42],
  ]);
  const meshWorld = mesh.matrixWorld.clone(),
    parentWorld = parent.matrixWorld.clone();
  tip.rotation.z = Math.PI / 2;
  const changed = extractTriangles(scene);
  assert.equal(changed.length, 1);
  assert.notDeepEqual(changed, base);
  // Vertex 2 blends the stationary root and rotated tip equally; the other vertices stay fixed.
  assertTriangleVertices(changed[0], [
    [-2, 20, 44],
    [4, 22, 42],
    [-2, 22, 42],
  ]);
  assert.deepEqual(mesh.matrixWorld.elements, meshWorld.elements);
  assert.deepEqual(parent.matrixWorld.elements, parentWorld.elements);
  assert.deepEqual(
    Array.from(geometry.getAttribute("position").array),
    [0, 0, 0, 1, 0, 0, 2, 1, 1],
  );
  tip.rotation.z = 0;
  assert.deepEqual(extractTriangles(scene), base);
});
test("graph CPU reference correctly composes broadcast, sine and vector multiplication", () => {
  const graph: any = {
    nodes: [
      { id: "base", op: "vec3", value: [0.1, 0.4, 0.8] },
      { id: "time", op: "time" },
      { id: "sine", op: "sin", inputs: ["time"] },
      { id: "out", op: "multiply", inputs: ["base", "sine"] },
    ],
    output: "out",
    outputType: "vec3",
  };
  const result = evaluateGraph(graph, Math.PI / 2);
  assert.deepEqual(result, [0.1, 0.4, 0.8]);
});
