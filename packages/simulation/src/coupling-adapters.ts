import type { CoupledDomain, CoupledParticle, SimulationCouplingFrame } from "./coupling-frame.ts";
import type { RopeDynamicCoupling, RopeSnapshot, RopeSolver, RopeCollider, Vec3 } from "./rope.ts";
import type { ClothSnapshot, ClothSolver } from "./cloth.ts";
import type { Simulation, SimulationSnapshot } from "../../../experiments/simulation/types.ts";
import { DEFAULT_SIMULATION_CONTAINER } from "../../../experiments/simulation/scenes.ts";
import { createBoxFrame, orientedParticleBoxContact } from "./box-contact.ts";
import { staticContactCorrection, sweepParticle } from "./continuous-contact.ts";
import type { CoupledView } from "./coupled-schedule.ts";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (p: Vec3, direction: Vec3, weight: number) => { for (let axis = 0; axis < 3; axis++) p[axis] += direction[axis] * weight; };

function projectDistances(particles: CoupledParticle[], distances: readonly { a: number; b: number; restLength: number; compliance: number }[], dt: number, lambdas: Float64Array) {
  for (const [i, c] of distances.entries()) {
    const a = particles[c.a], b = particles[c.b], delta = sub(a.position, b.position), length = Math.hypot(...delta), alpha = c.compliance / dt ** 2;
    const weight = a.inverseMass + b.inverseMass + alpha;
    if (length < 1e-12 || weight < 1e-20) continue;
    const impulse = (-(length - c.restLength) - alpha * lambdas[i]) / weight;
    lambdas[i] += impulse;
    add(a.position, delta, a.inverseMass * impulse / length); add(b.position, delta, -b.inverseMass * impulse / length);
  }
}
function projectColliders(particles: CoupledParticle[], colliders: readonly RopeCollider[], dt: number, coupling?: RopeDynamicCoupling) {
  for (const [i, p] of particles.entries()) {
    if (p.inverseMass === 0) continue;
    for (const source of colliders) {
      if (coupling?.ignoreAttachmentContact?.(i, source.id)) continue;
      const body = source.kind === "sphere" ? coupling?.sphere(source.id) : source.kind === "box" ? coupling?.box?.(source.id) : undefined;
      const collider = body ? { ...source, ...body } as RopeCollider : source;
      let hit: { normal: Vec3; depth: number } | null;
      if (collider.kind === "box") hit = orientedParticleBoxContact(p.position, p.radius, collider.center, collider.halfExtents, createBoxFrame(collider.center, collider.rotation ?? [0, 0, 0]));
      else if (collider.kind === "plane") {
        const depth = collider.offset + p.radius - dot(p.position, collider.normal);
        hit = depth > 0 ? { normal: collider.normal, depth } : null;
      } else {
        const delta = sub(p.position, collider.center), length = Math.hypot(...delta), depth = p.radius + collider.radius - length;
        hit = depth > 0 ? { normal: length > 1e-12 ? delta.map(v => v / length) as Vec3 : [1, 0, 0], depth } : null;
      }
      hit ??= sweepParticle(p.previous, p.position, p.radius, collider, body?.previousCenter, body && "previousRotation" in body ? body.previousRotation : undefined);
      if (!hit) continue;
      const surface = p.position.map((v, axis) => v + hit.normal[axis] * (hit.depth - p.radius)) as Vec3;
      const correction = body && coupling ? coupling.resolve(source.id, hit.normal, hit.depth, p.position, p.previous, 1 / p.inverseMass, dt, surface).correction
        : staticContactCorrection(hit.normal, hit.depth, p.position, p.previous);
      add(p.position, correction, 1);
    }
  }
  for (const i of coupling?.attachedParticles ?? []) {
    const p = particles[i];
    if (p.inverseMass > 0 && coupling?.resolveAttachment) add(p.position, coupling.resolveAttachment(i, p.position, p.previous, 1 / p.inverseMass, dt).correction, 1);
  }
}

export function stageRopeDomain(frame: SimulationCouplingFrame | undefined, id: string, solver: RopeSolver, before: RopeSnapshot, coupling?: RopeDynamicCoupling, view?: CoupledView<RopeSnapshot>): void {
  if (!frame?.active) return;
  const state = view?.state ?? solver.snapshot(), previous = view?.previous ?? before.positions, pinned = new Set(state.anchors.map(item => item.index));
  const particles = state.positions.map((position, i) => ({ position, previous: previous[i], velocity: state.velocities[i], inverseMass: pinned.has(i) ? 0 : 1 / state.config.mass, radius: state.config.radius }));
  const distances = state.config.restLengths.map((restLength, a) => ({ a, b: a + 1, restLength, compliance: 0 })), lambdas = new Float64Array(distances.length);
  frame.add({ id: `rope/${id}`, particles, edges: distances.map(c => [c.a, c.b]), triangles: [],
    project() { projectDistances(particles, distances, frame.dt, lambdas); projectColliders(particles, state.colliders, frame.dt, coupling); },
    commit() { if (!view) solver.restore(state); },
  });
}

export function stageClothDomain(frame: SimulationCouplingFrame | undefined, id: string, solver: ClothSolver, before: ClothSnapshot, coupling?: RopeDynamicCoupling, view?: CoupledView<ClothSnapshot>): void {
  if (!frame?.active) return;
  const state = view?.state ?? solver.snapshot(), previous = view?.previous ?? before.positions, pinned = new Set(state.anchors.map(item => item.index));
  const particles = state.positions.map((position, i) => ({ position, previous: previous[i], velocity: state.velocities[i], inverseMass: pinned.has(i) ? 0 : 1 / state.config.mass, radius: state.config.radius }));
  const distances = state.config.constraints.map(([a, b, restLength]) => ({ a, b, restLength, compliance: 0 })), lambdas = new Float64Array(distances.length);
  const edgeMap = new Map<string, [number, number]>();
  for (const [a, b, c] of state.config.triangles) for (const [i, j] of [[a, b], [b, c], [c, a]]) edgeMap.set(`${Math.min(i, j)}:${Math.max(i, j)}`, [i, j]);
  frame.add({ id: `cloth/${id}`, particles, edges: [...edgeMap.values()], triangles: state.config.triangles,
    project() { projectDistances(particles, distances, frame.dt, lambdas); projectColliders(particles, state.colliders, frame.dt, coupling); },
    commit() { if (!view) solver.restore(state); },
  });
}

export function stageParticleDomain(frame: SimulationCouplingFrame | undefined, id: string, simulation: Simulation, before: SimulationSnapshot, coupling?: RopeDynamicCoupling, view?: CoupledView<SimulationSnapshot>): void {
  if (!frame?.active) return;
  const state = view?.state ?? simulation.snapshot(), particles = state.particles.map((p, i) => ({ ...p, previous: view?.previous[i] ?? before.particles[i].position }));
  const distances = state.distances, distanceLambdas = new Float64Array(distances.length), volumeLambdas = new Float64Array(state.volumes.length);
  const colliders: RopeCollider[] = [...(state.colliders ?? []), ...state.bodies.map(body => {
    const box = state.sampledBoxes?.find(item => item.id === body.id);
    return box ? { kind: "box" as const, id: body.id, center: body.position, halfExtents: box.halfExtents, rotation: box.rotation }
      : { kind: "sphere" as const, id: body.id, center: body.position, radius: state.sampledBodies?.find(item => item.id === body.id)?.radius ?? body.radius };
  })];
  const domain: CoupledDomain = { id: `${state.kind}/${id}`, ...(state.kind === "fluid" ? { medium: "fluid" } : {}), particles, edges: state.kind === "softbody" ? distances.map(c => [c.a, c.b]) : [], triangles: state.triangles,
    project() {
      projectDistances(particles, distances, frame.dt, distanceLambdas);
      for (const [i, constraint] of state.volumes.entries()) {
        const points = constraint.indices.map(j => particles[j]), [a, b, c, d] = points.map(p => p.position);
        const ab = sub(b, a), ac = sub(c, a), ad = sub(d, a);
        const g1 = cross(ac, ad).map(v => v / 6) as Vec3, g2 = cross(ad, ab).map(v => v / 6) as Vec3, g3 = cross(ab, ac).map(v => v / 6) as Vec3;
        const gradients = [g1.map((v, axis) => -v - g2[axis] - g3[axis]) as Vec3, g1, g2, g3], alpha = constraint.compliance / frame.dt ** 2;
        const weight = points.reduce((sum, p, j) => sum + p.inverseMass * dot(gradients[j], gradients[j]), alpha);
        if (weight < 1e-20) continue;
        const lambda = (-(dot(ab, cross(ac, ad)) / 6 - constraint.restVolume) - alpha * volumeLambdas[i]) / weight;
        volumeLambdas[i] += lambda;
        for (let j = 0; j < 4; j++) add(points[j].position, gradients[j], points[j].inverseMass * lambda);
      }
      if (state.options.contacts) projectColliders(particles, colliders, frame.dt, coupling);
      const bounds = state.options.container ?? DEFAULT_SIMULATION_CONTAINER, origin = state.options.origin ?? [0, 0, 0];
      for (const p of particles) if (p.inverseMass > 0) for (let axis = 0; axis < 3; axis++) p.position[axis] = Math.max(bounds.min[axis] + origin[axis] + p.radius, Math.min(bounds.max[axis] + origin[axis] - p.radius, p.position[axis]));
    },
    commit() { for (const [i, p] of particles.entries()) { state.particles[i].position = p.position; state.particles[i].velocity = p.velocity; } if (!view) simulation.restore(state); },
  };
  frame.add(domain);
}
