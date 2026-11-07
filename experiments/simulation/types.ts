/** M0 CPU experiments, not the production physics API. All coordinates are 3D. */
export type Vec3 = [number, number, number];
export type SimulationKind = "rope" | "cloth" | "softbody" | "fluid";
export interface SimulationContainer { min: Vec3; max: Vec3 }
export type SimulationCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number }
  | { kind: "box"; id: string; center: Vec3; halfExtents: Vec3 };
export interface SimulationOptions {
  seed?: number;
  fixedDt?: number;
  substeps?: number;
  iterations?: number;
  /** Contact still affects particles, but the body is an infinite-mass collider when false. */
  twoWayCoupling?: boolean;
  contacts?: boolean;
  gravity?: Vec3;
  /** World-space translation of the reference particles and container. */
  origin?: Vec3;
  /** Axis-aligned bounds relative to origin. */
  container?: SimulationContainer;
  /** Initial fluid lattice dimensions; omitted means 4 by 4 by 4. */
  particleGrid?: Vec3;
  /** Initial soft-body lattice dimensions; omitted means 3 by 3 by 3. */
  softBodyGrid?: Vec3;
  /** Soft-body nonadjacent particle contacts, disabled by default. */
  selfCollisions?: boolean;
  bodyPosition?: Vec3;
  bodyVelocity?: Vec3;
}
export interface ResolvedOptions {
  seed: number;
  fixedDt: number;
  substeps: number;
  iterations: number;
  twoWayCoupling: boolean;
  contacts: boolean;
  gravity: Vec3;
  origin?: Vec3;
  container?: SimulationContainer;
  particleGrid?: Vec3;
  softBodyGrid?: Vec3;
  selfCollisions?: boolean;
  bodyPosition: Vec3;
  bodyVelocity: Vec3;
}
export interface PointState {
  id: string;
  position: Vec3;
  velocity: Vec3;
  inverseMass: number;
  radius: number;
}
export interface DistanceConstraint {
  a: number;
  b: number;
  restLength: number;
  compliance: number;
}
export interface VolumeConstraint {
  indices: [number, number, number, number];
  restVolume: number;
  compliance: number;
}
export interface SimulationCounters {
  contactCount: number;
  /** Cumulative particle-pair projection count, not unique contact events. */
  selfContactCorrections?: number;
  reactionImpulse: Vec3;
  absoluteReactionImpulse: number;
  maxContactCorrection: number;
  maxObservedSpeed: number;
}
export interface SimulationSnapshot {
  format: "pelican-m0-simulation";
  version: 1;
  kind: SimulationKind;
  options: ResolvedOptions;
  tick: number;
  bodies: PointState[];
  particles: PointState[];
  distances: DistanceConstraint[];
  volumes: VolumeConstraint[];
  triangles: [number, number, number][];
  counters: SimulationCounters;
  /** Optional sampled collider radii; absent in snapshots created before this field. */
  sampledBodies?: { id: string; radius: number }[];
  /** Forces queued for one fixed tick; absent in older snapshots. */
  particleForces?: { id: string; force: Vec3 }[];
  /** Manually configured particle colliders; absent in older snapshots. */
  colliders?: SimulationCollider[];
}
export interface SimulationRenderState {
  kind: SimulationKind;
  tick: number;
  bodies: { id: string; position: Vec3; radius: number }[];
  particles: { id: string; position: Vec3; radius: number }[];
  /** Every index in links / triangles addresses particles, never bodies. */
  links: [number, number][];
  triangles: [number, number, number][];
}
export interface SimulationInspection {
  kind: SimulationKind;
  tick: number;
  simulatedSeconds: number;
  disposed: boolean;
  finite: boolean;
  resources: {
    bodies: number;
    particles: number;
    constraints: number;
    triangles: number;
  };
  bodies: PointState[];
  particleBounds: { min: Vec3; max: Vec3 } | null;
  maxDistanceRelativeError: number;
  maxVolumeRelativeError: number;
  minSignedVolumeRatio: number | null;
  maxSpeed: number;
  kineticEnergy: number;
  momentum: Vec3;
  contacts: SimulationCounters;
  fluid: null | {
    method: "WCSPH";
    restDensity: number;
    minDensity: number;
    maxDensity: number;
    maxPressure: number;
  };
  /** Wall time spent executing the synchronous solver on the CPU; not GPU / process CPU time. */
  timing: {
    solverWallMs: number;
    measuredSteps: number;
    meanStepMs: number;
    maxStepMs: number;
  };
}
export interface Simulation {
  readonly kind: SimulationKind;
  step(steps?: number): SimulationInspection;
  /** Updates the built-in sampled sphere body used by the CPU reference scenes. */
  setBodyState(id: string, position: Vec3, velocity: Vec3, radius?: number): void;
  setTwoWayCoupling(enabled: boolean): void;
  setGravity(gravity: Vec3): void;
  setColliders(colliders: readonly SimulationCollider[]): void;
  snapshot(): SimulationSnapshot;
  restore(snapshot: SimulationSnapshot): void;
  inspect(): SimulationInspection;
  getRenderState(): SimulationRenderState;
  /** Detached particle velocities in the same order as getRenderState().particles. */
  getParticleVelocities(): Vec3[];
  applyImpulse(id: string, impulse: Vec3): void;
  applyImpulses(impulses: readonly { id: string; impulse: Vec3 }[]): void;
  applyForces(forces: readonly { id: string; force: Vec3 }[]): void;
  dispose(): void;
}
