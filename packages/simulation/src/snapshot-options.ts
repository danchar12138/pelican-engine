import { sameSimulationContainer } from "../../../experiments/simulation/scenes.ts";
import type { ResolvedOptions } from "../../../experiments/simulation/types.ts";

const sameVector = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function differingSimulationOption(
  actual: ResolvedOptions,
  expected: ResolvedOptions,
  kind: "fluid" | "softbody",
  bound: boolean,
): string | undefined {
  for (const key of ["seed", "fixedDt", "substeps", "iterations", "contacts"] as const)
    if (actual[key] !== expected[key]) return key;
  // Binding can update coupling independently of the initial solver configuration.
  if (!bound && actual.twoWayCoupling !== expected.twoWayCoupling) return "twoWayCoupling";
  for (const key of ["gravity", "bodyPosition", "bodyVelocity"] as const)
    if (!sameVector(actual[key], expected[key])) return key;
  if (!sameVector(actual.origin ?? [0, 0, 0], expected.origin ?? [0, 0, 0])) return "origin";
  if (!sameSimulationContainer(actual.container, expected.container)) return "container";
  if (kind === "fluid" && !sameVector(actual.particleGrid ?? [4, 4, 4], expected.particleGrid ?? [4, 4, 4])) return "particleGrid";
  if (kind === "softbody" && !sameVector(actual.softBodyGrid ?? [3, 3, 3], expected.softBodyGrid ?? [3, 3, 3])) return "softBodyGrid";
  return undefined;
}
