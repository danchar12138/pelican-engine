import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createMediumCatalog,
  MediumError,
} from "../packages/renderer/src/medium.ts";
import {
  extractSurfaceScene,
  type SurfaceScene,
  type SurfaceMaterial,
  type SurfaceTriangle,
  type SurfaceVec3,
} from "../packages/renderer/src/surface.ts";

type Physical = Partial<SurfaceMaterial> & {
  transmission?: number;
  ior?: number;
  attenuationColor?: SurfaceVec3;
  attenuationDistance?: number;
};
// Isolate catalog behavior from the independently developed physical extractor/ABI.
function capture(
  objects: THREE.Object3D[],
  changes: Physical | ((m: SurfaceMaterial, i: number) => Physical) = {},
): SurfaceScene {
  const scene = new THREE.Scene();
  for (const object of objects) scene.add(object);
  const s = extractSurfaceScene(scene);
  return Object.freeze({
    ...s,
    materials: Object.freeze(
      s.materials.map((m, i) =>
        Object.freeze({
          ...m,
          transmission: 1,
          ...(typeof changes === "function" ? changes(m, i) : changes),
        }),
      ),
    ),
  });
}
function box(
  size = 2,
  material:
    | THREE.Material
    | THREE.Material[] = new THREE.MeshStandardMaterial(),
) {
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size), material);
}
function sphere(radius = 1) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 24),
    new THREE.MeshStandardMaterial(),
  );
}
function expectCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof MediumError &&
      e.code === "TC_MEDIUM_" + code &&
      e.message.includes(e.code),
  );
}
function triangles(
  s: SurfaceScene,
  transform: (ts: readonly SurfaceTriangle[]) => readonly SurfaceTriangle[],
): SurfaceScene {
  return { ...s, triangles: transform(s.triangles) };
}
function near(a: number, b: number, epsilon = 1e-12) {
  assert.ok(Math.abs(a - b) < epsilon, a + " != " + b);
}

test("empty and wholly opaque snapshots have no volumes and separate immutable initial arrays", () => {
  const c = createMediumCatalog(capture([box()], { transmission: 0 }));
  assert.deepEqual(c.volumes, []);
  assert.deepEqual(c.initial([0, 0, 0]), []);
  assert.notEqual(c.initial([0, 0, 0]), c.initial([0, 0, 0]));
  assert.deepEqual(createMediumCatalog(capture([])).initial([0, 0, 0]), []);
});

test("indexed and nonindexed BoxGeometry weld face seams and preserve snapshot triangle indices", () => {
  for (const indexed of [true, false]) {
    const b = box();
    if (!indexed) b.geometry = b.geometry.toNonIndexed() as THREE.BoxGeometry;
    const s = capture([b]),
      before = JSON.stringify(s),
      c = createMediumCatalog(s);
    assert.equal(c.volumes.length, 1);
    assert.equal(c.volumes[0].id, 1);
    assert.equal(c.volumes[0].key, JSON.stringify([b.uuid, 0]));
    assert.deepEqual(c.volumes[0].bounds, {
      min: [-1, -1, -1],
      max: [1, 1, 1],
    });
    assert.deepEqual(
      c.volumes[0].triangleIndices,
      Array.from({ length: 12 }, (_, i) => i),
    );
    assert.deepEqual(c.initial([0, 0, 0]), [1]);
    assert.deepEqual(c.initial([0.99, -0.71, 0.4]), [1]);
    assert.deepEqual(c.initial([1.01, 0, 0]), []);
    assert.equal(JSON.stringify(s), before);
  }
});

test("optical defaults, linear Beer factors, distance-off and no hidden absorption clamping", () => {
  const defaults = createMediumCatalog(capture([box()]));
  assert.equal(defaults.volumes[0].ior, 1.5);
  assert.deepEqual(defaults.volumes[0].sigma, [0, 0, 0]);
  const color: SurfaceVec3 = [0.25, 0.5, 1],
    distance = 2;
  const c = createMediumCatalog(
    capture([box()], {
      ior: 1.33,
      attenuationColor: color,
      attenuationDistance: distance,
    }),
  );
  c.volumes[0].sigma.forEach((sigma, i) => {
    near(Math.exp(-sigma * distance), color[i]);
    near(Math.exp(-sigma * 6), color[i] ** 3);
  });
  assert.deepEqual(
    createMediumCatalog(
      capture([box()], { attenuationColor: [0, 0, 0], attenuationDistance: 0 }),
    ).volumes[0].sigma,
    [0, 0, 0],
  );
  expectCode(
    () =>
      createMediumCatalog(
        capture([box()], {
          attenuationColor: [0, 0.5, 1],
          attenuationDistance: 1,
        }),
      ),
    "ZERO_ATTENUATION",
  );
  expectCode(
    () =>
      createMediumCatalog(
        capture([box()], {
          attenuationColor: [0.5, 1, 1],
          attenuationDistance: 1e-300,
        }),
      ),
    "ABSORPTION_RANGE",
  );
});

test("material sharing never merges objects; IDs follow first snapshot encounter including interleaved faces", () => {
  const material = new THREE.MeshStandardMaterial(),
    a = box(2, material),
    b = box(2, material),
    opaque = box();
  a.position.x = -3;
  b.position.x = 3;
  const s = capture([opaque, a, b], (m) => ({
    transmission: m.uuid === (opaque.material as THREE.Material).uuid ? 0 : 1,
  }));
  const c = createMediumCatalog(
    triangles(s, (ts) => [
      ...ts.slice(0, 12),
      ...Array.from({ length: 12 }, (_, i) => [ts[24 + i], ts[12 + i]]).flat(),
    ]),
  );
  assert.deepEqual(
    c.volumes.map((v) => v.key),
    [JSON.stringify([b.uuid, 0]), JSON.stringify([a.uuid, 0])],
  );
  assert.deepEqual(c.initial([-3, 0, 0]), [2]);
  assert.deepEqual(c.initial([3, 0, 0]), [1]);
});

test("nested IDs are ordered by geometric containment, not encounter or AABB size", () => {
  const inner = box(1),
    middle = sphere(2),
    outer = box(8);
  inner.position.set(0.3, -0.2, 0.1);
  const c = createMediumCatalog(capture([inner, outer, middle]));
  assert.deepEqual(c.initial([0.3, -0.2, 0.1]), [2, 3, 1]);
  assert.deepEqual(c.initial([1.2, 0.2, 0.1]), [2, 3]);
  assert.deepEqual(c.initial([3, 0, 0]), [2]);
  assert.deepEqual(c.initial([5, 0, 0]), []);
  assert.deepEqual(c.inspect().nesting, [
    { id: 1, parentId: 3 },
    { id: 2, parentId: 0 },
    { id: 3, parentId: 2 },
  ]);
});

test("rotated disjoint thin boxes with intersecting AABBs are accepted", () => {
  const a = box(),
    b = box();
  for (const m of [a, b]) {
    m.scale.set(3, 0.1, 0.2);
    m.rotation.z = Math.PI / 4;
  }
  b.position.set(-0.4, 0.4, 0);
  const c = createMediumCatalog(capture([a, b]));
  assert.deepEqual(c.initial([0, 0, 0]), [1]);
  assert.deepEqual(c.initial([-0.4, 0.4, 0]), [2]);
});

test("AABB-contained sphere in torus hole is disjoint, not nested", () => {
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(2, 0.4, 12, 32),
    new THREE.MeshStandardMaterial(),
  );
  const c = createMediumCatalog(capture([torus, sphere(0.4)]));
  assert.deepEqual(c.initial([0, 0, 0]), [2]);
  assert.deepEqual(c.initial([2, 0, 0]), [1]);
  assert.deepEqual(c.inspect().nesting, [
    { id: 1, parentId: 0 },
    { id: 2, parentId: 0 },
  ]);
});

test("true overlap, edge-face crossing, coplanar contact and tangency fail before integration", () => {
  for (const offset of [
    [0.7, 0.4, 0.1],
    [2, 0, 0],
    [2, 2, 0],
    [2, 2, 2],
  ] as const) {
    const b = box();
    b.position.set(offset[0], offset[1], offset[2]);
    expectCode(() => createMediumCatalog(capture([box(), b])), "OVERLAP");
  }
  const a = box(),
    b = box();
  a.scale.set(3, 0.1, 0.1);
  b.scale.set(0.1, 3, 0.1);
  expectCode(() => createMediumCatalog(capture([a, b])), "OVERLAP");
  const inner = box(1);
  inner.position.x = 0.5;
  expectCode(() => createMediumCatalog(capture([box(), inner])), "OVERLAP");
});

test("mirrored and globally reversed winding work without relying on shading normals", () => {
  const b = box();
  b.scale.set(-2, 3, 0.5);
  b.rotation.set(0.4, 0.2, -0.3);
  b.position.set(3, -2, 5);
  const s = capture([b]),
    c = createMediumCatalog(s);
  assert.deepEqual(c.initial([3, -2, 5]), [1]);
  const reversed = triangles(s, (ts) =>
    ts.map((t) => ({
      ...t,
      vertices: [t.vertices[0], t.vertices[2], t.vertices[1]].map((v) => ({
        ...v,
        normal: [1, 0, 0] as SurfaceVec3,
      })) as unknown as SurfaceTriangle["vertices"],
    })),
  );
  assert.deepEqual(createMediumCatalog(reversed).initial([3, -2, 5]), [1]);
});

test("instances retain separate IDs and world-space mirrored transforms", () => {
  const m = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshStandardMaterial(),
    3,
  );
  for (let i = 0; i < 3; i++)
    m.setMatrixAt(
      i,
      new THREE.Matrix4().compose(
        new THREE.Vector3(i * 5, 0, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.3, 0.1)),
        new THREE.Vector3(i === 1 ? -1 : 1, 1, 1),
      ),
    );
  const c = createMediumCatalog(capture([m]));
  assert.deepEqual(
    c.volumes.map((v) => v.key),
    [0, 1, 2].map((i) => JSON.stringify([m.uuid, i])),
  );
  for (let i = 0; i < 3; i++)
    assert.deepEqual(c.initial([i * 5, 0, 0]), [i + 1]);
});

test("different surface materials/roughness/colors can share one phase; inconsistent IOR/sigma cannot", () => {
  const materials = Array.from(
    { length: 6 },
    (_, i) =>
      new THREE.MeshStandardMaterial({
        roughness: i / 6,
        color: new THREE.Color(i / 6, 0.2, 0.4),
      }),
  );
  const s = capture([box(2, materials)], {
    ior: 1.4,
    attenuationColor: [0.5, 0.8, 1],
    attenuationDistance: 2,
  });
  assert.equal(createMediumCatalog(s).volumes.length, 1);
  for (const change of [
    { ior: 1.6 },
    { attenuationColor: [0.7, 0.8, 1] as SurfaceVec3 },
  ]) {
    const bad = {
      ...s,
      materials: s.materials.map((m, i) => (i === 1 ? { ...m, ...change } : m)),
    };
    expectCode(() => createMediumCatalog(bad), "INCONSISTENT_MEDIUM");
  }
  const partial = {
    ...s,
    materials: s.materials.map((m, i) =>
      i === 2 ? { ...m, transmission: 0 } : m,
    ),
  };
  expectCode(() => createMediumCatalog(partial), "PARTIAL_TRANSMISSION");
});

test("holes, duplicate faces, flipped faces and collapsed/zero-thickness geometry are rejected", () => {
  const s = capture([box()]);
  expectCode(
    () => createMediumCatalog(triangles(s, (ts) => ts.slice(1))),
    "OPEN_OR_NONMANIFOLD",
  );
  expectCode(
    () => createMediumCatalog(triangles(s, (ts) => [...ts, ts[0]])),
    "OPEN_OR_NONMANIFOLD",
  );
  expectCode(
    () =>
      createMediumCatalog(
        triangles(s, (ts) =>
          ts.map((t, i) =>
            i
              ? t
              : {
                  ...t,
                  vertices: [t.vertices[0], t.vertices[2], t.vertices[1]],
                },
          ),
        ),
      ),
    "ORIENTATION",
  );
  expectCode(
    () =>
      createMediumCatalog(
        triangles(s, (ts) =>
          ts.map((t) => ({
            ...t,
            vertices: t.vertices.map((v) => ({
              ...v,
              position: [v.position[0], v.position[1], 0],
            })) as unknown as SurfaceTriangle["vertices"],
          })),
        ),
      ),
    "DEGENERATE",
  );
});

test("vertex pinch and disconnected shells are explicit unsupported topology", () => {
  const a = box(),
    b = box();
  b.position.set(2, 2, 2);
  const s = capture([a, b]);
  const merge = (snapshot: SurfaceScene) =>
    triangles(snapshot, (ts) => ts.map((t) => ({ ...t, objectUuid: a.uuid })));
  expectCode(() => createMediumCatalog(merge(s)), "VERTEX_NONMANIFOLD");
  b.position.set(5, 0, 0);
  expectCode(
    () => createMediumCatalog(merge(capture([a, b]))),
    "MULTIPLE_SHELLS",
  );
});

test("finite input, transform matrices, material IDs and object/instance identities are validated", () => {
  const s = capture([box()]);
  expectCode(
    () =>
      createMediumCatalog({
        ...s,
        materials: [...s.materials, s.materials[0]],
      }),
    "MATERIAL_ID",
  );
  expectCode(() => createMediumCatalog({ ...s, materials: [] }), "MATERIAL_ID");
  for (const change of [
    { objectUuid: "" },
    { instanceId: -1 },
    { instanceId: 0.5 },
    { instanceId: Infinity },
  ])
    expectCode(
      () =>
        createMediumCatalog(
          triangles(s, (ts) => ts.map((t) => ({ ...t, ...change }))),
        ),
      "IDENTITY",
    );
  for (const normalMatrix of [
    [],
    Array(9).fill(0),
    [NaN, 0, 0, 0, 1, 0, 0, 0, 1],
  ])
    expectCode(
      () =>
        createMediumCatalog(
          triangles(s, (ts) => ts.map((t) => ({ ...t, normalMatrix }))),
        ),
      "MATRIX",
    );
  expectCode(
    () =>
      createMediumCatalog(
        triangles(s, (ts) =>
          ts.map((t) => ({
            ...t,
            vertices: t.vertices.map((v) => ({
              ...v,
              position: [NaN, 0, 0],
            })) as unknown as SurfaceTriangle["vertices"],
          })),
        ),
      ),
    "INPUT",
  );
  for (const change of [
    { ior: 0 },
    { ior: Infinity },
    { transmission: -1 },
    { transmission: NaN },
    { attenuationDistance: -1 },
    { attenuationDistance: Infinity },
    { attenuationColor: [1, -0.1, 1] as SurfaceVec3 },
  ])
    expectCode(() => createMediumCatalog(capture([box()], change)), "MATERIAL");
  expectCode(
    () => createMediumCatalog({ ...s, version: 2 } as unknown as SurfaceScene),
    "INPUT",
  );
  expectCode(() => createMediumCatalog(s).initial([Infinity, 0, 0]), "INPUT");
});

test("exact face, diagonal, edge, vertex and near-boundary origins fail with explicit boundary diagnostic", () => {
  const c = createMediumCatalog(capture([box()]));
  for (const p of [
    [1, 0, 0],
    [1, 0.5, 0.5],
    [1, 1, 0],
    [1, 1, 1],
    [1 - 1e-8, 0, 0],
    [1 + 1e-8, 0, 0],
  ] as const)
    expectCode(() => c.initial(p), "BOUNDARY");
  assert.deepEqual(c.initial([1 - 1e-5, 0, 0]), [1]);
  assert.deepEqual(c.initial([1 + 1e-5, 0, 0]), []);
});

test("off-axis rays hitting shared face diagonal/vertex do not double-count", () => {
  const c = createMediumCatalog(capture([box()]));
  for (const d of [
    [1, 0.37139, 0.69421],
    [-0.52973, 1, 0.21761],
    [0.19317, -0.61843, 1],
  ]) {
    const p = new THREE.Vector3(...d.map(Math.sign)).addScaledVector(
      new THREE.Vector3(...d),
      -0.5,
    );
    assert.deepEqual(c.initial(p.toArray() as unknown as SurfaceVec3), [1]);
  }
  assert.deepEqual(c.initial([0.2, -0.1, 0.3]), [1]);
});

test("seeded sphere samples agree with analytic sphere outside the tessellation error band", () => {
  const mesh = sphere();
  mesh.position.set(0.31, -0.42, 0.27);
  const c = createMediumCatalog(capture([mesh]));
  let seed = 0x3456789,
    checked = 0;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
  for (let i = 0; i < 1500; i++) {
    const p = new THREE.Vector3(
        random() * 2.8 - 1.4,
        random() * 2.8 - 1.4,
        random() * 2.8 - 1.4,
      ),
      r = p.length();
    if (Math.abs(r - 1) < 0.012) continue;
    p.add(mesh.position);
    assert.deepEqual(
      c.initial(p.toArray() as unknown as SurfaceVec3),
      r < 1 ? [1] : [],
    );
    checked++;
  }
  assert.ok(checked > 1400);
  expectCode(() => c.initial([0.31, 0.58, 0.27]), "BOUNDARY");
});

test("explicit relative seam tolerance welds near seams but never silently fills larger holes", () => {
  const b = box();
  b.geometry = b.geometry.toNonIndexed() as THREE.BoxGeometry;
  const s = capture([b]);
  const perturb = (amount: number) =>
    triangles(s, (ts) =>
      ts.map((t, i) => ({
        ...t,
        vertices: t.vertices.map((v) => ({
          ...v,
          position: [
            v.position[0] + (i === 0 ? amount : 0),
            v.position[1],
            v.position[2],
          ],
        })) as unknown as SurfaceTriangle["vertices"],
      })),
    );
  const c = createMediumCatalog(perturb(5e-8));
  assert.deepEqual(c.initial([0, 0, 0]), [1]);
  near(c.inspect().tolerance[0].weld, 2.00000005e-7);
  expectCode(() => createMediumCatalog(perturb(2e-5)), "OPEN_OR_NONMANIFOLD");
});

test("closed animated skin+morph and world transforms rebuild from current snapshot without mutating sources", () => {
  const g = new THREE.BoxGeometry(2, 2, 2),
    count = g.getAttribute("position").count;
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [0, 0, 2]).flat(),
      3,
    ),
  ];
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(
      Array.from({ length: count }, () => [0, 0, 0, 0]).flat(),
      4,
    ),
  );
  g.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [1, 0, 0, 0]).flat(),
      4,
    ),
  );
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial()),
    bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.morphTargetInfluences![0] = 0.25;
  mesh.position.set(3, -2, 5);
  mesh.scale.set(-2, 1.5, 0.8);
  bone.position.x = 0.5;
  bone.rotation.y = 0.4;
  const before = {
    positions: Array.from(g.getAttribute("position").array),
    bind: mesh.bindMatrix.toArray(),
    bone: bone.position.toArray(),
  };
  const center = new THREE.Vector3(0, 0, 0.5)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)
    .add(bone.position)
    .multiply(mesh.scale)
    .add(mesh.position);
  const c = createMediumCatalog(capture([mesh]));
  assert.deepEqual(c.initial(center.toArray() as unknown as SurfaceVec3), [1]);
  bone.position.x += 5;
  const next = createMediumCatalog(capture([mesh]));
  assert.deepEqual(
    next.initial(center.toArray() as unknown as SurfaceVec3),
    [],
  );
  assert.deepEqual(c.initial(center.toArray() as unknown as SurfaceVec3), [1]);
  assert.deepEqual(
    Array.from(g.getAttribute("position").array),
    before.positions,
  );
  assert.deepEqual(mesh.bindMatrix.toArray(), before.bind);
  assert.deepEqual(before.bone, [0.5, 0, 0]);
});

test("catalog and outputs are deeply immutable; disposal rejects operational queries and remains inspectable", () => {
  const c = createMediumCatalog(capture([box()])),
    v = c.volumes[0],
    ids = c.initial([0, 0, 0]);
  for (const value of [
    c,
    c.volumes,
    v,
    v.bounds,
    v.bounds.min,
    v.bounds.max,
    v.sigma,
    v.triangleIndices,
    ids,
    c.inspect(),
    c.inspect().nesting,
    c.inspect().nesting[0],
  ])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    (v.bounds.min as unknown as number[])[0] = 99;
  }, TypeError);
  assert.throws(() => {
    (ids as number[]).push(99);
  }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(c.inspect())).volumes[0].id, 1);
  assert.notEqual(c.initial([0, 0, 0]), ids);
  c.dispose();
  c.dispose();
  expectCode(() => c.initial([0, 0, 0]), "DISPOSED");
  expectCode(() => c.volumes, "DISPOSED");
  assert.deepEqual(c.inspect(), {
    disposed: true,
    volumes: [],
    tolerance: [],
    nesting: [],
  });
});

test("equal optical phases allow different positive transmission and equivalent attenuation parameterizations", () => {
  const materials = Array.from(
    { length: 6 },
    () => new THREE.MeshStandardMaterial(),
  );
  const s = capture([box(2, materials)], (_, i) => ({
    transmission: i % 2 ? 0.25 : 1,
    ior: 1.4,
    attenuationColor: i % 2 ? [0.25, 1, 1] : [0.5, 1, 1],
    attenuationDistance: i % 2 ? 2 : 1,
  }));
  assert.equal(createMediumCatalog(s).volumes.length, 1);
  const off = capture([box(2, materials)], (_, i) => ({
    attenuationDistance: 0,
    attenuationColor: i % 2 ? [0, 0.3, 1] : [1, 1, 1],
  }));
  assert.deepEqual(createMediumCatalog(off).volumes[0].sigma, [0, 0, 0]);
});

test("closed edge topology with nondegenerate faces but zero enclosed volume is rejected", () => {
  const s = capture([box()]),
    p: SurfaceVec3[] = [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ];
  const ts = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ].map((ids) => ({
    ...s.triangles[0],
    vertices: ids.map((i) => ({
      ...s.triangles[0].vertices[0],
      position: p[i],
    })) as unknown as SurfaceTriangle["vertices"],
  }));
  expectCode(() => createMediumCatalog({ ...s, triangles: ts }), "DEGENERATE");
});

test("world-unit tolerance is scale-relative and handles large translated coordinates", () => {
  for (const [size, offset] of [
    [1e-6, 0],
    [1e6, 0],
    [2, 1e9],
  ]) {
    const b = box(size);
    b.position.set(offset, -offset, offset);
    const c = createMediumCatalog(capture([b]));
    assert.deepEqual(c.initial([offset, -offset, offset]), [1]);
    assert.deepEqual(c.initial([offset + size, -offset, offset]), []);
  }
});

test("seeded analytic boxes classify nesting/overlap/disjointness before any initial query", () => {
  let state = 0x1234abcd;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < 120; i++) {
    const half = 0.2 + random() * 2,
      center = new THREE.Vector3(
        random() * 7 - 3.5,
        random() * 7 - 3.5,
        random() * 7 - 3.5,
      ),
      b = box(half * 2);
    b.position.copy(center);
    const distances = center.toArray().map(Math.abs),
      disjoint = distances.some((d) => d > 1 + half),
      aContainsB = distances.every((d) => d + half < 1),
      bContainsA = distances.every((d) => d + 1 < half);
    const s = capture([box(), b]);
    if (!disjoint && !aContainsB && !bContainsA)
      expectCode(() => createMediumCatalog(s), "OVERLAP");
    else {
      const c = createMediumCatalog(s);
      const centerInA = distances.every((d) => d < 1),
        originInB = distances.every((d) => d < half);
      assert.deepEqual(
        c.initial(center.toArray() as unknown as SurfaceVec3),
        centerInA ? (aContainsB ? [1, 2] : [2, 1]) : [2],
      );
      assert.deepEqual(
        c.initial([0, 0, 0]),
        originInB ? (bContainsA ? [2, 1] : [1, 2]) : [1],
      );
    }
  }
});
