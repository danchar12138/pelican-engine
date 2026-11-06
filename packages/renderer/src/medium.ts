import { Box3, Ray, Triangle, Vector3 } from "three";
import type {
  SurfaceMaterial,
  SurfaceScene,
  SurfaceTriangle,
  SurfaceVec3,
} from "./surface.ts";

export interface MediumVolume {
  readonly id: number;
  readonly key: string;
  readonly ior: number;
  readonly sigma: SurfaceVec3;
  readonly bounds: { readonly min: SurfaceVec3; readonly max: SurfaceVec3 };
  readonly triangleIndices: readonly number[];
}
export interface MediumInspection {
  readonly disposed: boolean;
  readonly volumes: readonly MediumVolume[];
  readonly tolerance: readonly { readonly id: number; readonly weld: number }[];
  readonly nesting: readonly {
    readonly id: number;
    readonly parentId: number;
  }[];
}
export interface MediumCatalog {
  readonly volumes: readonly MediumVolume[];
  initial(origin: SurfaceVec3): readonly number[];
  inspect(): MediumInspection;
  dispose(): void;
}
export class MediumError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly key?: string,
  ) {
    super(code + ": " + message + (key === undefined ? "" : " [" + key + "]"));
    this.name = "MediumError";
  }
}
type Physical = SurfaceMaterial & {
  readonly transmission?: number;
  readonly ior?: number;
  readonly attenuationColor?: SurfaceVec3;
  readonly attenuationDistance?: number;
};
type Face = { triangle: Triangle; bounds: Box3; ids: readonly number[] };
type Solid = {
  volume: MediumVolume;
  faces: Face[];
  points: Vector3[];
  epsilon: number;
  bounds: Box3;
};
const directions = [
  [1, 0.37139, 0.69421],
  [-0.52973, 1, 0.21761],
  [0.19317, -0.61843, 1],
].map((v) => new Vector3(...v).normalize());
const fail = (code: string, message: string, key?: string): never => {
  throw new MediumError("TC_MEDIUM_" + code, message, key);
};
function vector(v: SurfaceVec3, key: string): Vector3 {
  if (!v || v.length !== 3 || !v.every(Number.isFinite))
    fail("INPUT", "Supply three finite world-space coordinates.", key);
  return new Vector3(...v);
}
function tuple(v: Vector3): SurfaceVec3 {
  return Object.freeze([v.x, v.y, v.z]);
}
function optical(m: Physical, key: string) {
  const ior = m.ior ?? 1.5,
    distance = m.attenuationDistance ?? 0,
    color = m.attenuationColor ?? [1, 1, 1];
  if (
    !Number.isFinite(ior) ||
    ior <= 0 ||
    !Number.isFinite(distance) ||
    distance < 0 ||
    color.length !== 3 ||
    !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)
  )
    fail(
      "MATERIAL",
      "Use positive finite IOR, finite distance >= 0 and linear attenuation color in [0,1].",
      key,
    );
  if (distance > 0 && color.some((c) => c === 0))
    fail(
      "ZERO_ATTENUATION",
      "Zero attenuation at positive distance has infinite absorption; use an explicit opaque path or positive color.",
      key,
    );
  const sigma = color.map((c) =>
    distance === 0 || c === 1 ? 0 : -Math.log(c) / distance,
  ) as unknown as SurfaceVec3;
  if (
    !sigma.every((c) => Number.isFinite(c) && Number.isFinite(Math.fround(c)))
  )
    fail(
      "ABSORPTION_RANGE",
      "Absorption must fit finite GPU float32; change attenuation color/distance.",
      key,
    );
  return { ior, sigma: Object.freeze(sigma) };
}
function build(
  indices: number[],
  snapshot: SurfaceScene,
  id: number,
  key: string,
  ior: number,
  sigma: SurfaceVec3,
): Solid {
  const raw = indices.map((i) =>
    snapshot.triangles[i].vertices.map((v) => vector(v.position, key)),
  );
  const bounds = new Box3().setFromPoints(raw.flat()),
    extent = bounds.getSize(new Vector3());
  const scale = Math.max(extent.x, extent.y, extent.z),
    magnitude = Math.max(
      ...bounds.min.toArray().map(Math.abs),
      ...bounds.max.toArray().map(Math.abs),
    );
  const epsilon = Math.max(scale * 1e-7, magnitude * Number.EPSILON * 32);
  if (!(epsilon > 0) || !Number.isFinite(epsilon) || !Number.isFinite(scale))
    fail("DEGENERATE", "Provide a resolvable nonzero closed volume.", key);
  // Numeric spatial buckets search adjacent cells, then verify world-space distance.
  const cells = new Map<number, Map<number, Map<number, number[]>>>(),
    points: Vector3[] = [];
  function weld(p: Vector3): number {
    const c = p.clone().sub(bounds.min).divideScalar(epsilon).floor();
    let found = Infinity;
    for (let x = c.x - 1; x <= c.x + 1; x++)
      for (let y = c.y - 1; y <= c.y + 1; y++)
        for (let z = c.z - 1; z <= c.z + 1; z++)
          for (const i of cells.get(x)?.get(y)?.get(z) ?? [])
            if (points[i].distanceTo(p) <= epsilon) found = Math.min(found, i);
    if (found !== Infinity) return found;
    if (!cells.has(c.x)) cells.set(c.x, new Map());
    const ys = cells.get(c.x)!;
    if (!ys.has(c.y)) ys.set(c.y, new Map());
    const zs = ys.get(c.y)!;
    if (!zs.has(c.z)) zs.set(c.z, []);
    const index = points.length;
    zs.get(c.z)!.push(index);
    points.push(p.clone());
    return index;
  }
  const faces: Face[] = raw.map((v) => {
    const ids = v.map(weld),
      triangle = new Triangle(
        ...(ids.map((i) => points[i]) as [Vector3, Vector3, Vector3]),
      );
    const lengths = [
      triangle.a.distanceTo(triangle.b),
      triangle.b.distanceTo(triangle.c),
      triangle.c.distanceTo(triangle.a),
    ];
    if (
      new Set(ids).size !== 3 ||
      triangle.getArea() <= epsilon * Math.max(...lengths)
    )
      fail("DEGENERATE", "Remove zero-area or sub-tolerance triangles.", key);
    return {
      triangle,
      ids,
      bounds: new Box3().setFromPoints([triangle.a, triangle.b, triangle.c]),
    };
  });
  const edges = new Map<
    number,
    Map<number, { face: number; forward: boolean }[]>
  >();
  const incident = points.map(() => [] as number[]),
    adjacent = faces.map(() => [] as number[]);
  faces.forEach((f, face) => {
    for (let j = 0; j < 3; j++) {
      const a = f.ids[j],
        b = f.ids[(j + 1) % 3],
        lo = Math.min(a, b),
        hi = Math.max(a, b);
      incident[a].push(face);
      if (!edges.has(lo)) edges.set(lo, new Map());
      const row = edges.get(lo)!;
      if (!row.has(hi)) row.set(hi, []);
      row.get(hi)!.push({ face, forward: a === lo });
    }
  });
  for (const row of edges.values())
    for (const uses of row.values()) {
      if (uses.length !== 2)
        fail(
          "OPEN_OR_NONMANIFOLD",
          "Each welded edge must have exactly two incident faces; close holes/remove duplicate faces.",
          key,
        );
      if (uses[0].forward === uses[1].forward)
        fail(
          "ORIENTATION",
          "Adjacent faces must traverse each shared edge in opposite directions.",
          key,
        );
      adjacent[uses[0].face].push(uses[1].face);
      adjacent[uses[1].face].push(uses[0].face);
    }
  function connected(allowed: Set<number>, start: number) {
    const seen = new Set([start]),
      queue = [start];
    for (let i = 0; i < queue.length; i++)
      for (const n of adjacent[queue[i]])
        if (allowed.has(n) && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    return seen.size === allowed.size;
  }
  for (const fs of incident)
    if (!connected(new Set(fs), fs[0]))
      fail(
        "VERTEX_NONMANIFOLD",
        "Split pinched vertices into separate objects with valid closed shells.",
        key,
      );
  if (!connected(new Set(faces.map((_, i) => i)), 0))
    fail(
      "MULTIPLE_SHELLS",
      "Use one connected closed shell per object/instance; split disconnected shells and cavities into separate objects.",
      key,
    );
  // Translation-relative signed volume accepts either global winding, including mirrors.
  let signed = 0,
    area = 0;
  for (const { triangle: t } of faces) {
    signed +=
      t.a
        .clone()
        .sub(points[0])
        .dot(t.b.clone().sub(points[0]).cross(t.c.clone().sub(points[0]))) / 6;
    area += t.getArea();
  }
  if (
    !Number.isFinite(signed) ||
    !Number.isFinite(area) ||
    Math.abs(signed) <= epsilon * area
  )
    fail(
      "DEGENERATE",
      "Shell has zero or numerically unresolved enclosed volume.",
      key,
    );
  const volume = Object.freeze({
    id,
    key,
    ior,
    sigma,
    bounds: Object.freeze({ min: tuple(bounds.min), max: tuple(bounds.max) }),
    triangleIndices: Object.freeze(indices.slice()),
  });
  return { volume, faces, points, epsilon, bounds };
}
function classify(s: Solid, point: Vector3): boolean {
  if (!s.bounds.clone().expandByScalar(s.epsilon).containsPoint(point))
    return false;
  const near = new Vector3();
  let angle = 0;
  for (const { triangle: t } of s.faces) {
    if (t.closestPointToPoint(point, near).distanceTo(point) <= s.epsilon)
      fail(
        "BOUNDARY",
        "Origin is on/within tolerance of a medium surface; move it explicitly to one side.",
        s.volume.key,
      );
    const a = t.a.clone().sub(point),
      b = t.b.clone().sub(point),
      c = t.c.clone().sub(point);
    const la = a.length(),
      lb = b.length(),
      lc = c.length();
    angle +=
      2 *
      Math.atan2(
        a.dot(b.clone().cross(c)),
        la * lb * lc + a.dot(b) * lc + b.dot(c) * la + c.dot(a) * lb,
      );
  }
  const winding = Math.abs(angle / (4 * Math.PI)),
    inside = winding > 0.5;
  if (!Number.isFinite(winding) || Math.abs(winding - (inside ? 1 : 0)) > 1e-5)
    fail(
      "CLASSIFICATION",
      "Noninteger winding: repair geometry or use a better-resolved scale.",
      s.volume.key,
    );
  // Edge/vertex hits invalidate a direction, never count both triangles of a face.
  for (const direction of directions) {
    const ray = new Ray(point, direction),
      hits: number[] = [];
    let ambiguous = false;
    for (const { triangle: t } of s.faces) {
      const hit = ray.intersectTriangle(t.a, t.b, t.c, false, new Vector3());
      if (!hit) continue;
      const bary = t.getBarycoord(hit, new Vector3());
      if (!bary || Math.min(bary.x, bary.y, bary.z) < 1e-8) {
        ambiguous = true;
        break;
      }
      hits.push(hit.distanceTo(point));
    }
    if (ambiguous) continue;
    hits.sort((a, b) => a - b);
    const crossings = hits.filter(
      (t, i) => i === 0 || t - hits[i - 1] > s.epsilon,
    ).length;
    if ((crossings % 2 === 1) !== inside)
      fail(
        "CLASSIFICATION",
        "Independent winding/ray classifications disagree; repair the shell.",
        s.volume.key,
      );
  }
  return inside;
}
function touches(a: Face, b: Face, epsilon: number): boolean {
  if (!a.bounds.clone().expandByScalar(epsilon).intersectsBox(b.bounds))
    return false;
  const av = [a.triangle.a, a.triangle.b, a.triangle.c],
    bv = [b.triangle.a, b.triangle.b, b.triangle.c],
    near = new Vector3();
  for (const p of av)
    if (b.triangle.closestPointToPoint(p, near).distanceTo(p) <= epsilon)
      return true;
  for (const p of bv)
    if (a.triangle.closestPointToPoint(p, near).distanceTo(p) <= epsilon)
      return true;
  for (const [v, target] of [
    [av, b.triangle],
    [bv, a.triangle],
  ] as const)
    for (let i = 0; i < 3; i++) {
      const direction = v[(i + 1) % 3].clone().sub(v[i]),
        length = direction.length(),
        ray = new Ray(v[i], direction.divideScalar(length));
      const hit = ray.intersectTriangle(
        target.a,
        target.b,
        target.c,
        false,
        new Vector3(),
      );
      if (hit && hit.distanceTo(v[i]) <= length + epsilon) return true;
    }
  // Coplanar contact also needs edge/edge distance.
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const d = av[(i + 1) % 3].clone().sub(av[i]),
        length = d.length(),
        onRay = new Vector3();
      new Ray(av[i], d.divideScalar(length)).distanceSqToSegment(
        bv[j],
        bv[(j + 1) % 3],
        onRay,
        near,
      );
      if (
        onRay.distanceTo(near) <= epsilon &&
        onRay.distanceTo(av[i]) <= length + epsilon
      )
        return true;
    }
  return false;
}
/** CPU catalog for properly nested, connected, closed transmissive shells. */
export function createMediumCatalog(snapshot: SurfaceScene): MediumCatalog {
  if (snapshot.version !== 1) fail("INPUT", "Expected SurfaceScene version 1.");
  const materials = new Map<string, Physical>();
  for (const m of snapshot.materials) {
    if (!m.uuid || materials.has(m.uuid))
      fail(
        "MATERIAL_ID",
        "Material UUIDs must be unique and nonempty.",
        m.uuid,
      );
    const p = m as Physical,
      transmission = p.transmission ?? 0;
    if (!Number.isFinite(transmission) || transmission < 0 || transmission > 1)
      fail("MATERIAL", "Transmission must be finite and in [0,1].", m.uuid);
    materials.set(m.uuid, p);
  }
  const groups = new Map<string, { indices: number[]; transmitting: number }>();
  snapshot.triangles.forEach((t: SurfaceTriangle, index) => {
    if (
      typeof t.objectUuid !== "string" ||
      !t.objectUuid ||
      !Number.isSafeInteger(t.instanceId) ||
      t.instanceId < 0
    )
      fail(
        "IDENTITY",
        "Require nonempty object UUID and nonnegative safe integer instance ID.",
      );
    const key = JSON.stringify([t.objectUuid, t.instanceId]),
      m = materials.get(t.materialUuid);
    if (!m)
      fail("MATERIAL_ID", "Triangle references an unknown material UUID.", key);
    if (!groups.has(key)) groups.set(key, { indices: [], transmitting: 0 });
    const group = groups.get(key)!;
    group.indices.push(index);
    if ((m!.transmission ?? 0) > 0) group.transmitting++;
  });
  const solids: Solid[] = [];
  for (const [key, group] of groups) {
    if (!group.transmitting) continue;
    if (group.transmitting !== group.indices.length)
      fail(
        "PARTIAL_TRANSMISSION",
        "Every triangle of a volume object/instance must transmit; opaque coatings are not supported.",
        key,
      );
    let properties: ReturnType<typeof optical> | undefined;
    for (const index of group.indices) {
      const t = snapshot.triangles[index],
        p = optical(materials.get(t.materialUuid)!, key);
      if (
        properties &&
        (properties.ior !== p.ior ||
          properties.sigma.some((s, i) => s !== p.sigma[i]))
      )
        fail(
          "INCONSISTENT_MEDIUM",
          "IOR and absorption must agree across all faces; split true phase interfaces into nested objects.",
          key,
        );
      properties = p;
      const n = t.normalMatrix;
      if (n.length !== 9 || !n.every(Number.isFinite))
        fail(
          "MATRIX",
          "Expected a finite 3x3 inverse-transpose normal matrix.",
          key,
        );
      const det =
        n[0] * (n[4] * n[8] - n[5] * n[7]) -
        n[3] * (n[1] * n[8] - n[2] * n[7]) +
        n[6] * (n[1] * n[5] - n[2] * n[4]);
      if (!Number.isFinite(det) || det === 0)
        fail(
          "MATRIX",
          "A medium transform must be nonsingular; negative determinant is supported.",
          key,
        );
    }
    solids.push(
      build(
        group.indices,
        snapshot,
        solids.length + 1,
        key,
        properties!.ior,
        properties!.sigma,
      ),
    );
  }
  const containers = solids.map(() => new Set<number>());
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i],
        b = solids[j],
        epsilon = Math.max(a.epsilon, b.epsilon);
      if (!a.bounds.clone().expandByScalar(epsilon).intersectsBox(b.bounds))
        continue;
      for (const fa of a.faces)
        for (const fb of b.faces)
          if (touches(fa, fb, epsilon))
            fail(
              "OVERLAP",
              "Medium boundaries intersect/touch; only disjoint or strictly nested shells are supported. Other key: " +
                b.volume.key,
              a.volume.key,
            );
      if (classify(a, b.points[0])) containers[j].add(i);
      if (classify(b, a.points[0])) containers[i].add(j);
    }
  const order = solids
    .map((_, i) => i)
    .sort((a, b) => containers[a].size - containers[b].size || a - b);
  const volumes = Object.freeze(solids.map((s) => s.volume));
  const tolerances = Object.freeze(
    solids.map((s) => Object.freeze({ id: s.volume.id, weld: s.epsilon })),
  );
  const nesting = Object.freeze(
    solids.map((s, i) => {
      const chain = [...containers[i]].sort(
        (a, b) => containers[b].size - containers[a].size,
      );
      for (let c = 1; c < chain.length; c++)
        if (!containers[chain[c - 1]].has(chain[c]))
          fail(
            "OVERLAP",
            "Containers do not form a proper nesting chain.",
            s.volume.key,
          );
      return Object.freeze({
        id: s.volume.id,
        parentId: chain.length ? solids[chain[0]].volume.id : 0,
      });
    }),
  );
  let disposed = false;
  function alive() {
    if (disposed) fail("DISPOSED", "Create a new catalog after dispose().");
  }
  return Object.freeze({
    get volumes() {
      alive();
      return volumes;
    },
    initial(origin: SurfaceVec3): readonly number[] {
      alive();
      const point = vector(origin, "origin"),
        result: number[] = [];
      for (const index of order)
        if (classify(solids[index], point))
          result.push(solids[index].volume.id);
      return Object.freeze(result);
    },
    inspect(): MediumInspection {
      return Object.freeze({
        disposed,
        volumes: disposed ? Object.freeze([]) : volumes,
        tolerance: disposed ? Object.freeze([]) : tolerances,
        nesting: disposed ? Object.freeze([]) : nesting,
      });
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        solids.length = 0;
        containers.length = 0;
        order.length = 0;
      }
    },
  });
}
