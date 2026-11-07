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
import { allPoints, DEFAULT_SIMULATION_CONTAINER, makeScene, resolveOptions } from "./scenes.ts";
import { createBoxFrame, orientedParticleBoxContact, type BoxFrame } from "../../packages/simulation/src/box-contact.ts";
import type {
  PointState,
  Simulation,
  SimulationBodyCoupling,
  SimulationInspection,
  SimulationKind,
  SimulationCollider,
  SimulationOptions,
  SimulationRenderState,
  SimulationSnapshot,
  Vec3,
} from "./types.ts";

const REST_DENSITY = 1;
const SMOOTHING_LENGTH = 0.34;
const PRESSURE_STIFFNESS = 12;
const VISCOSITY = 0.025;

function readColliders(input: unknown): SimulationCollider[] {
  if (!Array.isArray(input) || input.length > 64)
    return fail("SIM_COLLIDER", "Expected an array of at most 64 colliders.");
  const ids = new Set<string>();
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail("SIM_COLLIDER", "Each collider must be an object.");
    const item = value as Record<string, unknown>, id = item.id;
    if (typeof id !== "string" || !id.trim() || id.trim() !== id || id.length > 128 || ids.has(id))
      return fail("SIM_COLLIDER", "Collider IDs must be unique nonempty strings of at most 128 characters.");
    ids.add(id);
    if (item.kind === "sphere") {
      if (!isVec3(item.center) || item.center.some(n => Math.abs(n) > 1e6) ||
          typeof item.radius !== "number" || !Number.isFinite(item.radius) || item.radius <= 0 || item.radius > 1e6)
        return fail("SIM_COLLIDER", `Sphere '${id}' needs a finite center and positive radius at most 1e6.`);
      return { kind: "sphere", id, center: [...item.center] as Vec3, radius: item.radius };
    }
    if (item.kind === "plane") {
      if (!isVec3(item.normal) || Math.abs(length(item.normal) - 1) > 1e-6 ||
          typeof item.offset !== "number" || !Number.isFinite(item.offset) || Math.abs(item.offset) > 1e6)
        return fail("SIM_COLLIDER", `Plane '${id}' needs a unit normal and finite offset within [-1e6,1e6].`);
      return { kind: "plane", id, normal: [...item.normal] as Vec3, offset: item.offset };
    }
    if (item.kind === "box") {
      if (!isVec3(item.center) || item.center.some(n => Math.abs(n) > 1e6) ||
          !isVec3(item.halfExtents) || item.halfExtents.some(n => n <= 0 || n > 1e6) ||
          (item.rotation !== undefined && (!isVec3(item.rotation) || item.rotation.some(n => Math.abs(n) > 1e6))))
        return fail("SIM_COLLIDER", `Box '${id}' needs a finite center and rotation, and positive half-extents at most 1e6.`);
      return { kind: "box", id, center: [...item.center] as Vec3, halfExtents: [...item.halfExtents] as Vec3,
        ...(item.rotation !== undefined ? { rotation: [...item.rotation as Vec3] as Vec3 } : {}) };
    }
    return fail("SIM_COLLIDER", `Collider '${id}' must be a sphere, plane or box.`);
  });
}

/** Pure synchronous CPU reference solver with bounded spatial buckets for fluid neighbors. */
export function createSimulation(
  kind: SimulationKind,
  options: SimulationOptions = {},
): Simulation {
  let state = makeScene(kind, resolveOptions(kind, options));
  const excludedPairs = (snapshot: SimulationSnapshot): Set<number> => {
    const count = snapshot.particles.length;
    return new Set(snapshot.distances.map(({ a, b }) => Math.min(a, b) * count + Math.max(a, b)));
  };
  let adjacentParticles = excludedPairs(state);
  let disposed = false;
  const sampledRadii = new Map<string, number>();
  const sampledBoxes = new Map<string, { halfExtents: Vec3; rotation: Vec3; frame: BoxFrame }>();
  const isSampled = (id: string) => sampledRadii.has(id) || sampledBoxes.has(id);
  const particleForces = new Map<string, Vec3>();
  let colliders: SimulationCollider[] = [];
  let colliderFrames = new Map<string, BoxFrame>();
  const framesFor = (items: readonly SimulationCollider[]): Map<string, BoxFrame> => {
    const frames = new Map<string, BoxFrame>();
    for (const item of items) if (item.kind === "box" && item.rotation)
      frames.set(item.id, createBoxFrame(item.center, item.rotation));
    return frames;
  };
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

  function fluidNeighbors(): number[][] {
    const buckets = new Map<string, number[]>();
    const cells = state.particles.map((particle) => {
      const coord = particle.position.map(value => Math.floor(value / SMOOTHING_LENGTH)) as Vec3;
      if (!coord.every(value => Number.isSafeInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER))
        return fail("SIM_NONFINITE", `Fluid particle '${particle.id}' has an unrepresentable spatial cell; restore a known-good snapshot.`);
      return coord;
    });
    const key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
    for (let index = 0; index < cells.length; index++) {
      const [x, y, z] = cells[index], id = key(x, y, z);
      const bucket = buckets.get(id);
      if (bucket) bucket.push(index); else buckets.set(id, [index]);
    }
    return cells.map(([x, y, z]) => {
      const indices: number[] = [];
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const bucket = buckets.get(key(x + dx, y + dy, z + dz));
        if (bucket) indices.push(...bucket);
      }
      // Preserve the all-pairs accumulation order for candidates in neighboring cells.
      return indices.sort((a, b) => a - b);
    });
  }

  function fluidData(neighbors = fluidNeighbors()): { density: number[]; pressure: number[] } {
    const h2 = SMOOTHING_LENGTH ** 2;
    const poly6 = 315 / (64 * Math.PI * SMOOTHING_LENGTH ** 9);
    const density = state.particles.map((p, index) => {
      let rho = 0;
      for (const candidate of neighbors[index]) {
        const q = state.particles[candidate];
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
    const neighbors = fluidNeighbors();
    const { density, pressure } = fluidData(neighbors);
    const forces: Vec3[] = points.map(() => [0, 0, 0]);
    const kernel = 45 / (Math.PI * SMOOTHING_LENGTH ** 6);
    for (let i = 0; i < points.length; i++)
      for (const j of neighbors[i]) {
        if (j <= i) continue;
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

  function solveContacts(h: number, oldPositions: readonly Vec3[], coupling?: SimulationBodyCoupling): void {
    if (!state.options.contacts) return;
    for (const body of state.bodies) {
      const box = sampledBoxes.get(body.id);
      const sampled = isSampled(body.id);
      // A virtual body can translate during a tick; its box orientation stays fixed.
      const localFrame = box && coupling && sampled ? createBoxFrame([0, 0, 0], box.rotation) : undefined;
      for (let index = 0; index < state.particles.length; index++) {
        const p = state.particles[index];
        if (p.inverseMass === 0) continue;
        let normal: Vec3, penetration: number, point: Vec3;
        if (box) {
          const dynamicBox = coupling && sampled ? coupling.box?.(body.id) : undefined;
          if (coupling && sampled && !dynamicBox) fail("SIM_BODY", `Missing dynamic box '${body.id}'.`);
          const center = dynamicBox?.center ?? body.position, halfExtents = dynamicBox?.halfExtents ?? box.halfExtents;
          const hit = dynamicBox
            ? orientedParticleBoxContact(sub(p.position, center), p.radius, [0, 0, 0], halfExtents, localFrame)
            : orientedParticleBoxContact(p.position, p.radius, center, halfExtents, box.frame);
          if (!hit) continue;
          normal = hit.normal; penetration = hit.depth;
          point = add(p.position, mul(normal, penetration - p.radius));
        } else {
          const dynamicSphere = coupling && sampled ? coupling.sphere(body.id) : undefined;
          if (coupling && sampled && !dynamicSphere) fail("SIM_BODY", `Missing dynamic sphere '${body.id}'.`);
          const center = dynamicSphere?.center ?? body.position, colliderRadius = dynamicSphere?.radius ?? sampledRadii.get(body.id) ?? body.radius;
          const delta = sub(p.position, center), r = length(delta);
          penetration = colliderRadius + p.radius - r;
          normal = r > 1e-12 ? mul(delta, 1 / r) : [1, 0, 0];
          point = add(center, mul(normal, colliderRadius));
        }
        if (penetration <= 0) continue;
        let impulse: Vec3 | undefined, moment: Vec3 | undefined;
        if (sampled && coupling) {
          const result = coupling.resolve(body.id, normal, penetration, p.position, oldPositions[state.bodies.length + index], 1 / p.inverseMass, h, point);
          accumulate(p.position, result.correction);
          impulse = result.reactionImpulse;
          moment = result.reactionAngularImpulse;
        } else {
          // Without a bridge, sampled bodies remain fixed obstacles.
          const bodyWeight = state.options.twoWayCoupling && !sampled ? body.inverseMass : 0;
          const weight = p.inverseMass + bodyWeight;
          accumulate(p.position, normal, (penetration * p.inverseMass) / weight);
          accumulate(body.position, normal, (-penetration * bodyWeight) / weight);
          if (state.options.twoWayCoupling && (bodyWeight > 0 || sampled)) {
            impulse = mul(normal, -penetration / (weight * h));
            moment = cross(point, impulse);
          }
        }
        state.counters.contactCount++;
        state.counters.maxContactCorrection = Math.max(state.counters.maxContactCorrection, penetration);
        if (impulse && moment) {
          accumulate(state.counters.reactionImpulse, impulse);
          state.counters.reactionMoment ??= [0, 0, 0];
          accumulate(state.counters.reactionMoment, moment);
          state.counters.absoluteReactionImpulse += length(impulse);
          if (!isVec3(state.counters.reactionImpulse) || !isVec3(state.counters.reactionMoment) || !Number.isFinite(state.counters.absoluteReactionImpulse))
            fail("SIM_NONFINITE", "Contact reaction exceeded finite bounds; restore a known-good snapshot.");
        }
      }
    }
    for (const collider of colliders) for (const particle of state.particles) {
      if (particle.inverseMass === 0) continue;
      let normal: Vec3, penetration: number;
      if (collider.kind === "sphere") {
        const delta = sub(particle.position, collider.center), distance = length(delta);
        normal = distance > 1e-12 ? mul(delta, 1 / distance) : [1, 0, 0];
        penetration = collider.radius + particle.radius - distance;
      } else if (collider.kind === "plane") {
        normal = collider.normal;
        penetration = particle.radius - (dot(particle.position, normal) - collider.offset);
      } else if (collider.rotation) {
        const hit = orientedParticleBoxContact(particle.position, particle.radius, collider.center, collider.halfExtents, colliderFrames.get(collider.id));
        if (!hit) continue;
        normal = hit.normal; penetration = hit.depth;
      } else {
        const relative = sub(particle.position, collider.center);
        const closest = relative.map((value, axis) => Math.max(-collider.halfExtents[axis], Math.min(collider.halfExtents[axis], value))) as Vec3;
        const delta = sub(relative, closest), distance = length(delta);
        if (distance > 0) {
          normal = mul(delta, 1 / distance);
          penetration = particle.radius - distance;
        } else {
          let axis = 0, sign = -1, faceDistance = relative[0] + collider.halfExtents[0];
          for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
            const candidate = collider.halfExtents[i] - side * relative[i];
            if (candidate < faceDistance) { axis = i; sign = side; faceDistance = candidate; }
          }
          normal = [0, 0, 0]; normal[axis] = sign;
          penetration = particle.radius + faceDistance;
        }
      }
      if (penetration <= 0) continue;
      accumulate(particle.position, normal, penetration);
      state.counters.contactCount++;
      state.counters.maxContactCorrection = Math.max(state.counters.maxContactCorrection, penetration);
    }
  }

  function solveSoftBodySelfContacts(): void {
    if (kind !== "softbody" || !state.options.selfCollisions) return;
    const particles = state.particles, count = particles.length;
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      if (adjacentParticles.has(i * count + j)) continue;
      const a = particles[i], b = particles[j], totalWeight = a.inverseMass + b.inverseMass;
      if (totalWeight === 0) continue;
      const delta = sub(a.position, b.position), distance = length(delta), penetration = a.radius + b.radius - distance;
      if (penetration <= 0) continue;
      const normal: Vec3 = distance > 1e-12 ? mul(delta, 1 / distance) : [1, 0, 0];
      accumulate(a.position, normal, penetration * a.inverseMass / totalWeight);
      accumulate(b.position, normal, -penetration * b.inverseMass / totalWeight);
      const previous = state.counters.selfContactCorrections ?? 0;
      if (previous >= Number.MAX_SAFE_INTEGER) fail("SIM_CAPACITY", "Self-contact correction counter exhausted; create a new simulation.");
      state.counters.selfContactCorrections = previous + 1;
    }
  }

  function constrainWalls(p: PointState): void {
    if (p.inverseMass === 0) return;
    const container = state.options.container ?? DEFAULT_SIMULATION_CONTAINER;
    for (let k = 0; k < 3; k++)
      p.position[k] = Math.max(
        container.min[k] + (state.options.origin?.[k] ?? 0) + p.radius,
        Math.min(container.max[k] + (state.options.origin?.[k] ?? 0) - p.radius, p.position[k]),
      );
  }

  function substep(h: number, coupling?: SimulationBodyCoupling): void {
    const points = allPoints(state),
      oldPositions = points.map((p) => [...p.position] as Vec3);
    const fluid = kind === "fluid" ? sphAccelerations() : null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.inverseMass === 0) continue;
      if (i < state.bodies.length && isSampled(p.id)) continue;
      accumulate(p.velocity, state.options.gravity, h);
      const appliedForce = particleForces.get(p.id);
      if (appliedForce) accumulate(p.velocity, appliedForce, p.inverseMass * h);
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
      solveContacts(h, oldPositions, coupling);
      solveSoftBodySelfContacts();
      for (const p of points) if (!isSampled(p.id)) constrainWalls(p);
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.inverseMass === 0) continue;
      if (i < state.bodies.length && isSampled(p.id)) continue;
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

  function applyImpulses(impulses: readonly { id: string; impulse: Vec3 }[]): void {
    alive();
    if (!Array.isArray(impulses) || impulses.length > 512)
      fail("SIM_IMPULSE", "Expected at most 512 impulses.");
    const points = new Map(allPoints(state).map(point => [point.id, point]));
    const seen = new Set<string>();
    const staged: { point: PointState; velocity: Vec3 }[] = [];
    for (const item of impulses) {
      if (!item || typeof item.id !== "string" || !isVec3(item.impulse) || item.impulse.some((x: number) => Math.abs(x) > 100))
        fail("SIM_IMPULSE", "Each impulse requires an id and three finite components in [-100,100].");
      if (seen.has(item.id)) fail("SIM_IMPULSE", `Duplicate impulse target: ${item.id}`);
      seen.add(item.id);
      const point = points.get(item.id);
      if (!point) fail("SIM_ENTITY", `Unknown body or particle id: ${item.id}`);
      if (point.inverseMass === 0) fail("SIM_PINNED", `Cannot apply an impulse to fixed anchor ${item.id}.`);
      const velocity = point.velocity.map((value, axis) => value + item.impulse[axis] * point.inverseMass) as Vec3;
      if (!isVec3(velocity)) fail("SIM_IMPULSE", `Impulse would produce a non-finite velocity: ${item.id}`);
      staged.push({ point, velocity });
    }
    for (const item of staged) item.point.velocity = item.velocity;
  }

  function applyForces(forces: readonly { id: string; force: Vec3 }[]): void {
    alive();
    if (!Array.isArray(forces) || forces.length > 512)
      fail("SIM_FORCE", "Expected at most 512 particle forces.");
    const points = new Map(state.particles.map(point => [point.id, point]));
    const seen = new Set<string>(), staged: { id: string; force: Vec3 }[] = [];
    for (const item of forces) {
      if (!item || typeof item.id !== "string" || !isVec3(item.force) || item.force.some((value: number) => Math.abs(value) > 100))
        fail("SIM_FORCE", "Each force requires a particle id and finite components in [-100,100].");
      if (seen.has(item.id)) fail("SIM_FORCE", `Duplicate force target: ${item.id}`);
      seen.add(item.id);
      const point = points.get(item.id);
      if (!point) fail("SIM_ENTITY", `Unknown particle id: ${item.id}`);
      if (point.inverseMass === 0) fail("SIM_PINNED", `Cannot apply force to fixed anchor ${item.id}.`);
      const previous = particleForces.get(item.id) ?? [0, 0, 0];
      const next = previous.map((value, axis) => value + item.force[axis]) as Vec3;
      if (!isVec3(next) || next.some(value => Math.abs(value) > 100))
        fail("SIM_FORCE", `Accumulated force exceeds [-100,100]: ${item.id}`);
      staged.push({ id: item.id, force: next });
    }
    for (const item of staged) particleForces.set(item.id, item.force);
  }

  return {
    kind,
    step(steps = 1, coupling?: SimulationBodyCoupling) {
      alive();
      if (!Number.isInteger(steps) || steps < 0 || steps > 10000)
        fail("SIM_STEPS", "steps must be an integer in [0,10000].");
      for (let frame = 0; frame < steps; frame++) {
        const start = performance.now();
        for (let j = 0; j < state.options.substeps; j++)
          substep(state.options.fixedDt / state.options.substeps, coupling);
        state.tick++;
        particleForces.clear();
        const elapsed = performance.now() - start;
        solverWallMs += elapsed;
        measuredSteps++;
        maxStepMs = Math.max(maxStepMs, elapsed);
      }
      return inspect();
    },
    setBodyState(id: string, position: Vec3, velocity: Vec3, radius?: number) {
      alive();
      const body = state.bodies.find((item) => item.id === id);
      if (!body) fail("SIM_BODY", `Unknown body '${id}'.`);
      if (!isVec3(position) || !isVec3(velocity))
        fail("SIM_BODY", "Body position and velocity must be finite vectors.");
      if (radius !== undefined && (!Number.isFinite(radius) || radius <= 0 || radius > 1e6))
        fail("SIM_BODY", "Sampled radius must be finite and in (0, 1e6].");
      body.position = copy(position);
      body.velocity = copy(velocity);
      sampledBoxes.delete(id);
      if (radius === undefined) sampledRadii.delete(id);
      else sampledRadii.set(id, radius);
    },
    setBodyBoxState(id: string, position: Vec3, velocity: Vec3, halfExtents: Vec3, rotation: Vec3) {
      alive();
      const body = state.bodies.find(item => item.id === id);
      if (!body) return fail("SIM_BODY", `Unknown body '${id}'.`);
      if (!isVec3(position) || !isVec3(velocity) || !isVec3(halfExtents) || !isVec3(rotation) ||
          halfExtents.some(value => value <= 0 || value > 1e6) || rotation.some(value => Math.abs(value) > 1e6))
        return fail("SIM_BODY", "Sampled box needs finite position, velocity and rotation, and half-extents in (0, 1e6].");
      const nextPosition = copy(position), extents = copy(halfExtents), angles = copy(rotation);
      const frame = createBoxFrame(nextPosition, angles);
      body.position = nextPosition; body.velocity = copy(velocity);
      sampledRadii.delete(id);
      sampledBoxes.set(id, { halfExtents: extents, rotation: angles, frame });
    },
    setTwoWayCoupling(enabled: boolean) {
      alive();
      if (typeof enabled !== "boolean") fail("SIM_OPTIONS", "twoWayCoupling must be boolean.");
      state.options.twoWayCoupling = enabled;
    },
    setGravity(gravity: Vec3) {
      alive();
      if (!isVec3(gravity) || gravity.some(value => Math.abs(value) > 100))
        fail("SIM_OPTIONS", "gravity must contain three finite values in [-100,100].");
      state.options.gravity = copy(gravity);
    },
    setColliders(input: readonly SimulationCollider[]) {
      alive();
      const nextColliders = readColliders(input);
      const nextFrames = framesFor(nextColliders);
      colliders = nextColliders;
      colliderFrames = nextFrames;
    },
    snapshot() {
      alive();
      return copy({
        ...state,
        ...(sampledRadii.size ? { sampledBodies: [...sampledRadii].map(([id, radius]) => ({ id, radius })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } : {}),
        ...(sampledBoxes.size ? { sampledBoxes: [...sampledBoxes].map(([id, box]) => ({ id, halfExtents: box.halfExtents, rotation: box.rotation })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } : {}),
        ...(particleForces.size ? { particleForces: [...particleForces].map(([id, force]) => ({ id, force: [...force] as Vec3 })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } : {}),
        ...(colliders.length ? { colliders: copy(colliders) } : {}),
      });
    },
    restore(snapshot: SimulationSnapshot) {
      alive();
      const validated = validateSnapshot(snapshot, kind);
      const { sampledBodies, sampledBoxes: savedBoxes, particleForces: savedForces, colliders: savedColliders, ...next } = validated;
      const nextColliderFrames = framesFor(savedColliders ?? []);
      const nextBoxes = new Map<string, { halfExtents: Vec3; rotation: Vec3; frame: BoxFrame }>();
      for (const box of savedBoxes ?? []) {
        const body = next.bodies.find(item => item.id === box.id)!;
        nextBoxes.set(box.id, { halfExtents: box.halfExtents, rotation: box.rotation, frame: createBoxFrame(body.position, box.rotation) });
      }
      state = next;
      adjacentParticles = excludedPairs(state);
      sampledRadii.clear();
      for (const body of sampledBodies ?? []) sampledRadii.set(body.id, body.radius);
      sampledBoxes.clear();
      for (const [id, box] of nextBoxes) sampledBoxes.set(id, box);
      particleForces.clear();
      for (const item of savedForces ?? []) particleForces.set(item.id, item.force);
      colliders = savedColliders ?? [];
      colliderFrames = nextColliderFrames;
      solverWallMs = 0;
      measuredSteps = 0;
      maxStepMs = 0;
    },
    inspect,
    getParticleVelocities() {
      alive();
      return state.particles.map(particle => [...particle.velocity] as Vec3);
    },
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
        bodies: state.bodies.map((body) => {
          const box = sampledBoxes.get(body.id);
          return { ...renderPoint(body), radius: sampledRadii.get(body.id) ?? body.radius,
            ...(box ? { collider: { kind: "box" as const, halfExtents: copy(box.halfExtents), rotation: copy(box.rotation) } } : {}) };
        }),
        particles: state.particles.map(renderPoint),
        links: state.distances.map((c) => [c.a, c.b]),
        triangles: state.triangles.map((t) => [...t]),
      };
    },
    applyImpulse(id: string, impulse: Vec3) {
      applyImpulses([{ id, impulse }]);
    },
    applyImpulses,
    applyForces,
    dispose() {
      if (disposed) return;
      sampledRadii.clear();
      sampledBoxes.clear();
      particleForces.clear();
      colliders = [];
      colliderFrames.clear();
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
      (input.options.origin !== undefined && !isVec3(input.options.origin)) ||
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
    const sampledIds = new Set<string>();
    if (input.sampledBodies !== undefined) {
      if (!Array.isArray(input.sampledBodies) || input.sampledBodies.length > expected.bodies.length)
        throw new Error("invalid sampled bodies");
      for (const body of input.sampledBodies) {
        if (!body || typeof body !== "object" || typeof body.id !== "string" || sampledIds.has(body.id) ||
            !expected.bodies.some(item => item.id === body.id) || typeof body.radius !== "number" ||
            !Number.isFinite(body.radius) || body.radius <= 0 || body.radius > 1e6)
          throw new Error("invalid sampled body radius or identity");
        sampledIds.add(body.id);
      }
    }
    if (input.sampledBoxes !== undefined) {
      if (!Array.isArray(input.sampledBoxes) || input.sampledBoxes.length > expected.bodies.length)
        throw new Error("invalid sampled boxes");
      for (const box of input.sampledBoxes) {
        if (!box || typeof box !== "object" || typeof box.id !== "string" || sampledIds.has(box.id) ||
            !expected.bodies.some(item => item.id === box.id) || !isVec3(box.halfExtents) ||
            box.halfExtents.some(value => value <= 0 || value > 1e6) || !isVec3(box.rotation) ||
            box.rotation.some(value => Math.abs(value) > 1e6))
          throw new Error("invalid sampled box shape or identity");
        sampledIds.add(box.id);
      }
    }
    if (input.particleForces !== undefined) {
      if (!Array.isArray(input.particleForces) || input.particleForces.length > expected.particles.length)
        throw new Error("invalid particle forces");
      const particles = new Map(expected.particles.map(point => [point.id, point]));
      const seen = new Set<string>();
      for (const entry of input.particleForces) {
        const point = entry && particles.get(entry.id);
        if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || seen.has(entry.id) || !point || point.inverseMass === 0 ||
            !isVec3(entry.force) || entry.force.some(value => Math.abs(value) > 100))
          throw new Error("invalid queued particle force");
        seen.add(entry.id);
      }
    }
    if (input.colliders !== undefined) readColliders(input.colliders);
    const c = input.counters;
    if (
      !c ||
      !Number.isSafeInteger(c.contactCount) ||
      c.contactCount < 0 ||
      (c.selfContactCorrections !== undefined && (!Number.isSafeInteger(c.selfContactCorrections) || c.selfContactCorrections < 0)) ||
      !isVec3(c.reactionImpulse) ||
      (c.reactionMoment !== undefined && !isVec3(c.reactionMoment))
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
