import type { SurfaceScene, SurfaceTriangle } from "./surface.ts";
import { hasCapturedGeometry } from "./surface.ts";
/** Owned by one tracer. Frozen triangles can safely retain their emitter metadata. */
export function createEmissiveLightCache() {
  const entries = new WeakMap<
    SurfaceTriangle,
    { material: string; value: string; area: number; key: string }
  >();
  let previous: ReturnType<typeof appendEmissiveLights> | undefined;
  let previousTriangles: readonly SurfaceTriangle[] = [];
  let previousMaterials = "",
    previousExplicit = new Float32Array();
  let hits = 0,
    builds = 0;
  return {
    update(
      snapshot: SurfaceScene,
      ordered: readonly SurfaceTriangle[],
      explicit: Float32Array,
    ) {
      const materials = snapshot.materials
        .map((material) => JSON.stringify(material))
        .join("\n");
      const emitting = new Set(
        snapshot.materials
          .filter(
            (material) =>
              material.emissiveIntensity > 0 &&
              material.emissive.some((value) => value > 0),
          )
          .map((material) => material.uuid),
      );
      if (
        hasCapturedGeometry(snapshot) &&
        previous &&
        materials === previousMaterials &&
        ordered.length === previousTriangles.length &&
        ordered.every(
          (triangle, index) =>
            triangle === previousTriangles[index] ||
            (!emitting.has(triangle.materialUuid) &&
              !emitting.has(previousTriangles[index]!.materialUuid)),
        ) &&
        explicit.length === previousExplicit.length &&
        explicit.every((value, index) => value === previousExplicit[index])
      ) {
        hits++;
        return previous;
      }
      builds++;
      const result = appendEmissiveLights(snapshot, ordered, explicit, entries);
      previous = result;
      previousTriangles = [...ordered];
      previousMaterials = materials;
      previousExplicit = explicit.slice();
      return result;
    },
    inspect: () => ({ hits, builds }),
    clear() {
      previous = undefined;
      previousTriangles = [];
      previousMaterials = "";
      previousExplicit = new Float32Array();
    },
  };
}
/** Importance distribution over emitting geometry. Shader evaluates actual textured emission at each sample. */
export function appendEmissiveLights(
  snapshot: SurfaceScene,
  ordered: readonly SurfaceTriangle[],
  explicit: Float32Array,
  cache?: WeakMap<
    SurfaceTriangle,
    { material: string; value: string; area: number; key: string }
  >,
) {
  const materials = new Map(
    snapshot.materials.map((material) => [material.uuid, material]),
  );
  const emitters: {
    index: number;
    area: number;
    weight: number;
    color: readonly number[];
  }[] = [];
  const semantic: { key: string; value: string }[] = [];
  const materialKeys = new Map(
    snapshot.materials.map((material) => [
      material.uuid,
      JSON.stringify(material),
    ]),
  );
  ordered.forEach((triangle, index) => {
    const material = materials.get(triangle.materialUuid)!;
    const color = material.emissive.map(
        (value) => value * material.emissiveIntensity,
      ),
      luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    if (luminance <= 0) return;
    const cached = cache?.get(triangle),
      materialKey = materialKeys.get(material.uuid)!;
    if (cached?.material === materialKey) {
      emitters.push({
        index,
        area: cached.area,
        weight: cached.area * luminance,
        color,
      });
      semantic.push({ key: cached.key, value: cached.value });
      return;
    }
    const [a, b, c] = triangle.vertices.map((vertex) => vertex.position),
      e1 = b.map((value, axis) => value - a[axis]),
      e2 = c.map((value, axis) => value - a[axis]),
      cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ],
      area = Math.hypot(...cross) * 0.5;
    if (!Number.isFinite(area) || area <= 0)
      throw new Error("TC_TRACE_EMITTER: Invalid emissive triangle area.");
    emitters.push({ index, area, weight: area * luminance, color });
    const key = JSON.stringify([
      triangle.objectUuid,
      triangle.geometryUuid,
      triangle.instanceId,
      triangle.groupIndex,
      triangle.elementOffset,
      triangle.vertexIndices,
    ]);
    const value = JSON.stringify([
      key,
      triangle.vertices,
      triangle.normalMatrix,
      material,
    ]);
    if (hasCapturedGeometry(snapshot))
      cache?.set(triangle, { material: materialKey, value, area, key });
    semantic.push({
      key,
      value,
    });
  });
  const total = emitters.reduce((sum, emitter) => sum + emitter.weight, 0),
    output = new Float32Array(explicit.length + emitters.length * 12);
  output.set(explicit);
  let cumulative = 0;
  emitters.forEach((emitter, slot) => {
    const probability = emitter.weight / total;
    cumulative += probability;
    output.set(
      [
        emitter.index,
        emitter.area,
        probability,
        4,
        ...emitter.color,
        0,
        slot === emitters.length - 1 ? 1 : cumulative,
        0,
        0,
        0,
      ],
      explicit.length + slot * 12,
    );
  });
  // Vose alias sampling uses one table read plus an optional alias read. Keep
  // the CDF for CPU inspection; extra.y/z are alias threshold/index on the GPU.
  const scaled = emitters.map(
    (emitter) => (emitter.weight / total) * emitters.length,
  );
  const small: number[] = [],
    large: number[] = [];
  scaled.forEach((value, index) => (value < 1 ? small : large).push(index));
  const thresholds = scaled.map(() => 1),
    aliases = scaled.map((_, index) => index);
  while (small.length && large.length) {
    const low = small.pop()!,
      high = large.pop()!;
    thresholds[low] = scaled[low];
    aliases[low] = high;
    scaled[high] = scaled[high] + scaled[low] - 1;
    (scaled[high] < 1 ? small : large).push(high);
  }
  thresholds.forEach((threshold, slot) => {
    output[explicit.length + slot * 12 + 9] = threshold;
    output[explicit.length + slot * 12 + 10] = aliases[slot];
  });
  // GPU-only triangle -> emitter PDF lookup follows the emitting records.
  // An opaque triangle has probability zero. Volumes are appended after this
  // table by the tracer, so the light-buffer ownership and bindings stay shared.
  const gpuData = new Float32Array(
    output.length + (emitters.length ? ordered.length * 12 : 0),
  );
  gpuData.set(output);
  emitters.forEach((emitter) =>
    gpuData.set(
      [emitter.area, emitter.weight / total],
      output.length + emitter.index * 12,
    ),
  );
  return {
    signature: JSON.stringify([
      Array.from(explicit),
      semantic
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => entry.value),
    ]),
    data: output,
    gpuData,
    explicitRecords: explicit.length / 12,
    emitters: emitters.length,
    totalArea: emitters.reduce((sum, emitter) => sum + emitter.area, 0),
  };
}
