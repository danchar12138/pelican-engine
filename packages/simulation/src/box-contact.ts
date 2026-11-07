type Vec3 = [number, number, number];

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
