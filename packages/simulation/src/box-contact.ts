type Vec3 = [number, number, number];
export interface BoxFrame {
  toLocalPoint(point: Vec3): Vec3;
  toWorldPoint(point: Vec3): Vec3;
  toWorldDirection(direction: Vec3): Vec3;
}

/** XYZ Euler box basis; compute once per solver tick, not once per contact. */
export function createBoxFrame(center: Vec3, rotation: Vec3): BoxFrame {
  const [x, y, z] = rotation.map(value => value / 2);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const qx = sx * cy * cz + cx * sy * sz, qy = cx * sy * cz - sx * cy * sz;
  const qz = cx * cy * sz + sx * sy * cz, qw = cx * cy * cz - sx * sy * sz;
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const toWorldDirection = (v: Vec3): Vec3 => [m00 * v[0] + m01 * v[1] + m02 * v[2], m10 * v[0] + m11 * v[1] + m12 * v[2], m20 * v[0] + m21 * v[1] + m22 * v[2]];
  return {
    toLocalPoint(point) {
      const dx = point[0] - center[0], dy = point[1] - center[1], dz = point[2] - center[2];
      return [m00 * dx + m10 * dy + m20 * dz, m01 * dx + m11 * dy + m21 * dz, m02 * dx + m12 * dy + m22 * dz];
    },
    toWorldPoint(point) { const v = toWorldDirection(point); return [v[0] + center[0], v[1] + center[1], v[2] + center[2]]; },
    toWorldDirection,
  };
}

/** Sphere-particle contact against a stationary axis-aligned box, in world space. */
export function particleBoxContact(position: Vec3, radius: number, center: Vec3, halfExtents: Vec3): { normal: Vec3; depth: number } | null {
  const relative: Vec3 = [position[0] - center[0], position[1] - center[1], position[2] - center[2]];
  const closest: Vec3 = [
    Math.max(-halfExtents[0], Math.min(halfExtents[0], relative[0])),
    Math.max(-halfExtents[1], Math.min(halfExtents[1], relative[1])),
    Math.max(-halfExtents[2], Math.min(halfExtents[2], relative[2])),
  ];
  const delta: Vec3 = [relative[0] - closest[0], relative[1] - closest[1], relative[2] - closest[2]];
  const distance = Math.hypot(...delta);
  if (distance > 0) {
    if (distance >= radius) return null;
    return { normal: [delta[0] / distance, delta[1] / distance, delta[2] / distance], depth: radius - distance };
  }
  // Inside or exactly on the boundary: choose the nearest face deterministically.
  let axis = 0, faceDistance = halfExtents[0] - Math.abs(relative[0]);
  for (let i = 1; i < 3; i++) {
    const candidate = halfExtents[i] - Math.abs(relative[i]);
    if (candidate < faceDistance) { axis = i; faceDistance = candidate; }
  }
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = relative[axis] < 0 ? -1 : 1;
  return { normal, depth: radius + faceDistance };
}

export function orientedParticleBoxContact(position: Vec3, radius: number, center: Vec3, halfExtents: Vec3, frame?: BoxFrame): { normal: Vec3; depth: number } | null {
  if (!frame) return particleBoxContact(position, radius, center, halfExtents);
  const hit = particleBoxContact(frame.toLocalPoint(position), radius, [0, 0, 0], halfExtents);
  return hit ? { normal: frame.toWorldDirection(hit.normal), depth: hit.depth } : null;
}

/** Find an interior closest point on a segment and resolve it as a radius-bearing point. */
export function segmentBoxContact(a: Vec3, b: Vec3, radius: number, center: Vec3, halfExtents: Vec3):
  { fraction: number; point: Vec3; normal: Vec3; depth: number } | null {
  const start: Vec3 = [a[0] - center[0], a[1] - center[1], a[2] - center[2]];
  const direction: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  if (Math.hypot(...direction) < 1e-12) return null;
  // Squared distance to an AABB is quadratic between the segment's face crossings.
  const cuts = [0, 1];
  for (let axis = 0; axis < 3; axis++) if (direction[axis] !== 0) {
    for (const face of [-halfExtents[axis], halfExtents[axis]]) {
      const t = (face - start[axis]) / direction[axis];
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  let bestT = 0, bestDistance = Infinity;
  const consider = (t: number) => {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = start[axis] + direction[axis] * t;
      const outside = Math.max(-halfExtents[axis] - coordinate, 0, coordinate - halfExtents[axis]);
      squared += outside * outside;
    }
    if (squared < bestDistance || (squared === bestDistance && Math.abs(t - 0.5) < Math.abs(bestT - 0.5))) {
      bestT = t; bestDistance = squared;
    }
  };
  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i], hi = cuts[i + 1], mid = (lo + hi) / 2;
    if (hi <= lo) continue;
    let quadratic = 0, linear = 0;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = start[axis] + direction[axis] * mid;
      const face = coordinate < -halfExtents[axis] ? -halfExtents[axis] : coordinate > halfExtents[axis] ? halfExtents[axis] : undefined;
      if (face !== undefined) {
        quadratic += direction[axis] * direction[axis];
        linear += direction[axis] * (start[axis] - face);
      }
    }
    consider(quadratic === 0 ? mid : Math.max(lo, Math.min(hi, -linear / quadratic)));
  }
  if (bestT <= 0 || bestT >= 1 || bestDistance >= radius * radius) return null;
  const point: Vec3 = [a[0] + direction[0] * bestT, a[1] + direction[1] * bestT, a[2] + direction[2] * bestT];
  const contact = particleBoxContact(point, radius, center, halfExtents);
  return contact ? { fraction: bestT, point, ...contact } : null;
}

export function orientedSegmentBoxContact(a: Vec3, b: Vec3, radius: number, center: Vec3, halfExtents: Vec3, frame?: BoxFrame):
  { fraction: number; point: Vec3; normal: Vec3; depth: number } | null {
  if (!frame) return segmentBoxContact(a, b, radius, center, halfExtents);
  const hit = segmentBoxContact(frame.toLocalPoint(a), frame.toLocalPoint(b), radius, [0, 0, 0], halfExtents);
  return hit ? { ...hit, point: frame.toWorldPoint(hit.point), normal: frame.toWorldDirection(hit.normal) } : null;
}
