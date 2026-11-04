/** M0 CPU experiments, not the production physics API. All coordinates are 3D. */
export type Vec3 = [number, number, number];
export type SimulationKind = "rope" | "cloth" | "softbody" | "fluid";
export interface SimulationOptions {
  seed?: number;
  fixedDt?: number;
  substeps?: number;
  iterations?: number;
  /** Contact still affects particles, but the body is an infinite-mass collider when false. */
  twoWayCoupling?: boolean;
  contacts?: boolean;
  gravity?: Vec3;
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
  reactionImpulse: Vec3;
  absoluteReactionImpulse: number;
  maxContactCorrection: number;
  maxObservedSpeed: number;
}
export interface SimulationSnapshot {
  format: "threecat-m0-simulation";
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
  snapshot(): SimulationSnapshot;
  restore(snapshot: SimulationSnapshot): void;
  inspect(): SimulationInspection;
  getRenderState(): SimulationRenderState;
  applyImpulse(id: string, impulse: Vec3): void;
  dispose(): void;
}
