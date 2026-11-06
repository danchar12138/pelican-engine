/** Internal CPU rope solver. Metres, seconds, kilograms and Newtons; Y is not privileged.
 * External colliders are immutable input samples for each tick: contacts move rope particles
 * only. No rigid-body reaction, self/segment collision, tearing or rendering integration.
 */
export type Vec3 = [number, number, number];
export type RopeCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number };
export interface RopeOptions {
  /** At least two distinct consecutive 3D points, in metres. */
  points: Vec3[];
  /** Kilograms per particle; every non-anchored particle has this mass. */
  mass: number;
  /** Collision radius of each particle, metres. */
  radius?: number;
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
  /** Opposite impulse from particle contact projections, in world-space N·s. */
  reactionImpulse?: Vec3;
  /** Moment of those impulses about the world origin, in angular-momentum units. */
  reactionAngularImpulse?: Vec3;
}
export interface RopeState {
  tick: number;
  simulatedSeconds: number;
  disposed: boolean;
  positions: Vec3[];
  velocities: Vec3[];
  anchors: { index: number; position: Vec3 }[];
  contacts: RopeContact[];
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
  };
  positions: Vec3[];
  velocities: Vec3[];
  anchors: { index: number; position: Vec3 }[];
  /** Forces queued for exactly the next tick (Newtons). */
  forces: Vec3[];
  colliders: RopeCollider[];
  contacts: RopeContact[];
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
  return new RopeSolver({ mass, radius, fixedDt, substeps, iterations, damping, gravity, restLengths }, positions, anchors);
}

type Config = RopeSnapshot["config"];
export class RopeSolver {
  private tickValue = 0;
  private disposedValue = false;
  private velocities: Vec3[];
  private forces: Vec3[];
  private colliders: RopeCollider[] = [];
  private contacts: RopeContact[] = [];
  constructor(private readonly config: Config, private positions: Vec3[], private anchors: Map<number, Vec3>) {
    this.velocities = positions.map(() => [0, 0, 0]);
    this.forces = positions.map(() => [0, 0, 0]);
  }
  private alive(): void { if (this.disposedValue) fail("ROPE_DISPOSED", "rope has been disposed"); }
  /** Copies all inputs: callers may mutate their arrays after calling this. */
  setColliders(input: RopeCollider[]): void {
    this.alive(); this.colliders = readColliders(input); this.contacts = [];
  }
  /** Pins or moves a particle; new anchor position takes effect immediately. */
  setAnchor(index: number, position: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), p = validVec(position, "anchor position");
    this.anchors.set(i, p); this.positions[i] = copy(p); this.velocities[i] = [0, 0, 0]; this.forces[i] = [0, 0, 0];
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
  /** Newtons accumulated for exactly one next fixed tick; not a persistent force. */
  applyForce(index: number, force: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), v = validVec(force, "force");
    if (this.anchors.has(i)) fail("ROPE_ANCHORED", "cannot apply force to an anchor");
    const next: Vec3 = [0, 1, 2].map(k => this.forces[i][k] + v[k]) as Vec3;
    if (!finiteState(next)) fail("ROPE_NUMERIC", "force accumulation exceeds numeric bounds");
    this.forces[i] = next;
  }
  /** Exactly N fixed ticks; a failed batch restores the state before the first tick. */
  step(steps = 1): RopeState {
    this.alive();
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000 || this.tickValue + steps > Number.MAX_SAFE_INTEGER) fail("ROPE_INPUT", "steps must be an integer in [1,1000] without tick overflow");
    // stepOne replaces these arrays rather than mutating the prior committed state.
    const before = {
      positions: this.positions,
      velocities: this.velocities,
      forces: this.forces,
      contacts: this.contacts,
      tick: this.tickValue,
    };
    try {
      for (let s = 0; s < steps; s++) this.stepOne();
    } catch (error) {
      this.positions = before.positions;
      this.velocities = before.velocities;
      this.forces = before.forces;
      this.contacts = before.contacts;
      this.tickValue = before.tick;
      throw error;
    }
    return this.inspect();
  }
  private stepOne(): void {
    const { fixedDt, substeps, iterations, mass, gravity, damping, restLengths, radius } = this.config;
    const h = fixedDt / substeps, decay = Math.exp(-damping * h);
    // Work on copies; numeric failures must never leave half a tick applied.
    const positions = this.positions.map(copy), velocities = this.velocities.map(copy);
    const contacts = new Map<string, RopeContact>();
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
            let depth = 0; let normal: Vec3;
            if (c.kind === "plane") {
              depth = c.offset + radius - (p[0] * c.normal[0] + p[1] * c.normal[1] + p[2] * c.normal[2]);
              normal = c.normal;
            } else {
              const delta: Vec3 = [p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]];
              const distance = length(delta);
              depth = c.radius + radius - distance;
              normal = distance < 1e-12 ? [1, 0, 0] : [delta[0] / distance, delta[1] / distance, delta[2] / distance];
            }
            if (depth <= 0) continue;
            for (let k = 0; k < 3; k++) p[k] += normal[k] * depth;
            // Each positional projection changes the particle's velocity by depth / h.
            // Report its equal-and-opposite impulse and moment on the sampled surface;
            // the collider itself remains an immutable input and is not moved here.
            const magnitude = -mass * depth / h;
            const reaction: Vec3 = [normal[0] * magnitude, normal[1] * magnitude, normal[2] * magnitude];
            const point: Vec3 = c.kind === "sphere"
              ? [c.center[0] + normal[0] * c.radius, c.center[1] + normal[1] * c.radius, c.center[2] + normal[2] * c.radius]
              : [p[0] - normal[0] * radius, p[1] - normal[1] * radius, p[2] - normal[2] * radius];
            const moment: Vec3 = [point[1] * reaction[2] - point[2] * reaction[1], point[2] * reaction[0] - point[0] * reaction[2], point[0] * reaction[1] - point[1] * reaction[0]];
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
      }
      for (let i = 0; i < positions.length; i++) {
        if (this.anchors.has(i)) continue;
        for (let k = 0; k < 3; k++) velocities[i][k] = (positions[i][k] - previous[i][k]) / h;
        if (!finiteState(positions[i]) || !finiteState(velocities[i])) fail("ROPE_NUMERIC", "solver exceeded finite state bounds");
      }
    }
    this.positions = positions; this.velocities = velocities;
    this.forces = positions.map(() => [0, 0, 0]); this.contacts = [...contacts.values()]; this.tickValue++;
  }
  inspect(): RopeState {
    if (this.disposedValue) return { tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: true, positions: [], velocities: [], anchors: [], contacts: [], maxDistanceError: 0, resources: { particles: 0, constraints: 0, anchors: 0, colliders: 0 } };
    const maxDistanceError = Math.max(0, ...this.config.restLengths.map((d, i) => {
      const a = this.positions[i], b = this.positions[i + 1];
      return Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - d);
    }));
    return {
      tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: false,
      positions: this.positions.map(copy), velocities: this.velocities.map(copy),
      anchors: [...this.anchors].map(([index, position]) => ({ index, position: copy(position) })).sort((a, b) => a.index - b.index),
      contacts: this.contacts.map(copyContact), maxDistanceError,
      resources: { particles: this.positions.length, constraints: this.config.restLengths.length, anchors: this.anchors.size, colliders: this.colliders.length },
    };
  }
  snapshot(): RopeSnapshot {
    this.alive(); const state = this.inspect();
    return {
      format: "pelican-rope-cpu", version: 1, tick: this.tickValue,
      config: { ...this.config, gravity: copy(this.config.gravity), restLengths: [...this.config.restLengths] },
      positions: state.positions, velocities: state.velocities, anchors: state.anchors,
      forces: this.forces.map(copy), colliders: readColliders(this.colliders), contacts: state.contacts,
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
    this.positions = input.positions.map(copy); this.velocities = input.velocities.map(copy);
    this.forces = input.forces.map(copy); this.anchors = anchors; this.colliders = colliders;
    this.contacts = input.contacts.map(copyContact); this.tickValue = input.tick;
  }
  dispose(): void {
    if (this.disposedValue) return;
    this.disposedValue = true; this.positions = []; this.velocities = []; this.forces = [];
    this.colliders = []; this.contacts = []; this.anchors.clear();
  }
}
