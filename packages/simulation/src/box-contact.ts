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
