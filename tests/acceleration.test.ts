import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createSurfaceAcceleration,
  SurfaceAccelerationError,
  type AccelerationFrame,
  type AccelerationHit,
} from "../packages/renderer/src/acceleration.ts";
import {
  extractSurfaceScene,
  sampleSurfaceMaterial,
  type SurfaceScene,
  type SurfaceTriangle,
  type SurfaceVec3,
} from "../packages/renderer/src/surface.ts";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function geometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  );
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  return g;
}
function setup(
  g = geometry(),
  material:
    | THREE.Material
    | THREE.Material[] = new THREE.MeshStandardMaterial(),
) {
  const scene = new THREE.Scene(),
    mesh = new THREE.Mesh(g, material);
  scene.add(mesh);
  return { scene, mesh, g };
}
const templateScene = extractSurfaceScene(setup().scene);
const template = templateScene.triangles[0];
function triangle(index: number, x = index * 3, y = 0, z = 0): SurfaceTriangle {
  return {
    ...template,
    elementOffset: index * 3,
    vertices: template.vertices.map((v) => ({
      ...v,
      position: [v.position[0] + x, v.position[1] + y, v.position[2] + z],
    })) as unknown as SurfaceTriangle["vertices"],
  };
}
function sceneOf(
  triangles: readonly SurfaceTriangle[],
  base = templateScene,
): SurfaceScene {
  return freeze({ ...base, triangles });
}
function moved(t: SurfaceTriangle, delta: SurfaceVec3): SurfaceTriangle {
  return {
    ...t,
    vertices: t.vertices.map((v) => ({
      ...v,
      position: v.position.map(
        (n, axis) => n + delta[axis],
      ) as unknown as SurfaceVec3,
    })) as unknown as SurfaceTriangle["vertices"],
  };
}
function close(a: number, b: number, epsilon = 1e-8) {
  assert.ok(
    Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b)),
    a + " != " + b,
  );
}
function nearVec(a: SurfaceVec3, b: SurfaceVec3) {
  a.forEach((n, axis) => close(n, b[axis]));
}
function pointers(frame: AccelerationFrame) {
  return Array.from({ length: frame.nodes.length / 8 }, (_, i) => [
    frame.nodes[i * 8 + 3],
    frame.nodes[i * 8 + 7],
  ]);
}

// Exact containment (no epsilon), complete reachability, and exact child unions.
function verifyTree(frame: AccelerationFrame, snapshot: SurfaceScene): void {
  assert.equal(frame.nodes.length, frame.metrics.nodes * 8);
  assert.equal(frame.orderedTriangles.length, snapshot.triangles.length);
  assert.equal(frame.sourceIndices.length, snapshot.triangles.length);
  if (!snapshot.triangles.length) {
    assert.equal(frame.nodes.length, 0);
    assert.equal(frame.metrics.depth, 0);
    return;
  }
  const seen = new Set<number>(),
    slots = new Set<number>(),
    stack = [{ index: 0, depth: 1 }];
  let depth = 0;
  while (stack.length) {
    const item = stack.pop()!,
      index = item.index,
      offset = index * 8;
    assert.ok(
      Number.isSafeInteger(index) && index >= 0 && offset < frame.nodes.length,
    );
    assert.ok(!seen.has(index));
    seen.add(index);
    depth = Math.max(depth, item.depth);
    const n = frame.nodes.subarray(offset, offset + 8);
    assert.ok(n.every(Number.isFinite));
    if (n[7] > 0) {
      assert.ok(Number.isInteger(n[3]) && Number.isInteger(n[7]));
      for (let slot = n[3]; slot < n[3] + n[7]; slot++) {
        assert.ok(!slots.has(slot));
        slots.add(slot);
        const t = frame.orderedTriangles[slot];
        assert.equal(t, snapshot.triangles[frame.sourceIndices[slot]]);
        for (const vertex of t.vertices)
          vertex.position.forEach((v, axis) => {
            assert.ok(v >= n[axis]);
            assert.ok(v <= n[axis + 4]);
          });
      }
    } else {
      assert.ok(n[7] < 0);
      const left = n[3],
        right = -n[7];
      assert.ok(left > index && right > index);
      for (let axis = 0; axis < 3; axis++) {
        assert.equal(
          n[axis],
          Math.min(frame.nodes[left * 8 + axis], frame.nodes[right * 8 + axis]),
        );
        assert.equal(
          n[axis + 4],
          Math.max(
            frame.nodes[left * 8 + axis + 4],
            frame.nodes[right * 8 + axis + 4],
          ),
        );
      }
      stack.push(
        { index: left, depth: item.depth + 1 },
        { index: right, depth: item.depth + 1 },
      );
    }
  }
  assert.equal(seen.size, frame.metrics.nodes);
  assert.equal(slots.size, snapshot.triangles.length);
  assert.equal(depth, frame.metrics.depth);
}

function verifyRanges(
  before: AccelerationFrame,
  after: AccelerationFrame,
): void {
  const covered = new Set<number>();
  let end = -1;
  for (const range of after.changes.nodeRanges) {
    assert.equal(range.offset % 8, 0);
    assert.equal(range.count % 8, 0);
    assert.ok(range.count > 0);
    assert.ok(range.offset > end);
    end = range.offset + range.count;
    for (let offset = range.offset; offset < end; offset += 8)
      covered.add(offset);
  }
  for (let offset = 0; offset < after.nodes.length; offset += 8) {
    const changed = Array.from(after.nodes.subarray(offset, offset + 8)).some(
      (n, k) => n !== before.nodes[offset + k],
    );
    assert.equal(
      covered.has(offset),
      changed,
      "range membership for node " + offset / 8,
    );
  }
}

// Independent Three Ray/Triangle oracle: no BVH and no acceleration intersection math.
function brute(
  snapshot: SurfaceScene,
  origin: SurfaceVec3,
  direction: SurfaceVec3,
  maxDistance = Infinity,
): AccelerationHit | null {
  const ray = new THREE.Ray(
    new THREE.Vector3(...origin),
    new THREE.Vector3(...direction).normalize(),
  );
  let best: AccelerationHit | null = null;
  snapshot.triangles.forEach((t, triangleIndex) => {
    const [a, b, c] = t.vertices.map((v) => new THREE.Vector3(...v.position));
    const m = snapshot.materials.find((m) => m.uuid === t.materialUuid)!;
    const sign = Math.sign(
      new THREE.Matrix3().fromArray(t.normalMatrix).determinant(),
    );
    const reverse = sign < 0 !== (m.side === "back");
    const point = ray.intersectTriangle(
      a,
      reverse ? c : b,
      reverse ? b : c,
      m.side !== "double",
      new THREE.Vector3(),
    );
    if (!point) return;
    const distance = point.distanceTo(ray.origin);
    if (
      distance > maxDistance ||
      (best &&
        (distance > best.distance ||
          (distance === best.distance && triangleIndex > best.triangleIndex)))
    )
      return;
    const barycentric = new THREE.Triangle(a, b, c)
      .getBarycoord(point, new THREE.Vector3())!
      .toArray() as unknown as SurfaceVec3;
    const frontFacing =
      new THREE.Triangle(a, b, c)
        .getNormal(new THREE.Vector3())
        .dot(ray.direction) *
        sign <
      0;
    best = {
      triangleIndex,
      distance,
      barycentric,
      normal: sampleSurfaceMaterial(snapshot, triangleIndex, barycentric, {
        frontFacing,
      }).normal,
    };
  });
  return best;
}
function compare(
  actual: AccelerationHit | null,
  expected: AccelerationHit | null,
) {
  if (!actual || !expected) {
    assert.equal(actual, expected);
    return;
  }
  assert.equal(actual.triangleIndex, expected.triangleIndex);
  close(actual.distance, expected.distance);
  nearVec(actual.barycentric, expected.barycentric);
  nearVec(actual.normal, expected.normal);
}

test("fixed GPU layout, complete tree, finite timings and serializable inspection", () => {
  const snapshot = sceneOf(Array.from({ length: 37 }, (_, i) => triangle(i))),
    acceleration = createSurfaceAcceleration();
  const frame = acceleration.update(snapshot);
  assert.ok(frame.nodes instanceof Float32Array);
  assert.ok(frame.sourceIndices instanceof Uint32Array);
  assert.equal(frame.changes.kind, "rebuild");
  assert.equal(frame.revision, 1);
  assert.equal(frame.topologyRevision, 1);
  assert.deepEqual(frame.changes.nodeRanges, [
    { offset: 0, count: frame.nodes.length },
  ]);
  verifyTree(frame, snapshot);
  assert.ok(
    frame.metrics.buildMs >= 0 && Number.isFinite(frame.metrics.buildMs),
  );
  assert.equal(frame.metrics.refitMs, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(acceleration.inspect())),
    acceleration.inspect(),
  );
});

test("position refit crosses original partitions without repartitioning and updates every parent", () => {
  const acceleration = createSurfaceAcceleration(),
    first = sceneOf(Array.from({ length: 41 }, (_, i) => triangle(i)));
  const before = acceleration.update(first),
    second = sceneOf(
      first.triangles.map((t, i) => moved(t, [200 - i * 8, i % 3, -i])),
    );
  const after = acceleration.update(second);
  assert.equal(after.changes.kind, "refit");
  assert.equal(after.topologyRevision, before.topologyRevision);
  assert.deepEqual(pointers(after), pointers(before));
  assert.deepEqual(after.sourceIndices, before.sourceIndices);
  assert.deepEqual(
    after.orderedTriangles.map((t) => t.elementOffset),
    before.orderedTriangles.map((t) => t.elementOffset),
  );
  verifyTree(after, second);
  verifyRanges(before, after);
  assert.equal(after.metrics.buildMs, 0);
  assert.ok(after.metrics.refitMs >= 0);
  for (const t of second.triangles) {
    const p = t.vertices[0].position,
      origin: SurfaceVec3 = [p[0] + 0.2, p[1] + 0.2, p[2] + 2];
    compare(
      acceleration.intersect(origin, [0, 0, -7]),
      brute(second, origin, [0, 0, -7]),
    );
  }
  assert.equal(acceleration.inspect().rebuilds, 1);
  assert.equal(acceleration.inspect().refits, 1);
});

test("sparse refit reports only changed consecutive node groups and encloses non-Float32 positions", () => {
  const acceleration = createSurfaceAcceleration(),
    first = sceneOf(Array.from({ length: 64 }, (_, i) => triangle(i)));
  const before = acceleration.update(first);
  const second = sceneOf(
    first.triangles.map((t, i) =>
      i === 31 ? moved(t, [0.10000000001, -1e-12, -0.333333333333]) : t,
    ),
  );
  const after = acceleration.update(second);
  verifyTree(after, second);
  verifyRanges(before, after);
  assert.ok(after.changes.nodeRanges.length > 1);
  assert.ok(
    after.changes.nodeRanges.reduce((n, r) => n + r.count, 0) <
      after.nodes.length,
  );
});

test("positions can change inside a leaf's old envelope: refit with no dirty nodes", () => {
  const acceleration = createSurfaceAcceleration(),
    first = sceneOf([triangle(0, 0), triangle(1, 10), triangle(2, 4)]);
  const before = acceleration.update(first),
    after = acceleration.update(
      sceneOf([
        first.triangles[0],
        first.triangles[1],
        moved(first.triangles[2], [1, 0, 0]),
      ]),
    );
  assert.equal(after.changes.kind, "refit");
  assert.deepEqual(after.changes.nodeRanges, []);
  assert.deepEqual(after.nodes, before.nodes);
  assert.equal(
    acceleration.intersect([5.2, 0.2, 1], [0, 0, -1])!.triangleIndex,
    2,
  );
  assert.equal(acceleration.intersect([4.2, 0.2, 1], [0, 0, -1]), null);
});

test("reorder remaps snapshot indices while preserving leaf slots, including reorder plus refit", () => {
  const acceleration = createSurfaceAcceleration(),
    original = sceneOf(Array.from({ length: 19 }, (_, i) => triangle(i)));
  const before = acceleration.update(original),
    reversed = sceneOf([...original.triangles].reverse()),
    after = acceleration.update(reversed);
  assert.equal(after.changes.kind, "materials");
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.changes.nodeRanges, []);
  assert.equal(after.topologyRevision, before.topologyRevision);
  after.sourceIndices.forEach((source, slot) =>
    assert.equal(
      source,
      original.triangles.length - 1 - before.sourceIndices[slot],
    ),
  );
  assert.deepEqual(
    after.orderedTriangles.map((t) => t.elementOffset),
    before.orderedTriangles.map((t) => t.elementOffset),
  );
  verifyTree(after, reversed);
  compare(
    acceleration.intersect([0.2, 0.2, 2], [0, 0, -1]),
    brute(reversed, [0.2, 0.2, 2], [0, 0, -1]),
  );
  const changed = sceneOf(reversed.triangles.map((t) => moved(t, [0, 0, -3]))),
    refitted = acceleration.update(changed);
  assert.equal(refitted.changes.kind, "refit");
  assert.deepEqual(pointers(refitted), pointers(before));
  verifyTree(refitted, changed);
  assert.equal(acceleration.intersect([0.2, 0.2, 2], [0, 0, -2])!.distance, 5);
});

test("material UUID replacement, normals, UVs, and texture source pixels update without rebuilding nodes", () => {
  const acceleration = createSurfaceAcceleration(),
    first = sceneOf([triangle(0)]),
    before = acceleration.update(first);
  const material = {
    ...first.materials[0],
    uuid: "replacement",
    side: "back" as const,
  };
  const changed = freeze({
    ...first,
    materials: [material],
    triangles: [
      {
        ...first.triangles[0],
        materialUuid: material.uuid,
        vertices: first.triangles[0].vertices.map((v) => ({
          ...v,
          normal: [0, 1, 1] as SurfaceVec3,
          uv0: [0.25, 0.75] as const,
        })) as unknown as SurfaceTriangle["vertices"],
      },
    ],
  });
  const after = acceleration.update(changed);
  assert.equal(after.changes.kind, "materials");
  assert.equal(after.topologyRevision, before.topologyRevision);
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.changes.nodeRanges, []);
  assert.equal(acceleration.intersect([0.2, 0.2, 1], [0, 0, -1]), null);
  nearVec(acceleration.intersect([0.2, 0.2, -1], [0, 0, 1])!.normal, [
    0,
    -Math.SQRT1_2,
    -Math.SQRT1_2,
  ]);
  assert.equal(
    acceleration.update(structuredClone(changed)).changes.kind,
    "none",
  );
  const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const source = setup(
    geometry(),
    new THREE.MeshStandardMaterial({ map: tex }),
  );
  acceleration.update(extractSurfaceScene(source.scene));
  tex.image.data![0] = 127;
  tex.needsUpdate = true;
  const pixelsChanged = acceleration.update(extractSurfaceScene(source.scene));
  assert.equal(pixelsChanged.changes.kind, "materials");
  assert.deepEqual(pixelsChanged.changes.nodeRanges, []);
  const cached = acceleration.update(extractSurfaceScene(source.scene));
  assert.equal(cached.changes.kind, "none");
  assert.equal(cached.revision, pixelsChanged.revision);
});

test("actual Three transform, normal changes and morph extraction use refit rather than CPU rebuild", () => {
  const g = new THREE.BoxGeometry(),
    source = setup(
      g,
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
    );
  const position = g.getAttribute("position"),
    morph = new Float32Array(position.array.length);
  for (let i = 0; i < position.count; i++) {
    morph[i * 3] = position.getX(i) * 2;
    morph[i * 3 + 1] = position.getY(i) + position.getX(i) * 0.3;
    morph[i * 3 + 2] = position.getZ(i) * 0.6;
  }
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(morph, 3)];
  source.mesh.updateMorphTargets();
  const acceleration = createSurfaceAcceleration(),
    before = acceleration.update(extractSurfaceScene(source.scene));
  source.mesh.position.set(2, -1, -3);
  source.mesh.rotation.set(0.2, 0.4, 0.1);
  source.mesh.scale.set(2, 0.7, 1.3);
  source.mesh.morphTargetInfluences![0] = 0.65;
  const snapshot = extractSurfaceScene(source.scene),
    after = acceleration.update(snapshot);
  assert.equal(after.changes.kind, "refit");
  assert.deepEqual(pointers(after), pointers(before));
  assert.deepEqual(after.sourceIndices, before.sourceIndices);
  verifyTree(after, snapshot);
  for (let x = 0; x < 5; x += 0.25)
    compare(
      acceleration.intersect([x, -1, 4], [0, 0, -1]),
      brute(snapshot, [x, -1, 4], [0, 0, -1]),
    );
  assert.equal(acceleration.inspect().rebuilds, 1);
});

test("transmissive boundaries trace both sides with incident-facing normals, independent of raster side and mirroring", () => {
  for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
    for (const mirror of [1, -1]) {
      const scene = new THREE.Scene(),
        material = new THREE.MeshPhysicalMaterial({ transmission: 1, side }),
        mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material),
        acceleration = createSurfaceAcceleration();
      mesh.scale.x = mirror;
      scene.add(mesh);
      const surface = extractSurfaceScene(scene);
      acceleration.update(surface);
      for (const origin of [
        [0, 0, 0],
        [0, 0, 3],
      ] as const) {
        const hit = acceleration.intersect(origin, [0, 0, -1]);
        assert.ok(hit, JSON.stringify({ side, mirror, origin }));
        assert.equal(hit.distance, origin[2] === 0 ? 1 : 2);
        assert.ok(hit.normal[2] > 0.999);
        const sampled = sampleSurfaceMaterial(
          surface,
          hit.triangleIndex,
          hit.barycentric,
          { frontFacing: origin[2] !== 0 },
        );
        assert.equal(sampled.discarded, false);
        assert.deepEqual(hit.normal, sampled.normal);
      }
      acceleration.dispose();
      mesh.geometry.dispose();
      material.dispose();
    }
  }
});

test("spawn/remove and every identity component rebuild; unchanged identities do not", () => {
  const acceleration = createSurfaceAcceleration(),
    first = sceneOf([triangle(0), triangle(1)]);
  acceleration.update(first);
  const added = sceneOf([...first.triangles, triangle(2)]);
  assert.equal(acceleration.update(added).changes.kind, "rebuild");
  assert.equal(acceleration.update(first).changes.kind, "rebuild");
  for (const field of [
    "objectUuid",
    "geometryUuid",
    "instanceId",
    "groupIndex",
    "elementOffset",
    "vertexIndices",
  ] as const) {
    acceleration.update(first);
    const t = first.triangles[0],
      value =
        field === "vertexIndices"
          ? [2, 1, 0]
          : typeof t[field] === "string"
            ? "changed"
            : 99;
    const frame = acceleration.update(
      sceneOf([{ ...t, [field]: value }, first.triangles[1]]),
    );
    assert.equal(frame.changes.kind, "rebuild", field);
  }
});

test("actual visibility, instance count, instance transforms, and material visibility", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.InstancedMesh(geometry(), material, 3);
  scene.add(mesh);
  mesh.count = 2;
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
  const acceleration = createSurfaceAcceleration(),
    first = acceleration.update(extractSurfaceScene(scene));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(5, 0, -2));
  const movedFrame = acceleration.update(extractSurfaceScene(scene));
  assert.equal(movedFrame.changes.kind, "refit");
  assert.deepEqual(pointers(movedFrame), pointers(first));
  assert.equal(acceleration.intersect([5.2, 0.2, 1], [0, 0, -1])!.distance, 3);
  mesh.count = 3;
  assert.equal(
    acceleration.update(extractSurfaceScene(scene)).changes.kind,
    "rebuild",
  );
  mesh.visible = false;
  const hidden = acceleration.update(extractSurfaceScene(scene));
  assert.equal(hidden.changes.kind, "rebuild");
  assert.equal(hidden.nodes.length, 0);
  mesh.visible = true;
  assert.equal(
    acceleration.update(extractSurfaceScene(scene)).changes.kind,
    "rebuild",
  );
  material.visible = false;
  assert.equal(
    acceleration.update(extractSurfaceScene(scene)).changes.kind,
    "rebuild",
  );
  assert.equal(acceleration.intersect([0.2, 0.2, 1], [0, 0, -1]), null);
});

test("two groups respect front/back/double sides; mirror sign and custom normals do not redefine front", () => {
  const g = geometry(),
    pos = [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0];
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [0, 0, -1]).flat(),
      3,
    ),
  );
  g.deleteAttribute("uv");
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  const front = new THREE.MeshStandardMaterial({ side: THREE.FrontSide }),
    back = new THREE.MeshStandardMaterial({ side: THREE.BackSide });
  const source = setup(g, [front, back]),
    acceleration = createSurfaceAcceleration();
  for (const mirrored of [false, true]) {
    source.mesh.scale.x = mirrored ? -1 : 1;
    const snapshot = extractSurfaceScene(source.scene),
      frame = acceleration.update(snapshot);
    source.scene.updateMatrixWorld(true);
    if (mirrored) assert.equal(frame.changes.kind, "refit");
    const sign = mirrored ? -1 : 1;
    for (const group of [0, 1])
      for (const z of [2, -2]) {
        const origin: SurfaceVec3 = [sign * (group * 2 + 0.2), 0.2, z],
          direction: SurfaceVec3 = [0, 0, -Math.sign(z)];
        const raycaster = new THREE.Raycaster(
          new THREE.Vector3(...origin),
          new THREE.Vector3(...direction),
        );
        const expected = raycaster.intersectObject(source.mesh),
          hit = acceleration.intersect(origin, direction);
        assert.equal(
          hit !== null,
          expected.length !== 0,
          JSON.stringify({
            mirrored,
            group,
            z,
            hit,
            expected: expected.length,
          }),
        );
        compare(hit, brute(snapshot, origin, direction));
      }
    front.side = back.side = THREE.DoubleSide;
    const doubleFrame = acceleration.update(extractSurfaceScene(source.scene));
    assert.equal(doubleFrame.changes.kind, "materials");
    for (const z of [1, -1])
      assert.ok(
        acceleration.intersect([sign * 0.2, 0.2, z], [0, 0, -Math.sign(z)]),
      );
    front.side = THREE.FrontSide;
    back.side = THREE.BackSide;
  }
});

test("barycentric normal interpolation, zero-normal geometric fallback, and world-unit ray distances", () => {
  const acceleration = createSurfaceAcceleration();
  const t = triangle(0),
    normals: SurfaceVec3[] = [
      [1, 0, 1],
      [0, 1, 1],
      [0, 0, 1],
    ];
  const snapshot = sceneOf([
    {
      ...t,
      vertices: t.vertices.map((v, i) => ({
        ...v,
        normal: normals[i],
      })) as unknown as SurfaceTriangle["vertices"],
    },
  ]);
  acceleration.update(snapshot);
  const hit = acceleration.intersect([0.25, 0.25, 6], [0, 0, -90])!;
  assert.equal(hit.distance, 6);
  nearVec(hit.barycentric, [0.5, 0.25, 0.25]);
  nearVec(
    hit.normal,
    new THREE.Vector3(0.5, 0.25, 1)
      .normalize()
      .toArray() as unknown as SurfaceVec3,
  );
  compare(hit, brute(snapshot, [0.25, 0.25, 6], [0, 0, -90]));
  acceleration.update(
    sceneOf([
      {
        ...t,
        vertices: t.vertices.map((v) => ({
          ...v,
          normal: [0, 0, 0] as SurfaceVec3,
        })) as unknown as SurfaceTriangle["vertices"],
      },
    ]),
  );
  nearVec(
    acceleration.intersect([0.25, 0.25, 1], [0, 0, -1])!.normal,
    [0, 0, 1],
  );
});

test("ray slab parallel axes, inside bounds, edges, inclusive distance/Infinity and extreme direction scales", () => {
  const acceleration = createSurfaceAcceleration(),
    snapshot = extractSurfaceScene(
      setup(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
      ).scene,
    );
  acceleration.update(snapshot);
  compare(
    acceleration.intersect([0, 0, 0], [1, 0, 0]),
    brute(snapshot, [0, 0, 0], [1, 0, 0]),
  );
  assert.equal(acceleration.intersect([2, 0, 0], [0, 1, 0]), null);
  assert.equal(acceleration.intersect([0, 0, 5], [0, 0, -1], 3.999), null);
  assert.equal(acceleration.intersect([0, 0, 5], [0, 0, -1], 4)!.distance, 4);
  assert.equal(
    acceleration.intersect([0, 0, 5], [0, 0, -1], Infinity)!.distance,
    4,
  );
  assert.equal(acceleration.intersect([1, 0, 0], [-1, 0, 0], 0)!.distance, 0);
  for (const scale of [Number.MIN_VALUE, 1e-300, 1e300, Number.MAX_VALUE])
    assert.equal(
      acceleration.intersect([0, 0, 5], [0, 0, -scale])!.distance,
      4,
    );
  assert.ok(
    acceleration.intersect(
      [5, 5, 5],
      [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
    ),
  );
  compare(
    acceleration.intersect([1, 1, 5], [0, -0, -1]),
    brute(snapshot, [1, 1, 5], [0, -0, -1]),
  );
});

test("invalid rays and maxDistance have stable codes, including empty accelerations", () => {
  const acceleration = createSurfaceAcceleration();
  for (const direction of [
    [0, 0, 0],
    [NaN, 0, 1],
    [Infinity, 0, 1],
  ] as SurfaceVec3[])
    assert.throws(() => acceleration.intersect([0, 0, 0], direction), {
      code: "TC_ACCELERATION_INVALID_RAY",
    });
  assert.throws(() => acceleration.intersect([NaN, 0, 0], [0, 0, 1]), {
    code: "TC_ACCELERATION_INVALID_RAY",
  });
  for (const max of [-1, NaN, -Infinity])
    assert.throws(() => acceleration.intersect([0, 0, 0], [0, 0, 1], max), {
      code: "TC_ACCELERATION_INVALID_DISTANCE",
    });
  assert.equal(acceleration.intersect([0, 0, 0], [0, 0, 1], Infinity), null);
});

test("seeded randomized CPU ray comparisons remain correlated through refit/reorder/material updates", () => {
  for (const seed of [1, 0x12345678, 0xdeadbeef]) {
    let state = seed >>> 0;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const materials = ["front", "back", "double"].map((side, i) => ({
      ...templateScene.materials[0],
      uuid: "m" + i,
      side: side as "front" | "back" | "double",
    }));
    let snapshot = sceneOf(
      Array.from({ length: 79 }, (_, i) => {
        const t = triangle(
          i,
          random() * 16 - 8,
          random() * 16 - 8,
          random() * 8 - 4,
        );
        return {
          ...t,
          materialUuid: materials[i % 3].uuid,
          normalMatrix:
            i % 5 === 0 ? [-1, 0, 0, 0, 1, 0, 0, 0, 1] : t.normalMatrix,
          vertices: t.vertices.map((v, j) => ({
            ...v,
            position: [
              v.position[0] + (j === 1 ? random() : 0),
              v.position[1] + (j === 2 ? random() : 0),
              v.position[2] + (j ? random() - 0.5 : 0),
            ],
            normal: [random() - 0.5, random() - 0.5, random() + 0.1],
          })) as unknown as SurfaceTriangle["vertices"],
        };
      }),
      { ...templateScene, materials },
    );
    const acceleration = createSurfaceAcceleration();
    for (let generation = 0; generation < 4; generation++) {
      const frame = acceleration.update(snapshot);
      verifyTree(frame, snapshot);
      assert.equal(frame.changes.kind, generation === 0 ? "rebuild" : "refit");
      for (let i = 0; i < 250; i++) {
        const target =
          snapshot.triangles[i % snapshot.triangles.length].vertices;
        const center = new THREE.Vector3();
        target.forEach((v) =>
          center.addScaledVector(new THREE.Vector3(...v.position), 1 / 3),
        );
        const origin: SurfaceVec3 = [
          random() * 24 - 12,
          random() * 24 - 12,
          random() * 20 - 10,
        ];
        const direction = (i % 4
          ? center.sub(new THREE.Vector3(...origin))
          : new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5)
        ).toArray() as unknown as SurfaceVec3;
        const max = i % 7 === 0 ? random() * 10 : Infinity;
        compare(
          acceleration.intersect(origin, direction, max),
          brute(snapshot, origin, direction, max),
        );
      }
      snapshot = sceneOf(
        [...snapshot.triangles]
          .reverse()
          .map((t) =>
            moved(t, [random() - 0.5, random() - 0.5, random() - 0.5]),
          ),
        {
          ...snapshot,
          materials: snapshot.materials.map((m) => ({
            ...m,
            roughness: random(),
          })),
        },
      );
    }
    assert.equal(acceleration.inspect().rebuilds, 1);
    assert.equal(acceleration.inspect().refits, 3);
  }
});

test("input stays deeply immutable; old generations, mutable copies and transferred buffers cannot corrupt cache", () => {
  const acceleration = createSurfaceAcceleration(),
    snapshot = sceneOf(Array.from({ length: 9 }, (_, i) => triangle(i)));
  const text = JSON.stringify(snapshot),
    first = acceleration.update(snapshot),
    savedNodes = first.nodes.slice(),
    savedSources = first.sourceIndices.slice();
  const second = acceleration.update(
    sceneOf(snapshot.triangles.map((t) => moved(t, [0, 0, -3]))),
  );
  const cachedRanges = acceleration.inspect().changes.nodeRanges;
  // nodeRanges keeps the fixed mutable-array API but is also caller-owned.
  second.changes.nodeRanges[0].count = 999;
  second.changes.nodeRanges.push({ offset: 999, count: 999 });
  assert.deepEqual(acceleration.inspect().changes.nodeRanges, cachedRanges);
  assert.deepEqual(first.nodes, savedNodes);
  assert.deepEqual(first.sourceIndices, savedSources);
  assert.equal(JSON.stringify(snapshot), text);
  first.nodes.fill(NaN);
  first.sourceIndices.fill(999);
  second.nodes.fill(NaN);
  second.sourceIndices.fill(999);
  assert.equal(acceleration.intersect([0.2, 0.2, 2], [0, 0, -1])!.distance, 5);
  const third = acceleration.update(
    sceneOf(snapshot.triangles.map((t) => moved(t, [0, 0, -3]))),
  );
  assert.equal(third.changes.kind, "none");
  assert.ok(third.nodes.every(Number.isFinite));
  structuredClone(third.nodes, {
    transfer: [third.nodes.buffer as ArrayBuffer],
  });
  structuredClone(third.sourceIndices, {
    transfer: [third.sourceIndices.buffer as ArrayBuffer],
  });
  assert.equal(third.nodes.byteLength, 0);
  assert.equal(third.sourceIndices.byteLength, 0);
  assert.equal(acceleration.intersect([0.2, 0.2, 2], [0, 0, -1])!.distance, 5);
  const inspected = acceleration.inspect();
  (inspected.metrics as { depth: number }).depth = 999;
  assert.notEqual(acceleration.inspect().metrics.depth, 999);
  assert.ok(Object.isFrozen(first.orderedTriangles));
  assert.ok(Object.isFrozen(first.orderedTriangles[0]));
});

test("finite anisotropic normal matrices retain determinant sign without an artificial scale limit", () => {
  const acceleration = createSurfaceAcceleration(),
    t = triangle(0);
  const mirrored = sceneOf([
    {
      ...t,
      normalMatrix: [-1e240, 0, 0, 0, 1, 0, 0, 0, 1],
      vertices: t.vertices.map((v) => ({
        ...v,
        position: [-v.position[0], v.position[1], v.position[2]],
      })) as unknown as SurfaceTriangle["vertices"],
    },
  ]);
  acceleration.update(mirrored);
  assert.equal(acceleration.intersect([-0.2, 0.2, 1], [0, 0, -1])!.distance, 1);
  assert.equal(acceleration.intersect([-0.2, 0.2, -1], [0, 0, 1]), null);
});

test("NaN, degeneracy, duplicate identities, singular transforms and invalid materials reject atomically", () => {
  const acceleration = createSurfaceAcceleration(),
    snapshot = sceneOf([triangle(0)]);
  acceleration.update(snapshot);
  const inspection = acceleration.inspect(),
    hit = acceleration.intersect([0.2, 0.2, 1], [0, 0, -1]);
  const t = snapshot.triangles[0];
  const invalid: SurfaceScene[] = [
    sceneOf([
      {
        ...t,
        vertices: t.vertices.map((v, i) =>
          i === 0 ? { ...v, position: [NaN, 0, 0] } : v,
        ) as unknown as SurfaceTriangle["vertices"],
      },
    ]),
    sceneOf([
      { ...t, vertices: [t.vertices[0], t.vertices[0], t.vertices[2]] },
    ]),
    sceneOf([t, t]),
    sceneOf([{ ...t, normalMatrix: Array(9).fill(0) }]),
    sceneOf([{ ...t, materialUuid: "missing" }]),
    sceneOf([t], {
      ...snapshot,
      materials: [{ ...snapshot.materials[0], roughness: Infinity }],
    }),
    sceneOf([
      {
        ...t,
        vertices: t.vertices.map((v) => ({
          ...v,
          position: [Number.MAX_VALUE, v.position[1], 0],
        })) as unknown as SurfaceTriangle["vertices"],
      },
    ]),
    sceneOf([{ ...t, vertexIndices: [-1, 1, 2] }]),
  ];
  for (const bad of invalid) {
    assert.throws(
      () => acceleration.update(bad),
      (error: unknown) =>
        error instanceof SurfaceAccelerationError &&
        error.code.startsWith("TC_ACCELERATION_"),
    );
    assert.deepEqual(acceleration.inspect(), inspection);
    assert.deepEqual(acceleration.intersect([0.2, 0.2, 1], [0, 0, -1]), hit);
  }
  assert.equal(acceleration.update(snapshot).changes.kind, "none");
});

test("empty transitions and disposal preserve published frames and reject subsequent operations", () => {
  const acceleration = createSurfaceAcceleration(),
    empty = sceneOf([]);
  assert.equal(acceleration.intersect([0, 0, 0], [1, 0, 0]), null);
  const first = acceleration.update(empty);
  verifyTree(first, empty);
  assert.equal(first.changes.kind, "rebuild");
  const cached = acceleration.update(empty);
  assert.equal(cached.changes.kind, "none");
  assert.equal(cached.revision, first.revision);
  const full = acceleration.update(sceneOf([triangle(0)])),
    saved = full.nodes.slice();
  const removed = acceleration.update(empty);
  assert.equal(removed.changes.kind, "rebuild");
  assert.equal(removed.sourceIndices.length, 0);
  assert.deepEqual(removed.changes.nodeRanges, []);
  acceleration.dispose();
  acceleration.dispose();
  assert.deepEqual(full.nodes, saved);
  for (const action of [
    () => acceleration.update(empty),
    () => acceleration.intersect([0, 0, 0], [1, 0, 0]),
    () => acceleration.inspect(),
  ])
    assert.throws(action, { code: "TC_ACCELERATION_DISPOSED" });
});

test("131073 coincident-centroid triangles have median-bounded depth and no fixed traversal stack limit", () => {
  const count = 131073,
    triangles = Array.from({ length: count }, (_, i) => ({
      ...template,
      elementOffset: i * 3,
    }));
  const snapshot = sceneOf(triangles),
    acceleration = createSurfaceAcceleration(),
    frame = acceleration.update(snapshot);
  assert.ok(frame.metrics.depth <= Math.ceil(Math.log2(count)) + 1);
  verifyTree(frame, snapshot);
  assert.equal(
    acceleration.intersect([0.2, 0.2, 1], [0, 0, -1])!.triangleIndex,
    0,
  );
  const next = sceneOf(triangles.map((t) => moved(t, [0, 0, -1]))),
    refitted = acceleration.update(next);
  assert.equal(refitted.changes.kind, "refit");
  assert.deepEqual(pointers(refitted), pointers(frame));
  verifyTree(refitted, next);
  assert.equal(acceleration.intersect([0.2, 0.2, 1], [0, 0, -1])!.distance, 2);
  assert.equal(acceleration.inspect().rebuilds, 1);
});
