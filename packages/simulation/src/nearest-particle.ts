import type { Simulation } from "../../../experiments/simulation/index.ts";
import type { IndexedParticleHit, SimulationParticleHit, Vec3 } from "../../sdk/src/index.ts";

function checkedPosition(point: Vec3, maxDistance: number, code: string): void {
  if (!Array.isArray(point) || point.length !== 3 || !point.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6) ||
      typeof maxDistance !== "number" || !Number.isFinite(maxDistance) || maxDistance < 0 || maxDistance > 1e6)
    throw new Error(`${code}: Use a finite world position and nonnegative search distance with magnitude at most 1e6.`);
}

export function nearestIndexedParticle(positions: readonly Vec3[], point: Vec3, maxDistance: number, code: string): IndexedParticleHit | null {
  checkedPosition(point, maxDistance, code);
  let best: IndexedParticleHit | null = null;
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index];
    const distance = Math.hypot(position[0] - point[0], position[1] - point[1], position[2] - point[2]);
    if (distance <= maxDistance && (!best || distance < best.distance))
      best = { index, position: [position[0], position[1], position[2]], distance };
  }
  return best;
}

export function nearestParticle(simulation: Simulation, point: Vec3, maxDistance: number, code: string): SimulationParticleHit | null {
  checkedPosition(point, maxDistance, code);
  let best: SimulationParticleHit | null = null;
  for (const particle of simulation.getRenderState().particles) {
    const distance = Math.hypot(particle.position[0] - point[0], particle.position[1] - point[1], particle.position[2] - point[2]);
    if (distance <= maxDistance && (!best || distance < best.distance))
      best = { particle: particle.id, position: [...particle.position], distance };
  }
  return best;
}
