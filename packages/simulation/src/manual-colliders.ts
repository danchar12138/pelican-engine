import { cloneSerializable } from "../../runtime/src/random.ts";
import type { Simulation, SimulationCollider } from "../../../experiments/simulation/index.ts";
import type { ParticleSimulationCollider } from "../../sdk/src/index.ts";

export function checkColliderBindings(value: unknown, bindings: readonly { id: string }[], code: string): void {
  if (!Array.isArray(value)) return; // The solver reports malformed input.
  const bound = new Set(bindings.map(binding => binding.id));
  if (value.some(collider => collider && typeof collider === "object" && bound.has(collider.id)))
    throw new Error(`${code}: Manual collider IDs must not conflict with bound body collider IDs.`);
}

export function setManualColliders(simulation: Simulation, input: readonly ParticleSimulationCollider[], bindings: readonly { id: string }[], code: string): void {
  const colliders = cloneSerializable(input);
  checkColliderBindings(colliders, bindings, code);
  simulation.setColliders(colliders as readonly SimulationCollider[]);
}
