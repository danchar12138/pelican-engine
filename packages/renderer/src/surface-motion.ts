import type { SurfaceScene, SurfaceTriangle } from "./surface.ts";

const MAX_FLOAT = 3.4028234663852886e38;

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
  return JSON.stringify([
    t.objectUuid,
    t.geometryUuid,
    t.instanceId,
    t.groupIndex,
    t.elementOffset,
    t.vertexIndices,
  ]);
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
  return triangles;
}

/** Previous world-space positions only; a match does not validate shading history. */
export function packPreviousSurfacePositions(
  previous: SurfaceScene | undefined,
  current: SurfaceScene,
  ordered: readonly SurfaceTriangle[] = current?.triangles,
): { data: Float32Array; matched: number; missing: number } {
  const remaining = index(current, "current", false);
  const history =
    previous === undefined ? undefined : index(previous, "previous", true);
  if (!Array.isArray(ordered) || ordered.length !== remaining.size)
    fail("INVALID_ORDER", "ordered must include every current triangle once");
  const data = new Float32Array(ordered.length * 12);
  let matched = 0;
  for (const [i, t] of ordered.entries()) {
    const key = identity(t, "ordered[" + i + "]");
    if (!remaining.delete(key))
      fail("INVALID_ORDER", "ordered[" + i + "] is unknown or repeated");
    const old = history?.get(key);
    if (!old) continue;
    for (let j = 0; j < 3; j++)
      data.set(old.vertices[j].position, i * 12 + j * 4);
    data[i * 12 + 3] = 1;
    matched++;
  }
  return { data, matched, missing: ordered.length - matched };
}
