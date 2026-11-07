import {
  copy,
  fail,
  isVec3,
  length,
  seededRandom,
  sub,
  volume,
} from "./math.ts";
import type {
  PointState,
  ResolvedOptions,
  SimulationKind,
  SimulationOptions,
  SimulationSnapshot,
  Vec3,
} from "./types.ts";
export const KINDS: SimulationKind[] = ["rope", "cloth", "softbody", "fluid"];
export const DEFAULT_SIMULATION_CONTAINER = { min: [-1.35, -1.05, -1.1], max: [1.35, 1.65, 1.1] } as const;
export function sameSimulationContainer(first: unknown, second: unknown): boolean {
  const a = (first ?? DEFAULT_SIMULATION_CONTAINER) as { min?: unknown; max?: unknown };
  const b = (second ?? DEFAULT_SIMULATION_CONTAINER) as { min?: unknown; max?: unknown };
  return !!a && !!b && Array.isArray(a.min) && Array.isArray(a.max) && Array.isArray(b.min) && Array.isArray(b.max) &&
    a.min.length === 3 && a.max.length === 3 && b.min.length === 3 && b.max.length === 3 &&
    a.min.every((value, axis) => value === (b.min as number[])[axis]) &&
    a.max.every((value, axis) => value === (b.max as number[])[axis]);
}
export function resolveOptions(
  kind: SimulationKind,
  options: SimulationOptions = {},
): ResolvedOptions {
  if (!KINDS.includes(kind))
    fail("SIM_KIND", `Unknown simulation kind: ${kind}`);
  const result: ResolvedOptions = {
    seed: options.seed ?? 12345,
    fixedDt: options.fixedDt ?? 1 / 60,
    substeps: options.substeps ?? 6,
    iterations: options.iterations ?? 8,
    twoWayCoupling: options.twoWayCoupling ?? true,
    contacts: options.contacts ?? true,
    gravity: copy(options.gravity ?? [0, -2, 0]),
    ...(options.origin === undefined ? {} : { origin: copy(options.origin) }),
    ...(options.container === undefined ? {} : { container: copy(options.container) }),
    ...(options.particleGrid === undefined ? {} : { particleGrid: copy(options.particleGrid) }),
    ...(options.softBodyGrid === undefined ? {} : { softBodyGrid: copy(options.softBodyGrid) }),
    bodyPosition: copy(
      options.bodyPosition ??
        (kind === "cloth" ? [0.08, 0.15, -0.72] : [-0.78, 0.15, 0]).map((value, axis) => value + (options.origin?.[axis] ?? 0)) as Vec3,
    ),
    bodyVelocity: copy(
      options.bodyVelocity ?? (kind === "cloth" ? [0, 0, 1.6] : [1.6, 0, 0]),
    ),
  };
  if (
    !Number.isSafeInteger(result.seed) ||
    result.seed < 0 ||
    result.seed > 0xffffffff
  )
    fail("SIM_OPTIONS", "seed must be an unsigned 32-bit integer.");
  if (
    !Number.isFinite(result.fixedDt) ||
    result.fixedDt < 1 / 1000 ||
    result.fixedDt > 1 / 30
  )
    fail("SIM_OPTIONS", "fixedDt must be between 1/1000 and 1/30 seconds.");
  for (const key of ["substeps", "iterations"] as const) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 32)
      fail("SIM_OPTIONS", `${key} must be an integer in [1,32].`);
  }
  if (
    typeof result.contacts !== "boolean" ||
    typeof result.twoWayCoupling !== "boolean"
  )
    fail("SIM_OPTIONS", "Contact options must be boolean.");
  for (const key of ["gravity", "bodyPosition", "bodyVelocity", "origin"] as const) {
    if (key === "origin" && result.origin === undefined) continue;
    if (!isVec3(result[key]) || result[key].some((x) => Math.abs(x) > 100))
      fail(
        "SIM_OPTIONS",
        `${key} must contain three finite values in [-100,100].`,
      );
  }
  if (result.container !== undefined && (!result.container || !isVec3(result.container.min) || !isVec3(result.container.max) ||
      result.container.min.some((value, axis) => Math.abs(value) > 100 || Math.abs(result.container!.max[axis]) > 100 || result.container!.max[axis] - value <= 0.5)))
    fail("SIM_OPTIONS", "container bounds must be finite vectors in [-100,100], with each span greater than 0.5.");
  if (result.particleGrid !== undefined && (kind !== "fluid" || !isVec3(result.particleGrid) ||
      result.particleGrid.some(value => !Number.isSafeInteger(value) || value < 1 || value > 8)))
    fail("SIM_OPTIONS", "particleGrid is fluid-only and requires three integer dimensions in [1,8].");
  if (result.softBodyGrid !== undefined && (kind !== "softbody" || !isVec3(result.softBodyGrid) ||
      result.softBodyGrid.some(value => !Number.isSafeInteger(value) || value < 2 || value > 5)))
    fail("SIM_OPTIONS", "softBodyGrid is soft-body-only and requires three integer dimensions in [2,5].");
  return result;
}
export function makeScene(
  kind: SimulationKind,
  options: ResolvedOptions,
): SimulationSnapshot {
  const s: SimulationSnapshot = {
    format: "pelican-m0-simulation",
    version: 1,
    kind,
    options: copy(options),
    tick: 0,
    bodies: [
      {
        id: "body:0",
        position: copy(options.bodyPosition),
        velocity: copy(options.bodyVelocity),
        inverseMass: 1 / 0.35,
        radius: 0.25,
      },
    ],
    particles: [],
    distances: [],
    volumes: [],
    triangles: [],
    counters: {
      contactCount: 0,
      reactionImpulse: [0, 0, 0],
      absoluteReactionImpulse: 0,
      maxContactCorrection: 0,
      maxObservedSpeed: 0,
    },
  };
  const rng = seededRandom(options.seed);
  const particle = (
    position: Vec3,
    pinned = false,
    radius = 0.045,
    mass = 0.025,
  ): number => {
    const index = s.particles.length;
    // Seeded small perturbation breaks symmetry; no random forces / prescribed trajectories.
    const p = position.map(
      (x, axis) => x + (options.origin?.[axis] ?? 0) + (pinned ? 0 : (rng() - 0.5) * 0.001),
    ) as Vec3;
    s.particles.push({
      id: `particle:${index}`,
      position: p,
      velocity: [0, 0, 0],
      radius,
      inverseMass: pinned ? 0 : 1 / mass,
    });
    return index;
  };
  const edges = new Set<string>();
  const link = (a: number, b: number, compliance = 1e-7): void => {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    if (edges.has(key)) return;
    edges.add(key);
    s.distances.push({
      a,
      b,
      restLength: length(sub(s.particles[a].position, s.particles[b].position)),
      compliance,
    });
  };
  if (kind === "rope") {
    for (let i = 0; i < 15; i++)
      particle([0, 1.15 - i * 0.12, 0], i === 0, 0.055, 0.04);
    for (let i = 0; i < 14; i++) link(i, i + 1);
    for (let i = 0; i < 13; i++) link(i, i + 2, 2e-4);
  } else if (kind === "cloth") {
    const n = 7;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        particle(
          [-0.6 + x * 0.2, 1 - y * 0.2, 0],
          y === 0 && (x === 0 || x === n - 1),
          0.045,
          0.015,
        );
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (x + 1 < n) link(i, i + 1);
        if (y + 1 < n) link(i, i + n);
        if (x + 1 < n && y + 1 < n) {
          link(i, i + n + 1);
          link(i + 1, i + n);
          s.triangles.push([i, i + n, i + 1], [i + 1, i + n, i + n + 1]);
        }
        if (x + 2 < n) link(i, i + 2, 5e-5);
        if (y + 2 < n) link(i, i + 2 * n, 5e-5);
      }
  } else if (kind === "softbody") {
    const [width, height, depth] = options.softBodyGrid ?? [3, 3, 3];
    const index = (x: number, y: number, z: number): number =>
      z * width * height + y * width + x;
    for (let z = 0; z < depth; z++)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          particle(
            [(x - (width - 1) / 2) * 0.24, 0.2 + (y - (height - 1) / 2) * 0.24, (z - (depth - 1) / 2) * 0.24],
            false,
            0.085,
            0.025,
          );
    const faces = new Map<string, [number, number, number]>();
    for (let z = 0; z < depth - 1; z++)
      for (let y = 0; y < height - 1; y++)
        for (let x = 0; x < width - 1; x++) {
          const v = [
            index(x, y, z),
            index(x + 1, y, z),
            index(x, y + 1, z),
            index(x + 1, y + 1, z),
            index(x, y, z + 1),
            index(x + 1, y, z + 1),
            index(x, y + 1, z + 1),
            index(x + 1, y + 1, z + 1),
          ];
          for (const local of [
            [0, 1, 3, 7],
            [0, 3, 2, 7],
            [0, 2, 6, 7],
            [0, 6, 4, 7],
            [0, 4, 5, 7],
            [0, 5, 1, 7],
          ]) {
            const t = local.map((i) => v[i]) as [
              number,
              number,
              number,
              number,
            ];
            if (
              volume(
                ...(t.map((i) => s.particles[i].position) as [
                  Vec3,
                  Vec3,
                  Vec3,
                  Vec3,
                ]),
              ) < 0
            )
              [t[1], t[2]] = [t[2], t[1]];
            s.volumes.push({
              indices: t,
              restVolume: volume(
                ...(t.map((i) => s.particles[i].position) as [
                  Vec3,
                  Vec3,
                  Vec3,
                  Vec3,
                ]),
              ),
              compliance: 1e-10,
            });
            for (let a = 0; a < 4; a++)
              for (let b = a + 1; b < 4; b++) link(t[a], t[b], 2e-6);
            // Outward winding for a positively oriented tetrahedron. Shared interior faces cancel.
            for (const face of [
              [t[1], t[2], t[3]],
              [t[0], t[3], t[2]],
              [t[0], t[1], t[3]],
              [t[0], t[2], t[1]],
            ] as [number, number, number][]) {
              const key = [...face].sort((a, b) => a - b).join(":");
              if (faces.has(key)) faces.delete(key);
              else faces.set(key, face);
            }
          }
        }
    s.triangles = [...faces.values()];
  } else {
    // Mass = restDensity * latticeSpacing^3, with restDensity = 1.
    const [width, height, depth] = options.particleGrid ?? [4, 4, 4];
    for (let z = 0; z < depth; z++)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          particle(
            [(x - (width - 1) / 2) * 0.16, 0.22 + (y - (height - 1) / 2) * 0.16, (z - (depth - 1) / 2) * 0.16],
            false,
            0.055,
            0.16 ** 3,
          );
  }
  return s;
}
export function allPoints(s: SimulationSnapshot): PointState[] {
  return [...s.bodies, ...s.particles];
}
