import type { SurfaceScene, SurfaceTriangle } from "./surface.ts";
import { isCapturedTriangle, hasCapturedGeometry } from "./surface.ts";
const identities = new WeakMap<SurfaceTriangle, string>();
const capturedIndices = new WeakMap<
  readonly SurfaceTriangle[],
  { index: ReadonlyMap<string, SurfaceTriangle>; positions: boolean }
>();
const capturedOrders = new WeakMap<
  readonly SurfaceTriangle[],
  ReadonlyMap<string, number>
>();
const validPositions = new WeakSet<SurfaceTriangle>();

const MAX_FLOAT = 3.4028234663852886e38;

/** Acceleration validates source indices. Reuse aligned, extractor-owned data
 * without rebuilding string-key maps for every unchanged static primitive. */
export function createSurfaceMotionPacker() {
  let data: Float32Array = new Float32Array(), oldTriangles: readonly SurfaceTriangle[] = [];
  return (previous: SurfaceScene | undefined, current: SurfaceScene, ordered: readonly SurfaceTriangle[], sources: Uint32Array) => {
    const aligned = previous && hasCapturedGeometry(previous) && hasCapturedGeometry(current) &&
      previous.triangles.length === current.triangles.length && sources.length === ordered.length &&
      current.triangles.every((t, i) => {
        const old = previous.triangles[i];
        return t === old || (t.objectUuid === old.objectUuid && t.geometryUuid === old.geometryUuid &&
          t.instanceId === old.instanceId && t.groupIndex === old.groupIndex && t.elementOffset === old.elementOffset &&
          t.vertexIndices.every((n, j) => n === old.vertexIndices[j]));
      }) && ordered.every((t, i) => t === current.triangles[sources[i]]);
    if (!aligned) {
      oldTriangles = [];
      const result = packPreviousSurfacePositions(previous, current, ordered);
      data = result.data;
      return result;
    }
    if (data.length !== ordered.length * 12) { data = new Float32Array(ordered.length * 12); oldTriangles = []; }
    const next: SurfaceTriangle[] = new Array(ordered.length);
    for (let i = 0; i < ordered.length; i++) {
      const old = previous.triangles[sources[i]];
      next[i] = old;
      if (old === oldTriangles[i]) continue;
      for (let vertex = 0; vertex < 3; vertex++) {
        const p = old.vertices[vertex].position, offset = i * 12 + vertex * 4;
        data[offset] = p[0]; data[offset + 1] = p[1]; data[offset + 2] = p[2]; data[offset + 3] = 0;
      }
      data[i * 12 + 3] = 1;
    }
    oldTriangles = next;
    return { data, matched: ordered.length, missing: 0 };
  };
}

function fail(code: string, label: string): never {
  throw new Error(
    "TC_SURFACE_MOTION_" +
      code +
      ": " +
      label +
      "; re-extract unique version 1 surfaces and supply a complete current order",
  );
}

function identity(t: SurfaceTriangle, label: string): string {
  const cached = identities.get(t);
  if (cached) return cached;
  if (
    !t ||
    typeof t.objectUuid !== "string" ||
    !t.objectUuid.length ||
    typeof t.geometryUuid !== "string" ||
    !t.geometryUuid.length ||
    ![t.instanceId, t.elementOffset].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !Number.isSafeInteger(t.groupIndex) ||
    t.groupIndex < -1 ||
    !Array.isArray(t.vertexIndices) ||
    t.vertexIndices.length !== 3 ||
    !Array.from(t.vertexIndices).every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    fail("INVALID_IDENTITY", label);
  // Keep exactly the geometry identity used by acceleration.ts, not material UUID.
  const key = JSON.stringify([
    t.objectUuid,
    t.geometryUuid,
    t.instanceId,
    t.groupIndex,
    t.elementOffset,
    t.vertexIndices,
  ]);
  if (isCapturedTriangle(t)) identities.set(t, key);
  return key;
}

function index(scene: SurfaceScene, label: string, positions: boolean) {
  if (
    !scene ||
    scene.version !== 1 ||
    !Array.isArray(scene.triangles) ||
    !Array.isArray(scene.materials) ||
    !Array.isArray(scene.textures) ||
    !Array.isArray(scene.diagnostics)
  )
    fail("INVALID_SNAPSHOT", label);
  const captured = hasCapturedGeometry(scene);
  const cached = captured && capturedIndices.get(scene.triangles);
  if (cached && (!positions || cached.positions)) return cached.index;
  const triangles = new Map<string, SurfaceTriangle>();
  for (const [i, t] of scene.triangles.entries()) {
    const location = label + ".triangles[" + i + "]";
    const key = identity(t, location);
    if (triangles.has(key)) fail("DUPLICATE_IDENTITY", location);
    if (positions) {
      if (!Array.isArray(t.vertices) || t.vertices.length !== 3)
        fail("INVALID_POSITION", location + ".vertices");
      for (const [j, v] of t.vertices.entries()) {
        const p = v?.position;
        if (
          !Array.isArray(p) ||
          p.length !== 3 ||
          !Array.from(p).every(
            (n) =>
              typeof n === "number" &&
              Number.isFinite(n) &&
              Math.abs(n) <= MAX_FLOAT,
          )
        )
          fail("INVALID_POSITION", location + ".vertices[" + j + "].position");
      }
    }
    triangles.set(key, t);
  }
  if (captured) {
    capturedIndices.set(scene.triangles, { index: triangles, positions });
    capturedOrders.set(
      scene.triangles,
      new Map([...triangles.keys()].map((key, i) => [key, i])),
    );
  }
  return triangles;
}

/** Previous world-space positions only; a match does not validate shading history. */
export function packPreviousSurfacePositions(
  previous: SurfaceScene | undefined,
  current: SurfaceScene,
  ordered: readonly SurfaceTriangle[] = current?.triangles,
): { data: Float32Array; matched: number; missing: number } {
  if (
    previous?.version === 1 &&
    current?.version === 1 &&
    Array.isArray(previous.triangles) &&
    Array.isArray(current.triangles) &&
    Array.isArray(previous.materials) &&
    Array.isArray(previous.textures) &&
    Array.isArray(previous.diagnostics) &&
    Array.isArray(current.materials) &&
    Array.isArray(current.textures) &&
    Array.isArray(current.diagnostics) &&
    Array.isArray(ordered) &&
    ordered.length === current.triangles.length &&
    hasCapturedGeometry(previous) &&
    hasCapturedGeometry(current) &&
    capturedOrders.has(previous.triangles) &&
    previous.triangles.length === current.triangles.length &&
    current.triangles.every(
      (triangle, index) =>
        triangle === previous.triangles[index] ||
        identity(triangle, "current") ===
          identity(previous.triangles[index], "previous"),
    )
  ) {
    const sourceOrder = capturedOrders.get(previous.triangles)!;
    const seen = new Uint8Array(ordered.length);
    const data = new Float32Array(ordered.length * 12);
    for (let i = 0; i < ordered.length; i++) {
      const source = sourceOrder.get(
        identity(ordered[i], "ordered[" + i + "]"),
      );
      if (source === undefined || seen[source])
        fail("INVALID_ORDER", "ordered[" + i + "] is unknown or repeated");
      seen[source] = 1;
      const old = previous.triangles[source],
        checked = validPositions.has(old);
      for (let vertex = 0; vertex < 3; vertex++)
        for (let axis = 0; axis < 3; axis++) {
          const value = old.vertices[vertex].position[axis];
          if (
            !checked &&
            (!Number.isFinite(value) || Math.abs(value) > MAX_FLOAT)
          )
            fail("INVALID_POSITION", "previous captured position");
          data[i * 12 + vertex * 4 + axis] = value;
        }
      if (!checked) validPositions.add(old);
      data[i * 12 + 3] = 1;
    }
    capturedOrders.set(current.triangles, sourceOrder);
    return { data, matched: ordered.length, missing: 0 };
  }
  const currentIndex = index(current, "current", false);
  const seen = new Set<string>();
  const history =
    previous === undefined ? undefined : index(previous, "previous", true);
  if (!Array.isArray(ordered) || ordered.length !== currentIndex.size)
    fail("INVALID_ORDER", "ordered must include every current triangle once");
  const data = new Float32Array(ordered.length * 12);
  let matched = 0;
  for (const [i, t] of ordered.entries()) {
    const key = identity(t, "ordered[" + i + "]");
    if (!currentIndex.has(key) || seen.has(key))
      fail("INVALID_ORDER", "ordered[" + i + "] is unknown or repeated");
    seen.add(key);
    const old = history?.get(key);
    if (!old) continue;
    for (let j = 0; j < 3; j++)
      data.set(old.vertices[j].position, i * 12 + j * 4);
    data[i * 12 + 3] = 1;
    matched++;
  }
  return { data, matched, missing: ordered.length - matched };
}
