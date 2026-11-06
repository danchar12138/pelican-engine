import type {
  SurfaceMaterial,
  SurfaceScene,
  SurfaceTriangle,
  SurfaceVec3,
} from "./surface.ts";
import { isFrozenCapturedPixels } from "./surface.ts";

export interface AccelerationFrame {
  readonly nodes: Float32Array;
  readonly sourceIndices: Uint32Array;
  readonly orderedTriangles: readonly SurfaceTriangle[];
  readonly revision: number;
  readonly topologyRevision: number;
  readonly changes: {
    readonly kind: "rebuild" | "refit" | "materials" | "none";
    /** Float element offsets/counts, aligned to complete eight-float nodes. */
    readonly nodeRanges: { offset: number; count: number }[];
  };
  readonly metrics: {
    readonly buildMs: number;
    readonly refitMs: number;
    readonly triangles: number;
    readonly nodes: number;
    readonly depth: number;
  };
}

export interface AccelerationHit {
  readonly distance: number;
  /** Index in the most recently accepted SurfaceScene, not the leaf order. */
  readonly triangleIndex: number;
  readonly barycentric: SurfaceVec3;
  readonly normal: SurfaceVec3;
}

/** A fresh JSON-serializable inspection value; no live buffers or scene objects. */
export interface AccelerationInspection {
  readonly revision: number;
  readonly topologyRevision: number;
  readonly changes: AccelerationFrame["changes"];
  readonly metrics: AccelerationFrame["metrics"];
  readonly updates: number;
  readonly rebuilds: number;
  readonly refits: number;
}

export interface SurfaceAcceleration {
  update(snapshot: SurfaceScene): AccelerationFrame;
  intersect(
    origin: SurfaceVec3,
    direction: SurfaceVec3,
    maxDistance?: number,
  ): AccelerationHit | null;
  inspect(): AccelerationInspection;
  dispose(): void;
}

export class SurfaceAccelerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(code + ": " + message);
    this.name = "SurfaceAccelerationError";
  }
}

function fail(code: string, message: string): never {
  throw new SurfaceAccelerationError("TC_ACCELERATION_" + code, message);
}

const LEAF_SIZE = 4;
const SAH_BINS = 16;
// Reject splits with fewer than ceil(N / 32) primitives on either side.
const SAH_BALANCE = 32;
const MAX_FLOAT = 3.4028234663852886e38;
// Numeric pointers in the fixed float layout must be exact integers.
const MAX_EXACT_POINTER = 2 ** 24;
const roundBuffer = new ArrayBuffer(4);
const roundFloat = new Float32Array(roundBuffer);
const roundBits = new Uint32Array(roundBuffer);

function outward(value: number, lower: boolean): number {
  const rounded = Math.fround(value);
  if (lower ? rounded <= value : rounded >= value) return rounded;
  if (rounded === 0) return lower ? -(2 ** -149) : 2 ** -149;
  roundFloat[0] = rounded;
  roundBits[0] += rounded > 0 === lower ? -1 : 1;
  return roundFloat[0];
}

function vector(
  value: unknown,
  length: number,
  label: string,
): asserts value is readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n))
  ) {
    fail(
      "INVALID_SNAPSHOT",
      label +
        " must contain " +
        length +
        " finite numbers; re-extract the surface",
    );
  }
}

function finiteData(
  value: unknown,
  label: string,
  validatedFrozenData: WeakSet<object>,
  visiting = new WeakSet<object>(),
): boolean {
  if (typeof value === "number" && !Number.isFinite(value))
    fail(
      "INVALID_SNAPSHOT",
      label + " contains a non-finite value; re-extract the surface",
    );
  if (value && typeof value === "object") {
    if (isFrozenCapturedPixels(value)) return true;
    if (validatedFrozenData.has(value)) return true;
    if (visiting.has(value))
      fail("INVALID_SNAPSHOT", label + " contains cyclic data.");
    visiting.add(value);
    // Frozen accessors can still return mutable/changing values; never memoize them.
    const prototype = Object.getPrototypeOf(value);
    let immutable =
      Object.isFrozen(value) &&
      (prototype === Object.prototype ||
        prototype === Array.prototype ||
        prototype === null);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) immutable = false;
      if (
        !finiteData(
          "value" in descriptor ? descriptor.value : Reflect.get(value, key),
          label + "." + String(key),
          validatedFrozenData,
          visiting,
        )
      )
        immutable = false;
    }
    visiting.delete(value);
    if (immutable) validatedFrozenData.add(value);
    return immutable;
  }
  return true;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aa = a as Record<string, unknown>,
    bb = b as Record<string, unknown>;
  const keys = Object.keys(aa);
  return (
    keys.length === Object.keys(bb).length &&
    keys.every((key) => Object.hasOwn(bb, key) && equal(aa[key], bb[key]))
  );
}

function identity(t: SurfaceTriangle): string {
  return JSON.stringify([
    t.objectUuid,
    t.geometryUuid,
    t.instanceId,
    t.groupIndex,
    t.elementOffset,
    t.vertexIndices,
  ]);
}

function orientation(t: SurfaceTriangle): number {
  const m = t.normalMatrix;
  // Column-major inverse transpose: determinant has the world transform's sign.
  // Scale columns independently so finite anisotropic matrices do not acquire
  // an artificial zero determinant from multiplying tiny common-scale ratios.
  const scales = [0, 3, 6].map((i) =>
    Math.max(Math.abs(m[i]), Math.abs(m[i + 1]), Math.abs(m[i + 2])),
  );
  if (scales.some((scale) => scale === 0)) return 0;
  const a = m.map((x, i) => x / scales[Math.floor(i / 3)]);
  return Math.sign(
    a[0] * (a[4] * a[8] - a[7] * a[5]) -
      a[3] * (a[1] * a[8] - a[7] * a[2]) +
      a[6] * (a[1] * a[5] - a[4] * a[2]),
  );
}

function cross(a: SurfaceVec3, b: SurfaceVec3): SurfaceVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function sub(a: SurfaceVec3, b: SurfaceVec3): SurfaceVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: SurfaceVec3, b: SurfaceVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function unit(a: SurfaceVec3): SurfaceVec3 | null {
  const scale = Math.max(...a.map(Math.abs));
  if (!scale || !Number.isFinite(scale)) return null;
  const v = a.map((x) => x / scale),
    length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function validate(
  snapshot: SurfaceScene,
  frozenData: WeakSet<object>,
  triangles: WeakSet<object>,
): {
  indices: Map<string, number>;
  materials: Map<string, SurfaceMaterial>;
} {
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.triangles) ||
    !Array.isArray(snapshot.materials) ||
    !Array.isArray(snapshot.textures) ||
    !Array.isArray(snapshot.diagnostics)
  )
    fail(
      "INVALID_SNAPSHOT",
      "Expected a version 1 SurfaceScene; re-extract the surface",
    );
  finiteData(snapshot, "snapshot", frozenData);
  const materials = new Map<string, SurfaceMaterial>();
  for (const m of snapshot.materials) {
    if (
      !m ||
      typeof m.uuid !== "string" ||
      materials.has(m.uuid) ||
      !["front", "back", "double"].includes(m.side)
    )
      fail(
        "INVALID_MATERIAL",
        "Material UUIDs must be unique and side must be front/back/double",
      );
    materials.set(m.uuid, m);
  }
  const indices = new Map<string, number>();
  snapshot.triangles.forEach((t, index) => {
    const label = "triangle " + index;
    if (
      !t ||
      typeof t.objectUuid !== "string" ||
      typeof t.geometryUuid !== "string" ||
      ![t.instanceId, t.groupIndex, t.elementOffset, t.materialIndex].every(
        Number.isSafeInteger,
      )
    )
      fail(
        "INVALID_SNAPSHOT",
        label + " has invalid identity; re-extract the surface",
      );
    if (!triangles.has(t)) {
      vector(t.vertexIndices, 3, label + " indices");
      if (
        !t.vertexIndices.every((n: number) => Number.isSafeInteger(n) && n >= 0)
      )
        fail("INVALID_SNAPSHOT", label + " has invalid vertex indices");
      vector(t.normalMatrix, 9, label + " normalMatrix");
      if (!orientation(t))
        fail("INVALID_SNAPSHOT", label + " has a singular normalMatrix");
      if (!Array.isArray(t.vertices) || t.vertices.length !== 3)
        fail("INVALID_SNAPSHOT", label + " must have three vertices");
      for (const v of t.vertices) {
        vector(v?.position, 3, label + " position");
        vector(v?.normal, 3, label + " normal");
        if (v.position.some((n: number) => Math.abs(n) > MAX_FLOAT))
          fail(
            "INVALID_SNAPSHOT",
            label + " position exceeds finite Float32 bounds",
          );
        if (v.uv0) vector(v.uv0, 2, label + " uv0");
        if (v.uv1) vector(v.uv1, 2, label + " uv1");
        if (v.tangent) vector(v.tangent, 4, label + " tangent");
        if (v.color) vector(v.color, 4, label + " color");
      }
      const face = cross(
        sub(t.vertices[1].position, t.vertices[0].position),
        sub(t.vertices[2].position, t.vertices[0].position),
      );
      if (!unit(face))
        fail(
          "DEGENERATE_TRIANGLE",
          label +
            " has zero or unrepresentable area; remove degenerate geometry",
        );
      if (frozenData.has(t)) triangles.add(t);
    }
    if (!materials.has(t.materialUuid))
      fail(
        "INVALID_MATERIAL",
        label + " references missing material " + t.materialUuid,
      );
    const key = identity(t);
    if (indices.has(key))
      fail(
        "DUPLICATE_IDENTITY",
        label +
          " duplicates a triangle identity; re-extract unique groups/elements",
      );
    indices.set(key, index);
  });
  return { indices, materials };
}

function leafBounds(
  nodes: Float32Array,
  offset: number,
  triangles: readonly SurfaceTriangle[],
): void {
  const start = nodes[offset + 3],
    count = nodes[offset + 7];
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = start; i < start + count; i++)
      for (const v of triangles[i].vertices) {
        lo = Math.min(lo, v.position[axis]);
        hi = Math.max(hi, v.position[axis]);
      }
    nodes[offset + axis] = outward(lo, true);
    nodes[offset + 4 + axis] = outward(hi, false);
  }
}

function refit(
  nodes: Float32Array,
  triangles: readonly SurfaceTriangle[],
): void {
  // Build order is preorder: every child has a greater node index than its parent.
  for (let offset = nodes.length - 8; offset >= 0; offset -= 8) {
    if (nodes[offset + 7] > 0) leafBounds(nodes, offset, triangles);
    else {
      const left = nodes[offset + 3] * 8,
        right = -nodes[offset + 7] * 8;
      for (let axis = 0; axis < 3; axis++) {
        nodes[offset + axis] = Math.min(
          nodes[left + axis],
          nodes[right + axis],
        );
        nodes[offset + 4 + axis] = Math.max(
          nodes[left + 4 + axis],
          nodes[right + 4 + axis],
        );
      }
    }
  }
}

function build(snapshot: SurfaceScene): {
  nodes: Float32Array;
  sources: Uint32Array;
  depth: number;
} {
  const order = snapshot.triangles.map((_, i) => i),
    data: number[] = [];
  const centers = new Float64Array(order.length * 3),
    bounds = new Float64Array(order.length * 6),
    scratch = new Uint32Array(order.length);
  snapshot.triangles.forEach((t, i) => {
    for (let axis = 0; axis < 3; axis++) {
      centers[i * 3 + axis] = t.vertices.reduce(
        (sum, v) => sum + v.position[axis] / 3,
        0,
      );
      bounds[i * 6 + axis] = Math.min(
        ...t.vertices.map((v) => v.position[axis]),
      );
      bounds[i * 6 + 3 + axis] = Math.max(
        ...t.vertices.map((v) => v.position[axis]),
      );
    }
  });
  // Shared workspace is used only while choosing a split, before recursing.
  const binCounts = new Uint32Array(SAH_BINS),
    binBounds = new Float64Array(SAH_BINS * 6),
    rightCounts = new Uint32Array(SAH_BINS),
    rightAreas = new Float64Array(SAH_BINS),
    union = new Float64Array(6);
  const depthLimit =
    2 * Math.ceil(Math.log2(Math.max(1, Math.ceil(order.length / LEAF_SIZE)))) +
    1;
  function resetBox(box: Float64Array, offset = 0): void {
    for (let axis = 0; axis < 3; axis++) {
      box[offset + axis] = Infinity;
      box[offset + 3 + axis] = -Infinity;
    }
  }
  function mergeBox(
    target: Float64Array,
    offset: number,
    source: Float64Array,
    from: number,
  ): void {
    for (let axis = 0; axis < 3; axis++) {
      target[offset + axis] = Math.min(
        target[offset + axis],
        source[from + axis],
      );
      target[offset + 3 + axis] = Math.max(
        target[offset + 3 + axis],
        source[from + 3 + axis],
      );
    }
  }
  function area(box: Float64Array): number {
    const x = box[3] - box[0],
      y = box[4] - box[1],
      z = box[5] - box[2];
    return x < 0 || y < 0 || z < 0 ? 0 : 2 * (x * y + y * z + z * x);
  }
  function bin(
    source: number,
    axis: number,
    lo: number,
    extent: number,
  ): number {
    return Math.min(
      SAH_BINS - 1,
      Math.max(
        0,
        Math.floor(((centers[source * 3 + axis] - lo) / extent) * SAH_BINS),
      ),
    );
  }
  let depth = 0;
  function partition(start: number, end: number, level: number): number {
    const index = data.length / 8;
    if (index > MAX_EXACT_POINTER || start > MAX_EXACT_POINTER)
      fail(
        "BUFFER_CAPACITY",
        "Tree pointers exceed exact Float32 integers; split the surface into separate accelerations",
      );
    data.push(0, 0, 0, 0, 0, 0, 0, 0);
    depth = Math.max(depth, level);
    if (end - start <= LEAF_SIZE) {
      data[index * 8 + 3] = start;
      data[index * 8 + 7] = end - start;
    } else {
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++)
        for (let axis = 0; axis < 3; axis++) {
          lo[axis] = Math.min(lo[axis], centers[order[i] * 3 + axis]);
          hi[axis] = Math.max(hi[axis], centers[order[i] * 3 + axis]);
        }
      const count = end - start,
        minimumSide = Math.ceil(count / SAH_BALANCE);
      let bestCost = Infinity,
        bestAxis = -1,
        bestBin = -1,
        bestLeftCount = 0;
      for (let axis = 0; axis < 3; axis++) {
        const extent = hi[axis] - lo[axis];
        if (!(extent > 0)) continue;
        binCounts.fill(0);
        for (let b = 0; b < SAH_BINS; b++) resetBox(binBounds, b * 6);
        for (let i = start; i < end; i++) {
          const source = order[i],
            b = bin(source, axis, lo[axis], extent);
          binCounts[b]++;
          mergeBox(binBounds, b * 6, bounds, source * 6);
        }
        resetBox(union);
        let rightCount = 0;
        for (let b = SAH_BINS - 1; b >= 0; b--) {
          rightCount += binCounts[b];
          if (binCounts[b]) mergeBox(union, 0, binBounds, b * 6);
          rightCounts[b] = rightCount;
          rightAreas[b] = area(union);
        }
        // An underflowed/zero-area box has no useful geometric SAH signal.
        if (!(rightAreas[0] > 0)) continue;
        resetBox(union);
        let leftCount = 0;
        for (let b = 0; b < SAH_BINS - 1; b++) {
          leftCount += binCounts[b];
          if (binCounts[b]) mergeBox(union, 0, binBounds, b * 6);
          const right = rightCounts[b + 1];
          if (leftCount < minimumSide || right < minimumSide) continue;
          // Always reserve enough remaining levels for a balanced median tail.
          const tail = Math.ceil(
            Math.log2(Math.ceil(Math.max(leftCount, right) / LEAF_SIZE)),
          );
          if (level + 1 + tail > depthLimit) continue;
          const cost = area(union) * leftCount + rightAreas[b + 1] * right;
          // Equal costs keep the first axis/bin, making ties deterministic.
          if (cost < bestCost) {
            bestCost = cost;
            bestAxis = axis;
            bestBin = b;
            bestLeftCount = leftCount;
          }
        }
      }
      let middle: number;
      if (bestAxis >= 0) {
        middle = start + bestLeftCount;
        let left = start,
          right = middle;
        for (let i = start; i < end; i++) {
          const source = order[i];
          if (
            bin(source, bestAxis, lo[bestAxis], hi[bestAxis] - lo[bestAxis]) <=
            bestBin
          )
            scratch[left++] = source;
          else scratch[right++] = source;
        }
        for (let i = start; i < end; i++) order[i] = scratch[i];
      } else {
        let axis = 0;
        for (let k = 1; k < 3; k++)
          if (hi[k] - lo[k] > hi[axis] - lo[axis]) axis = k;
        const sorted = order
          .slice(start, end)
          .sort(
            (a, b) => centers[a * 3 + axis] - centers[b * 3 + axis] || a - b,
          );
        for (let i = start; i < end; i++) order[i] = sorted[i - start];
        middle = start + Math.floor(count / 2);
      }
      const left = partition(start, middle, level + 1),
        right = partition(middle, end, level + 1);
      data[index * 8 + 3] = left;
      data[index * 8 + 7] = -right;
    }
    return index;
  }
  if (order.length) partition(0, order.length, 1);
  const nodes = new Float32Array(data),
    sources = Uint32Array.from(order);
  refit(
    nodes,
    order.map((i) => snapshot.triangles[i]),
  );
  return { nodes, sources, depth };
}

function ranges(
  before: Float32Array,
  after: Float32Array,
): { offset: number; count: number }[] {
  const result: { offset: number; count: number }[] = [];
  for (let offset = 0; offset < after.length; offset += 8) {
    let changed = false;
    for (let k = 0; k < 8; k++)
      if (before[offset + k] !== after[offset + k]) changed = true;
    if (!changed) continue;
    const previous = result.at(-1);
    if (previous && previous.offset + previous.count === offset)
      previous.count += 8;
    else result.push({ offset, count: 8 });
  }
  return result;
}

function boundsHit(
  nodes: Float32Array,
  index: number,
  origin: SurfaceVec3,
  direction: SurfaceVec3,
  limit: number,
): boolean {
  let near = 0,
    far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const lo = nodes[index * 8 + axis],
      hi = nodes[index * 8 + axis + 4];
    if (direction[axis] === 0) {
      if (origin[axis] < lo || origin[axis] > hi) return false;
    } else {
      const a = (lo - origin[axis]) / direction[axis],
        b = (hi - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
      if (near > far) return false;
    }
  }
  return true;
}

function triangleHit(
  t: SurfaceTriangle,
  material: SurfaceMaterial,
  origin: SurfaceVec3,
  direction: SurfaceVec3,
  limit: number,
  triangleIndex: number,
): AccelerationHit | null {
  const a = t.vertices[0].position,
    e1 = sub(t.vertices[1].position, a),
    e2 = sub(t.vertices[2].position, a);
  const p = cross(direction, e2),
    determinant = dot(e1, p);
  if (determinant === 0) return null;
  const front = determinant * orientation(t) > 0;
  const physical = (material.transmission ?? 0) > 0;
  if (
    !physical &&
    ((material.side === "front" && !front) ||
      (material.side === "back" && front))
  )
    return null;
  const fromA = sub(origin, a),
    u = dot(fromA, p) / determinant;
  if (!(u >= 0 && u <= 1)) return null;
  const q = cross(fromA, e1),
    v = dot(direction, q) / determinant;
  if (!(v >= 0 && u + v <= 1)) return null;
  const distance = dot(e2, q) / determinant;
  if (!Number.isFinite(distance) || distance < 0 || distance > limit)
    return null;
  const barycentric: SurfaceVec3 = [1 - u - v, u, v];
  const blended: SurfaceVec3 = [0, 1, 2].map((axis) =>
    t.vertices.reduce(
      (sum, vertex, i) => sum + vertex.normal[axis] * barycentric[i],
      0,
    ),
  ) as unknown as SurfaceVec3;
  let normal = unit(blended) ?? unit(cross(e1, e2))!;
  if (
    physical
      ? !front
      : material.side === "back" || (material.side === "double" && !front)
  )
    normal = [-normal[0], -normal[1], -normal[2]];
  return {
    distance: Math.max(0, distance),
    triangleIndex,
    barycentric,
    normal,
  };
}

export function createSurfaceAcceleration(): SurfaceAcceleration {
  let frozenData = new WeakSet<object>(),
    validatedTriangles = new WeakSet<object>();
  let disposed = false,
    snapshot: SurfaceScene | undefined;
  let nodes: Float32Array = new Float32Array(),
    sources: Uint32Array = new Uint32Array();
  let ordered: readonly SurfaceTriangle[] = [],
    keys: readonly string[] = [];
  let materials = new Map<string, SurfaceMaterial>();
  let revision = 0,
    topologyRevision = 0,
    depth = 0,
    updates = 0,
    rebuilds = 0,
    refits = 0;
  let metrics: AccelerationFrame["metrics"] = {
    buildMs: 0,
    refitMs: 0,
    triangles: 0,
    nodes: 0,
    depth: 0,
  };
  let changes: AccelerationFrame["changes"] = { kind: "none", nodeRanges: [] };
  const active = () => {
    if (disposed)
      fail("DISPOSED", "Acceleration was disposed; create a new acceleration");
  };
  return {
    update(next) {
      active();
      const started = performance.now();
      // All validation, allocation and calculations precede publication (atomic failure).
      const validated = validate(next, frozenData, validatedTriangles);
      const topologyChanged =
        !snapshot ||
        keys.length !== next.triangles.length ||
        keys.some((key) => !validated.indices.has(key));
      let kind: AccelerationFrame["changes"]["kind"],
        nextNodes: Float32Array,
        nextSources: Uint32Array,
        nextDepth = depth;
      let nextOrdered: readonly SurfaceTriangle[];
      if (topologyChanged) {
        const built = build(next);
        nextNodes = built.nodes;
        nextSources = built.sources;
        nextDepth = built.depth;
        nextOrdered = Array.from(nextSources, (index) => next.triangles[index]);
        kind = "rebuild";
      } else {
        nextSources = Uint32Array.from(
          keys,
          (key) => validated.indices.get(key)!,
        );
        nextOrdered = Array.from(nextSources, (index) => next.triangles[index]);
        const moved = nextOrdered.some((t, i) =>
          t.vertices.some((v, j) =>
            v.position.some(
              (n, axis) => n !== ordered[i].vertices[j].position[axis],
            ),
          ),
        );
        nextNodes = moved ? nodes.slice() : nodes;
        if (moved) {
          refit(nextNodes, nextOrdered);
          kind = "refit";
        } else kind = equal(snapshot, next) ? "none" : "materials";
      }
      const nodeRanges =
        kind === "rebuild"
          ? nextNodes.length
            ? [{ offset: 0, count: nextNodes.length }]
            : []
          : kind === "refit"
            ? ranges(nodes, nextNodes)
            : [];
      const nextRevision = revision + (kind === "none" ? 0 : 1);
      const nextTopology = topologyRevision + (topologyChanged ? 1 : 0);
      const nextChanges = Object.freeze({
        kind,
        nodeRanges,
      });
      const nextMetrics = {
        buildMs: 0,
        refitMs: 0,
        triangles: nextOrdered.length,
        nodes: nextNodes.length / 8,
        depth: nextDepth,
      };
      // Returned mutable typed arrays are private copies, including on none/material updates.
      const frameNodes = nextNodes.slice(),
        frameSources = nextSources.slice();
      const frameOrdered = Object.freeze([...nextOrdered]);
      const nextKeys = topologyChanged ? nextOrdered.map(identity) : keys;
      const elapsed = performance.now() - started;
      if (kind === "rebuild") nextMetrics.buildMs = elapsed;
      if (kind === "refit") nextMetrics.refitMs = elapsed;
      const frame = Object.freeze({
        nodes: frameNodes,
        sourceIndices: frameSources,
        orderedTriangles: frameOrdered,
        revision: nextRevision,
        topologyRevision: nextTopology,
        changes: Object.freeze({
          kind,
          nodeRanges: nodeRanges.map((range) => ({ ...range })),
        }),
        metrics: Object.freeze(nextMetrics),
      });
      snapshot = next;
      nodes = nextNodes;
      sources = nextSources;
      ordered = frameOrdered;
      keys = nextKeys;
      materials = validated.materials;
      depth = nextDepth;
      revision = nextRevision;
      topologyRevision = nextTopology;
      metrics = frame.metrics;
      changes = nextChanges;
      updates++;
      if (kind === "rebuild") rebuilds++;
      if (kind === "refit") refits++;
      return frame;
    },
    intersect(origin, direction, maxDistance = Infinity) {
      active();
      if (
        !Array.isArray(origin) ||
        origin.length !== 3 ||
        !origin.every(Number.isFinite) ||
        !Array.isArray(direction) ||
        direction.length !== 3 ||
        !direction.every(Number.isFinite)
      )
        fail(
          "INVALID_RAY",
          "Origin and direction must be finite three-component vectors",
        );
      const ray = unit(direction);
      if (!ray) fail("INVALID_RAY", "Direction must have nonzero length");
      if (
        !(maxDistance >= 0) ||
        (maxDistance !== Infinity && !Number.isFinite(maxDistance))
      )
        fail(
          "INVALID_DISTANCE",
          "maxDistance must be nonnegative finite or positive Infinity",
        );
      if (!nodes.length) return null;
      let hit: AccelerationHit | null = null,
        limit = maxDistance;
      const stack = [0];
      while (stack.length) {
        const index = stack.pop()!,
          offset = index * 8;
        if (!boundsHit(nodes, index, origin, ray, limit)) continue;
        if (nodes[offset + 7] > 0) {
          const start = nodes[offset + 3],
            end = start + nodes[offset + 7];
          for (let i = start; i < end; i++) {
            const candidate = triangleHit(
              ordered[i],
              materials.get(ordered[i].materialUuid)!,
              origin,
              ray,
              limit,
              sources[i],
            );
            if (
              candidate &&
              (!hit ||
                candidate.distance < hit.distance ||
                (candidate.distance === hit.distance &&
                  candidate.triangleIndex < hit.triangleIndex))
            ) {
              hit = candidate;
              limit = candidate.distance;
            }
          }
        } else {
          stack.push(-nodes[offset + 7], nodes[offset + 3]);
        }
      }
      return hit;
    },
    inspect() {
      active();
      return {
        revision,
        topologyRevision,
        changes: {
          kind: changes.kind,
          nodeRanges: changes.nodeRanges.map((range) => ({ ...range })),
        },
        metrics: { ...metrics },
        updates,
        rebuilds,
        refits,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      snapshot = undefined;
      nodes = new Float32Array();
      sources = new Uint32Array();
      ordered = [];
      keys = [];
      materials.clear();
      frozenData = new WeakSet<object>();
      validatedTriangles = new WeakSet<object>();
    },
  };
}
