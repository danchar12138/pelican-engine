import type { SurfaceScene, SurfaceTriangle } from "./surface.ts";
/** Importance distribution over emitting geometry. Shader evaluates actual textured emission at each sample. */
export function appendEmissiveLights(
  snapshot: SurfaceScene,
  ordered: readonly SurfaceTriangle[],
  explicit: Float32Array,
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
  ordered.forEach((triangle, index) => {
    const material = materials.get(triangle.materialUuid)!;
    const color = material.emissive.map(
        (value) => value * material.emissiveIntensity,
      ),
      luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    if (luminance <= 0) return;
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
    semantic.push({
      key,
      value: JSON.stringify([
        key,
        triangle.vertices,
        triangle.normalMatrix,
        material,
      ]),
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
  return {
    signature: JSON.stringify([
      Array.from(explicit),
      semantic
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((entry) => entry.value),
    ]),
    data: output,
    emitters: emitters.length,
    totalArea: emitters.reduce((sum, emitter) => sum + emitter.area, 0),
  };
}
