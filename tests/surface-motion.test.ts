import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import {
  extractSurfaceScene,
  type SurfaceScene,
  type SurfaceTriangle,
} from "../packages/renderer/src/surface.ts";
import { packPreviousSurfacePositions } from "../packages/renderer/src/surface-motion.ts";

// The same non-overlapping triangle and single-bone fixtures as surface/cache tests.
function geometry(triangles = 2) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, (_, i) => [
        i * 2,
        0,
        0,
        i * 2 + 1,
        0,
        0,
        i * 2,
        1,
        0,
      ]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, () => [
        0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, () => [0, 0, 1, 0, 0, 1]).flat(),
      2,
    ),
  );
  g.setIndex(Array.from({ length: triangles * 3 }, (_, i) => i));
  g.addGroup(0, triangles * 3, 0);
  return g;
}
function setup(g = geometry()) {
  const scene = new THREE.Scene(),
    parent = new THREE.Group();
  const mesh = new THREE.Mesh<
    THREE.BufferGeometry,
    THREE.Material | THREE.Material[]
  >(g, [new THREE.MeshStandardMaterial()]);
  scene.add(parent);
  parent.add(mesh);
  return { scene, parent, mesh, g, capture: () => extractSurfaceScene(scene) };
}
function sceneOf(
  base: SurfaceScene,
  triangles: readonly SurfaceTriangle[],
): SurfaceScene {
  return { ...base, triangles };
}
function altered(
  t: SurfaceTriangle,
  patch: Record<string, unknown>,
): SurfaceTriangle {
  return { ...t, ...patch } as SurfaceTriangle;
}
function packed(t: SurfaceTriangle): Float32Array {
  return new Float32Array(
    t.vertices.flatMap((v, j) => [...v.position, j === 0 ? 1 : 0]),
  );
}
function expectCode(action: () => unknown, code: string, location?: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      error.message.startsWith("TC_SURFACE_MOTION_" + code + ":"),
      error.message,
    );
    if (location) assert.ok(error.message.includes(location), error.message);
    return true;
  });
}
const base = setup().capture();

test("ungrouped single-material extraction retains its valid groupIndex -1 motion identity", () => {
  const g = geometry();
  g.clearGroups();
  const material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.Mesh(g, material),
    scene = new THREE.Scene();
  scene.add(mesh);
  try {
    const previous = extractSurfaceScene(scene);
    assert.ok(
      previous.triangles.every((triangle) => triangle.groupIndex === -1),
    );
    mesh.position.set(2, 3, 4);
    const current = extractSurfaceScene(scene),
      result = packPreviousSurfacePositions(
        previous,
        current,
        [...current.triangles].reverse(),
      );
    assert.equal(result.matched, 2);
    assert.equal(result.missing, 0);
    assert.deepEqual(result.data.slice(0, 12), packed(previous.triangles[1]));
  } finally {
    g.dispose();
    material.dispose();
  }
});

test("real Three parent/object transforms pack previous world positions in 12-float records", () => {
  const s = setup();
  s.parent.position.set(4, -2, 7);
  s.parent.rotation.set(0.2, 0.4, -0.3);
  s.mesh.scale.set(2, 3, 0.5);
  s.mesh.position.set(1, 2, 3);
  s.scene.updateMatrixWorld(true);
  const oracle = Array.from({ length: 6 }, (_, i) =>
    s.mesh
      .getVertexPosition(i, new THREE.Vector3())
      .applyMatrix4(s.mesh.matrixWorld)
      .toArray(),
  );
  const previous = s.capture();
  s.parent.position.x += 5;
  s.mesh.rotation.y = 0.6;
  const current = s.capture();
  const result = packPreviousSurfacePositions(previous, current);
  assert.ok(result.data instanceof Float32Array);
  assert.equal(result.data.length, 24);
  assert.equal(result.matched, 2);
  assert.equal(result.missing, 0);
  for (let i = 0; i < 2; i++) {
    const expected = new Float32Array(
      oracle.slice(i * 3, i * 3 + 3).flatMap((p, j) => [...p, j === 0 ? 1 : 0]),
    );
    assert.deepEqual(result.data.slice(i * 12, i * 12 + 12), expected);
    assert.notDeepEqual(packed(current.triangles[i]), expected);
  }
});

test("mirrored instanced transforms match per-instance identity through reorder and count changes", () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.InstancedMesh(
    geometry(1),
    [new THREE.MeshStandardMaterial()],
    3,
  );
  mesh.count = 2;
  mesh.scale.set(-2, 3, 1);
  mesh.position.set(1, 2, 3);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(2, 0, 0));
  mesh.setMatrixAt(
    1,
    new THREE.Matrix4().makeScale(-1, 1, 1).setPosition(7, 0, 1),
  );
  scene.add(mesh);
  const previous = extractSurfaceScene(scene);
  assert.deepEqual(
    previous.triangles.map((t) => t.instanceId),
    [0, 1],
  );
  assert.deepEqual(
    previous.triangles[1].vertices.map((v) => [...v.position]),
    [
      [-13, 2, 4],
      [-11, 2, 4],
      [-13, 5, 4],
    ],
  );
  mesh.scale.x = 2;
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-5, 1, 2));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(12, 3, 4));
  const current = extractSurfaceScene(scene);
  const result = packPreviousSurfacePositions(
    previous,
    current,
    [...current.triangles].reverse(),
  );
  assert.equal(result.matched, 2);
  assert.deepEqual(result.data.slice(0, 12), packed(previous.triangles[1]));
  assert.deepEqual(result.data.slice(12), packed(previous.triangles[0]));
  mesh.count = 3;
  const added = extractSurfaceScene(scene);
  const addition = packPreviousSurfacePositions(current, added);
  assert.equal(addition.matched, 2);
  assert.equal(addition.missing, 1);
  assert.deepEqual(addition.data.slice(24), new Float32Array(12));
  mesh.count = 1;
  const removed = packPreviousSurfacePositions(
    added,
    extractSurfaceScene(scene),
  );
  assert.equal(removed.matched, 1);
  assert.equal(removed.missing, 0);
  assert.equal(removed.data.length, 12);
});

test("position refit retains history; topology add/remove and index changes are per-triangle", () => {
  const s = setup(geometry(3));
  s.g.setDrawRange(0, 6);
  const first = s.capture(),
    acceleration = createSurfaceAcceleration();
  acceleration.update(first);
  s.g.getAttribute("position").setZ(0, 2);
  s.g.getAttribute("position").needsUpdate = true;
  const refit = s.capture();
  assert.equal(acceleration.update(refit).changes.kind, "refit");
  assert.equal(packPreviousSurfacePositions(first, refit).matched, 2);
  assert.deepEqual(
    packPreviousSurfacePositions(first, refit).data.slice(0, 12),
    packed(first.triangles[0]),
  );
  s.g.setDrawRange(0, 9);
  const added = s.capture();
  assert.equal(acceleration.update(added).changes.kind, "rebuild");
  const addition = packPreviousSurfacePositions(refit, added);
  assert.equal(addition.matched, 2);
  assert.equal(addition.missing, 1);
  assert.deepEqual(addition.data.slice(24), new Float32Array(12));
  s.g.setDrawRange(3, 6);
  const removed = s.capture(),
    removal = packPreviousSurfacePositions(added, removed);
  assert.equal(removal.matched, 2);
  assert.equal(removal.missing, 0);
  assert.deepEqual(removal.data.slice(0, 12), packed(added.triangles[1]));
  s.g.setIndex([0, 1, 2, 3, 5, 4, 6, 7, 8]);
  const reindexed = packPreviousSurfacePositions(removed, s.capture());
  assert.equal(reindexed.matched, 1);
  assert.equal(reindexed.missing, 1);
  assert.deepEqual(reindexed.data.slice(0, 12), new Float32Array(12));
  acceleration.dispose();
});

test("replacement geometry or objects do not reuse old positions", () => {
  const s = setup(),
    previous = s.capture();
  s.mesh.geometry = s.g.clone();
  assert.equal(packPreviousSurfacePositions(previous, s.capture()).matched, 0);
  s.mesh.geometry = s.g;
  s.parent.remove(s.mesh);
  s.parent.add(s.mesh.clone());
  const result = packPreviousSurfacePositions(previous, s.capture());
  assert.equal(result.missing, 2);
  assert.deepEqual(result.data, new Float32Array(24));
});

test("current/leaf reorders and material UUID/index/normal changes preserve geometry continuity only", () => {
  const s = setup();
  s.mesh.material = [
    new THREE.MeshStandardMaterial(),
    new THREE.MeshStandardMaterial(),
  ];
  s.g.clearGroups();
  s.g.addGroup(0, 3, 0);
  s.g.addGroup(3, 3, 1);
  const previous = s.capture();
  s.mesh.material = [
    new THREE.MeshStandardMaterial({ color: 0xff0000 }),
    new THREE.MeshStandardMaterial({ roughness: 0.1 }),
  ];
  s.g.groups[0].materialIndex = 1;
  s.g.groups[1].materialIndex = 0;
  s.g.getAttribute("normal").setXYZ(0, 0, 1, 0);
  s.g.getAttribute("normal").needsUpdate = true;
  const current = sceneOf(s.capture(), [...s.capture().triangles].reverse());
  const acceleration = createSurfaceAcceleration();
  const ordered = acceleration.update(current).orderedTriangles;
  const result = packPreviousSurfacePositions(
    previous,
    current,
    ordered.map((t) => ({ ...t })),
  );
  assert.equal(result.matched, 2);
  assert.equal(result.missing, 0);
  ordered.forEach((t, i) => {
    const old = previous.triangles.find(
      (p) => p.elementOffset === t.elementOffset,
    )!;
    assert.notEqual(t.materialUuid, old.materialUuid);
    assert.deepEqual(result.data.slice(i * 12, i * 12 + 12), packed(old));
  });
  acceleration.dispose();
});

test("skin plus morph animation retains extracted old deformed world positions", () => {
  const scene = new THREE.Scene(),
    g = geometry(1);
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  ];
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(Array(12).fill(0), 4),
  );
  g.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const mesh = new THREE.SkinnedMesh(g, [new THREE.MeshStandardMaterial()]),
    bone = new THREE.Bone();
  mesh.add(bone);
  scene.add(mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.position.set(2, 3, 4);
  bone.position.y = 2;
  bone.rotation.x = 0.3;
  mesh.morphTargetInfluences![0] = 0.4;
  scene.updateMatrixWorld(true);
  const expected = new Float32Array(
    [0, 1, 2].flatMap((i) => [
      ...mesh
        .getVertexPosition(i, new THREE.Vector3())
        .applyMatrix4(mesh.matrixWorld)
        .toArray(),
      i === 0 ? 1 : 0,
    ]),
  );
  const previous = extractSurfaceScene(scene);
  bone.position.y = 5;
  bone.rotation.x = 0.9;
  mesh.morphTargetInfluences![0] = 0.8;
  const current = extractSurfaceScene(scene),
    result = packPreviousSurfacePositions(previous, current);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.data, expected);
  assert.notDeepEqual(result.data, packed(current.triangles[0]));
});

test("each exact acceleration identity component matters, with no delimiter collisions", () => {
  for (const field of [
    "objectUuid",
    "geometryUuid",
    "instanceId",
    "groupIndex",
    "elementOffset",
    "vertexIndices",
  ] as const) {
    const t = base.triangles[0];
    const value =
      field === "vertexIndices"
        ? [2, 1, 0]
        : typeof t[field] === "string"
          ? "changed"
          : 99;
    const result = packPreviousSurfacePositions(
      base,
      sceneOf(base, [altered(t, { [field]: value }), base.triangles[1]]),
    );
    assert.equal(result.matched, 1, field);
    assert.equal(result.missing, 1, field);
    assert.deepEqual(result.data.slice(0, 12), new Float32Array(12), field);
  }
  const t = base.triangles[0];
  const previous = sceneOf(base, [
    altered(t, { objectUuid: 'a","b', geometryUuid: "c" }),
  ]);
  const current = sceneOf(base, [
    altered(t, { objectUuid: "a", geometryUuid: 'b","c' }),
  ]);
  assert.equal(packPreviousSurfacePositions(previous, current).matched, 0);
});

test("absent/empty history never substitutes current positions, and empty current stays empty", () => {
  for (const previous of [undefined, sceneOf(base, [])]) {
    const result = packPreviousSurfacePositions(previous, base);
    assert.equal(result.matched, 0);
    assert.equal(result.missing, 2);
    assert.deepEqual(result.data, new Float32Array(24));
  }
  const result = packPreviousSurfacePositions(base, sceneOf(base, []));
  assert.deepEqual(result, {
    data: new Float32Array(),
    matched: 0,
    missing: 0,
  });
});

test("fresh detached buffers, no input freezing/mutation, and no stale retained cache", () => {
  const previous = structuredClone(base),
    current = structuredClone(base);
  const ordered = [...current.triangles].reverse(),
    before = structuredClone({ previous, current, ordered });
  const first = packPreviousSurfacePositions(previous, current, ordered);
  const second = packPreviousSurfacePositions(previous, current, ordered);
  assert.notEqual(first, second);
  assert.notEqual(first.data, second.data);
  assert.notEqual(first.data.buffer, second.data.buffer);
  assert.deepEqual({ previous, current, ordered }, before);
  function unfrozen(value: unknown) {
    if (value && typeof value === "object") {
      assert.equal(Object.isFrozen(value), false);
      Object.values(value).forEach(unfrozen);
    }
  }
  unfrozen({ previous, current, ordered });
  const saved = first.data.slice();
  (previous.triangles[1].vertices[0].position as unknown as number[])[0] = 123;
  (current.triangles[0].vertices[0].position as unknown as number[])[0] = 456;
  ordered.reverse();
  assert.deepEqual(first.data, saved);
  second.data.fill(-99);
  assert.deepEqual(first.data, saved);
  const third = packPreviousSurfacePositions(previous, current, ordered);
  assert.equal(third.data[12], 123);
  assert.notEqual(third.data[0], 456);
  for (const snapshot of [base, sceneOf(base, [])]) {
    const a = packPreviousSurfacePositions(undefined, snapshot),
      b = packPreviousSurfacePositions(undefined, snapshot);
    assert.notEqual(a.data.buffer, b.data.buffer);
  }
});

test("versions and scene array shapes fail with stable diagnostics, including null current defaults", () => {
  for (const value of [
    null,
    {},
    { ...base, version: 2 },
    { ...base, version: "1" },
    ...["triangles", "materials", "textures", "diagnostics"].map((field) => ({
      ...base,
      [field]: null,
    })),
  ]) {
    const invalid = value as unknown as SurfaceScene;
    expectCode(
      () => packPreviousSurfacePositions(undefined, invalid),
      "INVALID_SNAPSHOT",
      "current",
    );
    expectCode(
      () => packPreviousSurfacePositions(invalid, base),
      "INVALID_SNAPSHOT",
      "previous",
    );
  }
  expectCode(
    () =>
      packPreviousSurfacePositions(
        undefined,
        undefined as unknown as SurfaceScene,
      ),
    "INVALID_SNAPSHOT",
    "current",
  );
});

test("duplicate identities in either scene are rejected even without history or surviving triangles", () => {
  const t = base.triangles[0];
  const duplicate = sceneOf(base, [
    t,
    { ...t, materialUuid: "another-material" },
  ]);
  expectCode(
    () => packPreviousSurfacePositions(undefined, duplicate),
    "DUPLICATE_IDENTITY",
    "current.triangles[1]",
  );
  expectCode(
    () => packPreviousSurfacePositions(duplicate, sceneOf(base, [])),
    "DUPLICATE_IDENTITY",
    "previous.triangles[1]",
  );
});

test("malformed identities, empty UUIDs, negative/unsafe indices and sparse triangle arrays fail", () => {
  const patches: Record<string, unknown>[] = [
    { objectUuid: "" },
    { geometryUuid: "" },
    { objectUuid: null },
    { geometryUuid: 5 },
    ...["instanceId", "groupIndex", "elementOffset"].flatMap((field) =>
      [
        field === "groupIndex" ? -2 : -1,
        NaN,
        Infinity,
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        "0",
        undefined,
      ].map((v) => ({ [field]: v })),
    ),
    ...[
      null,
      [0, 1],
      [0, 1, 2, 3],
      [0, -1, 2],
      [0, 0.5, 2],
      [0, NaN, 2],
      Array(3),
    ].map((vertexIndices) => ({ vertexIndices })),
  ];
  for (const patch of patches) {
    const invalid = sceneOf(base, [altered(base.triangles[0], patch)]);
    expectCode(
      () => packPreviousSurfacePositions(undefined, invalid),
      "INVALID_IDENTITY",
      "current.triangles[0]",
    );
    expectCode(
      () => packPreviousSurfacePositions(invalid, base),
      "INVALID_IDENTITY",
      "previous.triangles[0]",
    );
  }
  for (const triangles of [
    [null],
    Array(2),
  ] as unknown as SurfaceTriangle[][]) {
    const invalid = sceneOf(base, triangles);
    expectCode(
      () => packPreviousSurfacePositions(undefined, invalid),
      "INVALID_IDENTITY",
    );
    expectCode(
      () => packPreviousSurfacePositions(invalid, base),
      "INVALID_IDENTITY",
    );
  }
});

test("ordered must be a complete identity permutation: no unknown, duplicate, omitted or sparse entries", () => {
  const [a, b] = base.triangles;
  const unknown = { ...b, geometryUuid: "unknown" };
  for (const ordered of [
    [],
    [a],
    [a, b, a],
    [a, a],
    [a, unknown],
    Array(2),
    [a, null],
    null,
    {},
  ]) {
    for (const previous of [undefined, base]) {
      expectCode(
        () =>
          packPreviousSurfacePositions(
            previous,
            base,
            ordered as readonly SurfaceTriangle[],
          ),
        Array.isArray(ordered) &&
          ordered.length === 2 &&
          (ordered[1] === null || !(0 in ordered))
          ? "INVALID_IDENTITY"
          : "INVALID_ORDER",
      );
    }
  }
});

test("previous positions must have three dense finite Float32-bounded coordinates, even if removed", () => {
  const t = base.triangles[0];
  const badPositions = [
    null,
    [],
    [1, 2],
    [1, 2, 3, 4],
    Array(3),
    [0, , 1],
    ...[
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_VALUE,
      -(2 ** 128),
      2 ** 128,
      "1",
      undefined,
    ].map((x) => [0, x, 1]),
  ];
  for (const position of badPositions) {
    const vertices = t.vertices.map((v, i) =>
      i === 1 ? { ...v, position } : v,
    );
    const invalid = sceneOf(base, [altered(t, { vertices })]);
    expectCode(
      () => packPreviousSurfacePositions(invalid, base),
      "INVALID_POSITION",
      "previous.triangles[0].vertices[1].position",
    );
    expectCode(
      () => packPreviousSurfacePositions(invalid, sceneOf(base, [])),
      "INVALID_POSITION",
    );
  }
  for (const vertices of [
    null,
    [],
    t.vertices.slice(1),
    [...t.vertices, t.vertices[0]],
    Array(3),
    [t.vertices[0], , t.vertices[2]],
  ]) {
    expectCode(
      () =>
        packPreviousSurfacePositions(
          sceneOf(base, [altered(t, { vertices })]),
          base,
        ),
      "INVALID_POSITION",
    );
  }
});

test("Float32 conversion permits ordinary rounding, subnormals and extrema, and preserves padding", () => {
  const values = [
    3.4028234663852886e38,
    -3.4028234663852886e38,
    2 ** -149,
    0.1,
    -0.2,
    1 / 3,
    Number.MIN_VALUE,
    -0,
    17,
  ];
  const t = base.triangles[0];
  const previous = sceneOf(base, [
    altered(t, {
      vertices: t.vertices.map((v, i) => ({
        ...v,
        position: values.slice(i * 3, i * 3 + 3),
      })),
    }),
  ]);
  const result = packPreviousSurfacePositions(previous, sceneOf(base, [t]));
  assert.deepEqual(result.data, packed(previous.triangles[0]));
  assert.ok(result.data.every(Number.isFinite));
  assert.equal(result.data[3], 1);
  assert.equal(result.data[7], 0);
  assert.equal(result.data[11], 0);
});

test("current and ordered positions are not read or treated as shading/history validation", () => {
  const triangles = base.triangles.map((t) => {
    const copy = { ...t };
    Object.defineProperty(copy, "vertices", {
      get() {
        throw new Error("current positions must not be read");
      },
    });
    return copy;
  });
  const current = sceneOf(base, triangles);
  const result = packPreviousSurfacePositions(
    base,
    current,
    [...triangles].reverse(),
  );
  assert.equal(result.matched, 2);
  assert.deepEqual(result.data.slice(0, 12), packed(base.triangles[1]));
  assert.deepEqual(
    packPreviousSurfacePositions(undefined, current).data,
    new Float32Array(24),
  );
});
