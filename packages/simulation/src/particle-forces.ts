import type { Simulation } from "../../../experiments/simulation/index.ts";
import type { SimulationForce } from "../../sdk/src/index.ts";

export function applyParticleForces(simulation: Simulation, input: readonly SimulationForce[], code: string): void {
  if (!Array.isArray(input) || input.length > 512)
    throw new Error(`${code}: Expected an array of at most 512 particle forces.`);
  const forces = input.map(item => {
    if (!item || typeof item !== "object" || typeof item.particle !== "string" || !/^particle:(0|[1-9]\d*)$/.test(item.particle) ||
        !Array.isArray(item.force) || item.force.length !== 3 ||
        !item.force.every((value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100))
      throw new Error(`${code}: Each entry needs a particle ID and finite force components in [-100,100].`);
    return { id: item.particle, force: [item.force[0], item.force[1], item.force[2]] as [number, number, number] };
  });
  simulation.applyForces(forces);
}
