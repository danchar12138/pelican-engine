import type { RopePhysicsSphere } from "../../runtime/src/plugins.ts";
import type { RopeDynamicCoupling, Vec3 } from "./rope.ts";

type Matrix = [number, number, number, number, number, number];
const error = (message: string): never => { throw new Error(`TC_ROPE_BODY_NUMERIC: ${message}`); };
const vector = (value: readonly number[], label: string): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return error(`${label} must be a finite 3D vector.`);
  return [value[0], value[1], value[2]];
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, value: number): Vec3 => [a[0] * value, a[1] * value, a[2] * value];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const multiply = (m: Matrix, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[1] * v[0] + m[3] * v[1] + m[4] * v[2], m[2] * v[0] + m[4] * v[1] + m[5] * v[2]];

/** Mutable per-host-tick approximation. Native rigid bodies remain untouched until commit. */
export class VirtualRopeSphere {
  center: Vec3;
  readonly radius: number;
  private centerOfMass: Vec3;
  private linearVelocity: Vec3;
  private angularVelocity: Vec3;
  private readonly inverseMass: Vec3;
  private readonly inverseInertia: Matrix;
  private impulse: Vec3 = [0, 0, 0];
  private moment: Vec3 = [0, 0, 0];

  constructor(sample: RopePhysicsSphere) {
    this.center = vector(sample.center, "sphere center");
    this.centerOfMass = vector(sample.centerOfMass, "center of mass");
    this.linearVelocity = vector(sample.linearVelocity, "linear velocity");
    this.angularVelocity = vector(sample.angularVelocity, "angular velocity");
    this.inverseMass = vector(sample.inverseMass, "inverse mass");
    if (this.inverseMass.some(value => value < 0)) error("inverse mass cannot be negative.");
    if (!Array.isArray(sample.inverseInertia) || sample.inverseInertia.length !== 6 || !sample.inverseInertia.every(Number.isFinite))
      throw new Error("TC_ROPE_BODY_NUMERIC: world inverse inertia must have six finite elements.");
    this.inverseInertia = [...sample.inverseInertia] as Matrix;
    if (this.inverseInertia[0] < 0 || this.inverseInertia[3] < 0 || this.inverseInertia[5] < 0)
      error("world inverse inertia diagonal cannot be negative.");
    if (!Number.isFinite(sample.radius) || sample.radius <= 0 || sample.radius > 1e6) error("sphere radius is outside (0, 1e6].");
    this.radius = sample.radius;
  }
  private point(normal: Vec3): Vec3 { return add(this.center, scale(normal, this.radius)); }
  private pointVelocity(point: Vec3): Vec3 { return add(this.linearVelocity, cross(this.angularVelocity, sub(point, this.centerOfMass))); }
  private inverseEffectiveMass(point: Vec3, normal: Vec3): number {
    const rCrossN = cross(sub(point, this.centerOfMass), normal);
    const linear = normal[0] * normal[0] * this.inverseMass[0] + normal[1] * normal[1] * this.inverseMass[1] + normal[2] * normal[2] * this.inverseMass[2];
    const angular = dot(rCrossN, multiply(this.inverseInertia, rCrossN));
    const result = linear + angular;
    if (!Number.isFinite(result) || result < -1e-8) return error("invalid effective inverse mass.");
    return Math.max(0, result);
  }
  private apply(impulse: Vec3, point: Vec3, dt: number): void {
    const r = sub(point, this.centerOfMass);
    const deltaLinear: Vec3 = [this.inverseMass[0] * impulse[0], this.inverseMass[1] * impulse[1], this.inverseMass[2] * impulse[2]];
    const deltaAngular = multiply(this.inverseInertia, cross(r, impulse));
    const relativeCenter = sub(this.center, this.centerOfMass);
    const translation = scale(deltaLinear, dt);
    // First-order virtual transform update; the actual rigid body moves on its next physics step.
    this.center = vector(add(add(this.center, translation), cross(scale(deltaAngular, dt), relativeCenter)), "virtual sphere center");
    this.centerOfMass = vector(add(this.centerOfMass, translation), "virtual center of mass");
    this.linearVelocity = vector(add(this.linearVelocity, deltaLinear), "virtual linear velocity");
    this.angularVelocity = vector(add(this.angularVelocity, deltaAngular), "virtual angular velocity");
    this.impulse = vector(add(this.impulse, impulse), "accumulated impulse");
    this.moment = vector(add(this.moment, cross(point, impulse)), "accumulated moment");
  }
  resolve(normal: Vec3, depth: number, position: Vec3, previous: Vec3, mass: number, dt: number) {
    const invParticle = 1 / mass;
    if (!Number.isFinite(invParticle) || invParticle <= 0 || !Number.isFinite(dt) || dt <= 0)
      return error("particle mass and substep must be finite and positive.");
    // n·M⁻¹n + (r×n)·I⁻¹(r×n) accounts for translation, rotation and locked axes.
    const firstPoint = this.point(normal), denominator = invParticle + this.inverseEffectiveMass(firstPoint, normal);
    if (!Number.isFinite(denominator) || denominator <= 0) return error("contact inverse mass must be positive and finite.");
    // Position projection is shared between particle and body by effective inverse mass.
    const positionImpulse = depth / (dt * denominator);
    const firstImpulse = scale(normal, -positionImpulse);
    let correction = scale(normal, positionImpulse * invParticle * dt);
    let reactionImpulse = firstImpulse, reactionAngularImpulse = cross(firstPoint, firstImpulse);
    this.apply(firstImpulse, firstPoint, dt);

    // Remove remaining closing normal velocity using the virtual body's updated velocity.
    const secondPoint = this.point(normal);
    const particleVelocity = scale(sub(add(position, correction), previous), 1 / dt);
    const relativeNormal = dot(sub(particleVelocity, this.pointVelocity(secondPoint)), normal);
    const velocityDenominator = invParticle + this.inverseEffectiveMass(secondPoint, normal);
    if (!Number.isFinite(relativeNormal) || !Number.isFinite(velocityDenominator) || velocityDenominator <= 0)
      return error("contact velocity or inverse mass is not finite.");
    if (relativeNormal < 0) {
      const velocityImpulse = -relativeNormal / velocityDenominator;
      const secondImpulse = scale(normal, -velocityImpulse);
      correction = add(correction, scale(normal, velocityImpulse * invParticle * dt));
      reactionImpulse = add(reactionImpulse, secondImpulse);
      reactionAngularImpulse = add(reactionAngularImpulse, cross(secondPoint, secondImpulse));
      this.apply(secondImpulse, secondPoint, dt);
    }
    return { correction: vector(correction, "particle correction"), reactionImpulse: vector(reactionImpulse, "reaction impulse"), reactionAngularImpulse: vector(reactionAngularImpulse, "reaction moment") };
  }
  reaction() { return { impulse: vector(this.impulse, "reaction impulse"), moment: vector(this.moment, "reaction moment") }; }
}

export function createRopeBodyCoupling(bodies: ReadonlyMap<string, VirtualRopeSphere>): RopeDynamicCoupling {
  return {
    sphere(id) { const body = bodies.get(id); return body ? { center: body.center, radius: body.radius } : undefined; },
    resolve(id, normal, depth, position, previous, mass, dt) {
      const body = bodies.get(id) ?? error(`Missing virtual sphere '${id}'.`);
      return body.resolve(normal, depth, position, previous, mass, dt);
    },
  };
}
