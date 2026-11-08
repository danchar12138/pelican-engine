import { resolveRopeSelfCollisions } from "./rope-self-collision.ts";
import { createBoxFrame, orientedParticleBoxContact, orientedSegmentBoxContact } from "./box-contact.ts";
import { staticContactCorrection, sweepParticle } from "./continuous-contact.ts";

/** Internal CPU rope solver. Metres, seconds, kilograms and Newtons; Y is not privileged.
 * External colliders are immutable input samples for each tick: contacts move rope particles
 * only. Optional host coupling can react on dynamic spheres and boxes. No tearing.
 */
export type Vec3 = [number, number, number];
export type RopeCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number }
  | { kind: "box"; id: string; center: Vec3; halfExtents: Vec3; rotation?: Vec3 };
/** Private per-tick coupling. The caller owns and discards virtual body state on failure. */
export interface RopeDynamicCoupling {
  sphere(colliderId: string): { center: Vec3; radius: number } | undefined;
  box?(colliderId: string): { center: Vec3; halfExtents: Vec3; rotation: Vec3 } | undefined;
  resolve(colliderId: string, normal: Vec3, depth: number, position: Vec3, previous: Vec3, mass: number, dt: number, surface?: Vec3): {
    correction: Vec3; reactionImpulse: Vec3; reactionAngularImpulse: Vec3;
  };
  /** Optional bilateral constraints for particles attached to dynamic bodies. */
  readonly attachedParticles?: readonly number[];
  /** Ignore contact with the body that owns a particle attachment. */
  ignoreAttachmentContact?(index: number, colliderId: string): boolean;
  resolveAttachment?(index: number, position: Vec3, previous: Vec3, mass: number, dt: number): {
    correction: Vec3; reactionImpulse: Vec3; reactionAngularImpulse: Vec3;
  };
}
export interface RopeOptions {
  /** At least two distinct consecutive 3D points, in metres. */
  points: Vec3[];
  /** Kilograms per particle; every non-anchored particle has this mass. */
  mass: number;
  /** Collision radius of each particle, metres. */
  radius?: number;
  /** New ropes resolve sampled sphere and box contacts on segment interiors by default. */
  segmentCollisions?: boolean;
  /** New ropes resolve non-adjacent self contacts by default. */
  selfCollisions?: boolean;
  fixedDt?: number;
  substeps?: number;
  iterations?: number;
  /** Linear velocity decay coefficient in inverse seconds. */
  damping?: number;
  gravity?: Vec3;
  /** Defaults to pinning the first particle at its initial position; [] gives a free rope. */
  anchors?: { index: number; position: Vec3 }[];
}
export interface RopeContact {
  tick: number;
  particle: number;
  colliderId: string;
  /** Maximum overlap observed during this tick before positional correction, metres. */
  penetration: number;
  /** Opposite impulse from particle contact response, in world-space N·s. */
  reactionImpulse?: Vec3;
  /** Moment of those impulses about the world origin, in angular-momentum units. */
  reactionAngularImpulse?: Vec3;
}
export interface RopeSegmentContact {
  tick: number;
  segment: number;
  colliderId: string;
  /** Last closest-point fraction on the segment, strictly between zero and one. */
  fraction: number;
  penetration: number;
  reactionImpulse?: Vec3;
  reactionAngularImpulse?: Vec3;
}
export interface RopeSelfContact {
  tick: number;
  firstSegment: number;
  secondSegment: number;
  firstFraction: number;
  secondFraction: number;
  penetration: number;
}
export interface RopeState {
  tick: number;
  simulatedSeconds: number;
  disposed: boolean;
  gravity: Vec3;
  segmentCollisions: boolean;
  selfCollisions: boolean;
  positions: Vec3[];
  velocities: Vec3[];
  anchors: { index: number; position: Vec3 }[];
  contacts: RopeContact[];
  segmentContacts: RopeSegmentContact[];
  selfContacts: RopeSelfContact[];
  maxDistanceError: number;
  resources: { particles: number; constraints: number; anchors: number; colliders: number };
}
export interface RopeSnapshot {
  format: "pelican-rope-cpu";
  version: 1;
  tick: number;
  config: {
    mass: number; radius: number; fixedDt: number; substeps: number;
    iterations: number; damping: number; gravity: Vec3; restLengths: number[];
    /** Absent in historical particle-only snapshots. */
    segmentCollisions?: boolean;
    /** Absent in historical snapshots without self collision. */
    selfCollisions?: boolean;
  };
  positions: Vec3[];
  velocities: Vec3[];
  anchors: { index: number; position: Vec3 }[];
  /** Forces queued for exactly the next tick (Newtons). */
  forces: Vec3[];
  colliders: RopeCollider[];
  contacts: RopeContact[];
  /** Absent in historical particle-only snapshots. */
  segmentContacts?: RopeSegmentContact[];
  /** Absent in historical snapshots without self collision. */
  selfContacts?: RopeSelfContact[];
}

export class RopeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "RopeError";
  }
}
const fail = (code: string, reason: string): never => { throw new RopeError(code, reason); };
const vec = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6);
const copy = (v: Vec3): Vec3 => [v[0], v[1], v[2]];
const finiteVector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x));
const copyContact = (contact: RopeContact): RopeContact => {
  const { reactionImpulse, reactionAngularImpulse, ...rest } = contact;
  return {
    ...rest,
    ...(reactionImpulse === undefined ? {} : { reactionImpulse: copy(reactionImpulse) }),
    ...(reactionAngularImpulse === undefined ? {} : { reactionAngularImpulse: copy(reactionAngularImpulse) }),
  };
};
const copySegmentContact = (contact: RopeSegmentContact): RopeSegmentContact => {
  const { reactionImpulse, reactionAngularImpulse, ...rest } = contact;
  return { ...rest, ...(reactionImpulse === undefined ? {} : { reactionImpulse: copy(reactionImpulse) }),
    ...(reactionAngularImpulse === undefined ? {} : { reactionAngularImpulse: copy(reactionAngularImpulse) }) };
};
const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const validVec = (v: unknown, name: string): Vec3 => vec(v) ? copy(v) : fail("ROPE_INPUT", `${name} must be a finite 3D vector (|component| <= 1e6)`);
const positive = (v: unknown, name: string): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e6 ? v : fail("ROPE_INPUT", `${name} must be positive and <= 1e6`);
const bounded = (v: unknown, name: string, max: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : fail("ROPE_INPUT", `${name} must be within [0, ${max}]`);
const indexOf = (v: unknown, count: number): number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < count ? v as number : fail("ROPE_INDEX", "particle index out of range");
const finiteState = (v: unknown): v is Vec3 => vec(v);
function readColliders(input: unknown): RopeCollider[] {
  if (!Array.isArray(input) || input.length > 4096) fail("ROPE_INPUT", "colliders must be an array (max 4096)");
  const ids = new Set<string>();
  return (input as RopeCollider[]).map((c: RopeCollider) => {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id || ids.has(c.id)) fail("ROPE_INPUT", "collider ids must be unique nonempty strings");
    ids.add(c.id);
    if (c.kind === "sphere") return { kind: "sphere", id: c.id, center: validVec(c.center, "center"), radius: positive(c.radius, "sphere radius") };
    if (c.kind === "box") {
      const center = validVec(c.center, "box center"), halfExtents = validVec(c.halfExtents, "box halfExtents");
      if (halfExtents.some(value => value <= 0)) fail("ROPE_INPUT", "box halfExtents must be positive");
      const rotation = c.rotation === undefined ? undefined : validVec(c.rotation, "box rotation");
      return { kind: "box", id: c.id, center, halfExtents, ...(rotation ? { rotation } : {}) };
    }
    if (c.kind === "plane") {
      const normal = validVec(c.normal, "normal"), n = length(normal);
      if (Math.abs(n - 1) > 1e-6) fail("ROPE_INPUT", "plane normal must have unit length");
      return { kind: "plane", id: c.id, normal, offset: boundedSigned(c.offset, "plane offset") };
    }
    return fail("ROPE_INPUT", "unsupported collider kind");
  });
}
function boundedSigned(v: unknown, name: string): number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : fail("ROPE_INPUT", `${name} must be finite (|value| <= 1e6)`);
}
function readAnchors(input: unknown, count: number): Map<number, Vec3> {
  if (!Array.isArray(input) || input.length > count) fail("ROPE_INPUT", "anchors must be an array of unique particle indices");
  const result = new Map<number, Vec3>();
  for (const a of input as { index: number; position: Vec3 }[]) {
    if (!a || typeof a !== "object") fail("ROPE_INPUT", "invalid anchor");
    const i = indexOf(a.index, count);
    if (result.has(i)) fail("ROPE_INPUT", "duplicate anchor index");
    result.set(i, validVec(a.position, "anchor position"));
  }
  return result;
}

export function createRope(options: RopeOptions): RopeSolver {
  if (!options || typeof options !== "object" || !Array.isArray(options.points) || options.points.length < 2 || options.points.length > 4096) fail("ROPE_INPUT", "points must contain 2..4096 particles");
  const positions = options.points.map((p, i) => validVec(p, `points[${i}]`));
  const mass = positive(options.mass, "mass");
  const radius = positive(options.radius ?? 0.025, "radius");
  if (options.segmentCollisions !== undefined && typeof options.segmentCollisions !== "boolean") fail("ROPE_INPUT", "segmentCollisions must be boolean");
  const segmentCollisions = options.segmentCollisions ?? true;
  if (options.selfCollisions !== undefined && typeof options.selfCollisions !== "boolean") fail("ROPE_INPUT", "selfCollisions must be boolean");
  const selfCollisions = options.selfCollisions ?? true;
  const fixedDt = positive(options.fixedDt ?? 1 / 60, "fixedDt");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) fail("ROPE_INPUT", "fixedDt must be in [1/1000, 1/30]");
  const substeps = options.substeps ?? 4, iterations = options.iterations ?? 12;
  if (!Number.isInteger(substeps) || substeps < 1 || substeps > 32 || !Number.isInteger(iterations) || iterations < 1 || iterations > 64) fail("ROPE_INPUT", "substeps/iterations must be positive bounded integers");
  const damping = bounded(options.damping ?? 0.15, "damping", 100);
  const gravity = validVec(options.gravity ?? [0, -9.81, 0], "gravity");
  const restLengths = positions.slice(1).map((p, i) => length([p[0] - positions[i][0], p[1] - positions[i][1], p[2] - positions[i][2]]));
  if (restLengths.some(d => !Number.isFinite(d) || d <= 1e-8)) fail("ROPE_INPUT", "adjacent particles must have distinct positions");
  const anchors = readAnchors(options.anchors ?? [{ index: 0, position: positions[0] }], positions.length);
  for (const [i, p] of anchors) positions[i] = copy(p);
  return new RopeSolver({ mass, radius, fixedDt, substeps, iterations, damping, gravity, restLengths, segmentCollisions, selfCollisions }, positions, anchors);
}

type Config = RopeSnapshot["config"] & { segmentCollisions: boolean; selfCollisions: boolean };
export class RopeSolver {
  private tickValue = 0;
  private disposedValue = false;
  private velocities: Vec3[];
  private forces: Vec3[];
  private colliders: RopeCollider[] = [];
  private contacts: RopeContact[] = [];
  private segmentContacts: RopeSegmentContact[] = [];
  private selfContacts: RopeSelfContact[] = [];
  constructor(private readonly config: Config, private positions: Vec3[], private anchors: Map<number, Vec3>) {
    this.velocities = positions.map(() => [0, 0, 0]);
    this.forces = positions.map(() => [0, 0, 0]);
  }
  private alive(): void { if (this.disposedValue) fail("ROPE_DISPOSED", "rope has been disposed"); }
  setGravity(value: Vec3): Vec3 { this.alive(); const gravity = validVec(value, "gravity"); this.config.gravity = gravity; return copy(gravity); }
  /** Copies all inputs: callers may mutate their arrays after calling this. */
  setColliders(input: RopeCollider[]): void {
    this.alive(); this.colliders = readColliders(input); this.contacts = []; this.segmentContacts = [];
  }
  /** Pins or moves a particle; new anchor position takes effect immediately. */
  setAnchor(index: number, position: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), p = validVec(position, "anchor position");
    this.anchors.set(i, p); this.positions[i] = copy(p); this.velocities[i] = [0, 0, 0]; this.forces[i] = [0, 0, 0];
  }
  setAnchors(anchors: readonly { index: number; position: Vec3 }[]): void {
    this.alive();
    const staged = readAnchors(anchors, this.positions.length);
    for (const [index, position] of staged) {
      this.anchors.set(index, position);
      this.positions[index] = copy(position);
      this.velocities[index] = [0, 0, 0];
      this.forces[index] = [0, 0, 0];
    }
  }
  releaseAnchor(index: number): void { this.alive(); this.anchors.delete(indexOf(index, this.positions.length)); }
  /** N·s (kg·m/s); changes velocity immediately, not position. */
  applyImpulse(index: number, impulse: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), v = validVec(impulse, "impulse");
    if (this.anchors.has(i)) fail("ROPE_ANCHORED", "cannot apply impulse to an anchor");
    const next: Vec3 = [0, 1, 2].map(k => this.velocities[i][k] + v[k] / this.config.mass) as Vec3;
    if (!finiteState(next)) fail("ROPE_NUMERIC", "impulse exceeds numeric bounds");
    this.velocities[i] = next;
  }
  applyImpulses(impulses: readonly { index: number; impulse: Vec3 }[]): void {
    this.alive();
    if (!Array.isArray(impulses) || impulses.length > this.positions.length) fail("ROPE_INPUT", "impulses must be an array no longer than the particle count");
    const seen = new Set<number>(), staged: { index: number; velocity: Vec3 }[] = [];
    for (const item of impulses) {
      if (!item || typeof item !== "object") fail("ROPE_INPUT", "invalid impulse entry");
      const index = indexOf(item.index, this.positions.length), impulse = validVec(item.impulse, "impulse");
      if (seen.has(index)) fail("ROPE_INPUT", "duplicate impulse target");
      if (this.anchors.has(index)) fail("ROPE_ANCHORED", "cannot apply impulse to an anchor");
      const velocity = [0, 1, 2].map(k => this.velocities[index][k] + impulse[k] / this.config.mass) as Vec3;
      if (!finiteState(velocity)) fail("ROPE_NUMERIC", "impulse exceeds numeric bounds");
      seen.add(index); staged.push({ index, velocity });
    }
    for (const item of staged) this.velocities[item.index] = item.velocity;
  }
  /** Newtons accumulated for exactly one next fixed tick; not a persistent force. */
  applyForce(index: number, force: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), v = validVec(force, "force");
    if (this.anchors.has(i)) fail("ROPE_ANCHORED", "cannot apply force to an anchor");
    const next: Vec3 = [0, 1, 2].map(k => this.forces[i][k] + v[k]) as Vec3;
    if (!finiteState(next)) fail("ROPE_NUMERIC", "force accumulation exceeds numeric bounds");
    this.forces[i] = next;
  }
  /** Exactly N fixed ticks; a failed batch restores the state before the first tick. */
  step(steps = 1, coupling?: RopeDynamicCoupling): RopeState {
    this.alive();
    if (coupling && steps !== 1) fail("ROPE_INPUT", "coupled stepping requires exactly one tick");
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000 || this.tickValue + steps > Number.MAX_SAFE_INTEGER) fail("ROPE_INPUT", "steps must be an integer in [1,1000] without tick overflow");
    // stepOne replaces these arrays rather than mutating the prior committed state.
    const before = {
      positions: this.positions,
      velocities: this.velocities,
      forces: this.forces,
      contacts: this.contacts,
      segmentContacts: this.segmentContacts,
      selfContacts: this.selfContacts,
      tick: this.tickValue,
    };
    try {
      for (let s = 0; s < steps; s++) this.stepOne(coupling);
    } catch (error) {
      this.positions = before.positions;
      this.velocities = before.velocities;
      this.forces = before.forces;
      this.contacts = before.contacts;
      this.segmentContacts = before.segmentContacts;
      this.selfContacts = before.selfContacts;
      this.tickValue = before.tick;
      throw error;
    }
    return this.inspect();
  }
  private stepOne(coupling?: RopeDynamicCoupling): void {
    const { fixedDt, substeps, iterations, mass, gravity, damping, restLengths, radius } = this.config;
    const h = fixedDt / substeps, decay = Math.exp(-damping * h);
    // Work on copies; numeric failures must never leave half a tick applied.
    const positions = this.positions.map(copy), velocities = this.velocities.map(copy);
    const contacts = new Map<string, RopeContact>();
    const segmentContacts = new Map<string, RopeSegmentContact>();
    const selfContacts = new Map<string, RopeSelfContact>();
    const spheres = this.config.segmentCollisions ? this.colliders.filter((collider): collider is Extract<RopeCollider, { kind: "sphere" }> => collider.kind === "sphere") : [];
    const boxes = this.config.segmentCollisions ? this.colliders.filter((collider): collider is Extract<RopeCollider, { kind: "box" }> => collider.kind === "box") : [];
    const boxFrames = new Map(this.colliders.flatMap(collider => collider.kind === "box" && collider.rotation ? [[collider.id, createBoxFrame(collider.center, collider.rotation)] as const] : []));
    for (let sub = 0; sub < substeps; sub++) {
      const previous = positions.map(copy);
      for (let i = 0; i < positions.length; i++) {
        const anchor = this.anchors.get(i);
        if (anchor) { positions[i] = copy(anchor); velocities[i] = [0, 0, 0]; continue; }
        for (let k = 0; k < 3; k++) {
          velocities[i][k] = velocities[i][k] * decay + (gravity[k] + this.forces[i][k] / mass) * h;
          positions[i][k] += velocities[i][k] * h;
        }
      }
      for (let iter = 0; iter < iterations; iter++) {
        for (let j = 0; j < restLengths.length; j++) {
          const a = positions[j], b = positions[j + 1];
          let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
          let dist = Math.hypot(dx, dy, dz);
          // If a contact collapses a link, separate it on a deterministic axis.
          if (dist < 1e-12) { dx = 1e-6; dy = 0; dz = 0; dist = 1e-6; }
          const wa = this.anchors.has(j) ? 0 : 1, wb = this.anchors.has(j + 1) ? 0 : 1;
          if (wa + wb === 0) continue; // two incompatible kinematic anchors are intentionally authoritative
          const d = (dist - restLengths[j]) / (dist * (wa + wb));
          for (let k = 0; k < 3; k++) {
            const correction = (k === 0 ? dx : k === 1 ? dy : dz) * d;
            a[k] += correction * wa; b[k] -= correction * wb;
          }
        }
        for (let i = 0; i < positions.length; i++) {
          if (this.anchors.has(i)) continue; // anchors cannot be displaced by external colliders
          const p = positions[i];
          for (const c of this.colliders) {
            if (coupling?.ignoreAttachmentContact?.(i, c.id)) continue;
            let depth = 0; let normal: Vec3;
            const dynamicSphere = c.kind === "sphere" ? coupling?.sphere(c.id) : undefined;
            const dynamicBox = c.kind === "box" ? coupling?.box?.(c.id) : undefined;
            if (c.kind === "plane") {
              depth = c.offset + radius - (p[0] * c.normal[0] + p[1] * c.normal[1] + p[2] * c.normal[2]);
              normal = c.normal;
            } else if (c.kind === "box") {
              const center = dynamicBox?.center ?? c.center, extents = dynamicBox?.halfExtents ?? c.halfExtents;
              const frame = dynamicBox ? createBoxFrame(center, dynamicBox.rotation) : boxFrames.get(c.id);
              const contact = orientedParticleBoxContact(p, radius, center, extents, frame);
              const hit = contact ?? sweepParticle(previous[i], p, radius, { ...c, center, halfExtents: extents, rotation: dynamicBox?.rotation ?? c.rotation });
              if (!hit) continue;
              normal = hit.normal; depth = hit.depth;
            } else {
              const center = dynamicSphere?.center ?? c.center, colliderRadius = dynamicSphere?.radius ?? c.radius;
              const delta: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
              const distance = length(delta);
              depth = colliderRadius + radius - distance;
              normal = distance < 1e-12 ? [1, 0, 0] : [delta[0] / distance, delta[1] / distance, delta[2] / distance];
            }
            if (depth <= 0) {
              const active: RopeCollider = c.kind === "sphere" && dynamicSphere ? { ...c, ...dynamicSphere } : c;
              const hit = sweepParticle(previous[i], p, radius, active);
              if (!hit) continue;
              normal = hit.normal; depth = hit.depth;
            }
            let reaction: Vec3, moment: Vec3;
            if ((dynamicSphere || dynamicBox) && coupling) {
              const surface: Vec3 | undefined = dynamicBox ? [p[0] + normal[0] * (depth - radius), p[1] + normal[1] * (depth - radius), p[2] + normal[2] * (depth - radius)] : undefined;
              const result = coupling.resolve(c.id, normal, depth, p, previous[i], mass, h, surface);
              if (!finiteVector(result.correction) || !finiteVector(result.reactionImpulse) || !finiteVector(result.reactionAngularImpulse))
                fail("ROPE_NUMERIC", "coupled contact exceeded finite numeric bounds");
              for (let k = 0; k < 3; k++) p[k] += result.correction[k];
              reaction = result.reactionImpulse; moment = result.reactionAngularImpulse;
            } else {
              const correction = staticContactCorrection(normal, depth, p, previous[i]);
              for (let k = 0; k < 3; k++) p[k] += correction[k];
              // A manually sampled collider remains immovable; expose its projection reaction.
              reaction = correction.map(value => -mass * value / h) as Vec3;
              const point: Vec3 = c.kind === "sphere"
                ? [c.center[0] + normal[0] * c.radius, c.center[1] + normal[1] * c.radius, c.center[2] + normal[2] * c.radius]
                : [p[0] - normal[0] * radius, p[1] - normal[1] * radius, p[2] - normal[2] * radius];
              moment = [point[1] * reaction[2] - point[2] * reaction[1], point[2] * reaction[0] - point[0] * reaction[2], point[0] * reaction[1] - point[1] * reaction[0]];
            }
            if (!finiteVector(reaction) || !finiteVector(moment)) fail("ROPE_NUMERIC", "contact reaction exceeded finite numeric bounds");
            const key = `${i}:${c.id}`;
            const existing = contacts.get(key);
            if (existing) {
              existing.penetration = Math.max(existing.penetration, depth);
              for (let k = 0; k < 3; k++) {
                existing.reactionImpulse![k] += reaction[k];
                existing.reactionAngularImpulse![k] += moment[k];
              }
              if (!finiteVector(existing.reactionImpulse) || !finiteVector(existing.reactionAngularImpulse)) fail("ROPE_NUMERIC", "contact reaction accumulation exceeded finite numeric bounds");
            } else contacts.set(key, { tick: this.tickValue + 1, particle: i, colliderId: c.id, penetration: depth, reactionImpulse: reaction, reactionAngularImpulse: moment });
          }
        }
        // Resolve interior segment/sphere overlaps after particle contacts. Endpoint
        // overlaps are already handled by the particle pass above.
        for (let j = 0; j < restLengths.length; j++) {
          const a = positions[j], b = positions[j + 1];
          for (const collider of spheres) {
            if (coupling?.ignoreAttachmentContact?.(j, collider.id) || coupling?.ignoreAttachmentContact?.(j + 1, collider.id)) continue;
            const dynamic = coupling?.sphere(collider.id);
            const center = dynamic?.center ?? collider.center, colliderRadius = dynamic?.radius ?? collider.radius;
            const direction: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const squared = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2];
            if (squared < 1e-24) continue; // collapsed segment is covered by particle contacts
            const fraction = Math.max(0, Math.min(1, ((center[0] - a[0]) * direction[0] + (center[1] - a[1]) * direction[1] + (center[2] - a[2]) * direction[2]) / squared));
            if (fraction <= 0 || fraction >= 1) continue;
            const closest: Vec3 = [a[0] + direction[0] * fraction, a[1] + direction[1] * fraction, a[2] + direction[2] * fraction];
            const delta: Vec3 = [closest[0] - center[0], closest[1] - center[1], closest[2] - center[2]];
            const distance = length(delta), depth = colliderRadius + radius - distance;
            if (depth <= 0) continue;
            let normal: Vec3;
            if (distance >= 1e-12) normal = [delta[0] / distance, delta[1] / distance, delta[2] / distance];
            else {
              // Choose a deterministic perpendicular if the sphere center lies exactly on the segment.
              const [x, y, z] = direction.map(Math.abs);
              const axis: Vec3 = x <= y && x <= z ? [1, 0, 0] : y <= z ? [0, 1, 0] : [0, 0, 1];
              const perpendicular: Vec3 = [direction[1] * axis[2] - direction[2] * axis[1], direction[2] * axis[0] - direction[0] * axis[2], direction[0] * axis[1] - direction[1] * axis[0]];
              const magnitude = length(perpendicular);
              normal = [perpendicular[0] / magnitude, perpendicular[1] / magnitude, perpendicular[2] / magnitude];
            }
            const first = this.anchors.has(j) ? 0 : 1 - fraction, second = this.anchors.has(j + 1) ? 0 : fraction;
            const inverseWeight = first * first + second * second;
            if (inverseWeight === 0) continue; // two authoritative anchors cannot move
            const contactMass = mass / inverseWeight;
            if (!Number.isFinite(contactMass) || contactMass <= 0) fail("ROPE_NUMERIC", "segment contact mass exceeded finite bounds");
            const previousPoint: Vec3 = [0, 1, 2].map(k => previous[j][k] * (1 - fraction) + previous[j + 1][k] * fraction) as Vec3;
            let correction: Vec3, reaction: Vec3, moment: Vec3;
            if (dynamic && coupling) {
              const resolved = coupling.resolve(collider.id, normal, depth, closest, previousPoint, contactMass, h);
              correction = resolved.correction; reaction = resolved.reactionImpulse; moment = resolved.reactionAngularImpulse;
            } else {
              correction = [normal[0] * depth, normal[1] * depth, normal[2] * depth];
              const magnitude = -contactMass * depth / h;
              reaction = [normal[0] * magnitude, normal[1] * magnitude, normal[2] * magnitude];
              const point: Vec3 = [center[0] + normal[0] * colliderRadius, center[1] + normal[1] * colliderRadius, center[2] + normal[2] * colliderRadius];
              moment = [point[1] * reaction[2] - point[2] * reaction[1], point[2] * reaction[0] - point[0] * reaction[2], point[0] * reaction[1] - point[1] * reaction[0]];
            }
            if (!finiteVector(correction) || !finiteVector(reaction) || !finiteVector(moment)) fail("ROPE_NUMERIC", "segment contact exceeded finite bounds");
            // Gradients of the closest point distribute correction to movable endpoints.
            for (let k = 0; k < 3; k++) {
              a[k] += correction[k] * first / inverseWeight;
              b[k] += correction[k] * second / inverseWeight;
            }
            const key = `${j}:${collider.id}`, existing = segmentContacts.get(key);
            if (existing) {
              existing.penetration = Math.max(existing.penetration, depth); existing.fraction = fraction;
              for (let k = 0; k < 3; k++) { existing.reactionImpulse![k] += reaction[k]; existing.reactionAngularImpulse![k] += moment[k]; }
              if (!finiteVector(existing.reactionImpulse) || !finiteVector(existing.reactionAngularImpulse)) fail("ROPE_NUMERIC", "segment reaction accumulation exceeded finite bounds");
            } else segmentContacts.set(key, { tick: this.tickValue + 1, segment: j, colliderId: collider.id, fraction, penetration: depth, reactionImpulse: reaction, reactionAngularImpulse: moment });
          }
          for (const collider of boxes) {
            if (coupling?.ignoreAttachmentContact?.(j, collider.id) || coupling?.ignoreAttachmentContact?.(j + 1, collider.id)) continue;
            const dynamic = coupling?.box?.(collider.id);
            const center = dynamic?.center ?? collider.center, extents = dynamic?.halfExtents ?? collider.halfExtents;
            const frame = dynamic ? createBoxFrame(center, dynamic.rotation) : boxFrames.get(collider.id);
            const contact = orientedSegmentBoxContact(a, b, radius, center, extents, frame);
            if (!contact) continue;
            const { fraction, point, normal, depth } = contact;
            const first = this.anchors.has(j) ? 0 : 1 - fraction, second = this.anchors.has(j + 1) ? 0 : fraction;
            const inverseWeight = first * first + second * second;
            if (inverseWeight === 0) continue;
            const surface: Vec3 = [point[0] + normal[0] * (depth - radius), point[1] + normal[1] * (depth - radius), point[2] + normal[2] * (depth - radius)];
            const contactMass = mass / inverseWeight;
            if (!Number.isFinite(contactMass) || contactMass <= 0) fail("ROPE_NUMERIC", "box segment contact mass exceeded finite bounds");
            let correction: Vec3, reaction: Vec3, moment: Vec3;
            if (dynamic && coupling) {
              const previousPoint: Vec3 = [0, 1, 2].map(k => previous[j][k] * (1 - fraction) + previous[j + 1][k] * fraction) as Vec3;
              const resolved = coupling.resolve(collider.id, normal, depth, point, previousPoint, contactMass, h, surface);
              correction = resolved.correction; reaction = resolved.reactionImpulse; moment = resolved.reactionAngularImpulse;
            } else {
              correction = [normal[0] * depth, normal[1] * depth, normal[2] * depth];
              const magnitude = -contactMass * depth / h;
              reaction = [normal[0] * magnitude, normal[1] * magnitude, normal[2] * magnitude];
              moment = [surface[1] * reaction[2] - surface[2] * reaction[1], surface[2] * reaction[0] - surface[0] * reaction[2], surface[0] * reaction[1] - surface[1] * reaction[0]];
            }
            if (!finiteVector(correction) || !finiteVector(reaction) || !finiteVector(moment)) fail("ROPE_NUMERIC", "box segment contact exceeded finite bounds");
            for (let k = 0; k < 3; k++) {
              a[k] += correction[k] * first / inverseWeight;
              b[k] += correction[k] * second / inverseWeight;
            }
            const key = `${j}:${collider.id}`, existing = segmentContacts.get(key);
            if (existing) {
              existing.penetration = Math.max(existing.penetration, depth); existing.fraction = fraction;
              for (let k = 0; k < 3; k++) { existing.reactionImpulse![k] += reaction[k]; existing.reactionAngularImpulse![k] += moment[k]; }
              if (!finiteVector(existing.reactionImpulse) || !finiteVector(existing.reactionAngularImpulse)) fail("ROPE_NUMERIC", "box segment reaction accumulation exceeded finite bounds");
            } else segmentContacts.set(key, { tick: this.tickValue + 1, segment: j, colliderId: collider.id, fraction, penetration: depth, reactionImpulse: reaction, reactionAngularImpulse: moment });
          }
        }
        if (this.config.selfCollisions && positions.length >= 4) resolveRopeSelfCollisions(positions, this.anchors, radius, this.tickValue + 1, selfContacts);
        for (const index of coupling?.attachedParticles ?? []) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length || this.anchors.has(index))
            fail("ROPE_ATTACHMENT", "Body attachment requires a valid, unpinned particle and an active physics bridge.");
          const resolve = coupling?.resolveAttachment ?? fail("ROPE_ATTACHMENT", "Body attachment requires an active physics bridge.");
          const result = resolve(index, positions[index], previous[index], mass, h);
          if (!finiteVector(result.correction) || !finiteVector(result.reactionImpulse) || !finiteVector(result.reactionAngularImpulse))
            fail("ROPE_NUMERIC", "Attachment reaction exceeded finite bounds.");
          for (let axis = 0; axis < 3; axis++) positions[index][axis] += result.correction[axis];
        }
      }
      for (let i = 0; i < positions.length; i++) {
        if (this.anchors.has(i)) continue;
        for (let k = 0; k < 3; k++) velocities[i][k] = (positions[i][k] - previous[i][k]) / h;
        if (!finiteState(positions[i]) || !finiteState(velocities[i])) fail("ROPE_NUMERIC", "solver exceeded finite state bounds");
      }
    }
    this.positions = positions; this.velocities = velocities;
    this.forces = positions.map(() => [0, 0, 0]); this.contacts = [...contacts.values()];
    this.segmentContacts = [...segmentContacts.values()]; this.selfContacts = [...selfContacts.values()]; this.tickValue++;
  }
  /** Detached positions for renderer synchronization without copying contact state. */
  particlePositions(): Vec3[] { this.alive(); return this.positions.map(copy); }
  inspect(): RopeState {
    if (this.disposedValue) return { tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: true, gravity: copy(this.config.gravity), segmentCollisions: this.config.segmentCollisions, selfCollisions: this.config.selfCollisions, positions: [], velocities: [], anchors: [], contacts: [], segmentContacts: [], selfContacts: [], maxDistanceError: 0, resources: { particles: 0, constraints: 0, anchors: 0, colliders: 0 } };
    const maxDistanceError = Math.max(0, ...this.config.restLengths.map((d, i) => {
      const a = this.positions[i], b = this.positions[i + 1];
      return Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - d);
    }));
    return {
      tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: false, gravity: copy(this.config.gravity), segmentCollisions: this.config.segmentCollisions, selfCollisions: this.config.selfCollisions,
      positions: this.positions.map(copy), velocities: this.velocities.map(copy),
      anchors: [...this.anchors].map(([index, position]) => ({ index, position: copy(position) })).sort((a, b) => a.index - b.index),
      contacts: this.contacts.map(copyContact), segmentContacts: this.segmentContacts.map(copySegmentContact), selfContacts: this.selfContacts.map(contact => ({ ...contact })), maxDistanceError,
      resources: { particles: this.positions.length, constraints: this.config.restLengths.length, anchors: this.anchors.size, colliders: this.colliders.length },
    };
  }
  snapshot(): RopeSnapshot {
    this.alive(); const state = this.inspect();
    return {
      format: "pelican-rope-cpu", version: 1, tick: this.tickValue,
      config: { ...this.config, gravity: copy(this.config.gravity), restLengths: [...this.config.restLengths] },
      positions: state.positions, velocities: state.velocities, anchors: state.anchors,
      forces: this.forces.map(copy), colliders: readColliders(this.colliders), contacts: state.contacts, segmentContacts: state.segmentContacts, selfContacts: state.selfContacts,
    };
  }
  /** Accepts a JSON-round-tripped snapshot only from the same rope configuration. Atomic on failure. */
  restore(input: RopeSnapshot): void {
    this.alive();
    if (!input || typeof input !== "object" || input.format !== "pelican-rope-cpu" || input.version !== 1 ||
        !Number.isSafeInteger(input.tick) || input.tick < 0) fail("ROPE_SNAPSHOT", "unsupported snapshot format or tick");
    const c = input.config;
    if (!c || c.mass !== this.config.mass || c.radius !== this.config.radius || c.fixedDt !== this.config.fixedDt ||
        c.substeps !== this.config.substeps || c.iterations !== this.config.iterations || c.damping !== this.config.damping ||
        (c.segmentCollisions !== undefined && typeof c.segmentCollisions !== "boolean") || (c.segmentCollisions ?? false) !== this.config.segmentCollisions ||
        (c.selfCollisions !== undefined && typeof c.selfCollisions !== "boolean") || (c.selfCollisions ?? false) !== this.config.selfCollisions ||
        !vec(c.gravity) || c.gravity.some((v, i) => v !== this.config.gravity[i]) ||
        !Array.isArray(c.restLengths) || c.restLengths.length !== this.config.restLengths.length ||
        c.restLengths.some((v, i) => v !== this.config.restLengths[i])) fail("ROPE_SNAPSHOT", "rope configuration/topology mismatch");
    const count = this.positions.length;
    if (!Array.isArray(input.positions) || !Array.isArray(input.velocities) || !Array.isArray(input.forces) ||
        [input.positions, input.velocities, input.forces].some(v => v.length !== count || !v.every(vec))) fail("ROPE_SNAPSHOT", "invalid particle state");
    const anchors = readAnchors(input.anchors, count);
    if ([...anchors].some(([i, p]) => p.some((v, k) => v !== input.positions[i][k]) || input.velocities[i].some(v => v !== 0) || input.forces[i].some(v => v !== 0))) fail("ROPE_SNAPSHOT", "inconsistent anchored particle state");
    const colliders = readColliders(input.colliders);
    if (!Array.isArray(input.contacts) || input.contacts.length > count * Math.max(1, colliders.length) ||
        input.contacts.some(contact => !contact || contact.tick !== input.tick ||
          !Number.isSafeInteger(contact.particle) || contact.particle < 0 || contact.particle >= count ||
          !colliders.some(collider => collider.id === contact.colliderId) ||
          typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0 ||
          (contact.reactionImpulse === undefined) !== (contact.reactionAngularImpulse === undefined) ||
          (contact.reactionImpulse !== undefined && (!finiteVector(contact.reactionImpulse) || !finiteVector(contact.reactionAngularImpulse))))) fail("ROPE_SNAPSHOT", "invalid contact state");
    const segments = input.segmentContacts === undefined ? [] : input.segmentContacts;
    if (!Array.isArray(segments) || segments.length > (count - 1) * colliders.length || (!this.config.segmentCollisions && segments.length > 0) ||
        segments.some(contact => !contact || contact.tick !== input.tick ||
          !Number.isSafeInteger(contact.segment) || contact.segment < 0 || contact.segment >= count - 1 ||
          !colliders.some(collider => collider.id === contact.colliderId && (collider.kind === "sphere" || collider.kind === "box")) ||
          typeof contact.fraction !== "number" || !Number.isFinite(contact.fraction) || contact.fraction <= 0 || contact.fraction >= 1 ||
          typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0 ||
          (contact.reactionImpulse === undefined) !== (contact.reactionAngularImpulse === undefined) ||
          (contact.reactionImpulse !== undefined && (!finiteVector(contact.reactionImpulse) || !finiteVector(contact.reactionAngularImpulse)))))
      fail("ROPE_SNAPSHOT", "invalid segment contact state");
    const segmentKeys = new Set<string>();
    for (const contact of segments) {
      const key = `${contact.segment}:${contact.colliderId}`;
      if (segmentKeys.has(key)) fail("ROPE_SNAPSHOT", "duplicate segment contact");
      segmentKeys.add(key);
    }
    const self = input.selfContacts === undefined ? [] : input.selfContacts;
    const maxSelfContacts = Math.max(0, (count - 2) * (count - 3) / 2);
    if (!Array.isArray(self) || self.length > maxSelfContacts || (!this.config.selfCollisions && self.length > 0) ||
        self.some(contact => !contact || contact.tick !== input.tick ||
          !Number.isSafeInteger(contact.firstSegment) || !Number.isSafeInteger(contact.secondSegment) ||
          contact.firstSegment < 0 || contact.secondSegment >= count - 1 || contact.secondSegment - contact.firstSegment <= 1 ||
          typeof contact.firstFraction !== "number" || !Number.isFinite(contact.firstFraction) || contact.firstFraction < 0 || contact.firstFraction > 1 ||
          typeof contact.secondFraction !== "number" || !Number.isFinite(contact.secondFraction) || contact.secondFraction < 0 || contact.secondFraction > 1 ||
          typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0))
      fail("ROPE_SNAPSHOT", "invalid self contact state");
    const selfKeys = new Set<string>();
    for (const contact of self) {
      const key = `${contact.firstSegment}:${contact.secondSegment}`;
      if (selfKeys.has(key)) fail("ROPE_SNAPSHOT", "duplicate self contact");
      selfKeys.add(key);
    }
    this.positions = input.positions.map(copy); this.velocities = input.velocities.map(copy);
    this.forces = input.forces.map(copy); this.anchors = anchors; this.colliders = colliders;
    this.contacts = input.contacts.map(copyContact); this.segmentContacts = segments.map(copySegmentContact); this.selfContacts = self.map(contact => ({ ...contact })); this.tickValue = input.tick;
  }
  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true; this.positions = []; this.velocities = []; this.forces = [];
    this.colliders = []; this.contacts = []; this.segmentContacts = []; this.selfContacts = []; this.anchors.clear();
  }
}
