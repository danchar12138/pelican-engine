import type { RopeSelfContact, Vec3 } from "./rope.ts";

type Bounds = { index: number; minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const fail = (message: string): never => { throw new Error(`ROPE_NUMERIC: ${message}`); };

/** Closest points of finite line segments; handles collapsed and near-parallel links. */
function closest(a: Vec3, b: Vec3, c: Vec3, d: Vec3): { first: number; second: number; firstPoint: Vec3; secondPoint: Vec3 } {
  const u = sub(b, a), v = sub(d, c), w = sub(a, c);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), uw = dot(u, w), vw = dot(v, w);
  let first = 0, second = 0;
  if (uu <= 1e-24 && vv <= 1e-24) { /* both points */ }
  else if (uu <= 1e-24) second = clamp(vw / vv);
  else if (vv <= 1e-24) first = clamp(-uw / uu);
  else {
    const denominator = uu * vv - uv * uv;
    if (denominator > 1e-12 * uu * vv) first = clamp((uv * vw - uw * vv) / denominator);
    second = (uv * first + vw) / vv;
    if (second < 0) { second = 0; first = clamp(-uw / uu); }
    else if (second > 1) { second = 1; first = clamp((uv - uw) / uu); }
  }
  const firstPoint: Vec3 = [a[0] + u[0] * first, a[1] + u[1] * first, a[2] + u[2] * first];
  const secondPoint: Vec3 = [c[0] + v[0] * second, c[1] + v[1] * second, c[2] + v[2] * second];
  if (![first, second, ...firstPoint, ...secondPoint].every(Number.isFinite)) fail("self-contact closest point is not finite");
  return { first, second, firstPoint, secondPoint };
}
function fallbackNormal(firstDirection: Vec3, secondDirection: Vec3): Vec3 {
  let normal = cross(firstDirection, secondDirection), magnitude = Math.hypot(...normal);
  if (magnitude < 1e-12) {
    const direction = dot(firstDirection, firstDirection) >= dot(secondDirection, secondDirection) ? firstDirection : secondDirection;
    const [x, y, z] = direction.map(Math.abs);
    const axis: Vec3 = x <= y && x <= z ? [1, 0, 0] : y <= z ? [0, 1, 0] : [0, 0, 1];
    normal = cross(direction, axis); magnitude = Math.hypot(...normal);
  }
  return magnitude < 1e-12 ? [1, 0, 0] : [normal[0] / magnitude, normal[1] / magnitude, normal[2] / magnitude];
}

/** Sweep-and-prune broadphase followed by discrete capsule-segment projection.
 * Bounds are rebuilt each iteration; contacts created by a correction may wait for the next pass.
 * Adjacent segments are excluded. The caller owns rollback for these temporary positions. */
export function resolveRopeSelfCollisions(
  positions: Vec3[], anchors: ReadonlyMap<number, Vec3>, radius: number, tick: number,
  contacts: Map<string, RopeSelfContact>,
): void {
  if (positions.some(point => point.some(value => !Number.isFinite(value) || Math.abs(value) > 1e6)))
    fail("particle position exceeded finite bounds before self-contact");
  const bounds: Bounds[] = [];
  for (let index = 0; index < positions.length - 1; index++) {
    const a = positions[index], b = positions[index + 1];
    bounds.push({ index, minX: Math.min(a[0], b[0]) - radius, maxX: Math.max(a[0], b[0]) + radius,
      minY: Math.min(a[1], b[1]) - radius, maxY: Math.max(a[1], b[1]) + radius,
      minZ: Math.min(a[2], b[2]) - radius, maxZ: Math.max(a[2], b[2]) + radius });
  }
  bounds.sort((a, b) => a.minX - b.minX || a.index - b.index);
  for (let left = 0; left < bounds.length; left++) {
    const x = bounds[left];
    for (let right = left + 1; right < bounds.length && bounds[right].minX <= x.maxX; right++) {
      const y = bounds[right];
      if (Math.abs(x.index - y.index) <= 1 || x.minY > y.maxY || y.minY > x.maxY || x.minZ > y.maxZ || y.minZ > x.maxZ) continue;
      const firstSegment = Math.min(x.index, y.index), secondSegment = Math.max(x.index, y.index);
      const a = positions[firstSegment], b = positions[firstSegment + 1], c = positions[secondSegment], d = positions[secondSegment + 1];
      const contact = closest(a, b, c, d), delta = sub(contact.firstPoint, contact.secondPoint), distance = Math.hypot(...delta);
      const penetration = 2 * radius - distance;
      if (!Number.isFinite(penetration)) fail("self-contact penetration is not finite");
      if (penetration <= 0) continue;
      const normal: Vec3 = distance < 1e-12 ? fallbackNormal(sub(b, a), sub(d, c)) : [delta[0] / distance, delta[1] / distance, delta[2] / distance];
      const indices = [firstSegment, firstSegment + 1, secondSegment, secondSegment + 1];
      const gradients = [1 - contact.first, contact.first, -(1 - contact.second), -contact.second]
        .map((weight, index) => anchors.has(indices[index]) ? 0 : weight);
      const weight = gradients.reduce((sum, value) => sum + value * value, 0);
      if (weight === 0) continue; // four immovable endpoints cannot be projected
      const magnitude = penetration / weight;
      if (!Number.isFinite(magnitude)) fail("self-contact projection exceeded finite bounds");
      for (let i = 0; i < 4; i++) for (let axis = 0; axis < 3; axis++) {
        const value = positions[indices[i]][axis] + normal[axis] * magnitude * gradients[i];
        if (!Number.isFinite(value) || Math.abs(value) > 1e6) fail("self-contact correction exceeded finite bounds");
        positions[indices[i]][axis] = value;
      }
      const key = `${firstSegment}:${secondSegment}`, existing = contacts.get(key);
      if (existing) {
        existing.penetration = Math.max(existing.penetration, penetration);
        existing.firstFraction = contact.first; existing.secondFraction = contact.second;
      } else contacts.set(key, { tick, firstSegment, secondSegment, firstFraction: contact.first, secondFraction: contact.second, penetration });
    }
  }
}
