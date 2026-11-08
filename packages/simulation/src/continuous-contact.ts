import { createBoxFrame, orientedParticleBoxContact } from "./box-contact.ts";
import type { RopeCollider, Vec3 } from "./rope.ts";

export interface SweptContact { normal: Vec3; depth: number; time: number }
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Linear sphere sweep. The normal points from the obstacle toward the particle. */
export function sweepSphere(start: Vec3, end: Vec3, centerStart: Vec3, centerEnd: Vec3, radius: number): SweptContact | null {
  const origin = sub(start, centerStart), travel = sub(sub(end, start), sub(centerEnd, centerStart));
  const a = dot(travel, travel), b = dot(origin, travel), c = dot(origin, origin) - radius * radius;
  if (a < 1e-24) return null;
  if (c <= 0) {
    const length = Math.hypot(...origin);
    if (length < 1e-12 || b >= 0) return null;
    const normal = origin.map(v => v / length) as Vec3, depth = radius - dot(sub(end, centerEnd), normal);
    return depth > 0 ? { normal, depth, time: 0 } : null;
  }
  if (b >= 0) return null;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const time = c / (-b + Math.sqrt(discriminant));
  if (time < 0 || time > 1) return null;
  const relative = sub(at(start, end, time), at(centerStart, centerEnd, time)), length = Math.hypot(...relative);
  if (length < 1e-12) return null;
  const normal: Vec3 = [relative[0] / length, relative[1] / length, relative[2] / length];
  const depth = radius - dot(sub(end, centerEnd), normal);
  return depth > 0 ? { normal, depth, time } : null;
}

/** Exact rounded-box distance with conservative advancement, not an inflated-AABB hit. */
export function sweepParticle(start: Vec3, end: Vec3, radius: number, collider: RopeCollider): SweptContact | null {
  if (collider.kind === "sphere") return sweepSphere(start, end, collider.center, collider.center, radius + collider.radius);
  if (collider.kind === "plane") {
    const first = dot(start, collider.normal) - collider.offset - radius;
    const last = dot(end, collider.normal) - collider.offset - radius;
    return first > 0 && last < 0 ? { normal: [...collider.normal], depth: -last, time: first / (first - last) } : null;
  }
  const frame = createBoxFrame(collider.center, collider.rotation ?? [0, 0, 0]);
  const a = frame.toLocalPoint(start), b = frame.toLocalPoint(end), travel = sub(b, a), speed = Math.hypot(...travel);
  if (speed < 1e-12) return null;
  const initial = orientedParticleBoxContact(start, radius, collider.center, collider.halfExtents, frame);
  if (initial) {
    const movement = dot(sub(end, start), initial.normal), depth = initial.depth - movement;
    return movement < 0 && depth > 0 ? { normal: initial.normal, depth, time: 0 } : null;
  }
  const tolerance = Math.max(1e-9, radius * 1e-6);
  let time = 0;
  for (let iteration = 0; iteration < 96; iteration++) {
    const point = at(a, b, time), closest = point.map((v, axis) => Math.max(-collider.halfExtents[axis], Math.min(collider.halfExtents[axis], v))) as Vec3;
    const delta = sub(point, closest), distance = Math.hypot(...delta), separation = distance - radius;
    if (separation <= tolerance) {
      if (distance < 1e-12) return null;
      const normal = frame.toWorldDirection(delta.map(v => v / distance) as Vec3);
      const surface = frame.toWorldPoint(closest), depth = radius - dot(sub(end, surface), normal);
      return depth > 0 ? { normal, depth, time } : null;
    }
    const advance = separation / speed;
    if (time + advance > 1) return null;
    time += Math.max(advance, Number.EPSILON);
  }
  throw new Error(`TC_SIMULATION_CCD_LIMIT: Box '${collider.id}' sweep did not converge; reduce the fixed timestep or travel distance.`);
}

/** Position-level Coulomb projection for an immovable contact. */
export function staticContactCorrection(normal: Vec3, depth: number, position: Vec3, previous: Vec3, friction = 0.5): Vec3 {
  const travel = sub(position, previous), normalTravel = dot(travel, normal);
  const tangent = travel.map((v, axis) => v - normal[axis] * normalTravel) as Vec3, length = Math.hypot(...tangent);
  const factor = length > 1e-12 ? Math.min(1, friction * depth / length) : 0;
  return normal.map((v, axis) => v * depth - tangent[axis] * factor) as Vec3;
}
