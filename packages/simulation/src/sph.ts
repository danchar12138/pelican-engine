import type { PointState, Vec3 } from "../../../experiments/simulation/types.ts";
import { accumulate, add, dot, length, mul, sub } from "../../../experiments/simulation/math.ts";

export const FLUID_REST_DENSITY = 1;
const smoothing = 0.34, stiffness = 12, viscosity = 0.025;
/** The same WCSPH field is used by isolated/manual and shared-clock fluid worlds. */
export function fluidField(points: readonly PointState[]) {
  if (points.length > 131072 || points.some(p => !Number.isFinite(p.inverseMass) || p.inverseMass <= 0 || [...p.position, ...p.velocity].some(v => !Number.isFinite(v) || Math.abs(v) > 1e6)))
    throw new Error("TC_FLUID_FIELD_INPUT: Supply at most 131072 finite, positive-mass fluid particles.");
  const buckets = new Map<string, number[]>(), key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
  const cells = points.map(p => p.position.map(value => Math.floor(value / smoothing)) as Vec3);
  for (const [index, [x, y, z]] of cells.entries()) { const id = key(x, y, z), bucket = buckets.get(id); if (bucket) bucket.push(index); else buckets.set(id, [index]); }
  let candidates = 0;
  const neighbors = cells.map(([x, y, z]) => {
    const indices: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const bucket = buckets.get(key(x + dx, y + dy, z + dz));
      if (bucket) {
        candidates += bucket.length;
        if (candidates > 2000000) throw new Error("TC_FLUID_FIELD_CAPACITY: More than 2000000 shared neighbors; reduce overlapping fluid density or partition the world.");
        indices.push(...bucket);
      }
    }
    return indices.sort((a, b) => a - b);
  });
  const h2 = smoothing ** 2, poly6 = 315 / (64 * Math.PI * smoothing ** 9), kernel = 45 / (Math.PI * smoothing ** 6);
  const density = points.map((p, i) => {
    let rho = 0;
    for (const j of neighbors[i]) { const delta = sub(p.position, points[j].position), r2 = dot(delta, delta); if (r2 < h2) rho += (1 / points[j].inverseMass) * poly6 * (h2 - r2) ** 3; }
    return rho;
  });
  const pressure = density.map(rho => stiffness * Math.max(0, rho - FLUID_REST_DENSITY)), forces: Vec3[] = points.map(() => [0, 0, 0]);
  for (let i = 0; i < points.length; i++) for (const j of neighbors[i]) {
    if (j <= i) continue;
    const delta = sub(points[i].position, points[j].position), r = length(delta);
    if (r >= smoothing || r < 1e-10) continue;
    const mi = 1 / points[i].inverseMass, mj = 1 / points[j].inverseMass, d = smoothing - r;
    const pressureForce = mul(delta, (mi * mj * (pressure[i] / density[i] ** 2 + pressure[j] / density[j] ** 2) * kernel * d ** 2) / r);
    const viscousForce = mul(sub(points[j].velocity, points[i].velocity), ((viscosity * mi * mj) / (density[i] * density[j])) * kernel * d);
    const force = add(pressureForce, viscousForce);
    accumulate(forces[i], force); accumulate(forces[j], force, -1);
  }
  return { density, pressure, acceleration: forces.map((force, i) => mul(force, points[i].inverseMass)) };
}
