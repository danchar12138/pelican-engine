/** Pelican Engine public API. No renderer or GPU implementation types escape this module. */
import { describeFeatures } from "./capabilities.ts";
import { expandRenderExtensions } from "./render-extension.ts";
import { createGameInstance } from "./runtime-lifecycle.ts";
export interface EngineFeature {
  id: string;
  /** Discovery text and vocabulary; implementation/backend limits still apply. */
  description?: string;
  aliases?: readonly string[];
  implementation: "implemented" | "partial";
  symbols: readonly string[];
  backends: readonly ("webgpu" | "webgl2" | "cpu")[];
  limits: readonly string[];
  recipes: readonly string[];
}
/** Implementation metadata, not runtime hardware acceptance; use ctx.render.capabilities for the active device. */
export function engineCapabilities(query = ""): EngineFeature[] { return describeFeatures(query); }
export const SDK_VERSION = "1.4.0";
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
export type TransformPatch = Partial<Transform>;
export type JsonValue = null | boolean | string | number | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type Field =
  | { type: "number"; default: number }
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string }
  | { type: "vec3"; default: Vec3 }
  | { type: "json"; default: JsonValue };
export type ComponentSchema = Readonly<Record<string, Field>>;
export interface ComponentDefinition<
  S extends ComponentSchema = ComponentSchema,
> {
  readonly kind: "component";
  readonly id: string;
  readonly schema: S;
}
export type ComponentValue<S extends ComponentSchema> = {
  -readonly [K in keyof S]: S[K]["type"] extends "number"
    ? number
    : S[K]["type"] extends "boolean"
      ? boolean
      : S[K]["type"] extends "vec3"
        ? Vec3
        : S[K]["type"] extends "json" ? JsonValue : string;
};
export type ComponentData = Record<string, JsonValue>;
export interface ComponentInstance {
  component: ComponentDefinition | string;
  value?: ComponentData;
}
export interface EngineFacade {
  getTransform(id: string): Transform;
  setTransform(id: string, patch: TransformPatch): void;
  getComponent<S extends ComponentSchema>(
    id: string,
    component: ComponentDefinition<S>,
  ): ComponentValue<S>;
  getComponent(id: string, component: string): ComponentData;
  setComponent<S extends ComponentSchema>(
    id: string,
    component: ComponentDefinition<S>,
    value: Partial<ComponentValue<S>>,
  ): void;
  setComponent(id: string, component: string, value: ComponentData): void;
  query(component: ComponentDefinition | string): readonly string[];
  /** Compiler/host integration. Game systems are scheduled by the engine, not by game code. */
  runGameSystems?(systems: readonly SystemDefinition[], dt: number): void;
  configureGameSystems?(systems: readonly SystemDefinition[], runtime?: { version: string }): void;
}
export interface EntityHandle {
  readonly world: number;
  readonly index: number;
  readonly generation: number;
}
export type EntityRef = string | EntityHandle;
export interface SpawnInput {
  id: string;
  prefab?: string;
  parent?: string;
  transform?: TransformPatch;
  components?: Record<string, ComponentData>;
}
export interface EntityCommands {
  resolve(id: string): EntityHandle;
  isAlive(entity: EntityRef): boolean;
  getTransform(entity: EntityRef): Transform;
  setTransform(entity: EntityRef, patch: TransformPatch): void;
  getComponent(entity: EntityRef, component: string): ComponentData;
  setComponent(
    entity: EntityRef,
    component: string,
    patch: ComponentData,
  ): void;
  /** Structural changes become visible at the engine's next command-commit boundary. */
  spawn(input: SpawnInput): void;
  destroy(entity: EntityRef): void;
  addComponent(
    entity: EntityRef,
    component: string,
    data?: ComponentData,
  ): void;
  removeComponent(entity: EntityRef, component: string): void;
}
export interface GameEvent {
  readonly type: string;
  readonly tick: number;
  readonly sequence: number;
  readonly payload: unknown;
}
export interface SystemContext extends EngineFacade {
  readonly time: {
    readonly tick: number;
    readonly elapsed: number;
    readonly fixedDt: number;
  };
  readonly entities: EntityCommands;
  random(): number;
  emit(type: string, payload: unknown): void;
  events(type?: string): readonly GameEvent[];
  readonly input: GamepadInputService;
  readonly physics: PhysicsService;
  /** Available only when the current scene opts into physics2d. */
  readonly physics2d: Physics2DService;
  readonly animation: AnimationControlService;
  readonly camera: CameraService;
  readonly ui: UIService;
  readonly audio: AudioService;
  readonly storage: StorageService;
  readonly scenes: SceneService;
  readonly render: RenderService;
  readonly compute: ComputeService;
  readonly navigation: NavigationService;
  readonly streaming: WorldStreamingService;
  readonly terrain: TerrainService;
  readonly cinematics: CinematicService;
  readonly inventory: InventoryService;
  readonly quests: QuestService;
  readonly dialogue: DialogueService;
  readonly i18n: LocalizationService;
  readonly sprites: SpriteService;
  readonly tilemaps: TilemapService;
  readonly lights: LightService;
  readonly ropes: RopeService;
  readonly cloth: ClothService;
  readonly fluid: FluidService;
  readonly softBodies: SoftBodyService;
}
export type Physics2DCollider =
  | { shape: "box"; halfExtents: Vec2; offset?: Vec2 }
  | { shape: "circle"; radius: number; offset?: Vec2 }
  /** Capsule aligned to local Y; halfHeight excludes the rounded caps. */
  | { shape: "capsule"; halfHeight: number; radius: number; offset?: Vec2 }
  /** Fixed bodies only; an empty list represents no collider. */
  | { shape: "compound"; parts: readonly { halfExtents: Vec2; offset: Vec2 }[] };
export interface Physics2DBodyDefinition {
  id: string; entity: string; type: "fixed" | "dynamic" | "kinematic";
  collider: Physics2DCollider;
  mass?: number; friction?: number; restitution?: number;
  sensor?: boolean; continuous?: boolean;
}
export interface Physics2DBodyState {
  id: string; entity: string; type: Physics2DBodyDefinition["type"];
  position: Vec2; angle: number; velocity: Vec2; angularVelocity: number; sleeping: boolean;
}
export interface Physics2DCharacterOptions {
  /** Positive separation from obstacles; defaults to 0.01 world units. */
  offset?: number;
  /** Optional downward snap distance; defaults to disabled. */
  snapToGround?: number;
  /** Maximum climbable slope angle in radians; defaults to 蟺/4. */
  maxSlope?: number;
}
export interface Physics2DCharacterState {
  body: string;
  requested: Vec2;
  movement: Vec2;
  grounded: boolean;
  /** Movement is deferred until physics query structures are current. */
  deferred: boolean;
}
export interface Physics2DJointBase {
  id: string; bodyA: string; bodyB: string;
  /** Anchor coordinates are local to each body. */
  anchorA?: Vec2; anchorB?: Vec2;
  /** Defaults to false for connected-body contacts. */
  contactsEnabled?: boolean;
}
export type Physics2DJointDefinition = Physics2DJointBase & (
  | { kind: "fixed"; frameA?: number; frameB?: number }
  | { kind: "revolute" }
  | { kind: "rope"; length: number }
  | { kind: "spring"; restLength: number; stiffness: number; damping: number }
);
/** Independent XY rigid-body world. No native physics objects cross this API. */
export interface Physics2DService {
  create(definition: Physics2DBodyDefinition): void;
  destroy(id: string): void;
  /** Replace a fixed body's collider; collision event continuity is not preserved. */
  setCollider(id: string, collider: Physics2DCollider): void;
  collider(id: string): Physics2DCollider;
  createJoint(definition: Physics2DJointDefinition): void;
  destroyJoint(id: string): void;
  inspectJoint(id: string): Physics2DJointDefinition;
  listJoints(): readonly Physics2DJointDefinition[];
  /** Attach a one-way controller to an existing non-sensor kinematic body. */
  attachCharacter(body: string, options?: Physics2DCharacterOptions): void;
  detachCharacter(body: string): void;
  /** Accumulate world-space XY displacement for a later fixed step. */
  moveCharacter(body: string, displacement: Vec2): void;
  characterState(body: string): Physics2DCharacterState;
  setVelocity(id: string, velocity: Vec2): void;
  setAngularVelocity(id: string, velocity: number): void;
  applyImpulse(id: string, impulse: Vec2): void;
  setGravity(gravity: Vec2): void;
  gravity(): Vec2;
  inspect(id: string): Physics2DBodyState;
  /** Queries the last completed 2D physics step, not pending transform edits. */
  raycast(origin: Vec2, direction: Vec2, maxDistance: number, options?: { exclude?: readonly string[]; includeSensors?: boolean }):
    { body: string; entity: string; distance: number; point: Vec2; normal: Vec2 } | null;
  /** Find live 2D body IDs overlapping a circle, sorted by ID. Uses the last completed physics step. */
  overlapCircle(center: Vec2, radius: number, options?: { exclude?: readonly string[]; includeSensors?: boolean }): readonly string[];
  /** Find live 2D body IDs overlapping a rotated box, sorted by ID. Angle is in radians. */
  overlapBox(center: Vec2, halfExtents: Vec2, angle?: number, options?: { exclude?: readonly string[]; includeSensors?: boolean }): readonly string[];
}
export interface SpriteAnimation {
  first: number;
  last: number;
  /** Atlas frames per second, greater than zero and at most 240. */
  fps: number;
  loop?: boolean;
}
export interface SpriteDefinition {
  id: string;
  /** Live entity whose world transform positions the sprite plane. */
  entity: string;
  /** Declared textured material; use transparent: true for alpha blending. */
  material: string;
  size: Vec2;
  offset?: Vec2;
  columns?: number;
  rows?: number;
  frame?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** When supplied, playback begins at the first frame. */
  animation?: SpriteAnimation;
}
export interface SpriteState {
  id: string; entity: string; material: string;
  size: Vec2; offset: Vec2; columns: number; rows: number;
  frame: number; playing: boolean; completed: boolean;
  castShadow: boolean; receiveShadow: boolean;
  animation: (SpriteAnimation & { loop: boolean }) | null;
}
export interface SpriteService {
  create(definition: SpriteDefinition): void;
  /** Restart the supplied or current animation at its first frame. */
  play(id: string, animation?: SpriteAnimation): void;
  pause(id: string): void;
  resume(id: string): void;
  /** Select any atlas frame and pause playback. */
  setFrame(id: string, frame: number): void;
  inspect(id: string): SpriteState;
  visuals(): readonly SpriteState[];
  destroy(id: string): void;
}
/** All cells using tile share a looping presentation animation; gameplay retains tile. */
export interface TilemapAnimation { tile: number; frames: readonly number[]; fps: number }
export interface TilemapDefinition {
  id: string; entity: string; material: string;
  width: number; height: number; tileSize: Vec2;
  /** Local XY top-left corner; rows extend toward negative Y. */
  offset?: Vec2;
  columns: number; rows: number;
  /** Row-major atlas frame indices; null means an empty cell. */
  cells?: readonly (number | null)[];
  animations?: readonly TilemapAnimation[];
  castShadow?: boolean; receiveShadow?: boolean;
}
export interface TilemapUpdate { x: number; y: number; frame: number | null }
/** Mapping to an exclusively controlled rectangle of a navigation grid. */
export interface TilemapNavigationOptions {
  origin?: NavigationCell;
  blockedFrames: readonly number[];
  emptyBlocked?: boolean;
}
export interface TilemapPhysics2DOptions {
  solidFrames: readonly number[];
  emptySolid?: boolean;
}
export interface TilemapWorldSyncOptions {
  grid: string; navigation: TilemapNavigationOptions;
  body: string; physics: TilemapPhysics2DOptions;
}
export interface TilemapState {
  id: string; entity: string; material: string; width: number; height: number;
  tileSize: Vec2; offset: Vec2; columns: number; rows: number;
  castShadow: boolean; receiveShadow: boolean; cells: readonly (number | null)[];
  animations: readonly (TilemapAnimation & { phase: number })[];
}
/** Chunk revision and token are presentation hints, not persistent identities. */
export interface TilemapVisualState extends Omit<TilemapState, "cells"> {
  token: number;
  chunks: readonly { x: number; y: number; revision: number }[];
}
export interface TilemapChunkState {
  x: number; y: number; width: number; height: number; revision: number;
  cells: readonly (number | null)[];
}
export interface TilemapService {
  create(definition: TilemapDefinition): void;
  getTile(id: string, x: number, y: number): number | null;
  setTile(id: string, x: number, y: number, frame: number | null): void;
  /** Validates the entire batch before changing any cell; duplicate cells are rejected. */
  setTiles(id: string, updates: readonly TilemapUpdate[]): void;
  /** Replace animations and restart them from their first frame. */
  setAnimations(id: string, animations: readonly TilemapAnimation[]): void;
  /** Overwrite the mapped grid rectangle based on the current tile frames. */
  syncNavigation(id: string, grid: string, options: TilemapNavigationOptions): void;
  /** Update tiles and their mapped navigation cells together; see rollback diagnostics. */
  setTilesAndSyncNavigation(id: string, updates: readonly TilemapUpdate[], grid: string, options: TilemapNavigationOptions): void;
  /** Replace a fixed 2D body's compound collider from current tile data. */
  syncPhysics2D(id: string, body: string, options: TilemapPhysics2DOptions): void;
  /** Update tiles and their fixed 2D collider together; see partial-state diagnostics. */
  setTilesAndSyncPhysics2D(id: string, updates: readonly TilemapUpdate[], body: string, options: TilemapPhysics2DOptions): void;
  /** Update tiles, replace the mapped navigation rectangle and replace the fixed 2D collider. */
  setTilesAndSyncWorld(id: string, updates: readonly TilemapUpdate[], options: TilemapWorldSyncOptions): void;
  inspect(id: string): TilemapState;
  visuals(): readonly TilemapVisualState[];
  /** Read one 32脳32 presentation chunk, including its current revision. */
  readChunk(id: string, x: number, y: number): TilemapChunkState;
  destroy(id: string): void;
}
/** CPU particles with sampled sphere, plane and box collisions. Explicit body bindings apply delayed
 * contact impulses to dynamic spheres or boxes; there is no full rigid-body coupling. */
export type RopeCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number }
  /** Stationary box sampled in world space; rotation is XYZ Euler radians. */
  | { kind: "box"; id: string; center: Vec3; halfExtents: Vec3; rotation?: Vec3 };
/** Explicit connection between a sampled rope collider id and a dynamic sphere or box body. */
export interface RopeBodyCollider { readonly id: string; readonly entity: string }
/** A rope particle connected to a point in a dynamic body's local rigid-body frame, in metres. */
export interface RopeBodyAttachment { readonly index: number; readonly entity: string; readonly localPoint: Vec3 }
/** Optional renderer-owned cylindrical segments following simulated particle positions. */
export interface RopeVisualOptions {
  material: string;
  radius?: number;
  radialSegments?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
/** Detached presentation state; native renderer objects are not exposed. */
export interface RopeVisualState {
  id: string;
  material: string;
  radius: number;
  radialSegments: number;
  castShadow: boolean;
  receiveShadow: boolean;
  positions: Vec3[];
}
export interface RopeDefinition {
  id: string;
  points: readonly Vec3[];
  /** Kilograms per particle, positive and at most 1e6. */
  mass: number;
  radius?: number;
  /** Defaults to the host interval; an explicit value must exactly match it. */
  fixedDt?: number;
  /** Join the shared fixed-tick/substep clock; defaults to false (manual stepping). */
  autoStep?: boolean;
  /** Automatically sample and react to existing dynamic, non-trigger sphere or box bodies. Requires autoStep. */
  bodyColliders?: readonly RopeBodyCollider[];
  /** Connect particles to live dynamic sphere/box bodies with delayed two-way reaction impulses. Requires autoStep. */
  bodyAttachments?: readonly RopeBodyAttachment[];
  /** Resolve sampled sphere and box contacts on segment interiors; defaults to true for new ropes. */
  segmentCollisions?: boolean;
  /** Resolve discrete non-adjacent segment self contacts; defaults to true for new ropes. */
  selfCollisions?: boolean;
  /** Optional segmented presentation using an already-declared material id. */
  visual?: RopeVisualOptions;
  substeps?: number;
  iterations?: number;
  damping?: number;
  gravity?: Vec3;
  anchors?: readonly { index: number; position: Vec3 }[];
}
/** Sampled-collider contact from the most recently completed rope tick. */
export interface RopeContact {
  tick: number; particle: number; colliderId: string; penetration: number;
  /** Opposite of particle contact impulses, N路s; absent in older snapshots. */
  reactionImpulse?: Vec3;
  /** Angular impulse about the world origin; absent in older snapshots. */
  reactionAngularImpulse?: Vec3;
}
/** Contact between an interior rope segment and a sampled sphere or box. */
export interface RopeSegmentContact {
  tick: number;
  /** Zero-based index of the first endpoint; the second is segment + 1. */
  segment: number;
  colliderId: string;
  /** Last closest-point fraction from the first endpoint toward the second. */
  fraction: number;
  penetration: number;
  reactionImpulse?: Vec3;
  reactionAngularImpulse?: Vec3;
}
/** Discrete self-contact between two non-adjacent rope segments. */
export interface RopeSelfContact {
  tick: number;
  /** Zero-based first endpoint of each non-adjacent segment, ordered ascending. */
  firstSegment: number; secondSegment: number;
  /** Last closest-point fractions along the respective segments. */
  firstFraction: number; secondFraction: number;
  /** Maximum observed overlap in metres during this tick. */
  penetration: number;
}
export interface RopeState {
  tick: number; simulatedSeconds: number; disposed: boolean;
  gravity: Vec3;
  segmentCollisions: boolean;
  selfCollisions: boolean;
  positions: Vec3[]; velocities: Vec3[];
  anchors: { index: number; position: Vec3 }[];
  contacts: RopeContact[];
  segmentContacts: RopeSegmentContact[];
  selfContacts: RopeSelfContact[];
  maxDistanceError: number;
  resources: { particles: number; constraints: number; anchors: number; colliders: number };
}
/** Particle-indexed impulse in N路s for rope and cloth. */
export interface IndexedParticleImpulse { index: number; impulse: Vec3 }
/** Nearest indexed particle centre in world space. */
export interface IndexedParticleHit { index: number; position: Vec3; distance: number }
/** An indexed world-space anchor position. */
export interface ParticleAnchor { index: number; position: Vec3 }
export interface RopeService {
  create(definition: RopeDefinition): void;
  /** Explicit ticks for manual ropes only. Auto-stepped ropes reject this call. A failed batch leaves the rope unchanged. */
  step(id: string, ticks?: number): RopeState;
  inspect(id: string): RopeState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): IndexedParticleHit | null;
  /** Detached visual descriptions, sorted by rope id; empty when no visuals are requested. */
  visuals(): readonly RopeVisualState[];
  /** Replace sampled colliders. Segment contacts support spheres and boxes when enabled. */
  setColliders(id: string, colliders: readonly RopeCollider[]): void;
  /** Connect an unpinned particle to a dynamic body; an existing attachment at the index is rejected. */
  attachBody(id: string, attachment: RopeBodyAttachment): void;
  /** Disconnect a particle without pinning it; it retains its simulated velocity. */
  detachBody(id: string, index: number): void;
  /** Inspect detached attachment definitions. */
  bodyAttachments(id: string): readonly RopeBodyAttachment[];
  setAnchor(id: string, index: number, position: Vec3): void;
  /** Pin or move the specified anchors atomically; other anchors are unchanged. */
  setAnchors(id: string, anchors: readonly ParticleAnchor[]): void;
  releaseAnchor(id: string, index: number): void;
  /** Set gravity for subsequent steps; components must be finite and at most 1e6 in magnitude. */
  setGravity(id: string, gravity: Vec3): void;
  applyForce(id: string, index: number, force: Vec3): void;
  applyImpulse(id: string, index: number, impulse: Vec3): void;
  /** Apply distinct particle impulses atomically; anchored particles are rejected. */
  applyImpulses(id: string, impulses: readonly IndexedParticleImpulse[]): void;
  destroy(id: string): void;
}
/** CPU triangulated cloth with particle contacts against sampled spheres and planes. */
export type ClothCollider = RopeCollider;
export type ClothTriangle = readonly [number, number, number];
export interface ClothVisualOptions {
  material: string;
  /** Optional per-particle UV coordinates; defaults to a planar projection. */
  uvs?: readonly Vec2[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}
export interface ClothBodyCollider { readonly id: string; readonly entity: string }
export interface ClothDefinition {
  id: string;
  points: readonly Vec3[];
  triangles: readonly ClothTriangle[];
  /** Kilograms per movable particle. */
  mass: number;
  radius?: number;
  fixedDt?: number;
  autoStep?: boolean;
  substeps?: number;
  iterations?: number;
  damping?: number;
  gravity?: Vec3;
  /** Distance-based bending approximation across shared triangle edges; defaults to true. */
  bending?: boolean;
  anchors?: readonly { index: number; position: Vec3 }[];
  visual?: ClothVisualOptions;
  /** Discrete non-adjacent particle self-contact; defaults to true for new cloth. */
  selfCollisions?: boolean;
  /** Discrete sphere, plane and sampled-box triangle contacts; defaults to true for new cloth. */
  surfaceCollisions?: boolean;
  /** Optional live dynamic non-trigger sphere or box bindings; sampled after the physics phase. */
  bodyColliders?: readonly ClothBodyCollider[];
  /** Exchange effective-mass contact reactions with bound bodies within shared substeps. */
  bodyReactions?: boolean;
}
export interface ClothContact { tick: number; particle: number; colliderId: string; penetration: number; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
export interface ClothSelfContact { tick: number; firstParticle: number; secondParticle: number; penetration: number }
export interface ClothSurfaceContact { tick: number; triangle: number; colliderId: string; penetration: number; barycentric: [number, number, number]; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
export interface ClothState {
  tick: number; simulatedSeconds: number; disposed: boolean; selfCollisions: boolean; surfaceCollisions: boolean;
  gravity: Vec3;
  positions: Vec3[]; velocities: Vec3[]; triangles: ClothTriangle[];
  anchors: { index: number; position: Vec3 }[];
  contacts: ClothContact[]; selfContacts: ClothSelfContact[]; surfaceContacts: ClothSurfaceContact[];
  maxDistanceError: number;
  resources: { particles: number; triangles: number; constraints: number; anchors: number; colliders: number };
}
export interface ClothVisualState {
  id: string; material: string; positions: Vec3[]; triangles: ClothTriangle[];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
export interface ClothService {
  create(definition: ClothDefinition): void;
  /** Explicit ticks for manual cloth only; automatic cloth rejects this call. */
  step(id: string, ticks?: number): ClothState;
  inspect(id: string): ClothState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): IndexedParticleHit | null;
  visuals(): readonly ClothVisualState[];
  /** Replace sampled colliders. Box triangle contacts are discrete samples, not continuous collision. */
  setColliders(id: string, colliders: readonly ClothCollider[]): void;
  setAnchor(id: string, index: number, position: Vec3): void;
  /** Pin or move the specified anchors atomically; other anchors are unchanged. */
  setAnchors(id: string, anchors: readonly ParticleAnchor[]): void;
  releaseAnchor(id: string, index: number): void;
  /** Set gravity for subsequent steps; components must be finite and at most 1e6 in magnitude. */
  setGravity(id: string, gravity: Vec3): void;
  applyForce(id: string, index: number, force: Vec3): void;
  applyImpulse(id: string, index: number, impulse: Vec3): void;
  /** Apply distinct particle impulses atomically; anchored particles are rejected. */
  applyImpulses(id: string, impulses: readonly IndexedParticleImpulse[]): void;
  destroy(id: string): void;
}
/** CPU WCSPH fluid prototype exposed as a bounded development service. */
export interface FluidVisualOptions { material: string; radius?: number; castShadow?: boolean; receiveShadow?: boolean }
/** A live dynamic non-trigger sphere or box sampled at each shared substep. */
export interface FluidBodyCollider { readonly id: string; readonly entity: string }
/** Axis-aligned container bounds relative to the simulation origin. */
export interface SimulationContainer { min: Vec3; max: Vec3 }
export interface FluidDefinition {
  id: string; autoStep?: boolean; seed?: number; fixedDt?: number; substeps?: number; iterations?: number;
  /** Initial lattice dimensions, each an integer in [1,8]; defaults to [4,4,4]. */
  particleGrid?: readonly [number, number, number];
  /** Translates the reference particles and container in world space. */
  origin?: Vec3;
  container?: SimulationContainer;
  contacts?: boolean; twoWayCoupling?: boolean; gravity?: Vec3;
  /** Reference sphere motion is used only by manual or restored legacy simulations. */
  bodyPosition?: Vec3; bodyVelocity?: Vec3;
  visual?: FluidVisualOptions;
  /** Up to 64 distinct live native sphere/box bindings; no implicit body is added to new automatic fluids. */
  bodyColliders?: readonly FluidBodyCollider[];
  /** Exchange effective-mass contact reactions with bound bodies within shared substeps. */
  bodyReactions?: boolean;
}
export interface FluidParticle {
  id: string; position: Vec3; radius: number;
  /** For a sampled box body, radius is the reference particle radius, not the collider dimensions. */
  collider?: { kind: "box"; halfExtents: Vec3; rotation: Vec3 };
}
export interface FluidState {
  tick: number; simulatedSeconds: number; disposed: boolean; particles: FluidParticle[]; bodies: FluidParticle[];
  /** Velocities in metres per second, aligned with particles. */
  velocities: Vec3[];
  gravity: Vec3;
  contacts: { contactCount: number; reactionImpulse: Vec3; reactionMoment?: Vec3; absoluteReactionImpulse: number; maxContactCorrection: number; maxObservedSpeed: number };
  fluid: { method: "WCSPH"; restDensity: number; minDensity: number; maxDensity: number; maxPressure: number } | null;
  resources: { particles: number; bodies: number };
}
export interface FluidVisualState {
  id: string; material: string; particles: FluidParticle[]; castShadow: boolean; receiveShadow: boolean;
}
/** A single particle impulse in N路s; particle IDs are returned by inspection. */
export interface SimulationImpulse { particle: string; impulse: Vec3 }
/** Force in newtons, applied to one particle for the next fixed tick. */
export interface SimulationForce { particle: string; force: Vec3 }
/** Manual particle obstacle; box rotation is optional XYZ Euler angles in radians. */
export type ParticleSimulationCollider = RopeCollider;
/** Nearest particle centre in world space; distance is measured in metres. */
export interface SimulationParticleHit { particle: string; position: Vec3; distance: number }
export interface FluidService {
  create(definition: FluidDefinition): void;
  step(id: string, ticks?: number): FluidState;
  inspect(id: string): FluidState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): SimulationParticleHit | null;
  visuals(): readonly FluidVisualState[];
  /** Set gravity for subsequent steps; values must be finite and in [-100,100]. */
  setGravity(id: string, gravity: Vec3): void;
  /** Replace up to 64 manual sphere, plane or axis-aligned box colliders. Requires contacts enabled. */
  setColliders(id: string, colliders: readonly ParticleSimulationCollider[]): void;
  applyImpulse(id: string, particle: string, impulse: Vec3): void;
  /** Apply up to 512 impulses atomically; duplicate targets are rejected. */
  applyImpulses(id: string, impulses: readonly SimulationImpulse[]): void;
  /** Accumulate a force for the next fixed tick. Components and accumulated values must stay in [-100,100]. */
  applyForce(id: string, particle: string, force: Vec3): void;
  /** Atomically queue up to 512 forces on distinct particles for the next fixed tick. */
  applyForces(id: string, forces: readonly SimulationForce[]): void;
  destroy(id: string): void;
}
/** CPU tetrahedral soft-body service backed by the bounded XPBD reference solver. */
export interface SoftBodyVisualOptions { material: string; castShadow?: boolean; receiveShadow?: boolean }
/** A live dynamic non-trigger sphere or box sampled at each shared substep. */
export interface SoftBodyBodyCollider { readonly id: string; readonly entity: string }
export interface SoftBodyDefinition {
  id: string; autoStep?: boolean; seed?: number; fixedDt?: number; substeps?: number; iterations?: number;
  /** Initial tetrahedral lattice dimensions, each in [2,5]; defaults to [3,3,3]. */
  softBodyGrid?: readonly [number, number, number];
  /** Enable discrete contacts between non-edge-adjacent soft-body particles; defaults to false. */
  selfCollisions?: boolean;
  /** Translates the reference particles and container in world space. */
  origin?: Vec3;
  container?: SimulationContainer;
  contacts?: boolean; twoWayCoupling?: boolean; gravity?: Vec3;
  /** Reference sphere motion is used only by manual or restored legacy simulations. */
  bodyPosition?: Vec3; bodyVelocity?: Vec3;
  visual?: SoftBodyVisualOptions;
  /** Up to 64 distinct live native sphere/box bindings; new automatic soft bodies have no implicit body. */
  bodyColliders?: readonly SoftBodyBodyCollider[];
  /** Use approximate split-step effective-mass contacts with delayed reaction impulses; not a unified coupled solve. */
  bodyReactions?: boolean;
}
export interface SoftBodyState {
  tick: number; simulatedSeconds: number; disposed: boolean;
  gravity: Vec3;
  positions: Vec3[]; triangles: [number, number, number][];
  /** Particle IDs aligned with positions. */
  particleIds: string[];
  /** Velocities in metres per second, aligned with positions and particleIds. */
  velocities: Vec3[];
  contacts: { contactCount: number; selfContactCorrections?: number; reactionImpulse: Vec3; reactionMoment?: Vec3; absoluteReactionImpulse: number; maxContactCorrection: number; maxObservedSpeed: number };
  maxDistanceError: number; maxVolumeRelativeError: number; minSignedVolumeRatio: number | null;
  resources: { particles: number; bodies: number; constraints: number; triangles: number };
}
export interface SoftBodyVisualState {
  id: string; material: string; positions: Vec3[]; triangles: [number, number, number][];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
export interface SoftBodyService {
  create(definition: SoftBodyDefinition): void;
  step(id: string, ticks?: number): SoftBodyState;
  inspect(id: string): SoftBodyState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): SimulationParticleHit | null;
  visuals(): readonly SoftBodyVisualState[];
  /** Set gravity for subsequent steps; values must be finite and in [-100,100]. */
  setGravity(id: string, gravity: Vec3): void;
  /** Replace up to 64 manual sphere, plane or axis-aligned box colliders. Requires contacts enabled. */
  setColliders(id: string, colliders: readonly ParticleSimulationCollider[]): void;
  applyImpulse(id: string, particle: string, impulse: Vec3): void;
  /** Apply up to 512 impulses atomically; duplicate targets are rejected. */
  applyImpulses(id: string, impulses: readonly SimulationImpulse[]): void;
  /** Accumulate a force for the next fixed tick. Components and accumulated values must stay in [-100,100]. */
  applyForce(id: string, particle: string, force: Vec3): void;
  /** Atomically queue up to 512 forces on distinct particles for the next fixed tick. */
  applyForces(id: string, forces: readonly SimulationForce[]): void;
  destroy(id: string): void;
}
/** Integer cells on a finite 2D grid; not continuous, flying or underwater navigation.
 * Searches allocate sparse state and depend on available memory. At most 2^32-1 cells may be defined.
 * Owners are explicit strings and are not automatically tied to entities. */
export interface TerrainGeometry {
  id: string;
  /** Vertex counts, each in [2,64]. Heights use row-major z * columns + x. */
  columns: number;
  rows: number;
  cellSize: number;
  origin: Vec3;
  heights: readonly number[];
  friction?: number;
  restitution?: number;
}
export interface TerrainDefinition extends TerrainGeometry {
  material: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Owned X/Z grid. Cells above either walkability threshold are blocked. */
  navigation?: { grid: string; maxSlope?: number; maxStep?: number };
}
export interface TerrainState extends TerrainDefinition { revision: number }
export interface TerrainHeightEdit { column: number; row: number; height: number }
export interface TerrainService {
  create(definition: TerrainDefinition): void;
  inspect(id: string): TerrainState;
  list(): readonly string[];
  /** Commit a height batch to rendering, native physics and owned navigation together. */
  setHeights(id: string, edits: readonly TerrainHeightEdit[]): void;
  sculpt(id: string, brush: { center: Vec2; radius: number; delta: number; falloff?: "linear" | "smooth" | "constant" }): void;
  /** World-space height on the actual mesh triangles, or null outside the terrain. */
  sampleHeight(id: string, x: number, z: number): number | null;
  visuals(): readonly ClothVisualState[];
  destroy(id: string): void;
}
export interface NavigationCell { readonly x: number; readonly y: number }
/** One obstacle change for an orthogonal navigation grid. */
export interface NavigationObstacleUpdate { readonly cell: NavigationCell; readonly blocked: boolean }
/** Cost to enter a cell; omitted cells cost 1. Values must be finite and at least 1. */
export interface NavigationCostUpdate { readonly cell: NavigationCell; readonly cost: number }
export interface NavigationGrid {
  readonly id: string;
  readonly owner: string;
  readonly width: number;
  readonly height: number;
  readonly blocked?: readonly NavigationCell[];
  readonly costs?: readonly NavigationCostUpdate[];
  /** Maximum distinct search cells, including endpoints; defaults to 65536. Raising it increases memory and CPU use. */
  readonly searchCellBudget?: number;
}
/** Options for one grid search. Diagonal movement never crosses blocked corners. */
export interface NavigationPathOptions {
  readonly allowDiagonal?: boolean;
  /** Additional blocked cells for this search only; does not modify the grid. */
  readonly blocked?: readonly NavigationCell[];
}
/** A non-physical root entity moving on a finite X/Z or X/Y navigation grid. */
export interface NavigationAgentDefinition {
  id: string;
  entity: string;
  grid: string;
  /** Follow an owned X/Z terrain grid and sample its triangle height during movement. */
  terrain?: string;
  /** World coordinates of cell (0,0)'s origin; defaults to [0,0]. */
  origin?: Vec2;
  /** X/Z by default; X/Y supports 2D-positioned entities. */
  plane?: "xz" | "xy";
  /** Direction in world space as grid y increases; defaults to positive. */
  rowDirection?: "positive" | "negative";
  /** World units per square cell; defaults to 1. */
  cellSize?: number;
  /** World units per second; defaults to 1. */
  speed?: number;
  allowDiagonal?: boolean;
  /** Reserve grid cells against other opted-in agents with the same mapping. */
  avoidAgents?: boolean;
}
export interface NavigationAgentState {
  id: string;
  entity: string;
  grid: string;
  terrain?: string;
  plane: "xz" | "xy";
  rowDirection: "positive" | "negative";
  target: NavigationCell | null;
  /** Live root entity followed by this agent, if any. */
  followEntity?: string;
  avoidAgents?: boolean;
  status: "idle" | "planning" | "moving" | "waiting" | "arrived" | "blocked" | "missing";
  /** Stable diagnostic code when movement is blocked or the entity was removed. */
  error: string | null;
  path: readonly NavigationCell[];
  cursor: number;
}
export interface NavigationService {
  createGrid(grid: NavigationGrid): void;
  /** Returns a detached description, including the current blocked cells. */
  getGrid(id: string): NavigationGrid;
  isBlocked(id: string, cell: NavigationCell): boolean;
  setBlocked(id: string, cell: NavigationCell, blocked: boolean): void;
  /** Validates the entire batch before committing; the last change for a repeated cell wins. */
  setBlockedBatch(id: string, updates: readonly NavigationObstacleUpdate[]): void;
  getCost(id: string, cell: NavigationCell): number;
  /** Applies all validated updates together; repeated cells use the last cost. */
  setCostsBatch(id: string, updates: readonly NavigationCostUpdate[]): void;
  /** Four-directional by default; diagonals cost sqrt(2) times the entered cell cost. */
  findPath(id: string, start: NavigationCell, end: NavigationCell, options?: NavigationPathOptions): readonly NavigationCell[];
  /** Movement is processed at fixed-tick boundaries; the entity must be a non-physical root. */
  createAgent(definition: NavigationAgentDefinition): void;
  setAgentTarget(id: string, target: NavigationCell): void;
  /** Follow a live root entity, replanning when it enters a different grid cell. */
  followAgentTarget(id: string, entity: string): void;
  stopAgent(id: string): void;
  inspectAgent(id: string): NavigationAgentState;
  listAgents(): readonly NavigationAgentState[];
  destroyAgent(id: string): void;
  destroyGrid(id: string): void;
  destroyOwner(owner: string): void;
}
/** Bounded static-entity chunk streaming on the world's X/Z plane. */
export interface WorldStreamingOptions {
  /** World units per chunk. Defaults to 32. */
  chunkSize?: number;
  /** Chebyshev radius in chunks to activate. Defaults to 1. */
  loadRadius?: number;
  /** Radius beyond which to deactivate; must be at least loadRadius. Defaults to 2. */
  unloadRadius?: number;
  /** Maximum chunk transitions per fixed tick. Defaults to 4. */
  maxChangesPerTick?: number;
}
export interface WorldChunkDefinition {
  x: number;
  z: number;
  /** Root entities with declared prefabs and absolute world-space transforms. */
  entities: readonly SpawnInput[];
}
export interface WorldStreamingService {
  configure(options: WorldStreamingOptions): void;
  defineChunk(chunk: WorldChunkDefinition): void;
  /** Add a root prefab to a chunk. Active-chunk edits take effect at a later structural boundary. */
  addEntity(x: number, z: number, entity: SpawnInput): void;
  /** Remove a chunk-owned root. Active-chunk edits take effect at a later structural boundary. */
  removeEntity(x: number, z: number, entityId: string): void;
  /** Detached committed entity data and queued edit identifiers. */
  getChunk(x: number, z: number): {
    x: number; z: number; active: boolean;
    entities: readonly SpawnInput[];
    pending: readonly { kind: "add" | "remove"; id: string }[];
  };
  /** Set a world-space observer, or null to suspend automatic residency changes. */
  setFocus(position: Vec3 | null): void;
  /** Follow a live root entity at fixed-tick boundaries; null suspends automatic residency. */
  followFocus(entity: string | null): void;
  /** Removes an inactive definition; loaded chunks must first move out of range. */
  removeChunk(x: number, z: number): void;
  inspect(): {
    focus: Vec3 | null;
    focusEntity: string | null;
    focusStatus: "manual" | "following" | "missing" | "invalid";
    options: Required<WorldStreamingOptions>;
    chunks: readonly { x: number; z: number; active: boolean; entities: number }[];
  };
}
export type RenderMode = "raster" | "hybrid" | "path";
export interface RenderCapabilities {
  backend: "webgpu" | "webgl2" | "uninitialized";
  compute: boolean;
  availableModes: readonly RenderMode[];
  /** Explanation when scene configuration further restricts render modes. */
  modeLimitation?: string;
}
export interface RenderSettings {
  mode: RenderMode;
  samplesPerFrame: number;
  maxBounces: number;
  denoise: boolean;
  denoiseIterations: number;
  exposure: number;
  directLighting: boolean;
  indirectLighting: boolean;
  debug: "beauty" | "albedo" | "normal" | "depth" | "samples";
}
/** Runtime values for non-graph material channels; colors are linear RGB. */
export interface MaterialSurfacePatch {
  color?: Vec3; emissive?: Vec3; roughness?: number; metalness?: number; emissiveIntensity?: number;
}
export interface RenderService {
  configure(settings: Partial<RenderSettings>): void;
  state(): Readonly<RenderSettings>;
  capabilities(): Readonly<RenderCapabilities>;
  setMaterialParameter(material: string, name: string, value: GraphValue): void;
  materialParameters(material: string): Readonly<Record<string, GraphValue>>;
  /** Merge values for a declared material; graph-controlled channels reject overrides. */
  setMaterialSurface(material: string, patch: MaterialSurfacePatch): void;
  materialSurface(material: string): Readonly<MaterialSurfacePatch>;
  /** Restore all authored surface values for a material. */
  resetMaterialSurface(material: string): void;
  readonly effects: PostProcessService;
  readonly buffers: RenderBufferBindings;
  readonly textures: RenderTextureBindings;
}
export interface MaterialBufferInput {
  /** Shared slot declaration for material and postprocess graphs. */
  name: string;
  type: GraphType;
  /** Optional initial logical compute-buffer ID. */
  buffer?: string;
  /** Optional exact element count required by this slot. */
  count?: number;
}
export interface RenderBufferReference {
  id: string;
  type: GraphType;
  count: number;
}
export interface RenderBufferBindings {
  bind(target: string, name: string, buffer: ComputeBufferHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderBufferReference>>;
}
export interface MaterialTextureInput extends ComputeTextureBinding {
  /** Initial managed texture ID; asset import uses computeTextures/createTexture. */
  texture?: string;
  width?: number;
  height?: number;
}
export interface RenderTextureReference extends ComputeTextureSize {
  id: string;
  format: "rgba32float";
}
export interface RenderTextureBindings {
  bind(target: string, name: string, texture: ComputeTextureHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderTextureReference>>;
}
export interface PostProcessState {
  id: string;
  enabled: boolean;
  parameters: Readonly<Record<string, GraphValue>>;
}
export interface PostProcessService {
  /** Compute-buffer slots declared by definePostProcess, addressed by pass ID. */
  readonly buffers: RenderBufferBindings;
  readonly textures: RenderTextureBindings;
  configure(id: string, settings: { enabled: boolean }): void;
  state(id: string): Readonly<PostProcessState>;
  setParameter(id: string, name: string, value: GraphValue): void;
  /** Clears temporal effect images; it does not modify game or trace accumulation state. */
  resetHistory(id?: string): void;
}
export interface ComputeBufferHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
}
export interface ComputeTaskHandle {
  readonly owner: number;
  readonly id: number;
}
export interface ComputeBufferInput {
  id: string;
  type: GraphType;
  count: number;
  data?: readonly GraphValue[];
}
export interface ComputeTextureHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
  readonly kind: "texture";
}
export interface ComputeTextureSize {
  width: number;
  height: number;
}
export interface ComputeTextureDataInput extends ComputeTextureSize {
  id: string;
  /** Linear rgba32float texels in row-major order, without color-space conversion. */
  data?: readonly Vec4[];
  asset?: never;
}
export interface ComputeTextureAssetInput {
  id: string;
  asset: AssetDefinition | string;
  width?: never;
  height?: never;
  data?: never;
}
export type ComputeTextureInput = ComputeTextureDataInput | ComputeTextureAssetInput;
export interface ComputeTextureBinding {
  name: string;
  filter?: "nearest" | "linear";
  wrapU?: "clamp" | "repeat" | "mirror";
  wrapV?: "clamp" | "repeat" | "mirror";
}
export interface ComputeDispatchInput {
  output: ComputeBufferHandle | ComputeTextureHandle;
  /** Handles capture dispatch-time data; task bindings consume that exact successful output revision. */
  bindings?: Readonly<Record<string, ComputeBufferHandle | { task: ComputeTaskHandle }>>;
  /** Named sampled rgba32float textures; task bindings capture that exact texture result. */
  textures?: Readonly<Record<string, ComputeTextureHandle | { task: ComputeTaskHandle }>>;
  /** Ordering only. It never silently refreshes ordinary handle bindings. */
  after?: readonly ComputeTaskHandle[];
  parameters?: Readonly<Record<string, GraphValue>>;
  /** Fixed simulation time by default, not wall-clock time. */
  time?: number;
}
export interface ComputeTaskState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code: string; message: string; remediation: string };
}
export interface ComputeService {
  createTexture(input: ComputeTextureInput): ComputeTextureHandle;
  resolveTexture(id: string): ComputeTextureHandle;
  describeTexture(texture: ComputeTextureHandle): Readonly<ComputeTextureSize & { id: string; format: "rgba32float"; revision: number }>;
  readTexture(texture: ComputeTextureHandle): readonly Vec4[];
  writeTexture(texture: ComputeTextureHandle, data: readonly Vec4[], region?: ComputeTextureSize & { x: number; y: number }): void;
  releaseTexture(texture: ComputeTextureHandle): void;
  createBuffer(input: ComputeBufferInput): ComputeBufferHandle;
  resolve(id: string): ComputeBufferHandle;
  describeBuffer(buffer: ComputeBufferHandle): Readonly<{ id: string; type: GraphType; count: number; revision: number }>;
  /** Last committed GPU result; detached CPU data, never a GPU object. */
  readBuffer(buffer: ComputeBufferHandle): readonly GraphValue[];
  writeBuffer(buffer: ComputeBufferHandle, values: readonly GraphValue[], offset?: number): void;
  releaseBuffer(buffer: ComputeBufferHandle): void;
  dispatch(kernel: ComputeDefinition | string, input: ComputeDispatchInput): ComputeTaskHandle;
  task(task: ComputeTaskHandle): Readonly<ComputeTaskState>;
  tasks(): readonly { handle: ComputeTaskHandle; state: ComputeTaskState }[];
  cancel(task: ComputeTaskHandle): void;
  releaseTask(task: ComputeTaskHandle): void;
}
export interface GamepadState {
  /** Browser gamepad API is present and readable. */
  available: boolean;
  connected: boolean;
  /** Browser index of the selected standard-mapped pad; no device identifier is exposed. */
  index: number | null;
  axes: readonly number[];
  buttons: readonly number[];
  /** Gameplay input is suppressed, for example while UI owns the gamepad. */
  suppressed: boolean;
}
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
export interface PointerContact { id: number; position: Vec2; pressure: number; kind: "mouse" | "pen" | "touch" }
export interface PointerState {
  /** Canvas-local CSS pixels and normalized device coordinates (Y up). */
  position: Vec2;
  ndc: Vec2;
  delta: Vec2;
  wheel: Vec2;
  buttons: number;
  pressed: number;
  released: number;
  inside: boolean;
  locked: boolean;
  contacts: readonly PointerContact[];
}
export interface GamepadInputService extends InputService {
  pointer(): PointerState;
  /** Requests lock on the next trusted canvas gesture; false releases it. */
  setPointerLock(enabled: boolean): void;
  /** Choose UI navigation or gameplay input; defaults to UI for backward compatibility. */
  setGamepadMode(mode: "ui" | "game"): void;
  /** Analog axis deadzone in [0, 0.95]; defaults to 0.15. */
  setGamepadDeadzone(value: number): void;
  gamepad(): GamepadState;
}
/** Shape for a 3D linear sweep; box dimensions are half-extents and capsule is aligned to local Y. */
export type PhysicsSweepShape =
  | { shape: "sphere"; radius: number }
  | { shape: "box"; halfExtents: Vec3 }
  | { shape: "capsule"; halfHeight: number; radius: number };
export interface PhysicsSweepHit { entity: string; fraction: number; distance: number; point: Vec3; normal: Vec3 }
/** Anchors and axes are in each rigid body's local frame, in metres/radians. */
export interface PhysicsJointBase {
  id: string;
  body1: string;
  body2: string;
  anchor1: Vec3;
  anchor2: Vec3;
  /** Connected bodies do not collide by default. */
  contactsEnabled?: boolean;
}
export type PhysicsJointDefinition = PhysicsJointBase & (
  | { kind: "ball" }
  | { kind: "fixed"; frame1: Vec4; frame2: Vec4 }
  | { kind: "revolute"; axis1: Vec3; axis2: Vec3; limits?: readonly [number, number] }
  | { kind: "prismatic"; axis: Vec3; limits?: readonly [number, number] }
  | { kind: "rope"; length: number }
  | { kind: "spring"; restLength: number; stiffness: number; damping: number }
);
export interface PhysicsService {
  /** Scripted collision-aware character target for the next fixed tick; overrides ordinary movement/gravity for that tick. */
  moveCharacterTo(entity: string, position: Vec3): void;
  /** Explicit discontinuous relocation; updates native queries and World together. */
  teleport(entity: string, transform: TransformPatch, options?: { resetVelocity?: boolean }): void;
  /** Create a 3D joint between fixed/dynamic bodies, with at least one dynamic endpoint. */
  createJoint(definition: PhysicsJointDefinition): void;
  /** Remove a joint; removing an endpoint body also removes its connected joints. */
  destroyJoint(id: string): void;
  inspectJoint(id: string): PhysicsJointDefinition;
  listJoints(): readonly PhysicsJointDefinition[];
  /** Set 3D rigid-body world gravity; wakes dynamic bodies. Character controllers keep their own gravity. */
  setGravity(gravity: Vec3): void;
  /** Current 3D rigid-body world gravity in world units per second squared. */
  gravity(): Vec3;
  /** Set or inspect a dynamic rigid body's gravity multiplier; wakes it when changed. */
  setGravityScale(entity: string, scale: number): void;
  gravityScale(entity: string): number;
  moveCharacter(entity: string, displacement: Vec3): void;
  grounded(entity: string): boolean;
  velocity(entity: string): Vec3;
  /** World-space rigid-body center of mass, including collider offsets. */
  centerOfMass(entity: string): Vec3;
  setVelocity(entity: string, velocity: Vec3): void;
  impulse(entity: string, impulse: Vec3): void;
  /** Angular velocity in world-space radians per second. */
  angularVelocity(entity: string): Vec3;
  setAngularVelocity(entity: string, velocity: Vec3): void;
  /** Instantaneous world-space angular impulse, in angular-momentum units. */
  torqueImpulse(entity: string, impulse: Vec3): void;
  /** Apply world-space impulse at a world-space point, changing linear and angular motion. */
  impulseAtPoint(entity: string, impulse: Vec3, point: Vec3): void;
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean },
  ): { entity: string; distance: number; point: Vec3; normal: Vec3 } | null;
  /** Sweep a shape through a nonzero world-space displacement. Initial overlaps hit at fraction 0. */
  castShape(shape: PhysicsSweepShape, center: Vec3, displacement: Vec3, rotation?: Vec3,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean }): PhysicsSweepHit | null;
  /** Find entities whose colliders overlap a world-space sphere, sorted by entity ID. */
  overlapSphere(
    center: Vec3,
    radius: number,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean },
  ): readonly string[];
  /** Find entities overlapping an oriented box; halfExtents are positive world units, rotation is XYZ radians. */
  overlapBox(
    center: Vec3,
    halfExtents: Vec3,
    rotation?: Vec3,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean },
  ): readonly string[];
  /** Find entities overlapping a capsule aligned to local Y; halfHeight excludes the rounded ends. */
  overlapCapsule(
    center: Vec3,
    halfHeight: number,
    radius: number,
    rotation?: Vec3,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean },
  ): readonly string[];
}
export interface AnimationService {
  /** Start at a clip-local time in seconds. Reverse playback defaults to the clip end. */
  play(
    entity: string,
    clip: string,
    options?: { fade?: number; speed?: number; loop?: boolean; startAt?: number },
  ): void;
  state(entity: string): {
    clip: string | null;
    time: number;
    playing: boolean;
  };
}
/** An additive layer uses the clip pose at referenceTime as its zero offset. */
export interface AdditiveAnimationOptions {
  /** Bone names to include; omitted selects all bone transform tracks. */
  bones?: readonly string[];
  /** Include descendant bones of the named bones; defaults to true. */
  includeChildren?: boolean;
  weight?: number;
  speed?: number;
  loop?: boolean;
  startAt?: number;
  referenceTime?: number;
}
export interface AdditiveAnimationState {
  id: string;
  clip: string;
  bones?: readonly string[];
  includeChildren: boolean;
  weight: number;
  speed: number;
  loop: boolean;
  referenceTime: number;
  time: number;
  paused: boolean;
  playing: boolean;
}
/** CCD inverse-kinematics chain; target coordinates are local to the loaded model root. */
export interface AnimationIKJointLimit {
  bone: string;
  enabled?: boolean;
  /** Local XYZ Euler bounds in radians. */
  rotationMin?: Vec3;
  rotationMax?: Vec3;
  /** Optional normalized local hinge axis. */
  hingeAxis?: Vec3;
}
export interface AnimationIKDefinition {
  id: string;
  effector: string;
  /** Parent bones in order from the effector's immediate parent toward the root. */
  chain: readonly string[];
  target: Vec3;
  iterations?: number;
  weight?: number;
  /** Maximum radians per joint update; omitted means no additional limit. */
  maxAngle?: number;
  jointLimits?: readonly AnimationIKJointLimit[];
  /** Model-local bend direction target for a two-link limb. */
  pole?: Vec3;
  /** Desired effector orientation in model-root space, as a normalized quaternion. */
  orientation?: Vec4;
  orientationWeight?: number;
}
export interface AnimationIKState {
  id: string;
  effector: string;
  chain: readonly string[];
  target: Vec3;
  iterations: number;
  weight: number;
  maxAngle?: number;
  jointLimits?: readonly AnimationIKJointLimit[];
  pole?: Vec3;
  orientation?: Vec4;
  orientationWeight?: number;
}
export interface AnimationRootMotionDefinition {
  bone: string;
  /** Translation channels in the root bone's parent frame; defaults to X/Z. */
  axes?: readonly [boolean, boolean, boolean];
  rotation?: "none" | "yaw" | "full";
  /** apply moves a non-physical root or character through the engine; extract leaves movement to game code. */
  mode?: "extract" | "apply";
}
/** Post-physics body adjustment and planted multi-chain IK in world-space Y-up gravity. */
export interface AnimationGroundingDefinition {
  body: string;
  /** Existing IK chain IDs, normally feet. */
  chains: readonly string[];
  probeUp?: number;
  probeDown?: number;
  soleOffset?: number;
  maxBodyOffset?: number;
  response?: number;
  /** Maximum horizontal separation at which a stance anchor remains planted. */
  plantDistance?: number;
  minGroundNormalY?: number;
}
export interface AnimationGroundingState {
  definition: Required<AnimationGroundingDefinition>;
  bodyOffset: number;
  feet: readonly { chain: string; target: Vec3; normal: Vec3; support: string | null; localPoint?: Vec3; localNormal?: Vec3 }[];
}
export interface AnimationMotionFeedback { requested: Vec3; actual: Vec3; strideScale: number }
export interface AnimationRootMotionDelta { translation: Vec3; rotation: Vec4 }
export interface AnimationRootMotionState {
  bone: string;
  axes: readonly [boolean, boolean, boolean];
  rotation: "none" | "yaw" | "full";
  mode: "extract" | "apply";
  pending: AnimationRootMotionDelta;
}
export interface AnimationRetargetDefinition {
  /** New clip name on the target model. Authored clips cannot be replaced. */
  name: string;
  sourceAsset: string;
  sourceClip: string;
  /** Explicit target-bone to source-bone mapping. */
  bones: Readonly<Record<string, string>>;
  /** Source hip bone; its mapped target receives scaled translation. */
  hip: string;
  scale?: number;
  fps?: number;
}
/** Full model animation controls exposed by system contexts. */
export interface AnimationControlService extends AnimationService {
  setGrounding(entity: string, definition: AnimationGroundingDefinition | null): void;
  grounding(entity: string): AnimationGroundingState | null;
  motionFeedback(entity: string): AnimationMotionFeedback | null;
  setRootMotion(entity: string, definition: AnimationRootMotionDefinition | null): void;
  rootMotion(entity: string): AnimationRootMotionState | null;
  consumeRootMotion(entity: string): AnimationRootMotionDelta;
  retarget(entity: string, definition: AnimationRetargetDefinition): void;
  removeRetargetedClip(entity: string, name: string): void;
  retargetedClips(entity: string): readonly AnimationRetargetDefinition[];
  /** Play two complete clips together; weight is the second clip's contribution in [0,1]. */
  blend(entity: string, first: string, second: string, weight: number): void;
  /** Change the second clip's weight without restarting either clip. */
  setBlendWeight(entity: string, weight: number): void;
  /** Align the second blended clip to the first clip's normalized time without changing speed or weights. */
  synchronizeBlend(entity: string): void;
  /** List uniquely named bones available for additive masks. */
  bones(entity: string): readonly string[];
  /** Play or replace a named additive bone-transform layer without stopping the base animation. */
  playAdditive(entity: string, id: string, clip: string, options?: AdditiveAnimationOptions): void;
  /** Set the weight of an existing additive layer in [0,1]. */
  setAdditiveWeight(entity: string, id: string, weight: number): void;
  /** Remove an additive layer and release its mixer resources. */
  stopAdditive(entity: string, id: string): void;
  /** Inspect the current additive layers, detached from the model. */
  additiveLayers(entity: string): readonly AdditiveAnimationState[];
  /** Create or replace a CCD inverse-kinematics chain. */
  setIK(entity: string, definition: AnimationIKDefinition): void;
  /** Change an IK target in model-root local coordinates. */
  setIKTarget(entity: string, id: string, target: Vec3): void;
  /** Remove a chain; remaining chains are reapplied over the unmodified animation pose. */
  removeIK(entity: string, id: string): void;
  /** Inspect active IK chains without exposing renderer objects. */
  ikChains(entity: string): readonly AnimationIKState[];
  /** Available model clips and their durations in seconds. */
  clips(entity: string): readonly { name: string; duration: number }[];
  /** Pause or resume all active clips and fades for this model; remains in effect across play calls. */
  pause(entity: string): void;
  resume(entity: string): void;
  /** Move the current clip to a local time in [0, duration] without changing pause state. */
  seek(entity: string, time: number): void;
  /** Change current clip playback speed; negative values reverse it, zero freezes clip time. */
  setSpeed(entity: string, speed: number): void;
}
export interface CinematicVectorKey { time: number; value: Vec3 }
export interface CinematicRotationKey { time: number; value: Vec4 }
export interface CinematicScalarKey { time: number; value: number }
export type CinematicTrack =
  | { kind: "transform"; entity: string; position?: readonly CinematicVectorKey[]; rotation?: readonly CinematicRotationKey[]; interpolation?: "linear" | "smooth" | "step" }
  | { kind: "camera"; position: readonly CinematicVectorKey[]; target: readonly CinematicVectorKey[]; interpolation?: "linear" | "smooth" | "step" }
  | { kind: "animation"; entity: string; clip: string; start: number; end: number; sourceStart?: number; speed?: number; loop?: boolean; /** Explicitly opt into an actor's configured apply-mode root motion. */ rootMotion?: boolean }
  | { kind: "audio"; sound: string; start: number; end: number; sourceStart?: number; rate?: number; volume?: number; loop?: boolean; entity?: string; bus?: string; priority?: number; occlusion?: boolean }
  | { kind: "subtitle"; start: number; end: number; text?: string; key?: string; variables?: LocalizationVariables; speaker?: string }
  | { kind: "transition"; opacity: readonly CinematicScalarKey[]; color?: string; interpolation?: "linear" | "smooth" | "step" };
export interface CinematicMarker { id: string; time: number; payload?: Readonly<Record<string, unknown>> }
export interface CinematicDefinition {
  id: string;
  duration: number;
  loop?: boolean;
  /** Hold keeps the final pose until stop(); restore releases control on the following fixed tick. */
  onFinish?: "hold" | "restore";
  tracks: readonly CinematicTrack[];
  markers?: readonly CinematicMarker[];
}
export interface CinematicState {
  id: string | null;
  time: number;
  cycle: number;
  speed: number;
  status: "idle" | "playing" | "paused" | "completed" | "failed";
  error: string | null;
}
export interface CinematicPresentation {
  subtitles: readonly { text: string; speaker: string | null }[];
  transition: { color: string; opacity: number };
}
/** One fixed-time director; starting a sequence releases the previous sequence's bindings. */
export interface CinematicService {
  define(definition: CinematicDefinition): void;
  undefine(id: string): void;
  list(): readonly string[];
  play(id: string, options?: { startAt?: number; speed?: number }): void;
  pause(): void;
  resume(): void;
  setSpeed(speed: number): void;
  /** Jumps sample poses/audio without locomotion or marker replay. Physical bindings are explicitly teleported. */
  seek(time: number): void;
  stop(options?: { restoreAnimation?: boolean; restoreCamera?: boolean; restoreTransforms?: boolean }): void;
  state(): CinematicState;
  presentation(): CinematicPresentation;
}
export interface CameraState {
  follow: Required<NonNullable<SceneInput["follow"]>> | null;
  pose: null | { position: Vec3; target: Vec3; transition?: { position: Vec3; target: Vec3; remaining: number } };
}
export interface CameraService {
  /** Detached control state; transition time is relative so a suspended camera can resume later. */
  state(): CameraState;
  /** Set a world-space manual pose, replacing follow mode and any transition. */
  setPose(position: Vec3, target: Vec3): void;
  /** Linearly transition from the current manual pose using fixed simulation time. */
  moveTo(position: Vec3, target: Vec3, duration: number): void;
  /** Return to the scene's authored camera pose. */
  reset(): void;
  follow(
    entity: string,
    options?: {
      distance?: number;
      height?: number;
      lookHeight?: number;
      yaw?: number;
      smoothing?: number;
    },
  ): void;
  orbit(yaw: number): void;
}
/** Detached runtime UI state. Dynamic elements carry a monotonically assigned generation. */
export interface UIElementState {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  text: string;
  value: number;
  visible: boolean;
  /** Missing means enabled, for compatibility with older states. */
  enabled?: boolean;
  ariaLabel?: string;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x: number; y: number; width: number; color: string;
  world?: { entity: string; offset: Vec3; occlude: boolean };
  generation?: number;
}
export interface UILayoutPatch {
  anchor?: UIElementState["anchor"];
  x?: number; y?: number; width?: number; color?: string;
}
export interface UIService {
  /** Create a dynamic element and return its generation; declared elements remain in game.ui. */
  create(definition: UIElementDefinition): number;
  /** Remove a dynamically created element; authored elements can be hidden instead. */
  remove(id: string): void;
  get(id: string): UIElementState;
  /** Atomically update layout properties. World labels use x/y as screen-pixel offsets. */
  setLayout(id: string, patch: UILayoutPatch): void;
  /** Bind text or button content to a localization key; setText removes the binding. */
  bindText(id: string, key: string, variables?: LocalizationVariables): void;
  /** Remove a localization binding, retaining its currently resolved text. */
  unbindText(id: string): void;
  setText(id: string, text: string): void;
  setProgress(id: string, value: number): void;
  setVisible(id: string, visible: boolean): void;
  /** Enable or disable a button or input without hiding it. */
  setEnabled(id: string, enabled: boolean): void;
  /** Set an accessible name, or clear it with null. */
  setAriaLabel(id: string, label: string | null): void;
}
/** Item stack rules; tags and label are game-defined, not localized automatically. */
export interface InventoryItemDefinition {
  id: string;
  maxStack?: number;
  label?: string;
  tags?: readonly string[];
}
export interface InventoryDefinition {
  id: string;
  /** Explicit grouping label, not an entity lifetime binding. */
  owner: string;
  capacity: number;
}
export interface InventorySlot { item: string; count: number }
export interface InventoryState {
  id: string;
  owner: string;
  slots: readonly (InventorySlot | null)[];
}
export interface EquipmentSlotDefinition { id: string; requiredTag?: string }
export interface EquipmentState {
  id: string; owner: string;
  slots: readonly { id: string; requiredTag?: string; item: string | null }[];
}
/** Deterministic bounded item containers; mutating operations are atomic on failure. */
export interface InventoryService {
  defineItem(definition: InventoryItemDefinition): void;
  getItem(id: string): Required<InventoryItemDefinition>;
  listItems(): readonly Required<InventoryItemDefinition>[];
  undefineItem(id: string): void;
  create(definition: InventoryDefinition): void;
  inspect(id: string): InventoryState;
  /** Counts all stacks of an item in one inventory. */
  count(id: string, item: string): number;
  add(id: string, item: string, count: number): void;
  remove(id: string, item: string, count: number): void;
  /** Transfers an entire requested amount or leaves both inventories unchanged. */
  transfer(from: string, to: string, item: string, count: number): void;
  /** Split, merge or swap slots; a swap requires the whole source stack. */
  moveSlot(id: string, from: number, to: number, count?: number): void;
  /** Define named equipment slots; optional requiredTag restricts compatible items. */
  createEquipment(id: string, owner: string, slots: readonly EquipmentSlotDefinition[]): void;
  inspectEquipment(id: string): EquipmentState;
  /** Move one item from an inventory into a slot; an existing item returns to that inventory atomically. */
  equip(equipment: string, slot: string, inventory: string, item: string): void;
  /** Move one equipped item back to an inventory belonging to the same owner. */
  unequip(equipment: string, slot: string, inventory: string): void;
  /** Empty all slots before destroying equipment. */
  destroyEquipment(id: string): void;
  destroy(id: string): void;
  destroyOwner(owner: string): void;
}
export interface QuestObjectiveDefinition {
  id: string;
  target: number;
  label?: string;
}
export interface QuestDefinition {
  id: string;
  title?: string;
  objectives: readonly QuestObjectiveDefinition[];
  /** Prerequisites are checked when starting; later resets do not cancel already-started quests. */
  prerequisites?: readonly string[];
  /** Completes when all objectives reach their targets; defaults to true. */
  autoComplete?: boolean;
}
export interface QuestState {
  id: string;
  title: string;
  status: "inactive" | "active" | "completed" | "failed";
  prerequisites: readonly string[];
  autoComplete: boolean;
  objectives: readonly { id: string; label: string; target: number; progress: number }[];
}
export interface QuestProgressUpdate { objective: string; amount: number }
/** Game-driven objective tracking. Rewards and event interpretation remain game rules. */
export interface QuestService {
  define(definition: QuestDefinition): void;
  start(id: string): void;
  advance(id: string, objective: string, amount?: number): void;
  /** Applies distinct objective increments as one operation. */
  advanceBatch(id: string, updates: readonly QuestProgressUpdate[]): void;
  complete(id: string): void;
  fail(id: string): void;
  /** Explicitly clears progress and returns this quest to inactive. */
  reset(id: string): void;
  inspect(id: string): QuestState;
  list(): readonly QuestState[];
}
export type DialogueVariable = string | number | boolean;
export interface DialogueChoiceDefinition {
  id: string;
  text: string;
  /** Omit or use null to end the session. */
  next?: string | null;
  /** Enabled only when the session variable exists and equals this value. */
  when?: { variable: string; equals: DialogueVariable };
}
export interface DialogueNodeDefinition {
  id: string;
  speaker?: string;
  text: string;
  /** Linear successor; cannot be combined with nonempty choices. */
  next?: string | null;
  choices?: readonly DialogueChoiceDefinition[];
}
export interface DialogueDefinition {
  id: string;
  start: string;
  nodes: readonly DialogueNodeDefinition[];
}
export interface DialogueSessionState {
  id: string;
  dialogue: string;
  status: "active" | "completed" | "cancelled";
  steps: number;
  variables: readonly { key: string; value: DialogueVariable }[];
  node: null | {
    id: string; speaker: string; text: string; next: string | null;
    choices: readonly { id: string; text: string; next: string | null; enabled: boolean }[];
  };
}
/** Branching text and session variables; game code owns UI and consequences. */
export interface DialogueService {
  define(definition: DialogueDefinition): void;
  undefine(id: string): void;
  start(session: string, dialogue: string): void;
  /** Set a session variable, or remove it with null. */
  setVariable(session: string, key: string, value: DialogueVariable | null): void;
  /** Advance a node without choices; a terminal node completes the session. */
  advance(session: string): void;
  choose(session: string, choice: string): void;
  cancel(session: string): void;
  close(session: string): void;
  inspect(session: string): DialogueSessionState;
  list(): readonly DialogueSessionState[];
}
export interface LocalizationPlural {
  zero?: string; one?: string; two?: string; few?: string; many?: string; other: string;
}
export type LocalizationMessage = string | LocalizationPlural;
export type LocalizationVariables = Readonly<Record<string, string | number | boolean>>;
/** Explicit game-authored translations; no automatic translation or platform account. */
export interface LocalizationService {
  define(locale: string, messages: Readonly<Record<string, LocalizationMessage>>): void;
  remove(locale: string): void;
  setLocale(locale: string | null): void;
  setFallback(locale: string | null): void;
  /** Plural messages require a finite numeric `count` variable. */
  text(key: string, variables?: LocalizationVariables): string;
  /** Format a finite number using the active locale's Intl implementation. */
  number(value: number): string;
  inspect(): { locale: string | null; fallback: string | null; available: readonly string[] };
}
/** Global convolution reverb applied after the master mix. */
export interface AudioReverb { wet: number; decay: number; preDelay: number }
export interface AudioVoiceState {
  id: string; sound: string; volume: number; loop: boolean; entity: string | null;
  bus?: string; priority: number; paused: boolean; occlusion: boolean;
  maxDuration?: number;
  /** Source seconds, before loop wrapping. */
  position: number;
  playbackRate: number;
}
export interface AudioService {
  /** Optional occlusion uses a 3D physics ray between the listener and a live entity. */
  play(
    id: string,
    options?: { volume?: number; loop?: boolean; entity?: string; bus?: string; priority?: number; occlusion?: boolean; maxDuration?: number; offset?: number; playbackRate?: number },
  ): string;
  stop(voice: string): void;
  /** Pause/resume are idempotent; an unknown valid voice id is a no-op. Playback time follows fixed simulation ticks, even while audio is locked. */
  pause(voice: string): void;
  resume(voice: string): void;
  /** Change source time without resetting elapsed maxDuration accounting; unknown voices are a no-op. */
  seek(voice: string, position: number): void;
  /** Positive source-time multiplier in [0.01,16], preserving the current source position. */
  setPlaybackRate(voice: string, rate: number): void;
  /** Set one active voice's gain; an unknown valid voice ID is a no-op. */
  setVoiceVolume(voice: string, volume: number): void;
  /** Return detached logical state, or null when the voice is no longer present. */
  voice(voice: string): AudioVoiceState | null;
  volume(value: number): void;
  /** Set a declared bus gain, independently of master and voice gain. */
  busVolume(id: string, value: number): void;
  /** Fade a declared bus over fixed-tick seconds; busVolume or another fade replaces it. */
  fadeBus(id: string, target: number, duration: number): void;
  /** Replace global reverb settings; wet is 0..1, decay 0.1..4s, preDelay 0..0.2s. */
  setReverb(settings: AudioReverb): void;
}
export interface StorageService {
  save(slot: string): void;
  load(slot: string): void;
  status(): {
    state: "idle" | "saving" | "loading" | "saved" | "loaded" | "failed";
    slot: string | null;
    error: string | null;
  };
}
export interface SceneService {
  current(): string;
  load(id: string): void;
}
export interface ModelDefinition {
  /** Optional whole-model material override; omitted keeps the asset's original materials. */
  material?: MaterialDefinition | string;
  /** Replace all asset material slots with the given exact material name. Mutually exclusive with material. */
  materialSlots?: Record<string, MaterialDefinition | string>;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Enable lights embedded in the model; defaults to true. */
  embeddedLights?: boolean;
  /** Enable shadows for embedded lights; defaults to false. */
  embeddedLightShadows?: boolean;
  asset: AssetDefinition | string;
  scale?: number;
  offset?: Vec3;
  rotation?: Vec3;
  animation?: { clip: string; speed?: number; loop?: boolean };
}
export interface RigidBodyDefinition {
  type: "fixed" | "dynamic" | "kinematic";
  collider: {
    shape: "box" | "sphere" | "capsule";
    size?: Vec3;
    radius?: number;
    halfHeight?: number;
    offset?: Vec3;
  };
  mass?: number;
  friction?: number;
  restitution?: number;
  trigger?: boolean;
}
export interface CharacterDefinition {
  radius: number;
  height: number;
  speed: number;
  jumpSpeed?: number;
  /** Downward acceleration magnitude in world units/s^2; defaults to 9.81. Scene.gravity is a signed vector. */
  gravity?: number;
}
export interface UIElementDefinition {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  /** Input values are limited to 4096 UTF-16 code units. */
  text?: string;
  value?: number;
  visible?: boolean;
  /** Buttons and inputs default to enabled. */
  enabled?: boolean;
  /** Accessible name; input and progress controls fall back to their ID. */
  ariaLabel?: string;
  anchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x?: number;
  y?: number;
  width?: number;
  color?: string;
  world?: { entity: string; offset?: Vec3; occlude?: boolean };
}
export interface SoundDefinition {
  id: string;
  asset: AssetDefinition | string;
  volume?: number;
  loop?: boolean;
  bus?: string;
}
export interface AudioBusDefinition {
  id: string;
  volume?: number;
}
export const SYSTEM_PHASES = [
  "input",
  "prePhysics",
  "physics",
  "postPhysics",
  "update",
  "presentation",
] as const;
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] }
  | BufferGeometryInput;
/** Declarative triangle geometry. The engine copies and owns all GPU attributes.
 * At most 1,048,576 vertices and 3,145,728 indices; numbers must fit finite float32.
 * Normals are generated when omitted. UVs are required when using material maps.
 * Runtime attribute mutation is not exposed; authoring requires no Three.js import.
 */
export interface BufferGeometryInput {
  kind: "buffer";
  positions: readonly number[];
  normals?: readonly number[];
  uv?: readonly number[];
  indices?: readonly number[];
  /** Compute bounding box and sphere on creation. Defaults to true. */
  computeBounds?: boolean;
}
export const GRAPH_TYPES = ["float", "vec2", "vec3", "vec4", "bool"] as const;
export type GraphType = typeof GRAPH_TYPES[number];
export type GraphValue = number | boolean | Vec2 | Vec3 | Vec4;
export interface GraphParameter {
  name: string;
  type: GraphType;
  default: GraphValue;
}
export const GRAPH_INPUT_TYPES = {
  uv: "vec2", uv1: "vec2", positionWorld: "vec3", normalWorld: "vec3",
  viewDirectionWorld: "vec3", vertexColor: "vec4", index: "float",
  screenSize: "vec2", texelSize: "vec2",
  pixelCoord: "vec2", outputSize: "vec2",
  positionLocal: "vec3", normalLocal: "vec3", vertexIndex: "float", instanceIndex: "float",
} as const;
export type GraphInputName = keyof typeof GRAPH_INPUT_TYPES;
export const GRAPH_OPERATIONS = {
  unary: ["sin", "cos", "abs", "floor", "ceil", "fract", "negate", "saturate", "normalize", "length", "safeSqrt"] as const,
  binary: ["add", "subtract", "multiply", "safeDivide", "min", "max", "dot", "cross", "step", "lessThan", "lessEqual", "greaterThan", "greaterEqual", "equal", "and", "or"] as const,
  ternary: ["mix", "clamp", "smoothstep", "select"] as const,
} as const;
export type GraphNode =
  | { id: string; op: "float"; value: number }
  | { id: string; op: "bool"; value: boolean }
  | { id: string; op: "vec2"; value: Vec2 }
  | { id: string; op: "vec3"; value: Vec3 }
  | { id: string; op: "vec4"; value: Vec4 }
  | { id: string; op: "time" }
  | { id: string; op: "input"; name: GraphInputName }
  | { id: string; op: "parameter"; name: string }
  | { id: string; op: typeof GRAPH_OPERATIONS.unary[number] | "not"; inputs: readonly [string] }
  | { id: string; op: typeof GRAPH_OPERATIONS.binary[number]; inputs: readonly [string, string] }
  | { id: string; op: typeof GRAPH_OPERATIONS.ternary[number]; inputs: readonly [string, string, string] }
  | { id: string; op: "compose2"; inputs: readonly [string, string] }
  | { id: string; op: "compose3"; inputs: readonly [string, string, string] }
  | { id: string; op: "compose4"; inputs: readonly [string, string, string, string] }
  | { id: string; op: "swizzle"; inputs: readonly [string]; components: string }
  | { id: string; op: "sampleTexture"; inputs: readonly [string]; texture: AssetDefinition | string }
  | { id: string; op: "readBuffer"; inputs: readonly [string]; buffer: string }
  | { id: string; op: "sampleFrame"; inputs: readonly [string]; channel: string }
  | { id: string; op: "sampleHistory"; inputs: readonly [string]; channel: string };
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
  parameters?: readonly GraphParameter[];
}
export interface MaterialGraphs {
  baseColor?: Graph;
  emissive?: Graph;
  roughness?: Graph;
  metalness?: Graph;
  opacity?: Graph;
  /** Absolute, unsided world-space normal; engine applies material boundary orientation. */
  normalWorld?: Graph;
}
export interface VertexGraphs {
  /** Absolute object-local position after built-in morph, skin and instance transforms. */
  position?: Graph;
  /** Unsided object-local normal in the same domain; zero keeps the normalized input normal. */
  normal?: Graph;
}
export interface MaterialInput {
  id: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  texture?: AssetDefinition | string;
  /** Tangent-space normal texture asset; sampled as linear data. */
  normalMap?: AssetDefinition | string;
  /** Green channel, multiplied by roughness; sampled as linear data. */
  roughnessMap?: AssetDefinition | string;
  /** Blue channel, multiplied by metalness; sampled as linear data. */
  metalnessMap?: AssetDefinition | string;
  /** Red channel ambient occlusion on the primary UVs; sampled as linear data. */
  aoMap?: AssetDefinition | string;
  /** Color texture, using the asset's declared color space (sRGB by default). */
  emissiveMap?: AssetDefinition | string;
  /** Tangent-space normal XY multipliers. Defaults to [1, 1]. */
  normalScale?: Vec2;
  graph?: Graph;
  graphs?: MaterialGraphs;
  vertex?: VertexGraphs;
  buffers?: readonly MaterialBufferInput[];
  textures?: readonly MaterialTextureInput[];
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  /** Enable alpha blending even when opacity is 1, for example for transparent texture pixels. */
  transparent?: boolean;
  alphaTest?: number;
  side?: "front" | "back" | "double";
  /** Closed-volume dielectric fraction; opacity remains independent stochastic coverage. */
  transmission?: number;
  ior?: number;
  /** Nontransmissive dielectric specular strength in [0,1]. Defaults to 1. */
  specularIntensity?: number;
  /** Nontransmissive dielectric specular color, a hex or named sRGB color. Defaults to white. */
  specularColor?: string;
  attenuationColor?: string;
  /** World-space distance for Beer absorption; omitted means no absorption. */
  attenuationDistance?: number;
}
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
export interface PostProcessInput {
  id: string;
  buffers?: readonly MaterialBufferInput[];
  textures?: readonly MaterialTextureInput[];
  /** Linear HDR vec4 output. Frame channels: scene.color, scene.normal, scene.depth, or an earlier pass ID. */
  graph: Graph;
  enabled?: boolean;
}
export interface PostProcessDefinition extends PostProcessInput {
  readonly kind: "postprocess";
}
export interface ComputeInput {
  id: string;
  graph: Graph;
  outputType: GraphType;
  count: number;
  workgroupSize?: number;
  buffers?: readonly { name: string; type: GraphType }[];
  textures?: readonly ComputeTextureBinding[];
}
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
export interface AssetInput {
  id: string;
  path: string;
  type: "texture" | "binary" | "model" | "audio";
  source?: string;
  license?: string;
  attribution?: string;
  /** Texture imports only; defaults to sRGB color. Data/normal/ORM textures use linear. */
  colorSpace?: "srgb" | "linear";
}
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
export interface LightDefinition {
  kind: "directional" | "point" | "spot";
  color?: string;
  intensity?: number;
  castShadow?: boolean;
  target?: Vec3;
  /** Spot cone half-angle in radians, greater than zero and at most PI / 2. */
  angle?: number;
  /** Spot cone edge softness from 0 to 1. */
  penumbra?: number;
  /** Point/spot cutoff distance; 0 means unlimited. */
  distance?: number;
  /** Point/spot distance decay exponent; defaults to 2. */
  decay?: number;
  shadow?: {
    mapSize?: number;
    extent?: number;
    bias?: number;
    normalBias?: number;
    near?: number;
    far?: number;
  };
}
/** Runtime overrides for an entity's declared light. Colors use linear RGB. */
export interface LightPatch { intensity?: number; color?: Vec3; target?: Vec3; visible?: boolean }
export interface LightOverride extends LightPatch { entity: string }
export interface LightService {
  /** Merge a patch into a live entity's declared light overrides. */
  set(entity: string, patch: LightPatch): void;
  /** Remove overrides, restoring the authored light values. */
  reset(entity: string): void;
  /** Detached active overrides for renderer integration. */
  visuals(): readonly LightOverride[];
}
export interface EntityInput {
  id: string;
  prefab?: PrefabDefinition | string;
  parent?: string;
  transform?: TransformPatch;
  mesh?: MeshDefinition;
  light?: LightDefinition;
  model?: ModelDefinition;
  rigidBody?: RigidBodyDefinition;
  character?: CharacterDefinition;
  components?: readonly ComponentInstance[];
}
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
export interface SceneInput {
  id: string;
  camera?: {
    position: Vec3;
    target: Vec3;
    /** Perspective by default. Orthographic tracing and per-ray media are development-stage and unverified. */
    projection?: "perspective" | "orthographic";
    /** Orthographic vertical span in world units; defaults to 10. */
    orthographicSize?: number;
    fov?: number;
    near?: number;
    far?: number;
  };
  environment?: {
    background?: string;
    /** Optional equirectangular panorama used as the visible background, not scene lighting. */
    backgroundTexture?: AssetDefinition | string;
    /** Panorama rotation around the vertical axis in radians; defaults to 0. */
    backgroundRotation?: number;
    /** Panorama brightness multiplier; defaults to 1. */
    backgroundIntensity?: number;
    /** Equirectangular texture used for image-based lighting; mutually exclusive with lighting presets. */
    lightingTexture?: AssetDefinition | string;
    /** Image-based lighting rotation around the vertical axis in radians; defaults to 0. */
    lightingRotation?: number;
    /** Image-based lighting intensity multiplier; defaults to 1. */
    lightingIntensity?: number;
    ambientIntensity?: number;
    lighting?: "none" | "studio";
  };
  follow?: {
    entity: string;
    distance?: number;
    height?: number;
    lookHeight?: number;
    yaw?: number;
    smoothing?: number;
  };
  gravity?: Vec3;
  /** Opt into the independent XY physics world; default gravity is [0,-9.81]. */
  physics2d?: { gravity?: Vec2 };
  entities: readonly EntityInput[];
}
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
export interface SystemInput {
  id: string;
  phase?: SystemPhase;
  before?: readonly string[];
  after?: readonly string[];
  reads?: readonly string[];
  writes?: readonly string[];
  structural?: boolean;
  run: (engine: SystemContext, dt: number) => void;
}
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
/** Build-visible scheduling contract; runtime.create supplies its run function by ID. */
export type SystemMetadata = Omit<SystemDefinition, "run"> & { run?: SystemInput["run"] };
export interface GameRuntimeScope {
  readonly engine: EngineFacade;
  readonly signal: AbortSignal;
  /** Synchronous cleanup, invoked once in reverse registration order, including failed initialization. */
  defer(release: () => void): void;
  /** Transfer ownership of a disposable resource to this instance and return it unchanged. */
  own<T extends { dispose(): void }>(resource: T): T;
}
export interface GameRuntimeState {
  systems?: Readonly<Record<string, SystemInput["run"]>>;
  /** Finite JSON; same bounded data contract as component JSON fields. Supply all three state hooks together. */
  snapshot?(): JsonValue;
  /** Throw on invalid data. Validation must be synchronous and must not mutate state. */
  validateSnapshot?(value: JsonValue): void;
  restore?(value: JsonValue): void;
  dispose?(): void;
}
export interface GameRuntimeDefinition {
  /** Author-owned save schema version. Incompatible versions require an explicit migration outside restore. */
  version: string;
  /** Called once per instance, never by content construction. Put browser-only imports/initialization here. */
  create(scope: GameRuntimeScope): GameRuntimeState | void | Promise<GameRuntimeState | void>;
}
export interface GameRuntimeSnapshot {
  format: "pelican.game-runtime";
  version: 1;
  game: string;
  runtimeVersion: string;
  payload: JsonValue;
}
export interface GameInput {
  id: string;
  scene: SceneDefinition;
  /** auto preserves synchronous physics for authored code; disabled keeps empty queries without loading the 3D backend. */
  services?: { readonly physics3d?: "auto" | "required" | "disabled" };
  systems?: readonly SystemMetadata[];
  runtime?: GameRuntimeDefinition;
  /** Composable managed rendering resources and per-instance runtime setup. */
  extensions?: readonly RenderExtensionDefinition[];
  components?: readonly ComponentDefinition[];
  prefabs?: readonly PrefabDefinition[];
  materials?: readonly MaterialDefinition[];
  computes?: readonly ComputeDefinition[];
  computeBuffers?: readonly ComputeBufferInput[];
  computeTextures?: readonly ComputeTextureInput[];
  assets?: readonly AssetDefinition[];
  scenes?: readonly SceneDefinition[];
  input?: Readonly<Record<string, readonly string[]>>;
  ui?: readonly UIElementDefinition[];
  sounds?: readonly SoundDefinition[];
  audioBuses?: readonly AudioBusDefinition[];
  render?: Partial<RenderSettings>;
  postProcesses?: readonly PostProcessDefinition[];
}
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
/** Versioned integration contract. Resources use the same IDs, graphs, ownership and diagnostics as ordinary SDK declarations. */
export interface RenderExtensionDefinition {
  readonly kind: "render-extension";
  readonly apiVersion: 1;
  id: string;
  version: string;
  systems?: readonly SystemMetadata[];
  materials?: readonly MaterialDefinition[];
  assets?: readonly AssetDefinition[];
  computes?: readonly ComputeDefinition[];
  postProcesses?: readonly PostProcessDefinition[];
  computeBuffers?: readonly ComputeBufferInput[];
  computeTextures?: readonly ComputeTextureInput[];
  create?: GameRuntimeDefinition["create"];
}
export interface GameInstance {
  /** Legacy hand-written instances may omit readiness. Compiled instances always supply it. */
  readonly ready?: Promise<void>;
  readonly status?: "initializing" | "ready" | "failed" | "disposed";
  snapshot?(): GameRuntimeSnapshot | undefined;
  validateSnapshot?(value: unknown): void;
  restore?(value: unknown): void;
  update(dt: number): void;
  dispose(): void;
}
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S> {
  return { ...input, kind: "component" };
}
export function defineMaterial(input: MaterialInput): MaterialDefinition {
  return { ...input, kind: "material" };
}
export function definePostProcess(input: PostProcessInput): PostProcessDefinition {
  return { ...input, kind: "postprocess" };
}
export function defineCompute(input: ComputeInput): ComputeDefinition {
  return { ...input, kind: "compute" };
}
export function defineAsset(input: AssetInput): AssetDefinition {
  return { ...input, kind: "asset" };
}
export function definePrefab(input: PrefabInput): PrefabDefinition {
  return { ...input, kind: "prefab" };
}
export function defineScene(input: SceneInput): SceneDefinition {
  return { ...input, kind: "scene" };
}
export function defineSystem<T extends Omit<SystemInput, "run"> & { run?: SystemInput["run"] }>(input: T): T & { readonly kind: "system" } {
  return { ...input, kind: "system" };
}
export function defineGame(input: GameInput): GameDefinition {
  return { ...expandRenderExtensions(input), kind: "game" };
}
/** Use ordinary npm modules to export reusable rendering packages without taking private GPU ownership. */
export function defineRenderExtension(input: Omit<RenderExtensionDefinition, "kind" | "apiVersion">): RenderExtensionDefinition {
  return { ...input, kind: "render-extension", apiVersion: 1 };
}
/** Runtime wrapper used by compiled game.js. Construction is extracted statically or evaluated in an owned compiler process. */
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance {
  return createGameInstance(game, engine);
}
