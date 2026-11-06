import {
  accumulate,
  add,
  copy,
  cross,
  dot,
  fail,
  isVec3,
  length,
  mul,
  sub,
  volume,
} from "./math.ts";
import { allPoints, makeScene, resolveOptions } from "./scenes.ts";
import type {
  PointState,
  Simulation,
  SimulationInspection,
  SimulationKind,
  SimulationOptions,
  SimulationRenderState,
  SimulationSnapshot,
  Vec3,
} from "./types.ts";

const REST_DENSITY = 1;
const SMOOTHING_LENGTH = 0.34;
const PRESSURE_STIFFNESS = 12;
const VISCOSITY = 0.025;
const LOWER: Vec3 = [-1.35, -1.05, -1.1];
const UPPER: Vec3 = [1.35, 1.65, 1.1];

/** Pure synchronous CPU reference solver; intentionally small O(n²) fluid neighbor search. */
export function createSimulation(
  kind: SimulationKind,
  options: SimulationOptions = {},
): Simulation {
  let state = makeScene(kind, resolveOptions(kind, options));
  let disposed = false;
  let solverWallMs = 0,
    measuredSteps = 0,
    maxStepMs = 0;
  const alive = (): void => {
    if (disposed)
      fail(
        "SIM_DISPOSED",
        "Create a new simulation before stepping, restoring, or reading geometry.",
      );
  };

  function fluidData(): { density: number[]; pressure: number[] } {
    const h2 = SMOOTHING_LENGTH ** 2;
    const poly6 = 315 / (64 * Math.PI * SMOOTHING_LENGTH ** 9);
    const density = state.particles.map((p) => {
      let rho = 0;
      for (const q of state.particles) {
        const delta = sub(p.position, q.position),
          r2 = dot(delta, delta);
        if (r2 < h2) rho += (1 / q.inverseMass) * poly6 * (h2 - r2) ** 3;
      }
      return rho;
    });
    // Weakly compressible SPH: compressive pressure only, free-surface tension omitted.
    const pressure = density.map(
      (rho) => PRESSURE_STIFFNESS * Math.max(0, rho - REST_DENSITY),
    );
    return { density, pressure };
  }

  function sphAccelerations(): Vec3[] {
    const points = state.particles;
    const { density, pressure } = fluidData();
    const forces: Vec3[] = points.map(() => [0, 0, 0]);
    const kernel = 45 / (Math.PI * SMOOTHING_LENGTH ** 6);
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const delta = sub(points[i].position, points[j].position),
          r = length(delta);
        if (r >= SMOOTHING_LENGTH || r < 1e-10) continue;
        const mi = 1 / points[i].inverseMass,
          mj = 1 / points[j].inverseMass;
        const d = SMOOTHING_LENGTH - r;
        const pressureForce = mul(
          delta,
          (mi *
            mj *
            (pressure[i] / density[i] ** 2 + pressure[j] / density[j] ** 2) *
            kernel *
            d ** 2) /
            r,
        );
        const viscousForce = mul(
          sub(points[j].velocity, points[i].velocity),
          ((VISCOSITY * mi * mj) / (density[i] * density[j])) * kernel * d,
        );
        const force = add(pressureForce, viscousForce);
        // Equal-and-opposite pair forces; total internal momentum is conserved before damping/walls.
        accumulate(forces[i], force);
        accumulate(forces[j], force, -1);
      }
    return forces.map((f, i) => mul(f, points[i].inverseMass));
  }

  function solveDistances(h: number, lambdas: Float64Array): void {
    for (let i = 0; i < state.distances.length; i++) {
      const c = state.distances[i],
        a = state.particles[c.a],
        b = state.particles[c.b];
      const delta = sub(a.position, b.position),
        r = length(delta);
      if (r < 1e-12) continue;
      const alpha = c.compliance / (h * h),
        denom = a.inverseMass + b.inverseMass + alpha;
      if (denom === 0) continue;
      const dl = (-(r - c.restLength) - alpha * lambdas[i]) / denom;
      lambdas[i] += dl;
      accumulate(a.position, delta, (a.inverseMass * dl) / r);
      accumulate(b.position, delta, (-b.inverseMass * dl) / r);
    }
  }

  function solveVolumes(h: number, lambdas: Float64Array): void {
    for (let i = 0; i < state.volumes.length; i++) {
      const c = state.volumes[i],
        p = c.indices.map((index) => state.particles[index]);
      const [a, b, d, e] = p.map((point) => point.position);
      const g1 = mul(cross(sub(d, a), sub(e, a)), 1 / 6);
      const g2 = mul(cross(sub(e, a), sub(b, a)), 1 / 6);
      const g3 = mul(cross(sub(b, a), sub(d, a)), 1 / 6);
      const gradients = [mul(add(add(g1, g2), g3), -1), g1, g2, g3];
      const alpha = c.compliance / (h * h);
      const denom = p.reduce(
        (sum, point, k) =>
          sum + point.inverseMass * dot(gradients[k], gradients[k]),
        alpha,
      );
      if (denom < 1e-20) continue;
      const dl =
        (-(volume(a, b, d, e) - c.restVolume) - alpha * lambdas[i]) / denom;
      lambdas[i] += dl;
      for (let k = 0; k < 4; k++)
        accumulate(p[k].position, gradients[k], p[k].inverseMass * dl);
    }
  }

  function solveContacts(h: number): void {
    if (!state.options.contacts) return;
    for (const body of state.bodies)
      for (const p of state.particles) {
        if (p.inverseMass === 0) continue;
        const delta = sub(p.position, body.position),
          r = length(delta),
          penetration = body.radius + p.radius - r;
        if (penetration <= 0) continue;
        const normal: Vec3 = r > 1e-12 ? mul(delta, 1 / r) : [1, 0, 0];
        const bodyWeight = state.options.twoWayCoupling ? body.inverseMass : 0;
        const weight = p.inverseMass + bodyWeight;
        accumulate(p.position, normal, (penetration * p.inverseMass) / weight);
        accumulate(body.position, normal, (-penetration * bodyWeight) / weight);
        state.counters.contactCount++;
        state.counters.maxContactCorrection = Math.max(
          state.counters.maxContactCorrection,
          penetration,
        );
        if (bodyWeight > 0) {
          const impulse = mul(normal, -penetration / (weight * h));
          accumulate(state.counters.reactionImpulse, impulse);
          state.counters.absoluteReactionImpulse += length(impulse);
        }
      }
  }

  function constrainWalls(p: PointState): void {
    if (p.inverseMass === 0) return;
    for (let k = 0; k < 3; k++)
      p.position[k] = Math.max(
        LOWER[k] + p.radius,
        Math.min(UPPER[k] - p.radius, p.position[k]),
      );
  }

  function substep(h: number): void {
    const points = allPoints(state),
      oldPositions = points.map((p) => [...p.position] as Vec3);
    const fluid = kind === "fluid" ? sphAccelerations() : null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.inverseMass === 0) continue;
      accumulate(p.velocity, state.options.gravity, h);
      if (fluid && i >= state.bodies.length)
        accumulate(p.velocity, fluid[i - state.bodies.length], h);
      // Explicitly dissipative reference model, not an energy-conserving integrator.
      p.velocity = mul(
        p.velocity,
        Math.exp(-(i < state.bodies.length ? 0.12 : 0.25) * h),
      );
      accumulate(p.position, p.velocity, h);
    }
    const distanceLambdas = new Float64Array(state.distances.length);
    const volumeLambdas = new Float64Array(state.volumes.length);
    for (let iteration = 0; iteration < state.options.iterations; iteration++) {
      solveDistances(h, distanceLambdas);
      solveVolumes(h, volumeLambdas);
      solveContacts(h);
      for (const p of points) constrainWalls(p);
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.inverseMass === 0) continue;
      p.velocity = mul(sub(p.position, oldPositions[i]), 1 / h);
      state.counters.maxObservedSpeed = Math.max(
        state.counters.maxObservedSpeed,
        length(p.velocity),
      );
    }
    if (points.some((p) => !isVec3(p.position) || !isVec3(p.velocity)))
      fail(
        "SIM_NONFINITE",
        `Non-finite state at tick ${state.tick}; capture the last valid snapshot and reduce the timestep or impulse.`,
      );
  }

  function inspect(): SimulationInspection {
    const points = allPoints(state);
    let maxDistanceRelativeError = 0,
      maxVolumeRelativeError = 0,
      minSignedVolumeRatio: number | null = null;
    for (const c of state.distances)
      maxDistanceRelativeError = Math.max(
        maxDistanceRelativeError,
        Math.abs(
          length(
            sub(state.particles[c.a].position, state.particles[c.b].position),
          ) - c.restLength,
        ) / c.restLength,
      );
    for (const c of state.volumes) {
      const v = volume(
        ...(c.indices.map((i) => state.particles[i].position) as [
          Vec3,
          Vec3,
          Vec3,
          Vec3,
        ]),
      );
      const ratio = v / c.restVolume;
      maxVolumeRelativeError = Math.max(
        maxVolumeRelativeError,
        Math.abs(ratio - 1),
      );
      minSignedVolumeRatio = Math.min(minSignedVolumeRatio ?? Infinity, ratio);
    }
    const bounds = state.particles.length
      ? {
          min: [0, 1, 2].map((k) =>
            Math.min(...state.particles.map((p) => p.position[k])),
          ) as Vec3,
          max: [0, 1, 2].map((k) =>
            Math.max(...state.particles.map((p) => p.position[k])),
          ) as Vec3,
        }
      : null;
    let kineticEnergy = 0,
      maxSpeed = 0;
    const momentum: Vec3 = [0, 0, 0];
    for (const p of points) {
      maxSpeed = Math.max(maxSpeed, length(p.velocity));
      if (p.inverseMass > 0) {
        kineticEnergy += dot(p.velocity, p.velocity) / (2 * p.inverseMass);
        accumulate(momentum, p.velocity, 1 / p.inverseMass);
      }
    }
    const f = kind === "fluid" && !disposed ? fluidData() : null;
    return {
      kind,
      tick: state.tick,
      simulatedSeconds: state.tick * state.options.fixedDt,
      disposed,
      finite: points.every((p) => isVec3(p.position) && isVec3(p.velocity)),
      resources: {
        bodies: state.bodies.length,
        particles: state.particles.length,
        constraints: state.distances.length + state.volumes.length,
        triangles: state.triangles.length,
      },
      bodies: copy(state.bodies),
      particleBounds: bounds,
      maxDistanceRelativeError,
      maxVolumeRelativeError,
      minSignedVolumeRatio,
      maxSpeed,
      kineticEnergy,
      momentum,
      contacts: copy(state.counters),
      fluid: f
        ? {
            method: "WCSPH",
            restDensity: REST_DENSITY,
            minDensity: Math.min(...f.density),
            maxDensity: Math.max(...f.density),
            maxPressure: Math.max(...f.pressure),
          }
        : null,
      timing: {
        solverWallMs,
        measuredSteps,
        meanStepMs: measuredSteps ? solverWallMs / measuredSteps : 0,
        maxStepMs,
      },
    };
  }

  return {
    kind,
    step(steps = 1) {
      alive();
      if (!Number.isInteger(steps) || steps < 0 || steps > 10000)
        fail("SIM_STEPS", "steps must be an integer in [0,10000].");
      for (let frame = 0; frame < steps; frame++) {
        const start = performance.now();
        for (let j = 0; j < state.options.substeps; j++)
          substep(state.options.fixedDt / state.options.substeps);
        state.tick++;
        const elapsed = performance.now() - start;
        solverWallMs += elapsed;
        measuredSteps++;
        maxStepMs = Math.max(maxStepMs, elapsed);
      }
      return inspect();
    },
    snapshot() {
      alive();
      return copy(state);
    },
    restore(snapshot: SimulationSnapshot) {
      alive();
      state = validateSnapshot(snapshot, kind);
      solverWallMs = 0;
      measuredSteps = 0;
      maxStepMs = 0;
    },
    inspect,
    getRenderState(): SimulationRenderState {
      alive();
      const renderPoint = (p: PointState) => ({
        id: p.id,
        position: [...p.position] as Vec3,
        radius: p.radius,
      });
      return {
        kind,
        tick: state.tick,
        bodies: state.bodies.map(renderPoint),
        particles: state.particles.map(renderPoint),
        links: state.distances.map((c) => [c.a, c.b]),
        triangles: state.triangles.map((t) => [...t]),
      };
    },
    applyImpulse(id: string, impulse: Vec3) {
      alive();
      if (!isVec3(impulse) || impulse.some((x) => Math.abs(x) > 100))
        fail(
          "SIM_IMPULSE",
          "impulse must contain three finite components in [-100,100].",
        );
      const p = allPoints(state).find((point) => point.id === id);
      if (!p) fail("SIM_ENTITY", `Unknown body or particle id: ${id}`);
      if (p.inverseMass === 0)
        fail("SIM_PINNED", `Cannot apply an impulse to fixed anchor ${id}.`);
      accumulate(p.velocity, impulse, p.inverseMass);
    },
    dispose() {
      if (disposed) return;
      state.bodies.length = 0;
      state.particles.length = 0;
      state.distances.length = 0;
      state.volumes.length = 0;
      state.triangles.length = 0;
      disposed = true;
    },
  };
}

/** Restore accepts only this prototype's fixed topology; validates before replacing live state. */
function validateSnapshot(
  input: SimulationSnapshot,
  kind: SimulationKind,
): SimulationSnapshot {
  try {
    if (
      !input ||
      input.format !== "pelican-m0-simulation" ||
      input.version !== 1 ||
      input.kind !== kind
    )
      throw new Error("format, version, or kind mismatch");
    if (
      !input.options ||
      !isVec3(input.options.gravity) ||
      !isVec3(input.options.bodyPosition) ||
      !isVec3(input.options.bodyVelocity)
    )
      throw new Error("invalid options");
    const expected = makeScene(kind, resolveOptions(kind, input.options));
    if (!Number.isSafeInteger(input.tick) || input.tick < 0)
      throw new Error("invalid tick");
    for (const key of ["bodies", "particles"] as const) {
      if (
        !Array.isArray(input[key]) ||
        input[key].length !== expected[key].length
      )
        throw new Error(`invalid ${key} count`);
      input[key].forEach((p, i) => {
        const reference = expected[key][i];
        if (
          p.id !== reference.id ||
          p.inverseMass !== reference.inverseMass ||
          p.radius !== reference.radius ||
          !isVec3(p.position) ||
          !isVec3(p.velocity)
        )
          throw new Error(`invalid ${key}[${i}]`);
        if (
          p.inverseMass === 0 &&
          (JSON.stringify(p.position) !== JSON.stringify(reference.position) ||
            length(p.velocity) !== 0)
        )
          throw new Error("anchor changed");
      });
    }
    for (const key of ["distances", "volumes", "triangles"] as const)
      if (JSON.stringify(input[key]) !== JSON.stringify(expected[key]))
        throw new Error(`invalid ${key} topology`);
    const c = input.counters;
    if (
      !c ||
      !Number.isSafeInteger(c.contactCount) ||
      c.contactCount < 0 ||
      !isVec3(c.reactionImpulse)
    )
      throw new Error("invalid contact counters");
    for (const n of [
      c.absoluteReactionImpulse,
      c.maxContactCorrection,
      c.maxObservedSpeed,
    ])
      if (!Number.isFinite(n) || n < 0) throw new Error("invalid counters");
    // Validate the original before JSON copying, so NaN / Infinity cannot silently become null.
    return copy({ ...input, options: expected.options });
  } catch (error) {
    fail(
      "SIM_SNAPSHOT",
      `Snapshot rejected without changing live state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
