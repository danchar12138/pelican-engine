import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createManagedGeometry } from "../packages/renderer/src/managed-geometry.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import type {
  BufferGeometryInput,
  Geometry,
} from "../packages/sdk/src/index.ts";
const triangle = (): BufferGeometryInput => ({
  kind: "buffer",
  positions: [0, 0, 0, 2, 0, 0, 0, 3, 0],
  uv: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
});
const diagnostic = (code: string, field: string) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.startsWith(code + ":"), error.message);
  assert.ok(error.message.includes("shape.geometry." + field), error.message);
  assert.match(error.message, /Repair:/);
  return true;
};
test("managed buffer copies all input data, generates normals and bounds and extracts real Three triangles", () => {
  const input = triangle(),
    geometry = createManagedGeometry(input, "shape"),
    second = createManagedGeometry(input, "second");
  const capture = createSurfaceCapture(),
    material = new THREE.MeshStandardNodeMaterial(),
    scene = new THREE.Scene();
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++);
  try {
    (input.positions as number[])[3] = 99;
    (input.uv as number[])[2] = 99;
    (input.indices as number[])[1] = 2;
    assert.equal(geometry.getAttribute("position").getX(1), 2);
    assert.equal(geometry.getAttribute("uv").getX(1), 1);
    assert.equal(geometry.index!.getX(1), 1);
    assert.deepEqual(geometry.boundingBox!.min.toArray(), [0, 0, 0]);
    assert.deepEqual(geometry.boundingBox!.max.toArray(), [2, 3, 0]);
    assert.ok(
      Math.abs(geometry.boundingSphere!.radius - Math.sqrt(13) / 2) < 1e-12,
    );
    assert.deepEqual(
      Array.from(geometry.getAttribute("normal").array),
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
    );
    assert.notEqual(
      geometry.getAttribute("position").array,
      second.getAttribute("position").array,
    );
    scene.add(new THREE.Mesh(geometry, material));
    const result = capture.capture(scene);
    assert.equal(result.surface.triangles.length, 1);
    assert.equal(result.surface.triangles[0]!.vertices[1].position[0], 2);
    capture.dispose();
    assert.equal(disposed, 0); // Capture borrows mesh geometry.
    geometry.dispose();
    assert.equal(disposed, 1);
    scene.children[0]!.removeFromParent();
    scene.add(new THREE.Mesh(second, material));
    const primitive = createManagedGeometry({ kind: "plane" }, "primitive");
    try {
      assert.equal(primitive.type, "PlaneGeometry");
    } finally {
      primitive.dispose();
    }
  } finally {
    capture.dispose();
    second.dispose();
    material.dispose();
  }
});
test("nonindexed buffers, provided normals, deferred bounds and large positions remain usable", () => {
  const input = triangle();
  delete input.indices;
  input.normals = [0, 0, 2, 0, 0, 3, 0, 0, 4];
  input.computeBounds = false;
  const geometry = createManagedGeometry(input, "shape");
  try {
    assert.equal(geometry.index, null);
    assert.equal(geometry.boundingBox, null);
    assert.equal(geometry.getAttribute("normal").getZ(1), 1);
    geometry.computeBoundingBox();
    assert.deepEqual(geometry.boundingBox!.max.toArray(), [2, 3, 0]);
  } finally {
    geometry.dispose();
  }
  const large = createManagedGeometry(
    { kind: "buffer", positions: [0, 0, 0, 1e30, 0, 0, 0, 1e30, 0] },
    "shape",
  );
  try {
    assert.equal(large.getAttribute("normal").getZ(0), 1);
    assert.ok(Number.isFinite(large.boundingSphere!.radius));
  } finally {
    large.dispose();
  }
  const count = 65538,
    positions = new Array<number>(count * 3).fill(0);
  const wide = createManagedGeometry(
    { kind: "buffer", positions, indices: [0, 65536, 65537] },
    "shape",
  );
  try {
    assert.ok(wide.index!.array instanceof Uint32Array);
    assert.equal(wide.index!.getX(2), 65537);
  } finally {
    wide.dispose();
  }
});
test("runtime boundary rejects malformed attributes, nonfinite float32 values and invalid indices with repair diagnostics", () => {
  const cases: [Partial<BufferGeometryInput>, string, string][] = [
    [{ positions: [] }, "ATTRIBUTE", "positions"],
    [{ positions: new Array(1048576 * 3 + 3) }, "ATTRIBUTE", "positions"],
    [{ positions: [0, 0] }, "ATTRIBUTE", "positions"],
    [{ positions: [0, 0, 0, 1, 0, 0], uv: [0, 0, 1, 0] }, "INDEX", "indices"],
    [{ normals: [0, 0, 1] }, "ATTRIBUTE", "normals"],
    [{ uv: [0, 0] }, "ATTRIBUTE", "uv"],
    [{ normals: [0, 0, 0, 0, 0, 1, 0, 0, 1] }, "NORMAL", "normals"],
    [{ indices: [] }, "INDEX", "indices"],
    [{ indices: new Array(3145728 + 3) }, "INDEX", "indices"],
    [{ indices: [0, 1] }, "INDEX", "indices"],
    ...[-1, 3, 0.5, NaN, Infinity, 2 ** 32].map(
      (value) =>
        [{ indices: [0, 1, value] }, "INDEX", "indices"] as [
          Partial<BufferGeometryInput>,
          string,
          string,
        ],
    ),
    ...[NaN, Infinity, -Infinity, 1e40, 1e-50].map(
      (value) =>
        [
          { positions: [value, 0, 0, 2, 0, 0, 0, 3, 0] },
          "NUMBER",
          "positions",
        ] as [Partial<BufferGeometryInput>, string, string],
    ),
    [
      { computeBounds: 1 } as unknown as Partial<BufferGeometryInput>,
      "BOUNDS",
      "computeBounds",
    ],
  ];
  for (const [patch, code, field] of cases)
    assert.throws(
      () => createManagedGeometry({ ...triangle(), ...patch }, "shape"),
      diagnostic("TC_GEOMETRY_" + code, field),
    );
  const nonindexed = {
    ...triangle(),
    positions: [0, 0, 0, 1, 0, 0],
    uv: [0, 0, 1, 0],
    indices: undefined,
  };
  assert.throws(
    () => createManagedGeometry(nonindexed, "shape"),
    diagnostic("TC_GEOMETRY_INDEX", "positions"),
  );
  assert.throws(
    () =>
      createManagedGeometry({ ...triangle(), mystery: 1 } as Geometry, "shape"),
    diagnostic("TC_GEOMETRY_FIELD", "mystery"),
  );
});
