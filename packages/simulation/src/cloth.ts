/** CPU position-based triangular cloth. SI units; sampled colliders are one-way. */
export type Vec3 = [number, number, number];
export type Triangle = [number, number, number];
export type ClothCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number };
export interface ClothOptions {
  points: Vec3[]; triangles: Triangle[]; mass: number; radius?: number; fixedDt?: number;
  substeps?: number; iterations?: number; damping?: number; gravity?: Vec3; bending?: boolean; selfCollisions?: boolean; surfaceCollisions?: boolean;
  anchors?: { index: number; position: Vec3 }[];
}
export interface ClothContact { tick: number; particle: number; colliderId: string; penetration: number }
export interface ClothSelfContact { tick: number; firstParticle: number; secondParticle: number; penetration: number }
export interface ClothSurfaceContact { tick: number; triangle: number; colliderId: string; penetration: number; barycentric: [number, number, number] }
type Constraint = [number, number, number];
type Config = { mass: number; radius: number; fixedDt: number; substeps: number; iterations: number; damping: number; gravity: Vec3; bending: boolean; selfCollisions: boolean; surfaceCollisions: boolean; triangles: Triangle[]; constraints: Constraint[] };
export interface ClothState {
  tick: number; simulatedSeconds: number; disposed: boolean; selfCollisions: boolean; surfaceCollisions: boolean; positions: Vec3[]; velocities: Vec3[]; triangles: Triangle[];
  anchors: { index: number; position: Vec3 }[]; contacts: ClothContact[]; selfContacts: ClothSelfContact[]; surfaceContacts: ClothSurfaceContact[]; maxDistanceError: number;
  resources: { particles: number; triangles: number; constraints: number; anchors: number; colliders: number };
}
export interface ClothSnapshot {
  format: "pelican-cloth-cpu"; version: 1; tick: number; config: Config; positions: Vec3[]; velocities: Vec3[];
  forces: Vec3[]; anchors: { index: number; position: Vec3 }[]; colliders: ClothCollider[]; contacts: ClothContact[]; selfContacts: ClothSelfContact[]; surfaceContacts: ClothSurfaceContact[];
}
export class ClothError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "ClothError"; }
}
const fail = (code: string, message: string): never => { throw new ClothError(code, message); };
const vec = (input: unknown): input is Vec3 => Array.isArray(input) && input.length === 3 && input.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6);
const copy = (value: Vec3): Vec3 => [value[0], value[1], value[2]];
const readVec = (input: unknown, label: string): Vec3 => vec(input) ? copy(input) : fail("CLOTH_INPUT", `${label} must be a finite 3D vector with component magnitude <= 1e6`);
const positive = (input: unknown, label: string): number => typeof input === "number" && Number.isFinite(input) && input > 0 && input <= 1e6 ? input : fail("CLOTH_INPUT", `${label} must be positive and <= 1e6`);
const indexOf = (input: unknown, count: number): number => Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) < count ? input as number : fail("CLOTH_INDEX", "particle index is out of range");
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const tuple = (a: Vec3): Triangle => [a[0], a[1], a[2]];
function readAnchors(input: unknown, count: number): Map<number, Vec3> {
  if (!Array.isArray(input) || input.length > count) fail("CLOTH_INPUT", "anchors must be an array of unique particle indices");
  const result = new Map<number, Vec3>();
  for (const anchor of input as { index: number; position: Vec3 }[]) {
    if (!anchor || typeof anchor !== "object") fail("CLOTH_INPUT", "invalid anchor");
    const index = indexOf(anchor.index, count);
    if (result.has(index)) fail("CLOTH_INPUT", "duplicate anchor index");
    result.set(index, readVec(anchor.position, "anchor position"));
  }
  return result;
}
function readColliders(input: unknown): ClothCollider[] {
  if (!Array.isArray(input) || input.length > 4096) fail("CLOTH_INPUT", "colliders must be an array of at most 4096 items");
  const ids = new Set<string>();
  return (input as ClothCollider[]).map(collider => {
    if (!collider || typeof collider !== "object" || typeof collider.id !== "string" || !collider.id || ids.has(collider.id)) fail("CLOTH_INPUT", "collider ids must be unique nonempty strings");
    ids.add(collider.id);
    if (collider.kind === "sphere") return { kind: "sphere", id: collider.id, center: readVec(collider.center, "sphere center"), radius: positive(collider.radius, "sphere radius") };
    if (collider.kind === "plane") {
      const normal = readVec(collider.normal, "plane normal"), magnitude = Math.hypot(...normal);
      if (Math.abs(magnitude - 1) > 1e-6 || typeof collider.offset !== "number" || !Number.isFinite(collider.offset) || Math.abs(collider.offset) > 1e6)
        fail("CLOTH_INPUT", "plane requires a unit normal and finite offset with magnitude <= 1e6");
      return { kind: "plane", id: collider.id, normal, offset: collider.offset };
    }
    return fail("CLOTH_INPUT", "unsupported collider kind");
  });
}
function topology(points: Vec3[], input: unknown, bending: boolean): { triangles: Triangle[]; constraints: Constraint[] } {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8192) fail("CLOTH_INPUT", "triangles must contain 1..8192 faces");
  const triangles: Triangle[] = [], faces = new Set<string>();
  const edges = new Map<string, { a: number; b: number; opposite: number[]; directions: number[] }>();
  for (const raw of input as unknown[]) {
    if (!Array.isArray(raw) || raw.length !== 3) fail("CLOTH_INPUT", "triangle must contain three particle indices");
    const [a, b, c] = (raw as unknown[]).map(value => indexOf(value, points.length));
    if (a === b || b === c || a === c) fail("CLOTH_INPUT", "triangle indices must be distinct");
    const key = [a, b, c].sort((x, y) => x - y).join(":");
    if (faces.has(key)) fail("CLOTH_INPUT", "duplicate triangle"); faces.add(key);
    const u: Vec3 = [points[b][0] - points[a][0], points[b][1] - points[a][1], points[b][2] - points[a][2]];
    const v: Vec3 = [points[c][0] - points[a][0], points[c][1] - points[a][1], points[c][2] - points[a][2]];
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) <= 1e-10)
      fail("CLOTH_INPUT", "initial triangle area must be nonzero");
    triangles.push([a, b, c]);
    for (const [from, to, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const low = Math.min(from, to), high = Math.max(from, to), edgeKey = `${low}:${high}`;
      const edge = edges.get(edgeKey) ?? { a: low, b: high, opposite: [], directions: [] };
      edge.opposite.push(opposite); edge.directions.push(from === low ? 1 : -1);
      if (edge.opposite.length > 2 || (edge.opposite.length === 2 && edge.directions[0] === edge.directions[1]))
        fail("CLOTH_INPUT", "shared edges require manifold faces with consistent winding");
      edges.set(edgeKey, edge);
    }
  }
  const constraints: Constraint[] = [], seen = new Set<string>();
  const add = (a: number, b: number) => {
    const low = Math.min(a, b), high = Math.max(a, b), key = `${low}:${high}`;
    if (seen.has(key)) return;
    const rest = distance(points[low], points[high]);
    if (!Number.isFinite(rest) || rest <= 1e-8) fail("CLOTH_INPUT", "constraint endpoints must be distinct");
    seen.add(key); constraints.push([low, high, rest]);
  };
  for (const edge of edges.values()) add(edge.a, edge.b);
  if (bending) for (const edge of edges.values()) if (edge.opposite.length === 2) add(edge.opposite[0], edge.opposite[1]);
  return { triangles, constraints };
}
function closestTriangle(point: Vec3, a: Vec3, b: Vec3, c: Vec3): { point: Vec3; barycentric: [number, number, number] } {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2], d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
  if (d1 <= 0 && d2 <= 0) return { point: copy(a), barycentric: [1, 0, 0] };
  const bp: Vec3 = [point[0] - b[0], point[1] - b[1], point[2] - b[2]], d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2], d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
  if (d3 >= 0 && d4 <= d3) return { point: copy(b), barycentric: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], barycentric: [1 - t, t, 0] }; }
  const cp: Vec3 = [point[0] - c[0], point[1] - c[1], point[2] - c[2]], d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2], d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
  if (d6 >= 0 && d5 <= d6) return { point: copy(c), barycentric: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return { point: [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t], barycentric: [1 - t, 0, t] }; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const edge: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]], t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return { point: [b[0] + edge[0] * t, b[1] + edge[1] * t, b[2] + edge[2] * t], barycentric: [0, 1 - t, t] }; }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator;
  return { point: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w], barycentric: [1 - v - w, v, w] };
}
export function createCloth(input: ClothOptions): ClothSolver {
  if (!input || typeof input !== "object" || !Array.isArray(input.points) || input.points.length < 3 || input.points.length > 4096)
    fail("CLOTH_INPUT", "points must contain 3..4096 particles");
  const positions = input.points.map((point, index) => readVec(point, `points[${index}]`));
  const mass = positive(input.mass, "mass"), radius = positive(input.radius ?? 0.025, "radius"), fixedDt = positive(input.fixedDt ?? 1 / 60, "fixedDt");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) fail("CLOTH_INPUT", "fixedDt must be in [1/1000, 1/30]");
  const substeps = input.substeps ?? 4, iterations = input.iterations ?? 12, damping = input.damping ?? 0.15;
  if (!Number.isInteger(substeps) || substeps < 1 || substeps > 32 || !Number.isInteger(iterations) || iterations < 1 || iterations > 64)
    fail("CLOTH_INPUT", "substeps and iterations are outside their supported bounds");
  if (typeof damping !== "number" || !Number.isFinite(damping) || damping < 0 || damping > 100) fail("CLOTH_INPUT", "damping must be in [0,100]");
  if (input.bending !== undefined && typeof input.bending !== "boolean") fail("CLOTH_INPUT", "bending must be boolean");
  const bending = input.bending ?? true, selfCollisions = input.selfCollisions ?? true, surfaceCollisions = input.surfaceCollisions ?? true, gravity = readVec(input.gravity ?? [0, -9.81, 0], "gravity");
  if (typeof selfCollisions !== "boolean" || typeof surfaceCollisions !== "boolean") fail("CLOTH_INPUT", "collision options must be boolean");
  const { triangles, constraints } = topology(positions, input.triangles, bending);
  const anchors = readAnchors(input.anchors ?? [], positions.length);
  for (const [index, point] of anchors) positions[index] = copy(point);
  return new ClothSolver({ mass, radius, fixedDt, substeps, iterations, damping, gravity, bending, selfCollisions, surfaceCollisions, triangles, constraints }, positions, anchors);
}
export class ClothSolver {
  private tickValue = 0;
  private disposed = false;
  private velocities: Vec3[];
  private forces: Vec3[];
  private colliders: ClothCollider[] = [];
  private contacts: ClothContact[] = [];
  private selfContacts: ClothSelfContact[] = [];
  private surfaceContacts: ClothSurfaceContact[] = [];
  private readonly adjacent: ReadonlySet<string>;
  constructor(private readonly config: Config, private positions: Vec3[], private anchors: Map<number, Vec3>) {
    this.velocities = positions.map(() => [0, 0, 0]); this.forces = positions.map(() => [0, 0, 0]);
    this.adjacent = new Set(config.triangles.flatMap(([a, b, c]) => [`${Math.min(a,b)}:${Math.max(a,b)}`, `${Math.min(b,c)}:${Math.max(b,c)}`, `${Math.min(c,a)}:${Math.max(c,a)}`]));
  }
  private alive() { if (this.disposed) fail("CLOTH_DISPOSED", "cloth has been disposed"); }
  setColliders(input: ClothCollider[]): void { this.alive(); this.colliders = readColliders(input); this.contacts = []; }
  setAnchor(index: number, position: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), p = readVec(position, "anchor position");
    this.anchors.set(i, p); this.positions[i] = copy(p); this.velocities[i] = [0, 0, 0]; this.forces[i] = [0, 0, 0];
  }
  releaseAnchor(index: number): void { this.alive(); this.anchors.delete(indexOf(index, this.positions.length)); }
  applyForce(index: number, input: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), force = readVec(input, "force");
    if (this.anchors.has(i)) fail("CLOTH_ANCHORED", "cannot apply force to an anchor");
    const next: Vec3 = [0, 1, 2].map(axis => this.forces[i][axis] + force[axis]) as Vec3;
    if (!vec(next)) fail("CLOTH_NUMERIC", "force accumulation exceeded bounds"); this.forces[i] = next;
  }
  applyImpulse(index: number, input: Vec3): void {
    this.alive(); const i = indexOf(index, this.positions.length), impulse = readVec(input, "impulse");
    if (this.anchors.has(i)) fail("CLOTH_ANCHORED", "cannot apply impulse to an anchor");
    const next: Vec3 = [0, 1, 2].map(axis => this.velocities[i][axis] + impulse[axis] / this.config.mass) as Vec3;
    if (!vec(next)) fail("CLOTH_NUMERIC", "impulse exceeded bounds"); this.velocities[i] = next;
  }
  /** A failed batch restores its pre-batch state. */
  step(steps = 1): ClothState {
    this.alive();
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000 || this.tickValue + steps > Number.MAX_SAFE_INTEGER)
      fail("CLOTH_INPUT", "steps must be in [1,1000] without tick overflow");
    const before = { positions: this.positions, velocities: this.velocities, forces: this.forces, contacts: this.contacts, selfContacts: this.selfContacts, surfaceContacts: this.surfaceContacts, tick: this.tickValue };
    try { for (let i = 0; i < steps; i++) this.stepOne(); }
    catch (error) { this.positions = before.positions; this.velocities = before.velocities; this.forces = before.forces; this.contacts = before.contacts; this.selfContacts = before.selfContacts; this.surfaceContacts = before.surfaceContacts; this.tickValue = before.tick; throw error; }
    return this.inspect();
  }
  private stepOne(): void {
    const { fixedDt, substeps, iterations, mass, gravity, damping, constraints, radius } = this.config;
    const h = fixedDt / substeps, decay = Math.exp(-damping * h);
    const positions = this.positions.map(copy), velocities = this.velocities.map(copy), contacts = new Map<string, ClothContact>(), selfContacts = new Map<string, ClothSelfContact>(), surfaceContacts = new Map<string, ClothSurfaceContact>();
    for (let sub = 0; sub < substeps; sub++) {
      const previous = positions.map(copy);
      for (let i = 0; i < positions.length; i++) {
        const anchor = this.anchors.get(i);
        if (anchor) { positions[i] = copy(anchor); velocities[i] = [0, 0, 0]; continue; }
        for (let k = 0; k < 3; k++) { velocities[i][k] = velocities[i][k] * decay + (gravity[k] + this.forces[i][k] / mass) * h; positions[i][k] += velocities[i][k] * h; }
      }
      for (let iter = 0; iter < iterations; iter++) {
        for (const [i, j, rest] of constraints) {
          const a = positions[i], b = positions[j];
          let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], dist = Math.hypot(dx, dy, dz);
          if (dist < 1e-12) { dx = 1e-6; dy = 0; dz = 0; dist = 1e-6; }
          const wa = this.anchors.has(i) ? 0 : 1, wb = this.anchors.has(j) ? 0 : 1;
          if (wa + wb === 0) continue;
          const factor = (dist - rest) / (dist * (wa + wb));
          for (let k = 0; k < 3; k++) { const correction = (k === 0 ? dx : k === 1 ? dy : dz) * factor; a[k] += correction * wa; b[k] -= correction * wb; }
        }
        for (let i = 0; i < positions.length; i++) {
          if (this.anchors.has(i)) continue;
          const p = positions[i];
          for (const collider of this.colliders) {
            let depth: number, normal: Vec3;
            if (collider.kind === "plane") { normal = collider.normal; depth = collider.offset + radius - (p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2]); }
            else {
              const delta: Vec3 = [p[0] - collider.center[0], p[1] - collider.center[1], p[2] - collider.center[2]], length = Math.hypot(...delta);
              depth = collider.radius + radius - length; normal = length < 1e-12 ? [1, 0, 0] : [delta[0] / length, delta[1] / length, delta[2] / length];
            }
            if (depth <= 0) continue;
            for (let k = 0; k < 3; k++) p[k] += normal[k] * depth;
            const key = `${i}:${collider.id}`, old = contacts.get(key);
            if (old) old.penetration = Math.max(old.penetration, depth);
            else contacts.set(key, { tick: this.tickValue + 1, particle: i, colliderId: collider.id, penetration: depth });
          }
        }
        if (this.config.surfaceCollisions) for (let triangleIndex = 0; triangleIndex < this.config.triangles.length; triangleIndex++) {
          const triangle = this.config.triangles[triangleIndex], a = positions[triangle[0]], b = positions[triangle[1]], c = positions[triangle[2]];
          for (const collider of this.colliders) {
            if (collider.kind !== "sphere") continue;
            const closest = closestTriangle(collider.center, a, b, c), delta: Vec3 = [closest.point[0] - collider.center[0], closest.point[1] - collider.center[1], closest.point[2] - collider.center[2]], length = Math.hypot(...delta), depth = collider.radius + radius - length;
            if (depth <= 0) continue;
            const normal: Vec3 = length < 1e-12 ? [0, 1, 0] : [delta[0] / length, delta[1] / length, delta[2] / length], weights = [this.anchors.has(triangle[0]) ? 0 : closest.barycentric[0], this.anchors.has(triangle[1]) ? 0 : closest.barycentric[1], this.anchors.has(triangle[2]) ? 0 : closest.barycentric[2]], denominator = weights.reduce((sum, value) => sum + value * value, 0);
            if (denominator === 0) continue;
            const correction = depth / denominator;
            for (let vertex = 0; vertex < 3; vertex++) for (let axis = 0; axis < 3; axis++) positions[triangle[vertex]][axis] += normal[axis] * correction * weights[vertex];
            const key = `${triangleIndex}:${collider.id}`, old = surfaceContacts.get(key);
            if (old) old.penetration = Math.max(old.penetration, depth); else surfaceContacts.set(key, { tick: this.tickValue + 1, triangle: triangleIndex, colliderId: collider.id, penetration: depth, barycentric: closest.barycentric });
          }
        }
        if (this.config.selfCollisions) for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
          if (this.adjacent.has(`${i}:${j}`)) continue;
          const a = positions[i], b = positions[j], dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2], length = Math.hypot(dx, dy, dz), depth = 2 * radius - length;
          if (depth <= 0) continue;
          const normal: Vec3 = length < 1e-12 ? [1, 0, 0] : [dx / length, dy / length, dz / length];
          const wa = this.anchors.has(i) ? 0 : 1, wb = this.anchors.has(j) ? 0 : 1;
          if (wa + wb === 0) continue;
          const correction = depth / (wa + wb);
          for (let axis = 0; axis < 3; axis++) { a[axis] += normal[axis] * correction * wa; b[axis] -= normal[axis] * correction * wb; }
          const key = `${i}:${j}`, old = selfContacts.get(key);
          if (old) old.penetration = Math.max(old.penetration, depth); else selfContacts.set(key, { tick: this.tickValue + 1, firstParticle: i, secondParticle: j, penetration: depth });
        }
      }
      for (let i = 0; i < positions.length; i++) {
        if (this.anchors.has(i)) continue;
        for (let k = 0; k < 3; k++) velocities[i][k] = (positions[i][k] - previous[i][k]) / h;
        if (!vec(positions[i]) || !vec(velocities[i])) fail("CLOTH_NUMERIC", "solver exceeded finite state bounds");
      }
    }
    this.positions = positions; this.velocities = velocities; this.forces = positions.map(() => [0, 0, 0]); this.contacts = [...contacts.values()]; this.selfContacts = [...selfContacts.values()]; this.surfaceContacts = [...surfaceContacts.values()]; this.tickValue++;
  }
  inspect(): ClothState {
    if (this.disposed) return { tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: true, selfCollisions: this.config.selfCollisions, surfaceCollisions: this.config.surfaceCollisions, positions: [], velocities: [], triangles: [], anchors: [], contacts: [], selfContacts: [], surfaceContacts: [], maxDistanceError: 0, resources: { particles: 0, triangles: 0, constraints: 0, anchors: 0, colliders: 0 } };
    let maxDistanceError = 0;
    for (const [a, b, rest] of this.config.constraints) maxDistanceError = Math.max(maxDistanceError, Math.abs(distance(this.positions[a], this.positions[b]) - rest));
    return { tick: this.tickValue, simulatedSeconds: this.tickValue * this.config.fixedDt, disposed: false, selfCollisions: this.config.selfCollisions, surfaceCollisions: this.config.surfaceCollisions,
      positions: this.positions.map(copy), velocities: this.velocities.map(copy), triangles: this.config.triangles.map(tuple),
      anchors: [...this.anchors].map(([index, position]) => ({ index, position: copy(position) })).sort((a, b) => a.index - b.index),
      contacts: this.contacts.map(contact => ({ ...contact })), selfContacts: this.selfContacts.map(contact => ({ ...contact })), surfaceContacts: this.surfaceContacts.map(contact => ({ ...contact })), maxDistanceError,
      resources: { particles: this.positions.length, triangles: this.config.triangles.length, constraints: this.config.constraints.length, anchors: this.anchors.size, colliders: this.colliders.length } };
  }
  snapshot(): ClothSnapshot {
    this.alive(); const state = this.inspect();
    return { format: "pelican-cloth-cpu", version: 1, tick: this.tickValue,
      config: { ...this.config, gravity: copy(this.config.gravity), triangles: this.config.triangles.map(tuple), constraints: this.config.constraints.map(tuple) },
      positions: state.positions, velocities: state.velocities, forces: this.forces.map(copy), anchors: state.anchors, colliders: readColliders(this.colliders), contacts: state.contacts, selfContacts: state.selfContacts, surfaceContacts: state.surfaceContacts };
  }
  restore(input: ClothSnapshot): void {
    this.alive();
    if (!input || typeof input !== "object" || input.format !== "pelican-cloth-cpu" || input.version !== 1 || !Number.isSafeInteger(input.tick) || input.tick < 0)
      fail("CLOTH_SNAPSHOT", "unsupported snapshot format or tick");
    const config = input.config, expected = this.config;
    if (!config || config.mass !== expected.mass || config.radius !== expected.radius || config.fixedDt !== expected.fixedDt || config.substeps !== expected.substeps ||
        config.iterations !== expected.iterations || config.damping !== expected.damping || config.bending !== expected.bending || (config.selfCollisions ?? false) !== expected.selfCollisions || (config.surfaceCollisions ?? false) !== expected.surfaceCollisions ||
        !vec(config.gravity) || config.gravity.some((value, i) => value !== expected.gravity[i]) ||
        !Array.isArray(config.triangles) || JSON.stringify(config.triangles) !== JSON.stringify(expected.triangles) ||
        !Array.isArray(config.constraints) || JSON.stringify(config.constraints) !== JSON.stringify(expected.constraints))
      fail("CLOTH_SNAPSHOT", "cloth configuration or topology mismatch");
    const count = this.positions.length;
    if (!Array.isArray(input.positions) || !Array.isArray(input.velocities) || !Array.isArray(input.forces) ||
        [input.positions, input.velocities, input.forces].some(values => values.length !== count || !values.every(vec))) fail("CLOTH_SNAPSHOT", "invalid particle state");
    const anchors = readAnchors(input.anchors, count);
    if ([...anchors].some(([i, point]) => point.some((value, k) => value !== input.positions[i][k]) || input.velocities[i].some(value => value !== 0) || input.forces[i].some(value => value !== 0)))
      fail("CLOTH_SNAPSHOT", "inconsistent anchored particle state");
    const colliders = readColliders(input.colliders), keys = new Set<string>();
    if (!Array.isArray(input.contacts) || input.contacts.length > count * colliders.length || input.contacts.some(contact => !contact || contact.tick !== input.tick ||
        !Number.isSafeInteger(contact.particle) || contact.particle < 0 || contact.particle >= count || !colliders.some(collider => collider.id === contact.colliderId) ||
        typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0)) fail("CLOTH_SNAPSHOT", "invalid contact state");
    for (const contact of input.contacts) { const key = `${contact.particle}:${contact.colliderId}`; if (keys.has(key)) fail("CLOTH_SNAPSHOT", "duplicate contact"); keys.add(key); }
    const selfContacts = input.selfContacts ?? [];
    const selfKeys = new Set<string>();
    if (!Array.isArray(selfContacts) || selfContacts.length > count * Math.max(0, count - 1) / 2 || (!this.config.selfCollisions && selfContacts.length > 0) ||
        selfContacts.some(contact => !contact || contact.tick !== input.tick || !Number.isSafeInteger(contact.firstParticle) || !Number.isSafeInteger(contact.secondParticle) ||
          contact.firstParticle < 0 || contact.secondParticle >= count || contact.firstParticle >= contact.secondParticle ||
          this.adjacent.has(`${contact.firstParticle}:${contact.secondParticle}`) || typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0))
      fail("CLOTH_SNAPSHOT", "invalid self contact state");
    for (const contact of selfContacts) { const key = `${contact.firstParticle}:${contact.secondParticle}`; if (selfKeys.has(key)) fail("CLOTH_SNAPSHOT", "duplicate self contact"); selfKeys.add(key); }
    const surfaceContacts = input.surfaceContacts ?? [];
    const surfaceKeys = new Set<string>();
    if (!Array.isArray(surfaceContacts) || surfaceContacts.length > this.config.triangles.length * colliders.length || (!this.config.surfaceCollisions && surfaceContacts.length > 0) ||
        surfaceContacts.some(contact => !contact || contact.tick !== input.tick || !Number.isSafeInteger(contact.triangle) || contact.triangle < 0 || contact.triangle >= this.config.triangles.length ||
          !colliders.some(collider => collider.id === contact.colliderId && collider.kind === "sphere") || typeof contact.penetration !== "number" || !Number.isFinite(contact.penetration) || contact.penetration <= 0 ||
          !Array.isArray(contact.barycentric) || contact.barycentric.length !== 3 || !contact.barycentric.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) ||
          Math.abs(contact.barycentric[0] + contact.barycentric[1] + contact.barycentric[2] - 1) > 1e-5))
      fail("CLOTH_SNAPSHOT", "invalid surface contact state");
    for (const contact of surfaceContacts) { const key = `${contact.triangle}:${contact.colliderId}`; if (surfaceKeys.has(key)) fail("CLOTH_SNAPSHOT", "duplicate surface contact"); surfaceKeys.add(key); }
    this.positions = input.positions.map(copy); this.velocities = input.velocities.map(copy); this.forces = input.forces.map(copy);
    this.anchors = anchors; this.colliders = colliders; this.contacts = input.contacts.map(contact => ({ ...contact })); this.selfContacts = selfContacts.map(contact => ({ ...contact })); this.surfaceContacts = surfaceContacts.map(contact => ({ ...contact, barycentric: [...contact.barycentric] as [number, number, number] })); this.tickValue = input.tick;
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.positions = []; this.velocities = []; this.forces = []; this.colliders = []; this.contacts = []; this.selfContacts = []; this.surfaceContacts = []; this.anchors.clear(); }
}
