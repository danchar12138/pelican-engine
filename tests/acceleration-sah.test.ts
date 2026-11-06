import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createSurfaceAcceleration,
  SurfaceAccelerationError,
  type AccelerationFrame,
} from "../packages/renderer/src/acceleration.ts";
import {
  extractSurfaceScene,
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
const geometry = new THREE.BufferGeometry();
geometry.setAttribute(
  "position",
  new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
);
const root = new THREE.Scene();
root.add(
  new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
  ),
);
const base = extractSurfaceScene(root),
  template = base.triangles[0];
function triangle(
  index: number,
  positions: readonly SurfaceVec3[],
): SurfaceTriangle {
  const vertices = positions.map((p) => new THREE.Vector3(...p));
  const normal = new THREE.Triangle(
    ...(vertices as [THREE.Vector3, THREE.Vector3, THREE.Vector3]),
  )
    .getNormal(new THREE.Vector3())
    .toArray() as unknown as SurfaceVec3;
  return {
    ...template,
    objectUuid: "sah-object",
    geometryUuid: "sah-geometry",
    elementOffset: index * 3,
    vertices: positions.map((position) => ({
      position,
      normal,
    })) as unknown as SurfaceTriangle["vertices"],
  };
}
function sceneOf(triangles: readonly SurfaceTriangle[]): SurfaceScene {
  return freeze({ ...base, triangles });
}
function random(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function translate(t: SurfaceTriangle, delta: SurfaceVec3): SurfaceTriangle {
  return {
    ...t,
    vertices: t.vertices.map((v) => ({
      ...v,
      position: v.position.map(
        (p, axis) => p + delta[axis],
      ) as unknown as SurfaceVec3,
    })) as unknown as SurfaceTriangle["vertices"],
  };
}
function smallTriangle(
  index: number,
  center: SurfaceVec3,
  size: number,
  rng: () => number,
): SurfaceTriangle {
  const [x, y, z] = center,
    tilt = (rng() - 0.5) * size;
  return triangle(index, [
    [x - size, y - size, z],
    [x + size, y - size, z + tilt],
    [x, y + size, z - tilt],
  ]);
}

const SCENES = [
  { name: "clusters", seed: 0x51a7c001 },
  { name: "wide-walls", seed: 0x51a7c002 },
  { name: "bottle-cloud-remotes", seed: 0x51a7c003 },
] as const;
function representativeScene(
  name: (typeof SCENES)[number]["name"],
  seed: number,
): SurfaceScene {
  const rng = random(seed),
    triangles: SurfaceTriangle[] = [];
  const addSmall = (center: SurfaceVec3, size: number) =>
    triangles.push(smallTriangle(triangles.length, center, size, rng));
  if (name === "clusters") {
    // Deliberately unequal populations and diagonal/separated clusters.
    const centers: SurfaceVec3[] = [
      [-18, -4, 0],
      [-17, 5, 1],
      [0, 0, 0],
      [2, 7, -3],
      [18, -2, 2],
    ];
    const counts = [128, 192, 384, 128, 64];
    centers.forEach((center, k) => {
      for (let i = 0; i < counts[k]; i++)
        addSmall(
          center.map((p) => p + (rng() - 0.5) * 1.8) as unknown as SurfaceVec3,
          0.04 + rng() * 0.16,
        );
    });
  } else if (name === "wide-walls") {
    // 64 broad background triangles behind 1024 small foreground triangles.
    for (let i = 0; i < 32; i++) {
      const z = -4 - i * 0.08;
      triangles.push(
        triangle(triangles.length, [
          [-24, -6, z],
          [24, -6, z],
          [24, 6, z],
        ]),
      );
      triangles.push(
        triangle(triangles.length, [
          [-24, -6, z],
          [24, 6, z],
          [-24, 6, z],
        ]),
      );
    }
    for (let i = 0; i < 1024; i++) {
      const cluster = i % 16;
      addSmall(
        [
          -15 + (cluster % 4) * 10 + (rng() - 0.5) * 2,
          -2 + Math.floor(cluster / 4) * 1.4 + (rng() - 0.5),
          1 + rng() * 6,
        ],
        0.06 + rng() * 0.2,
      );
    }
  } else {
    // A dense lathed bottle surface, with small satellites far from the body.
    const point = (ring: number, sector: number): SurfaceVec3 => {
      const h = ring / 48,
        angle = (sector / 48) * Math.PI * 2;
      const radius =
        h < 0.65
          ? 1 + 0.08 * Math.sin(h * 8)
          : h < 0.82
            ? 1 - ((h - 0.65) / 0.17) * 0.65
            : 0.35;
      return [Math.cos(angle) * radius, h * 4 - 2, Math.sin(angle) * radius];
    };
    for (let ring = 0; ring < 48; ring++)
      for (let sector = 0; sector < 48; sector++) {
        const a = point(ring, sector),
          b = point(ring, sector + 1),
          c = point(ring + 1, sector),
          d = point(ring + 1, sector + 1);
        triangles.push(triangle(triangles.length, [a, b, d]));
        triangles.push(triangle(triangles.length, [a, d, c]));
      }
    for (let i = 0; i < 32; i++) {
      const x = (i % 2 ? -1 : 1) * (7 + rng() * 3),
        y = (rng() - 0.5) * 8,
        z = (rng() - 0.5) * 8,
        s = 0.05 + rng() * 0.15;
      const p: SurfaceVec3[] = [
        [x, y + s, z],
        [x - s, y - s, z + s],
        [x + s, y - s, z + s],
        [x, y - s, z - s],
      ];
      for (const face of [
        [0, 1, 2],
        [0, 2, 3],
        [0, 3, 1],
        [1, 3, 2],
      ])
        triangles.push(
          triangle(
            triangles.length,
            face.map((i) => p[i]),
          ),
        );
    }
  }
  return sceneOf(triangles);
}

type Tree = Pick<AccelerationFrame, "nodes" | "sourceIndices">;
// Independent, test-only recreation of the previous longest-centroid-axis median.
// Both trees are traversed by the same counter; production build/intersect is not
// called to construct the reference. Round reference bounds outward as well.
function outward(value: number, lower: boolean): number {
  const f = new Float32Array([value]);
  if (lower ? f[0] > value : f[0] < value) {
    if (f[0] === 0) return lower ? -(2 ** -149) : 2 ** -149;
    const bits = new Uint32Array(f.buffer);
    bits[0] += f[0] > 0 === lower ? -1 : 1;
  }
  return f[0];
}
function medianReferenceBuild(scene: SurfaceScene): Tree {
  const data: number[] = [],
    sources: number[] = [];
  const centers = scene.triangles.map((t) =>
    [0, 1, 2].map((axis) =>
      t.vertices.reduce((sum, v) => sum + v.position[axis] / 3, 0),
    ),
  );
  function build(indices: number[]): number {
    const index = data.length / 8,
      bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const source of indices)
      for (const vertex of scene.triangles[source].vertices)
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis] = Math.min(bounds[axis], vertex.position[axis]);
          bounds[axis + 3] = Math.max(bounds[axis + 3], vertex.position[axis]);
        }
    data.push(
      ...bounds.slice(0, 3).map((v) => outward(v, true)),
      0,
      ...bounds.slice(3).map((v) => outward(v, false)),
      0,
    );
    if (indices.length <= 4) {
      data[index * 8 + 3] = sources.length;
      data[index * 8 + 7] = indices.length;
      sources.push(...indices);
    } else {
      const spans = [0, 1, 2].map((axis) => {
        let lo = Infinity,
          hi = -Infinity;
        for (const source of indices) {
          lo = Math.min(lo, centers[source][axis]);
          hi = Math.max(hi, centers[source][axis]);
        }
        return hi - lo;
      });
      let axis = 0;
      for (let k = 1; k < 3; k++) if (spans[k] > spans[axis]) axis = k;
      indices.sort((a, b) => centers[a][axis] - centers[b][axis] || a - b);
      const middle = Math.floor(indices.length / 2);
      data[index * 8 + 3] = build(indices.slice(0, middle));
      data[index * 8 + 7] = -build(indices.slice(middle));
    }
    return index;
  }
  if (scene.triangles.length) build(scene.triangles.map((_, i) => i));
  return {
    nodes: Float32Array.from(data),
    sourceIndices: Uint32Array.from(sources),
  };
}

// Explicitly check the contiguous preorder contract required by escape packing.
function verifyTree(frame: AccelerationFrame, scene: SurfaceScene): void {
  const { nodes, sourceIndices } = frame;
  assert.equal(nodes.length, frame.metrics.nodes * 8);
  assert.equal(sourceIndices.length, scene.triangles.length);
  assert.equal(frame.orderedTriangles.length, scene.triangles.length);
  const slots = new Set<number>(),
    sources = new Set<number>(),
    subtreeCounts = new Uint32Array(nodes.length / 8);
  let measuredDepth = 0;
  function visit(index: number, level: number, expectedEscape: number): number {
    const offset = index * 8,
      count = nodes[offset + 7];
    assert.ok(
      Number.isInteger(index) && offset >= 0 && offset + 8 <= nodes.length,
    );
    assert.ok(nodes.subarray(offset, offset + 8).every(Number.isFinite));
    measuredDepth = Math.max(measuredDepth, level);
    if (count > 0) {
      const start = nodes[offset + 3];
      assert.ok(
        Number.isInteger(start) && Number.isInteger(count) && count <= 4,
      );
      for (let slot = start; slot < start + count; slot++) {
        assert.ok(slot < sourceIndices.length && !slots.has(slot));
        slots.add(slot);
        const source = sourceIndices[slot];
        assert.ok(source < scene.triangles.length && !sources.has(source));
        sources.add(source);
        assert.equal(frame.orderedTriangles[slot], scene.triangles[source]);
        for (const v of scene.triangles[source].vertices)
          for (let axis = 0; axis < 3; axis++)
            assert.ok(
              v.position[axis] >= nodes[offset + axis] &&
                v.position[axis] <= nodes[offset + 4 + axis],
            );
      }
      subtreeCounts[index] = count;
      assert.equal(index + 1, expectedEscape, "leaf escape");
      return index + 1;
    }
    const left = nodes[offset + 3],
      right = -count;
    assert.equal(left, index + 1, "left must immediately follow parent");
    assert.ok(Number.isInteger(right) && right > left);
    assert.equal(
      visit(left, level + 1, right),
      right,
      "left subtree end must equal right",
    );
    const escape = visit(right, level + 1, expectedEscape);
    assert.equal(
      escape,
      expectedEscape,
      "right subtree end must equal parent escape",
    );
    subtreeCounts[index] = subtreeCounts[left] + subtreeCounts[right];
    const minimumSide = Math.ceil(subtreeCounts[index] / 32);
    assert.ok(
      subtreeCounts[left] >= minimumSide && subtreeCounts[right] >= minimumSide,
      "every split obeys the balance guard",
    );
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(
        nodes[offset + axis],
        Math.min(nodes[left * 8 + axis], nodes[right * 8 + axis]),
      );
      assert.equal(
        nodes[offset + 4 + axis],
        Math.max(nodes[left * 8 + 4 + axis], nodes[right * 8 + 4 + axis]),
      );
    }
    return escape;
  }
  if (nodes.length)
    assert.equal(
      visit(0, 1, nodes.length / 8),
      nodes.length / 8,
      "root escape",
    );
  assert.equal(measuredDepth, frame.metrics.depth);
  const depthLimit =
    2 *
      Math.ceil(Math.log2(Math.max(1, Math.ceil(scene.triangles.length / 4)))) +
    1;
  assert.ok(measuredDepth <= depthLimit);
  assert.equal(slots.size, scene.triangles.length);
  assert.equal(sources.size, scene.triangles.length);
}
function pointers(frame: AccelerationFrame): number[] {
  return Array.from(frame.nodes).filter((_, i) => i % 8 === 3 || i % 8 === 7);
}
type Ray = { origin: SurfaceVec3; direction: SurfaceVec3; limit: number };
type Hit = { triangleIndex: number; distance: number } | null;
type Cost = { rayBoxTests: number; triangleTests: number };
function prepared(
  scene: SurfaceScene,
): [THREE.Vector3, THREE.Vector3, THREE.Vector3][] {
  return scene.triangles.map(
    (t) =>
      t.vertices.map((v) => new THREE.Vector3(...v.position)) as [
        THREE.Vector3,
        THREE.Vector3,
        THREE.Vector3,
      ],
  );
}
function rayAt(
  origin: SurfaceVec3,
  target: SurfaceVec3,
  limit = Infinity,
): Ray {
  return {
    origin,
    direction: new THREE.Vector3(...target)
      .sub(new THREE.Vector3(...origin))
      .normalize()
      .toArray() as unknown as SurfaceVec3,
    limit,
  };
}
function raysFor(scene: SurfaceScene, seed: number, count: number): Ray[] {
  const rng = random(seed ^ 0x6a09e667),
    rays: Ray[] = [];
  for (let i = 0; i < count; i++) {
    const t = scene.triangles[Math.floor(rng() * scene.triangles.length)],
      u = 0.2 + rng() * 0.2,
      v = 0.2 + rng() * 0.2;
    const target = [0, 1, 2].map(
      (axis) =>
        t.vertices[0].position[axis] * (1 - u - v) +
        t.vertices[1].position[axis] * u +
        t.vertices[2].position[axis] * v,
    ) as unknown as SurfaceVec3;
    // Front/back/side camera rays, interior secondary rays and uncorrelated rays.
    const origin: SurfaceVec3 =
      i % 4 === 0
        ? [0, 0, 0]
        : i % 4 === 1
          ? [(rng() - 0.5) * 48, (rng() - 0.5) * 16, 24]
          : i % 4 === 2
            ? [24, (rng() - 0.5) * 16, (rng() - 0.5) * 24]
            : [(rng() - 0.5) * 48, (rng() - 0.5) * 16, -24];
    rays.push(
      rayAt(
        origin,
        i % 5 === 0
          ? [(rng() - 0.5) * 60, (rng() - 0.5) * 24, (rng() - 0.5) * 32]
          : target,
        i % 7 === 0 ? 8 : Infinity,
      ),
    );
  }
  return rays;
}
function boxNear(
  nodes: Float32Array,
  index: number,
  ray: Ray,
  limit: number,
  cost: Cost,
): number {
  cost.rayBoxTests++;
  let near = 0,
    far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const lo = nodes[index * 8 + axis],
      hi = nodes[index * 8 + axis + 4],
      d = ray.direction[axis],
      o = ray.origin[axis];
    if (d === 0) {
      if (o < lo || o > hi) return Infinity;
    } else {
      const a = (lo - o) / d,
        b = (hi - o) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return Infinity;
    }
  }
  return near;
}
function intersectTriangle(
  ray: THREE.Ray,
  vertices: [THREE.Vector3, THREE.Vector3, THREE.Vector3],
  point: THREE.Vector3,
): number | null {
  return ray.intersectTriangle(...vertices, false, point)
    ? point.distanceTo(ray.origin)
    : null;
}
function traverse(
  tree: Tree,
  vertices: ReturnType<typeof prepared>,
  ray: Ray,
  nearFirst: boolean,
  cost: Cost,
): Hit {
  const threeRay = new THREE.Ray(
      new THREE.Vector3(...ray.origin),
      new THREE.Vector3(...ray.direction),
    ),
    point = new THREE.Vector3();
  let best: Hit = null,
    limit = ray.limit;
  const stack = tree.nodes.length
    ? [
        {
          index: 0,
          near: nearFirst ? boxNear(tree.nodes, 0, ray, limit, cost) : 0,
        },
      ]
    : [];
  while (stack.length) {
    const entry = stack.pop()!,
      { index } = entry;
    const near = nearFirst
      ? entry.near
      : boxNear(tree.nodes, index, ray, limit, cost);
    if (near === Infinity || near > limit) continue;
    const offset = index * 8,
      count = tree.nodes[offset + 7];
    if (count > 0) {
      const start = tree.nodes[offset + 3];
      for (let slot = start; slot < start + count; slot++) {
        cost.triangleTests++;
        const source = tree.sourceIndices[slot],
          distance = intersectTriangle(threeRay, vertices[source], point);
        if (
          distance !== null &&
          distance <= limit &&
          (!best ||
            distance < best.distance ||
            (distance === best.distance && source < best.triangleIndex))
        ) {
          best = { triangleIndex: source, distance };
          limit = distance;
        }
      }
    } else {
      const left = { index: tree.nodes[offset + 3], near: 0 },
        right = { index: -count, near: 0 };
      if (nearFirst) {
        left.near = boxNear(tree.nodes, left.index, ray, limit, cost);
        right.near = boxNear(tree.nodes, right.index, ray, limit, cost);
        if (left.near > right.near) stack.push(left, right);
        else stack.push(right, left);
      } else stack.push(right, left);
    }
  }
  return best;
}
function brute(vertices: ReturnType<typeof prepared>, ray: Ray): Hit {
  const threeRay = new THREE.Ray(
      new THREE.Vector3(...ray.origin),
      new THREE.Vector3(...ray.direction),
    ),
    point = new THREE.Vector3();
  let best: Hit = null;
  vertices.forEach((v, source) => {
    const distance = intersectTriangle(threeRay, v, point);
    if (
      distance !== null &&
      distance <= ray.limit &&
      (!best ||
        distance < best.distance ||
        (distance === best.distance && source < best.triangleIndex))
    )
      best = { triangleIndex: source, distance };
  });
  return best;
}
function sameHit(actual: Hit, expected: Hit): void {
  if (!actual || !expected) {
    assert.equal(actual, expected);
    return;
  }
  assert.equal(actual.triangleIndex, expected.triangleIndex);
  assert.ok(
    Math.abs(actual.distance - expected.distance) <=
      1e-8 * Math.max(1, expected.distance),
  );
}

for (const definition of SCENES) {
  test("SAH raw geometric traversal cost: " + definition.name, (t) => {
    const scene = representativeScene(definition.name, definition.seed),
      vertices = prepared(scene),
      rays = raysFor(scene, definition.seed, 1536);
    const acceleration = createSurfaceAcceleration(),
      frame = acceleration.update(scene);
    verifyTree(frame, scene);
    const second = createSurfaceAcceleration().update(
      representativeScene(definition.name, definition.seed),
    );
    assert.deepEqual(frame.nodes, second.nodes);
    assert.deepEqual(frame.sourceIndices, second.sourceIndices);
    const started = performance.now(),
      median = medianReferenceBuild(scene),
      medianBuildMs = performance.now() - started;
    const samples = [];
    for (const nearFirst of [false, true]) {
      const sahCost: Cost = { rayBoxTests: 0, triangleTests: 0 },
        medianCost: Cost = { rayBoxTests: 0, triangleTests: 0 };
      let hits = 0;
      for (const ray of rays) {
        const expected = traverse(median, vertices, ray, nearFirst, medianCost),
          actual = traverse(frame, vertices, ray, nearFirst, sahCost);
        sameHit(actual, expected);
        if (actual) hits++;
      }
      const sahTotal = sahCost.rayBoxTests + sahCost.triangleTests,
        medianTotal = medianCost.rayBoxTests + medianCost.triangleTests;
      assert.ok(hits > 0 && hits < rays.length);
      // Behavioural geometric work only, no machine/time dependent threshold.
      assert.ok(
        sahTotal < medianTotal,
        JSON.stringify({
          scene: definition.name,
          nearFirst,
          sahCost,
          medianCost,
        }),
      );
      samples.push({
        order: nearFirst ? "near-first" : "left-first",
        hits,
        sah: { ...sahCost, total: sahTotal },
        median: { ...medianCost, total: medianTotal },
        ratio: sahTotal / medianTotal,
      });
    }
    const deformed = sceneOf(
      scene.triangles.map((tri, i) =>
        i % 5 === 0 ? translate(tri, [0.1, -0.05, 0.03]) : tri,
      ),
    );
    const refitted = acceleration.update(deformed);
    assert.equal(refitted.changes.kind, "refit");
    assert.deepEqual(pointers(frame), pointers(refitted));
    verifyTree(refitted, deformed);
    assert.ok(
      Number.isFinite(frame.metrics.buildMs) &&
        Number.isFinite(refitted.metrics.refitMs),
    );
    t.diagnostic(
      JSON.stringify({
        scene: definition.name,
        seed: definition.seed,
        raysSeed: (definition.seed ^ 0x6a09e667) >>> 0,
        rays: rays.length,
        triangles: scene.triangles.length,
        sahNodes: frame.metrics.nodes,
        sahDepth: frame.metrics.depth,
        medianNodes: median.nodes.length / 8,
        buildMs: frame.metrics.buildMs,
        refitMs: refitted.metrics.refitMs,
        medianBuildMs,
        samples,
      }),
    );
    acceleration.dispose();
  });
  test(
    "random rays vs brute force across reorder/refit: " + definition.name,
    () => {
      const scene = representativeScene(definition.name, definition.seed),
        acceleration = createSurfaceAcceleration(),
        first = acceleration.update(scene);
      const reordered = sceneOf([...scene.triangles].reverse()),
        second = acceleration.update(reordered);
      assert.equal(second.changes.kind, "materials");
      assert.deepEqual(first.nodes, second.nodes);
      assert.deepEqual(first.orderedTriangles, second.orderedTriangles);
      assert.deepEqual(
        Array.from(second.sourceIndices),
        Array.from(first.sourceIndices, (i) => scene.triangles.length - 1 - i),
      );
      const thirdScene = sceneOf(
          reordered.triangles.map((tri, i) =>
            translate(tri, [i % 2 ? -3.25 : 2.125, 0.03125, -0.0625]),
          ),
        ),
        third = acceleration.update(thirdScene);
      assert.equal(third.changes.kind, "refit");
      assert.equal(third.topologyRevision, first.topologyRevision);
      assert.deepEqual(pointers(third), pointers(first));
      assert.deepEqual(third.sourceIndices, second.sourceIndices);
      verifyTree(third, thirdScene);
      for (const current of [scene, reordered, thirdScene]) {
        acceleration.update(current);
        const vertices = prepared(current),
          median = medianReferenceBuild(current);
        for (const ray of raysFor(current, definition.seed ^ 0x9e3779b9, 192)) {
          const expected = brute(vertices, ray);
          sameHit(
            acceleration.intersect(ray.origin, ray.direction, ray.limit),
            expected,
          );
          sameHit(
            traverse(median, vertices, ray, true, {
              rayBoxTests: 0,
              triangleTests: 0,
            }),
            expected,
          );
        }
      }
      acceleration.dispose();
    },
  );
}

test("all-axis area heuristic selects a shorter centroid axis when it separates broad sheets", () => {
  const triangles: SurfaceTriangle[] = [];
  for (let layer = 0; layer < 2; layer++)
    for (let i = 0; i < 32; i++) {
      const x = i - 16,
        z = layer * 8;
      triangles.push(
        triangle(triangles.length, [
          [x - 100, -1, z],
          [x + 100, -1, z],
          [x, 1, z],
        ]),
      );
    }
  const scene = sceneOf(triangles),
    frame = createSurfaceAcceleration().update(scene);
  verifyTree(frame, scene);
  // x centroid span 31 > z span 8, but area cost should separate the z layers.
  const right = -frame.nodes[7];
  assert.equal(frame.nodes[6], 8);
  assert.equal(frame.nodes[1 * 8 + 6], 0);
  assert.equal(frame.nodes[right * 8 + 2], 8);
});

test("coincident centroids and overlapping clusters retain all sources and deterministic balanced fallback", () => {
  const triangles = Array.from({ length: 4097 }, (_, i) => {
    const s = 0.1 + (i % 17) * 0.02;
    return triangle(i, [
      [-s, -s, 0],
      [s, -s, 0],
      [0, 2 * s, 0],
    ]);
  });
  const scene = sceneOf(triangles),
    a = createSurfaceAcceleration(),
    frame = a.update(scene);
  verifyTree(frame, scene);
  assert.ok(frame.metrics.depth <= Math.ceil(Math.log2(triangles.length)) + 1);
  assert.deepEqual(
    frame.nodes,
    createSurfaceAcceleration().update(scene).nodes,
  );
  sameHit(a.intersect([0, 0, 1], [0, 0, -1]), {
    triangleIndex: 0,
    distance: 1,
  });
  const overlapping = sceneOf(
      triangles.map((tri, i) =>
        translate(tri, [(i % 3) * 0.00001, 0, (i % 7) * 0.00001]),
      ),
    ),
    refitted = a.update(overlapping);
  assert.equal(refitted.changes.kind, "refit");
  assert.deepEqual(pointers(frame), pointers(refitted));
  verifyTree(refitted, overlapping);
});

test("planar/tiny bounds stay outward; true zero-area geometry still rejects atomically", () => {
  const scale = 1e-140;
  const scene = sceneOf(
    Array.from({ length: 65 }, (_, i) =>
      triangle(i, [
        [i * scale, 0, 0],
        [(i + 0.75) * scale, 0, 0],
        [i * scale, scale, 0],
      ]),
    ),
  );
  const acceleration = createSurfaceAcceleration(),
    frame = acceleration.update(scene);
  verifyTree(frame, scene);
  const before = acceleration.inspect(),
    tri = scene.triangles[0];
  assert.throws(
    () =>
      acceleration.update(
        sceneOf([
          {
            ...tri,
            vertices: [tri.vertices[0], tri.vertices[0], tri.vertices[0]],
          },
        ]),
      ),
    (e: unknown) =>
      e instanceof SurfaceAccelerationError &&
      e.code === "TC_ACCELERATION_DEGENERATE_TRIANGLE",
  );
  assert.deepEqual(acceleration.inspect(), before);
  assert.equal(acceleration.update(scene).changes.kind, "none");
});

test("exponentially spaced and highly unequal clusters obey the global depth budget without omissions", (t) => {
  const rng = random(0x51a7dead),
    triangles: SurfaceTriangle[] = [];
  for (let i = 0; i < 8193; i++) {
    const x = 2 ** (Math.floor(i / 64) - 64),
      s = x * 0.001;
    triangles.push(
      smallTriangle(i, [x, (i % 8) * s * 4, (i % 13) * s], s, rng),
    );
  }
  const scene = sceneOf(triangles),
    frame = createSurfaceAcceleration().update(scene);
  verifyTree(frame, scene);
  const budget = 2 * Math.ceil(Math.log2(Math.ceil(triangles.length / 4))) + 1;
  assert.ok(frame.metrics.depth <= budget);
  assert.equal(new Set(frame.sourceIndices).size, triangles.length);
  t.diagnostic(
    JSON.stringify({
      scene: "pathological-exponents",
      seed: 0x51a7dead,
      triangles: triangles.length,
      depth: frame.metrics.depth,
      depthLimit: budget,
    }),
  );
});

test("a rejected update retains previously memoized deeply frozen validation", () => {
  let ownKeys = 0;
  const normalMatrix = new Proxy([...template.normalMatrix], {
    ownKeys(target) {
      ownKeys++;
      return Reflect.ownKeys(target);
    },
  });
  const tri = {
    ...triangle(0, [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]),
    normalMatrix,
  };
  const snapshot = sceneOf([tri]),
    acceleration = createSurfaceAcceleration();
  acceleration.update(snapshot);
  const validatedKeys = ownKeys;
  assert.ok(validatedKeys > 0);
  const bad = {
    ...triangle(1, [
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
    ]),
    normalMatrix: [NaN, ...template.normalMatrix.slice(1)],
  };
  assert.throws(
    () => acceleration.update({ ...snapshot, triangles: [tri, bad] }),
    SurfaceAccelerationError,
  );
  assert.equal(ownKeys, validatedKeys);
  assert.equal(acceleration.update(snapshot).changes.kind, "none");
  assert.equal(
    ownKeys,
    validatedKeys,
    "failure must not reset previous frozen validation caches",
  );
});

test("mutable failures cannot publish partial SAH trees or clear prior validation/cache state", () => {
  const frozen = representativeScene("clusters", 0x51a7c001),
    acceleration = createSurfaceAcceleration();
  const first = acceleration.update(frozen),
    inspection = acceleration.inspect();
  const ray = raysFor(frozen, 43, 2)[1],
    hit = acceleration.intersect(ray.origin, ray.direction, ray.limit);
  const mutable = structuredClone(frozen);
  Object.assign(mutable.triangles[0].vertices[0].position, { 0: NaN });
  assert.throws(() => acceleration.update(mutable), SurfaceAccelerationError);
  assert.deepEqual(acceleration.inspect(), inspection);
  sameHit(acceleration.intersect(ray.origin, ray.direction, ray.limit), hit);
  assert.deepEqual(first.nodes, acceleration.update(frozen).nodes);
  const accepted = structuredClone(frozen);
  acceleration.update(accepted);
  const beforeMutation = acceleration.inspect();
  const originalZ = accepted.triangles[10].vertices[1].position[2];
  Object.assign(accepted.triangles[10].vertices[1].position, { 2: Infinity });
  assert.throws(() => acceleration.update(accepted), SurfaceAccelerationError);
  assert.deepEqual(acceleration.inspect(), beforeMutation);
  // Restore the caller-owned record before querying/reusing it: the API's
  // snapshots are immutable by contract, even though mutable inputs are validated.
  Object.assign(accepted.triangles[10].vertices[1].position, { 2: originalZ });
  const added = {
    ...structuredClone(frozen.triangles[0]),
    elementOffset: 999999,
  };
  Object.assign(added.vertices[0].position, { 1: Infinity });
  assert.throws(
    () =>
      acceleration.update({
        ...frozen,
        triangles: [...frozen.triangles, added],
      }),
    SurfaceAccelerationError,
  );
  assert.deepEqual(acceleration.inspect(), beforeMutation);
  assert.equal(acceleration.update(frozen).changes.kind, "none");
});
