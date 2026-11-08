import type { RopePhysicsBridge } from "../../runtime/src/plugins.ts";
import type { TerrainService } from "../../sdk/src/index.ts";
import type { Vec3 } from "./rope.ts";
import { closestTriangle } from "./cloth.ts";
import { closest as closestSegments } from "./rope-self-collision.ts";
import type { VirtualRopeCollider } from "./rope-body-coupling.ts";
import type { PointState } from "../../../experiments/simulation/types.ts";
import { fluidField } from "./sph.ts";

export interface CoupledParticle { position: Vec3; previous: Vec3; velocity: Vec3; inverseMass: number; radius: number }
export interface CoupledDomain {
  id: string;
  friction?: number;
  medium?: "fluid";
  particles: CoupledParticle[];
  edges: readonly (readonly [number, number])[];
  triangles: readonly (readonly [number, number, number])[];
  project(): void;
  commit(): void;
}
type Primitive = { domain: CoupledDomain; indices: readonly number[]; radius: number; key: string; dynamic: boolean };
type Contact = { first: Primitive; second: Primitive; normal: Vec3; weights: number[]; normalLambda: number; tangentLambda: Vec3 };
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const weighted = (points: readonly CoupledParticle[], weights: readonly number[], previous = false): Vec3 => [0, 1, 2].map(axis => points.reduce((sum, p, index) => sum + (previous ? p.previous : p.position)[axis] * weights[index], 0)) as Vec3;
const fail = (detail: string): never => { throw new Error(`TC_SIMULATION_COUPLING: ${detail}; restore a known-good checkpoint or reduce the active simulation size.`); };

function closest(first: Primitive, second: Primitive, time: number) {
  const a = first.indices.map(i => { const p = first.domain.particles[i]; return mix(p.previous, p.position, time); });
  const b = second.indices.map(i => { const p = second.domain.particles[i]; return mix(p.previous, p.position, time); });
  if (a.length === 1 && b.length === 1) return { first: a[0], second: b[0], weights: [1, -1] };
  if (a.length === 1 && b.length === 3) {
    const hit = closestTriangle(a[0], b[0], b[1], b[2]);
    return { first: a[0], second: hit.point, weights: [1, ...hit.barycentric.map(v => -v)] };
  }
  const hit = closestSegments(a[0], a[1] ?? a[0], b[0], b[1] ?? b[0]);
  return { first: hit.firstPoint, second: hit.secondPoint,
    weights: [...(a.length === 1 ? [1] : [1 - hit.first, hit.first]), ...(b.length === 1 ? [-1] : [hit.second - 1, -hit.second])] };
}

function contact(first: Primitive, second: Primitive): Contact | null {
  const particles = [...first.indices.map(i => first.domain.particles[i]), ...second.indices.map(i => second.domain.particles[i])];
  if (particles.every(p => p.inverseMass === 0)) return null;
  const radius = first.radius + second.radius, tolerance = Math.max(1e-8, radius * 1e-5);
  const travel = (primitive: Primitive) => Math.max(...primitive.indices.map(i => { const p = primitive.domain.particles[i]; return Math.hypot(...sub(p.position, p.previous)); }));
  const speed = travel(first) + travel(second);
  let time = 0;
  for (let iteration = 0; iteration < 128; iteration++) {
    const hit = closest(first, second, time), delta = sub(hit.first, hit.second), distance = Math.hypot(...delta);
    if (distance <= radius + tolerance) {
      let normal: Vec3;
      if (distance > 1e-12) normal = delta.map(v => v / distance) as Vec3;
      else {
        const motion = sub(weighted(particles, hit.weights), weighted(particles, hit.weights, true)), length = Math.hypot(...motion);
        normal = length > 1e-12 ? motion.map(v => -v / length) as Vec3 : [1, 0, 0];
      }
      const depth = radius - dot(weighted(particles, hit.weights), normal);
      if (depth <= 0) return null;
      return { first, second, normal, weights: hit.weights, normalLambda: 0, tangentLambda: [0, 0, 0] };
    }
    if (speed < 1e-12) return null;
    const next = time + (distance - radius) / speed;
    if (next > 1) return null;
    time = Math.max(next, time + Number.EPSILON);
  }
  return fail(`CCD for '${first.key}' and '${second.key}' did not converge`);
}

/** Shared contact stage; each material solver keeps its own constitutive constraints. */
export class SimulationCouplingFrame {
  readonly bodies = new Map<string, VirtualRopeCollider>();
  active = false;
  private domains: CoupledDomain[] = [];
  private undo: (() => void)[] = [];
  private contacts = new Map<string, Contact>();
  private fluids = new Map<string, readonly PointState[]>();
  private accelerations = new Map<string, Vec3[]>();
  constructor(public dt: number) {}
  begin(dt = this.dt): void {
    if (this.active) fail("A coupling transaction is already active");
    if (!Number.isFinite(dt) || dt <= 0) fail("Substep duration must be finite and positive");
    this.dt = dt;
    this.active = true; this.bodies.clear(); this.domains = []; this.undo = []; this.contacts.clear();
    this.fluids.clear(); this.accelerations.clear();
  }
  registerFluid(id: string, particles: readonly PointState[]): void { if (this.fluids.has(id)) fail(`Duplicate fluid '${id}'`); this.fluids.set(id, particles); }
  prepareFluids(): void {
    const fields = [...this.fluids].sort(([a], [b]) => a.localeCompare(b, "en"));
    if (!fields.length) return;
    const field = fluidField(fields.flatMap(([, particles]) => [...particles]));
    let offset = 0;
    for (const [id, particles] of fields) { this.accelerations.set(id, field.acceleration.slice(offset, offset + particles.length)); offset += particles.length; }
  }
  fluidAcceleration(id: string, index: number): Vec3 { return this.accelerations.get(id)?.[index] ?? fail(`Missing fluid field for '${id}/${index}'`); }
  rollbackWith(action: () => void): void { if (this.active) this.undo.push(action); }
  add(domain: CoupledDomain): void {
    if (!this.active || this.domains.some(item => item.id === domain.id)) fail(`Invalid or duplicate domain '${domain.id}'`);
    if (domain.particles.some(p => !Number.isFinite(p.inverseMass) || p.inverseMass < 0 || !Number.isFinite(p.radius) || p.radius < 0 || (p.radius === 0 && p.inverseMass > 0))) fail(`Invalid particles in '${domain.id}'`);
    if (domain.friction !== undefined && (!Number.isFinite(domain.friction) || domain.friction < 0 || domain.friction > 100)) fail(`Invalid friction in '${domain.id}'`);
    this.domains.push(domain);
  }
  addTerrain(service?: TerrainService): void {
    if (!this.domains.length || !service) return;
    for (const terrain of service.visuals()) {
      const edges = new Map<string, [number, number]>();
      for (const [a, b, c] of terrain.triangles) for (const [i, j] of [[a, b], [b, c], [c, a]]) edges.set(`${Math.min(i, j)}:${Math.max(i, j)}`, [i, j]);
      this.add({ id: `terrain/${terrain.id}`, friction: service.inspect(terrain.id).friction ?? 0.5, particles: terrain.positions.map(position => ({ position: [...position], previous: [...position], velocity: [0, 0, 0], inverseMass: 0, radius: 0 })),
        triangles: terrain.triangles, edges: [...edges.values()], project() {}, commit() {} });
    }
  }
  private primitives(): Primitive[] {
    return this.domains.flatMap(domain => [
      ...domain.particles.map((p, i) => ({ domain, indices: [i], radius: p.radius, key: `${domain.id}/p${i}`, dynamic: p.inverseMass > 0 })),
      ...domain.edges.map((indices, i) => ({ domain, indices, radius: Math.max(...indices.map(j => domain.particles[j].radius)), key: `${domain.id}/e${i}`, dynamic: indices.some(j => domain.particles[j].inverseMass > 0) })),
      ...domain.triangles.map((indices, i) => ({ domain, indices, radius: Math.max(...indices.map(j => domain.particles[j].radius)), key: `${domain.id}/t${i}`, dynamic: indices.some(j => domain.particles[j].inverseMass > 0) })),
    ]);
  }
  private discover(): void {
    const primitives = this.primitives();
    if (primitives.length > 100000) fail("More than 100000 contact primitives are active");
    const bounds = primitives.map(primitive => {
      const positions = primitive.indices.flatMap(i => { const p = primitive.domain.particles[i]; return [p.previous, p.position]; });
      return { primitive, min: [0, 1, 2].map(axis => Math.min(...positions.map(p => p[axis])) - primitive.radius),
        max: [0, 1, 2].map(axis => Math.max(...positions.map(p => p[axis])) + primitive.radius) };
    }).sort((a, b) => a.min[0] - b.min[0] || a.primitive.key.localeCompare(b.primitive.key, "en"));
    let candidates = 0;
    for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length && bounds[j].min[0] <= bounds[i].max[0]; j++) {
      let first = bounds[i].primitive, second = bounds[j].primitive;
      if (first.domain === second.domain || (first.domain.medium === "fluid" && second.domain.medium === "fluid") || (!first.dynamic && !second.dynamic) || bounds[i].min[1] > bounds[j].max[1] || bounds[j].min[1] > bounds[i].max[1] || bounds[i].min[2] > bounds[j].max[2] || bounds[j].min[2] > bounds[i].max[2]) continue;
      if (first.indices.length > second.indices.length || (first.indices.length === second.indices.length && first.key > second.key)) [first, second] = [second, first];
      if (first.indices.length === 3 || (first.indices.length === 2 && second.indices.length === 3)) continue;
      if (++candidates > 2000000) fail("More than 2000000 candidate contacts in one iteration");
      const key = `${first.key}|${second.key}`;
      if (!this.contacts.has(key)) { const hit = contact(first, second); if (hit) this.contacts.set(key, hit); }
    }
  }
  private projectContact(item: Contact): void {
    const particles = [...item.first.indices.map(i => item.first.domain.particles[i]), ...item.second.indices.map(i => item.second.domain.particles[i])];
    const denominator = particles.reduce((sum, p, i) => sum + p.inverseMass * item.weights[i] ** 2, 0);
    if (denominator <= 1e-20) return;
    const gap = weighted(particles, item.weights), depth = item.first.radius + item.second.radius - dot(gap, item.normal);
    const next = Math.max(0, item.normalLambda + depth / denominator), normalDelta = next - item.normalLambda;
    item.normalLambda = next;
    const motion = sub(gap, weighted(particles, item.weights, true)), along = dot(motion, item.normal);
    let tangent = item.tangentLambda.map((v, axis) => v - (motion[axis] - item.normal[axis] * along) / denominator) as Vec3;
    const length = Math.hypot(...tangent), limit = Math.sqrt((item.first.domain.friction ?? 0.5) * (item.second.domain.friction ?? 0.5)) * next;
    if (length > limit && length > 0) tangent = tangent.map(v => v * limit / length) as Vec3;
    const correction = item.normal.map((v, axis) => v * normalDelta + tangent[axis] - item.tangentLambda[axis]) as Vec3;
    item.tangentLambda = tangent;
    for (const [i, particle] of particles.entries()) for (let axis = 0; axis < 3; axis++) particle.position[axis] += correction[axis] * item.weights[i] * particle.inverseMass;
  }
  commit(bridge?: RopePhysicsBridge): void {
    this.domains.sort((a, b) => a.id.localeCompare(b.id, "en"));
    const baseline = new Map(this.domains.map(domain => [domain, domain.particles.map(p => [...p.position] as Vec3)]));
    if (this.domains.length > 1) for (let iteration = 0; iteration < 8; iteration++) {
      for (const domain of this.domains) domain.project();
      this.discover();
      for (const item of this.contacts.values()) this.projectContact(item);
    }
    for (const domain of this.domains) {
      for (const [i, p] of domain.particles.entries()) {
        if (p.inverseMass > 0) for (let axis = 0; axis < 3; axis++) p.velocity[axis] += (p.position[axis] - baseline.get(domain)![i][axis]) / this.dt;
        if ([...p.position, ...p.velocity].some(v => !Number.isFinite(v) || Math.abs(v) > 1e6)) fail(`Nonfinite or out-of-bounds particle ${i} in '${domain.id}'`);
      }
      domain.commit();
    }
    const reactions = [...this.bodies].map(([entity, body]) => ({ entity, ...body.reaction() }))
      .filter(item => [...item.impulse, ...item.moment].some(v => v !== 0)).sort((a, b) => a.entity.localeCompare(b.entity, "en"));
    if (reactions.length) {
      (bridge ?? fail("Rigid-body reactions require the physics plugin")).applyParticleReactions(reactions);
    }
    this.clear();
  }
  rollback(cause: unknown): never {
    const failures: unknown[] = [];
    for (const undo of [...this.undo].reverse()) try { undo(); } catch (error) { failures.push(error); }
    this.clear();
    if (failures.length) throw new AggregateError([cause, ...failures], "TC_SIMULATION_COUPLING_ROLLBACK: partialState=true; restore a known-good checkpoint.");
    throw cause;
  }
  private clear(): void { this.active = false; this.bodies.clear(); this.domains = []; this.undo = []; this.contacts.clear(); this.fluids.clear(); this.accelerations.clear(); }
}
