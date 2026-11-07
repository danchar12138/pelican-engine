# pelican 0.9.0 API 索引

由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。

## SDK_VERSION

来源：`packages/sdk/src/index.ts:2`

```ts
SDK_VERSION = "0.9.0"
```

## Vec2

来源：`packages/sdk/src/index.ts:3`

```ts
export type Vec2 = readonly [number, number];
```

## Vec3

来源：`packages/sdk/src/index.ts:4`

```ts
export type Vec3 = readonly [number, number, number];
```

## Vec4

来源：`packages/sdk/src/index.ts:5`

```ts
export type Vec4 = readonly [number, number, number, number];
```

## Transform

来源：`packages/sdk/src/index.ts:6`

```ts
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
```

## TransformPatch

来源：`packages/sdk/src/index.ts:11`

```ts
export type TransformPatch = Partial<Transform>;
```

## Field

来源：`packages/sdk/src/index.ts:12`

```ts
export type Field =
  | { type: "number"; default: number }
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string }
  | { type: "vec3"; default: Vec3 };
```

## ComponentSchema

来源：`packages/sdk/src/index.ts:17`

```ts
export type ComponentSchema = Readonly<Record<string, Field>>;
```

## ComponentDefinition

来源：`packages/sdk/src/index.ts:18`

```ts
export interface ComponentDefinition<
  S extends ComponentSchema = ComponentSchema,
> {
  readonly kind: "component";
  readonly id: string;
  readonly schema: S;
}
```

## ComponentValue

来源：`packages/sdk/src/index.ts:25`

```ts
export type ComponentValue<S extends ComponentSchema> = {
  -readonly [K in keyof S]: S[K]["type"] extends "number"
    ? number
    : S[K]["type"] extends "boolean"
      ? boolean
      : S[K]["type"] extends "vec3"
        ? Vec3
        : string;
};
```

## ComponentData

来源：`packages/sdk/src/index.ts:34`

```ts
export type ComponentData = Record<string, number | boolean | string | Vec3>;
```

## ComponentInstance

来源：`packages/sdk/src/index.ts:35`

```ts
export interface ComponentInstance {
  component: ComponentDefinition | string;
  value?: ComponentData;
}
```

## EngineFacade

来源：`packages/sdk/src/index.ts:39`

```ts
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
  configureGameSystems?(systems: readonly SystemDefinition[]): void;
}
```

## EntityHandle

来源：`packages/sdk/src/index.ts:58`

```ts
export interface EntityHandle {
  readonly world: number;
  readonly index: number;
  readonly generation: number;
}
```

## EntityRef

来源：`packages/sdk/src/index.ts:63`

```ts
export type EntityRef = string | EntityHandle;
```

## SpawnInput

来源：`packages/sdk/src/index.ts:64`

```ts
export interface SpawnInput {
  id: string;
  prefab?: string;
  parent?: string;
  transform?: TransformPatch;
  components?: Record<string, ComponentData>;
}
```

## EntityCommands

来源：`packages/sdk/src/index.ts:71`

```ts
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
```

## GameEvent

来源：`packages/sdk/src/index.ts:92`

```ts
export interface GameEvent {
  readonly type: string;
  readonly tick: number;
  readonly sequence: number;
  readonly payload: unknown;
}
```

## SystemContext

来源：`packages/sdk/src/index.ts:98`

```ts
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
```

## Physics2DCollider

来源：`packages/sdk/src/index.ts:134`

```ts
export type Physics2DCollider =
  | { shape: "box"; halfExtents: Vec2; offset?: Vec2 }
  | { shape: "circle"; radius: number; offset?: Vec2 }
  /** Capsule aligned to local Y; halfHeight excludes the rounded caps. */
  | { shape: "capsule"; halfHeight: number; radius: number; offset?: Vec2 }
  /** Fixed bodies only; an empty list represents no collider. */
  | { shape: "compound"; parts: readonly { halfExtents: Vec2; offset: Vec2 }[] };
```

## Physics2DBodyDefinition

来源：`packages/sdk/src/index.ts:141`

```ts
export interface Physics2DBodyDefinition {
  id: string; entity: string; type: "fixed" | "dynamic" | "kinematic";
  collider: Physics2DCollider;
  mass?: number; friction?: number; restitution?: number;
  sensor?: boolean; continuous?: boolean;
}
```

## Physics2DBodyState

来源：`packages/sdk/src/index.ts:147`

```ts
export interface Physics2DBodyState {
  id: string; entity: string; type: Physics2DBodyDefinition["type"];
  position: Vec2; angle: number; velocity: Vec2; angularVelocity: number; sleeping: boolean;
}
```

## Physics2DCharacterOptions

来源：`packages/sdk/src/index.ts:151`

```ts
export interface Physics2DCharacterOptions {
  /** Positive separation from obstacles; defaults to 0.01 world units. */
  offset?: number;
  /** Optional downward snap distance; defaults to disabled. */
  snapToGround?: number;
  /** Maximum climbable slope angle in radians; defaults to π/4. */
  maxSlope?: number;
}
```

## Physics2DCharacterState

来源：`packages/sdk/src/index.ts:159`

```ts
export interface Physics2DCharacterState {
  body: string;
  requested: Vec2;
  movement: Vec2;
  grounded: boolean;
  /** Movement is deferred until physics query structures are current. */
  deferred: boolean;
}
```

## Physics2DJointBase

来源：`packages/sdk/src/index.ts:167`

```ts
export interface Physics2DJointBase {
  id: string; bodyA: string; bodyB: string;
  /** Anchor coordinates are local to each body. */
  anchorA?: Vec2; anchorB?: Vec2;
  /** Defaults to false for connected-body contacts. */
  contactsEnabled?: boolean;
}
```

## Physics2DJointDefinition

来源：`packages/sdk/src/index.ts:174`

```ts
export type Physics2DJointDefinition = Physics2DJointBase & (
  | { kind: "fixed"; frameA?: number; frameB?: number }
  | { kind: "revolute" }
  | { kind: "rope"; length: number }
  | { kind: "spring"; restLength: number; stiffness: number; damping: number }
);
```

## Physics2DService

来源：`packages/sdk/src/index.ts:181`

```ts
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
}
```

## SpriteAnimation

来源：`packages/sdk/src/index.ts:207`

```ts
export interface SpriteAnimation {
  first: number;
  last: number;
  /** Atlas frames per second, greater than zero and at most 240. */
  fps: number;
  loop?: boolean;
}
```

## SpriteDefinition

来源：`packages/sdk/src/index.ts:214`

```ts
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
```

## SpriteState

来源：`packages/sdk/src/index.ts:230`

```ts
export interface SpriteState {
  id: string; entity: string; material: string;
  size: Vec2; offset: Vec2; columns: number; rows: number;
  frame: number; playing: boolean; completed: boolean;
  castShadow: boolean; receiveShadow: boolean;
  animation: (SpriteAnimation & { loop: boolean }) | null;
}
```

## SpriteService

来源：`packages/sdk/src/index.ts:237`

```ts
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
```

## TilemapAnimation

来源：`packages/sdk/src/index.ts:250`

```ts
export interface TilemapAnimation { tile: number; frames: readonly number[]; fps: number }
```

## TilemapDefinition

来源：`packages/sdk/src/index.ts:251`

```ts
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
```

## TilemapUpdate

来源：`packages/sdk/src/index.ts:262`

```ts
export interface TilemapUpdate { x: number; y: number; frame: number | null }
```

## TilemapNavigationOptions

来源：`packages/sdk/src/index.ts:264`

```ts
export interface TilemapNavigationOptions {
  origin?: NavigationCell;
  blockedFrames: readonly number[];
  emptyBlocked?: boolean;
}
```

## TilemapPhysics2DOptions

来源：`packages/sdk/src/index.ts:269`

```ts
export interface TilemapPhysics2DOptions {
  solidFrames: readonly number[];
  emptySolid?: boolean;
}
```

## TilemapState

来源：`packages/sdk/src/index.ts:273`

```ts
export interface TilemapState {
  id: string; entity: string; material: string; width: number; height: number;
  tileSize: Vec2; offset: Vec2; columns: number; rows: number;
  castShadow: boolean; receiveShadow: boolean; cells: readonly (number | null)[];
  animations: readonly (TilemapAnimation & { phase: number })[];
}
```

## TilemapVisualState

来源：`packages/sdk/src/index.ts:280`

```ts
export interface TilemapVisualState extends Omit<TilemapState, "cells"> {
  token: number;
  chunks: readonly { x: number; y: number; revision: number }[];
}
```

## TilemapChunkState

来源：`packages/sdk/src/index.ts:284`

```ts
export interface TilemapChunkState {
  x: number; y: number; width: number; height: number; revision: number;
  cells: readonly (number | null)[];
}
```

## TilemapService

来源：`packages/sdk/src/index.ts:288`

```ts
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
  inspect(id: string): TilemapState;
  visuals(): readonly TilemapVisualState[];
  /** Read one 32×32 presentation chunk, including its current revision. */
  readChunk(id: string, x: number, y: number): TilemapChunkState;
  destroy(id: string): void;
}
```

## RopeCollider

来源：`packages/sdk/src/index.ts:312`

```ts
export type RopeCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number };
```

## RopeBodyCollider

来源：`packages/sdk/src/index.ts:316`

```ts
export interface RopeBodyCollider { readonly id: string; readonly entity: string }
```

## RopeVisualOptions

来源：`packages/sdk/src/index.ts:318`

```ts
export interface RopeVisualOptions {
  material: string;
  radius?: number;
  radialSegments?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## RopeVisualState

来源：`packages/sdk/src/index.ts:326`

```ts
export interface RopeVisualState {
  id: string;
  material: string;
  radius: number;
  radialSegments: number;
  castShadow: boolean;
  receiveShadow: boolean;
  positions: Vec3[];
}
```

## RopeDefinition

来源：`packages/sdk/src/index.ts:335`

```ts
export interface RopeDefinition {
  id: string;
  points: readonly Vec3[];
  /** Kilograms per particle, positive and at most 1e6. */
  mass: number;
  radius?: number;
  /** Defaults to the host interval; an explicit value must exactly match it. */
  fixedDt?: number;
  /** When true, step once after each physics phase; defaults to false (manual stepping). */
  autoStep?: boolean;
  /** Automatically sample and react to existing dynamic, non-trigger sphere bodies. Requires autoStep. */
  bodyColliders?: readonly RopeBodyCollider[];
  /** Resolve sphere contacts on segment interiors; defaults to true for new ropes. */
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
```

## RopeContact

来源：`packages/sdk/src/index.ts:360`

```ts
export interface RopeContact {
  tick: number; particle: number; colliderId: string; penetration: number;
  /** Opposite of particle contact impulses, N·s; absent in older snapshots. */
  reactionImpulse?: Vec3;
  /** Angular impulse about the world origin; absent in older snapshots. */
  reactionAngularImpulse?: Vec3;
}
```

## RopeSegmentContact

来源：`packages/sdk/src/index.ts:368`

```ts
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
```

## RopeSelfContact

来源：`packages/sdk/src/index.ts:380`

```ts
export interface RopeSelfContact {
  tick: number;
  /** Zero-based first endpoint of each non-adjacent segment, ordered ascending. */
  firstSegment: number; secondSegment: number;
  /** Last closest-point fractions along the respective segments. */
  firstFraction: number; secondFraction: number;
  /** Maximum observed overlap in metres during this tick. */
  penetration: number;
}
```

## RopeState

来源：`packages/sdk/src/index.ts:389`

```ts
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
```

## IndexedParticleImpulse

来源：`packages/sdk/src/index.ts:403`

```ts
export interface IndexedParticleImpulse { index: number; impulse: Vec3 }
```

## IndexedParticleHit

来源：`packages/sdk/src/index.ts:405`

```ts
export interface IndexedParticleHit { index: number; position: Vec3; distance: number }
```

## ParticleAnchor

来源：`packages/sdk/src/index.ts:407`

```ts
export interface ParticleAnchor { index: number; position: Vec3 }
```

## RopeService

来源：`packages/sdk/src/index.ts:408`

```ts
export interface RopeService {
  create(definition: RopeDefinition): void;
  /** Explicit ticks for manual ropes only. Auto-stepped ropes reject this call. A failed batch leaves the rope unchanged. */
  step(id: string, ticks?: number): RopeState;
  inspect(id: string): RopeState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): IndexedParticleHit | null;
  /** Detached visual descriptions, sorted by rope id; empty when no visuals are requested. */
  visuals(): readonly RopeVisualState[];
  setColliders(id: string, colliders: readonly RopeCollider[]): void;
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
```

## ClothCollider

来源：`packages/sdk/src/index.ts:431`

```ts
export type ClothCollider = RopeCollider;
```

## ClothTriangle

来源：`packages/sdk/src/index.ts:432`

```ts
export type ClothTriangle = readonly [number, number, number];
```

## ClothVisualOptions

来源：`packages/sdk/src/index.ts:433`

```ts
export interface ClothVisualOptions {
  material: string;
  /** Optional per-particle UV coordinates; defaults to a planar projection. */
  uvs?: readonly Vec2[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## ClothBodyCollider

来源：`packages/sdk/src/index.ts:440`

```ts
export interface ClothBodyCollider { readonly id: string; readonly entity: string }
```

## ClothDefinition

来源：`packages/sdk/src/index.ts:441`

```ts
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
  /** Sphere triangle-surface contacts; defaults to true for new cloth. */
  surfaceCollisions?: boolean;
  /** Optional live dynamic sphere bindings; sampled after the physics phase. */
  bodyColliders?: readonly ClothBodyCollider[];
  /** When true, detected contacts submit approximate reaction impulses to bound bodies. */
  bodyReactions?: boolean;
}
```

## ClothContact

来源：`packages/sdk/src/index.ts:467`

```ts
export interface ClothContact { tick: number; particle: number; colliderId: string; penetration: number; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
```

## ClothSelfContact

来源：`packages/sdk/src/index.ts:468`

```ts
export interface ClothSelfContact { tick: number; firstParticle: number; secondParticle: number; penetration: number }
```

## ClothSurfaceContact

来源：`packages/sdk/src/index.ts:469`

```ts
export interface ClothSurfaceContact { tick: number; triangle: number; colliderId: string; penetration: number; barycentric: [number, number, number]; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
```

## ClothState

来源：`packages/sdk/src/index.ts:470`

```ts
export interface ClothState {
  tick: number; simulatedSeconds: number; disposed: boolean; selfCollisions: boolean; surfaceCollisions: boolean;
  gravity: Vec3;
  positions: Vec3[]; velocities: Vec3[]; triangles: ClothTriangle[];
  anchors: { index: number; position: Vec3 }[];
  contacts: ClothContact[]; selfContacts: ClothSelfContact[]; surfaceContacts: ClothSurfaceContact[];
  maxDistanceError: number;
  resources: { particles: number; triangles: number; constraints: number; anchors: number; colliders: number };
}
```

## ClothVisualState

来源：`packages/sdk/src/index.ts:479`

```ts
export interface ClothVisualState {
  id: string; material: string; positions: Vec3[]; triangles: ClothTriangle[];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
```

## ClothService

来源：`packages/sdk/src/index.ts:483`

```ts
export interface ClothService {
  create(definition: ClothDefinition): void;
  /** Explicit ticks for manual cloth only; automatic cloth rejects this call. */
  step(id: string, ticks?: number): ClothState;
  inspect(id: string): ClothState;
  /** Find the nearest centre within maxDistance, or null; ties use particle order. */
  nearestParticle(id: string, position: Vec3, maxDistance: number): IndexedParticleHit | null;
  visuals(): readonly ClothVisualState[];
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
```

## FluidVisualOptions

来源：`packages/sdk/src/index.ts:505`

```ts
export interface FluidVisualOptions { material: string; radius?: number; castShadow?: boolean; receiveShadow?: boolean }
```

## FluidBodyCollider

来源：`packages/sdk/src/index.ts:506`

```ts
export interface FluidBodyCollider { readonly id: string; readonly entity: string }
```

## SimulationContainer

来源：`packages/sdk/src/index.ts:508`

```ts
export interface SimulationContainer { min: Vec3; max: Vec3 }
```

## FluidDefinition

来源：`packages/sdk/src/index.ts:509`

```ts
export interface FluidDefinition {
  id: string; autoStep?: boolean; seed?: number; fixedDt?: number; substeps?: number; iterations?: number;
  /** Initial lattice dimensions, each an integer in [1,8]; defaults to [4,4,4]. */
  particleGrid?: readonly [number, number, number];
  /** Translates the reference particles and container in world space. */
  origin?: Vec3;
  container?: SimulationContainer;
  contacts?: boolean; twoWayCoupling?: boolean; gravity?: Vec3; bodyPosition?: Vec3; bodyVelocity?: Vec3;
  visual?: FluidVisualOptions;
  bodyColliders?: readonly FluidBodyCollider[];
  bodyReactions?: boolean;
}
```

## FluidParticle

来源：`packages/sdk/src/index.ts:521`

```ts
export interface FluidParticle { id: string; position: Vec3; radius: number }
```

## FluidState

来源：`packages/sdk/src/index.ts:522`

```ts
export interface FluidState {
  tick: number; simulatedSeconds: number; disposed: boolean; particles: FluidParticle[]; bodies: FluidParticle[];
  /** Velocities in metres per second, aligned with particles. */
  velocities: Vec3[];
  gravity: Vec3;
  contacts: { contactCount: number; reactionImpulse: Vec3; absoluteReactionImpulse: number; maxContactCorrection: number; maxObservedSpeed: number };
  fluid: { method: "WCSPH"; restDensity: number; minDensity: number; maxDensity: number; maxPressure: number } | null;
  resources: { particles: number; bodies: number };
}
```

## FluidVisualState

来源：`packages/sdk/src/index.ts:531`

```ts
export interface FluidVisualState {
  id: string; material: string; particles: FluidParticle[]; castShadow: boolean; receiveShadow: boolean;
}
```

## SimulationImpulse

来源：`packages/sdk/src/index.ts:535`

```ts
export interface SimulationImpulse { particle: string; impulse: Vec3 }
```

## SimulationForce

来源：`packages/sdk/src/index.ts:537`

```ts
export interface SimulationForce { particle: string; force: Vec3 }
```

## ParticleSimulationCollider

来源：`packages/sdk/src/index.ts:539`

```ts
export type ParticleSimulationCollider = RopeCollider | { kind: "box"; id: string; center: Vec3; halfExtents: Vec3 };
```

## SimulationParticleHit

来源：`packages/sdk/src/index.ts:541`

```ts
export interface SimulationParticleHit { particle: string; position: Vec3; distance: number }
```

## FluidService

来源：`packages/sdk/src/index.ts:542`

```ts
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
```

## SoftBodyVisualOptions

来源：`packages/sdk/src/index.ts:563`

```ts
export interface SoftBodyVisualOptions { material: string; castShadow?: boolean; receiveShadow?: boolean }
```

## SoftBodyBodyCollider

来源：`packages/sdk/src/index.ts:564`

```ts
export interface SoftBodyBodyCollider { readonly id: string; readonly entity: string }
```

## SoftBodyDefinition

来源：`packages/sdk/src/index.ts:565`

```ts
export interface SoftBodyDefinition {
  id: string; autoStep?: boolean; seed?: number; fixedDt?: number; substeps?: number; iterations?: number;
  /** Initial tetrahedral lattice dimensions, each in [2,5]; defaults to [3,3,3]. */
  softBodyGrid?: readonly [number, number, number];
  /** Translates the reference particles and container in world space. */
  origin?: Vec3;
  container?: SimulationContainer;
  contacts?: boolean; twoWayCoupling?: boolean; gravity?: Vec3; bodyPosition?: Vec3; bodyVelocity?: Vec3;
  visual?: SoftBodyVisualOptions;
  bodyColliders?: readonly SoftBodyBodyCollider[];
  bodyReactions?: boolean;
}
```

## SoftBodyState

来源：`packages/sdk/src/index.ts:577`

```ts
export interface SoftBodyState {
  tick: number; simulatedSeconds: number; disposed: boolean;
  gravity: Vec3;
  positions: Vec3[]; triangles: [number, number, number][];
  /** Particle IDs aligned with positions. */
  particleIds: string[];
  /** Velocities in metres per second, aligned with positions and particleIds. */
  velocities: Vec3[];
  contacts: { contactCount: number; reactionImpulse: Vec3; absoluteReactionImpulse: number; maxContactCorrection: number; maxObservedSpeed: number };
  maxDistanceError: number; maxVolumeRelativeError: number; minSignedVolumeRatio: number | null;
  resources: { particles: number; bodies: number; constraints: number; triangles: number };
}
```

## SoftBodyVisualState

来源：`packages/sdk/src/index.ts:589`

```ts
export interface SoftBodyVisualState {
  id: string; material: string; positions: Vec3[]; triangles: [number, number, number][];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
```

## SoftBodyService

来源：`packages/sdk/src/index.ts:593`

```ts
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
```

## NavigationCell

来源：`packages/sdk/src/index.ts:616`

```ts
export interface NavigationCell { readonly x: number; readonly y: number }
```

## NavigationObstacleUpdate

来源：`packages/sdk/src/index.ts:618`

```ts
export interface NavigationObstacleUpdate { readonly cell: NavigationCell; readonly blocked: boolean }
```

## NavigationCostUpdate

来源：`packages/sdk/src/index.ts:620`

```ts
export interface NavigationCostUpdate { readonly cell: NavigationCell; readonly cost: number }
```

## NavigationGrid

来源：`packages/sdk/src/index.ts:621`

```ts
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
```

## NavigationPathOptions

来源：`packages/sdk/src/index.ts:632`

```ts
export interface NavigationPathOptions { readonly allowDiagonal?: boolean }
```

## NavigationAgentDefinition

来源：`packages/sdk/src/index.ts:634`

```ts
export interface NavigationAgentDefinition {
  id: string;
  entity: string;
  grid: string;
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
}
```

## NavigationAgentState

来源：`packages/sdk/src/index.ts:650`

```ts
export interface NavigationAgentState {
  id: string;
  entity: string;
  grid: string;
  plane: "xz" | "xy";
  rowDirection: "positive" | "negative";
  target: NavigationCell | null;
  /** Live root entity followed by this agent, if any. */
  followEntity?: string;
  status: "idle" | "planning" | "moving" | "arrived" | "blocked" | "missing";
  /** Stable diagnostic code when movement is blocked or the entity was removed. */
  error: string | null;
  path: readonly NavigationCell[];
  cursor: number;
}
```

## NavigationService

来源：`packages/sdk/src/index.ts:665`

```ts
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
```

## WorldStreamingOptions

来源：`packages/sdk/src/index.ts:691`

```ts
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
```

## WorldChunkDefinition

来源：`packages/sdk/src/index.ts:701`

```ts
export interface WorldChunkDefinition {
  x: number;
  z: number;
  /** Root entities with declared prefabs and absolute world-space transforms. */
  entities: readonly SpawnInput[];
}
```

## WorldStreamingService

来源：`packages/sdk/src/index.ts:707`

```ts
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
  /** Removes an inactive definition; loaded chunks must first move out of range. */
  removeChunk(x: number, z: number): void;
  inspect(): {
    focus: Vec3 | null;
    options: Required<WorldStreamingOptions>;
    chunks: readonly { x: number; z: number; active: boolean; entities: number }[];
  };
}
```

## RenderMode

来源：`packages/sdk/src/index.ts:730`

```ts
export type RenderMode = "raster" | "hybrid" | "path";
```

## RenderCapabilities

来源：`packages/sdk/src/index.ts:731`

```ts
export interface RenderCapabilities {
  backend: "webgpu" | "webgl2" | "uninitialized";
  compute: boolean;
  availableModes: readonly RenderMode[];
  /** Explanation when scene configuration further restricts render modes. */
  modeLimitation?: string;
}
```

## RenderSettings

来源：`packages/sdk/src/index.ts:738`

```ts
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
```

## RenderService

来源：`packages/sdk/src/index.ts:749`

```ts
export interface RenderService {
  configure(settings: Partial<RenderSettings>): void;
  state(): Readonly<RenderSettings>;
  capabilities(): Readonly<RenderCapabilities>;
  setMaterialParameter(material: string, name: string, value: GraphValue): void;
  materialParameters(material: string): Readonly<Record<string, GraphValue>>;
  readonly effects: PostProcessService;
  readonly buffers: RenderBufferBindings;
  readonly textures: RenderTextureBindings;
}
```

## MaterialBufferInput

来源：`packages/sdk/src/index.ts:759`

```ts
export interface MaterialBufferInput {
  /** Shared slot declaration for material and postprocess graphs. */
  name: string;
  type: GraphType;
  /** Optional initial logical compute-buffer ID. */
  buffer?: string;
  /** Optional exact element count required by this slot. */
  count?: number;
}
```

## RenderBufferReference

来源：`packages/sdk/src/index.ts:768`

```ts
export interface RenderBufferReference {
  id: string;
  type: GraphType;
  count: number;
}
```

## RenderBufferBindings

来源：`packages/sdk/src/index.ts:773`

```ts
export interface RenderBufferBindings {
  bind(target: string, name: string, buffer: ComputeBufferHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderBufferReference>>;
}
```

## MaterialTextureInput

来源：`packages/sdk/src/index.ts:778`

```ts
export interface MaterialTextureInput extends ComputeTextureBinding {
  /** Initial managed texture ID; asset import uses computeTextures/createTexture. */
  texture?: string;
  width?: number;
  height?: number;
}
```

## RenderTextureReference

来源：`packages/sdk/src/index.ts:784`

```ts
export interface RenderTextureReference extends ComputeTextureSize {
  id: string;
  format: "rgba32float";
}
```

## RenderTextureBindings

来源：`packages/sdk/src/index.ts:788`

```ts
export interface RenderTextureBindings {
  bind(target: string, name: string, texture: ComputeTextureHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderTextureReference>>;
}
```

## PostProcessState

来源：`packages/sdk/src/index.ts:793`

```ts
export interface PostProcessState {
  id: string;
  enabled: boolean;
  parameters: Readonly<Record<string, GraphValue>>;
}
```

## PostProcessService

来源：`packages/sdk/src/index.ts:798`

```ts
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
```

## ComputeBufferHandle

来源：`packages/sdk/src/index.ts:808`

```ts
export interface ComputeBufferHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
}
```

## ComputeTaskHandle

来源：`packages/sdk/src/index.ts:813`

```ts
export interface ComputeTaskHandle {
  readonly owner: number;
  readonly id: number;
}
```

## ComputeBufferInput

来源：`packages/sdk/src/index.ts:817`

```ts
export interface ComputeBufferInput {
  id: string;
  type: GraphType;
  count: number;
  data?: readonly GraphValue[];
}
```

## ComputeTextureHandle

来源：`packages/sdk/src/index.ts:823`

```ts
export interface ComputeTextureHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
  readonly kind: "texture";
}
```

## ComputeTextureSize

来源：`packages/sdk/src/index.ts:829`

```ts
export interface ComputeTextureSize {
  width: number;
  height: number;
}
```

## ComputeTextureDataInput

来源：`packages/sdk/src/index.ts:833`

```ts
export interface ComputeTextureDataInput extends ComputeTextureSize {
  id: string;
  /** Linear rgba32float texels in row-major order, without color-space conversion. */
  data?: readonly Vec4[];
  asset?: never;
}
```

## ComputeTextureAssetInput

来源：`packages/sdk/src/index.ts:839`

```ts
export interface ComputeTextureAssetInput {
  id: string;
  asset: AssetDefinition | string;
  width?: never;
  height?: never;
  data?: never;
}
```

## ComputeTextureInput

来源：`packages/sdk/src/index.ts:846`

```ts
export type ComputeTextureInput = ComputeTextureDataInput | ComputeTextureAssetInput;
```

## ComputeTextureBinding

来源：`packages/sdk/src/index.ts:847`

```ts
export interface ComputeTextureBinding {
  name: string;
  filter?: "nearest" | "linear";
  wrapU?: "clamp" | "repeat" | "mirror";
  wrapV?: "clamp" | "repeat" | "mirror";
}
```

## ComputeDispatchInput

来源：`packages/sdk/src/index.ts:853`

```ts
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
```

## ComputeTaskState

来源：`packages/sdk/src/index.ts:865`

```ts
export interface ComputeTaskState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code: string; message: string; remediation: string };
}
```

## ComputeService

来源：`packages/sdk/src/index.ts:869`

```ts
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
```

## GamepadState

来源：`packages/sdk/src/index.ts:889`

```ts
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
```

## InputService

来源：`packages/sdk/src/index.ts:900`

```ts
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
```

## GamepadInputService

来源：`packages/sdk/src/index.ts:906`

```ts
export interface GamepadInputService extends InputService {
  /** Choose UI navigation or gameplay input; defaults to UI for backward compatibility. */
  setGamepadMode(mode: "ui" | "game"): void;
  /** Analog axis deadzone in [0, 0.95]; defaults to 0.15. */
  setGamepadDeadzone(value: number): void;
  gamepad(): GamepadState;
}
```

## PhysicsSweepShape

来源：`packages/sdk/src/index.ts:914`

```ts
export type PhysicsSweepShape =
  | { shape: "sphere"; radius: number }
  | { shape: "box"; halfExtents: Vec3 }
  | { shape: "capsule"; halfHeight: number; radius: number };
```

## PhysicsSweepHit

来源：`packages/sdk/src/index.ts:918`

```ts
export interface PhysicsSweepHit { entity: string; fraction: number; distance: number; point: Vec3; normal: Vec3 }
```

## PhysicsService

来源：`packages/sdk/src/index.ts:919`

```ts
export interface PhysicsService {
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
```

## AnimationService

来源：`packages/sdk/src/index.ts:965`

```ts
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
```

## AnimationControlService

来源：`packages/sdk/src/index.ts:979`

```ts
export interface AnimationControlService extends AnimationService {
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
```

## CameraService

来源：`packages/sdk/src/index.ts:990`

```ts
export interface CameraService {
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
```

## UIElementState

来源：`packages/sdk/src/index.ts:1004`

```ts
export interface UIElementState {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  text: string;
  value: number;
  visible: boolean;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x: number; y: number; width: number; color: string;
  world?: { entity: string; offset: Vec3; occlude: boolean };
  generation?: number;
}
```

## UILayoutPatch

来源：`packages/sdk/src/index.ts:1015`

```ts
export interface UILayoutPatch {
  anchor?: UIElementState["anchor"];
  x?: number; y?: number; width?: number; color?: string;
}
```

## UIService

来源：`packages/sdk/src/index.ts:1019`

```ts
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
}
```

## InventoryItemDefinition

来源：`packages/sdk/src/index.ts:1036`

```ts
export interface InventoryItemDefinition {
  id: string;
  maxStack?: number;
  label?: string;
  tags?: readonly string[];
}
```

## InventoryDefinition

来源：`packages/sdk/src/index.ts:1042`

```ts
export interface InventoryDefinition {
  id: string;
  /** Explicit grouping label, not an entity lifetime binding. */
  owner: string;
  capacity: number;
}
```

## InventorySlot

来源：`packages/sdk/src/index.ts:1048`

```ts
export interface InventorySlot { item: string; count: number }
```

## InventoryState

来源：`packages/sdk/src/index.ts:1049`

```ts
export interface InventoryState {
  id: string;
  owner: string;
  slots: readonly (InventorySlot | null)[];
}
```

## EquipmentSlotDefinition

来源：`packages/sdk/src/index.ts:1054`

```ts
export interface EquipmentSlotDefinition { id: string; requiredTag?: string }
```

## EquipmentState

来源：`packages/sdk/src/index.ts:1055`

```ts
export interface EquipmentState {
  id: string; owner: string;
  slots: readonly { id: string; requiredTag?: string; item: string | null }[];
}
```

## InventoryService

来源：`packages/sdk/src/index.ts:1060`

```ts
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
```

## QuestObjectiveDefinition

来源：`packages/sdk/src/index.ts:1087`

```ts
export interface QuestObjectiveDefinition {
  id: string;
  target: number;
  label?: string;
}
```

## QuestDefinition

来源：`packages/sdk/src/index.ts:1092`

```ts
export interface QuestDefinition {
  id: string;
  title?: string;
  objectives: readonly QuestObjectiveDefinition[];
  /** Prerequisites are checked when starting; later resets do not cancel already-started quests. */
  prerequisites?: readonly string[];
  /** Completes when all objectives reach their targets; defaults to true. */
  autoComplete?: boolean;
}
```

## QuestState

来源：`packages/sdk/src/index.ts:1101`

```ts
export interface QuestState {
  id: string;
  title: string;
  status: "inactive" | "active" | "completed" | "failed";
  prerequisites: readonly string[];
  autoComplete: boolean;
  objectives: readonly { id: string; label: string; target: number; progress: number }[];
}
```

## QuestProgressUpdate

来源：`packages/sdk/src/index.ts:1109`

```ts
export interface QuestProgressUpdate { objective: string; amount: number }
```

## QuestService

来源：`packages/sdk/src/index.ts:1111`

```ts
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
```

## DialogueChoiceDefinition

来源：`packages/sdk/src/index.ts:1124`

```ts
export interface DialogueChoiceDefinition {
  id: string;
  text: string;
  /** Omit or use null to end the session. */
  next?: string | null;
}
```

## DialogueNodeDefinition

来源：`packages/sdk/src/index.ts:1130`

```ts
export interface DialogueNodeDefinition {
  id: string;
  speaker?: string;
  text: string;
  /** Linear successor; cannot be combined with nonempty choices. */
  next?: string | null;
  choices?: readonly DialogueChoiceDefinition[];
}
```

## DialogueDefinition

来源：`packages/sdk/src/index.ts:1138`

```ts
export interface DialogueDefinition {
  id: string;
  start: string;
  nodes: readonly DialogueNodeDefinition[];
}
```

## DialogueSessionState

来源：`packages/sdk/src/index.ts:1143`

```ts
export interface DialogueSessionState {
  id: string;
  dialogue: string;
  status: "active" | "completed" | "cancelled";
  steps: number;
  node: null | {
    id: string; speaker: string; text: string; next: string | null;
    choices: readonly { id: string; text: string; next: string | null }[];
  };
}
```

## DialogueService

来源：`packages/sdk/src/index.ts:1154`

```ts
export interface DialogueService {
  define(definition: DialogueDefinition): void;
  undefine(id: string): void;
  start(session: string, dialogue: string): void;
  /** Advance a node without choices; a terminal node completes the session. */
  advance(session: string): void;
  choose(session: string, choice: string): void;
  cancel(session: string): void;
  close(session: string): void;
  inspect(session: string): DialogueSessionState;
  list(): readonly DialogueSessionState[];
}
```

## LocalizationPlural

来源：`packages/sdk/src/index.ts:1166`

```ts
export interface LocalizationPlural {
  zero?: string; one?: string; two?: string; few?: string; many?: string; other: string;
}
```

## LocalizationMessage

来源：`packages/sdk/src/index.ts:1169`

```ts
export type LocalizationMessage = string | LocalizationPlural;
```

## LocalizationVariables

来源：`packages/sdk/src/index.ts:1170`

```ts
export type LocalizationVariables = Readonly<Record<string, string | number | boolean>>;
```

## LocalizationService

来源：`packages/sdk/src/index.ts:1172`

```ts
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
```

## AudioService

来源：`packages/sdk/src/index.ts:1183`

```ts
export interface AudioService {
  /** Optional occlusion uses a 3D physics ray between the listener and a live entity. */
  play(
    id: string,
    options?: { volume?: number; loop?: boolean; entity?: string; bus?: string; priority?: number; occlusion?: boolean },
  ): string;
  stop(voice: string): void;
  /** Pause/resume are idempotent; an unknown valid voice id is a no-op. Playback time follows fixed simulation ticks, even while audio is locked. */
  pause(voice: string): void;
  resume(voice: string): void;
  volume(value: number): void;
  /** Set a declared bus gain, independently of master and voice gain. */
  busVolume(id: string, value: number): void;
  /** Fade a declared bus over fixed-tick seconds; busVolume or another fade replaces it. */
  fadeBus(id: string, target: number, duration: number): void;
}
```

## StorageService

来源：`packages/sdk/src/index.ts:1199`

```ts
export interface StorageService {
  save(slot: string): void;
  load(slot: string): void;
  status(): {
    state: "idle" | "saving" | "loading" | "saved" | "loaded" | "failed";
    slot: string | null;
    error: string | null;
  };
}
```

## SceneService

来源：`packages/sdk/src/index.ts:1208`

```ts
export interface SceneService {
  current(): string;
  load(id: string): void;
}
```

## ModelDefinition

来源：`packages/sdk/src/index.ts:1212`

```ts
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
```

## RigidBodyDefinition

来源：`packages/sdk/src/index.ts:1229`

```ts
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
```

## CharacterDefinition

来源：`packages/sdk/src/index.ts:1243`

```ts
export interface CharacterDefinition {
  radius: number;
  height: number;
  speed: number;
  jumpSpeed?: number;
  /** Downward acceleration magnitude in world units/s^2; defaults to 9.81. Scene.gravity is a signed vector. */
  gravity?: number;
}
```

## UIElementDefinition

来源：`packages/sdk/src/index.ts:1251`

```ts
export interface UIElementDefinition {
  id: string;
  kind: "text" | "bar" | "button" | "input";
  text?: string;
  value?: number;
  visible?: boolean;
  anchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  x?: number;
  y?: number;
  width?: number;
  color?: string;
  world?: { entity: string; offset?: Vec3; occlude?: boolean };
}
```

## SoundDefinition

来源：`packages/sdk/src/index.ts:1264`

```ts
export interface SoundDefinition {
  id: string;
  asset: AssetDefinition | string;
  volume?: number;
  loop?: boolean;
  bus?: string;
}
```

## AudioBusDefinition

来源：`packages/sdk/src/index.ts:1271`

```ts
export interface AudioBusDefinition {
  id: string;
  volume?: number;
}
```

## SYSTEM_PHASES

来源：`packages/sdk/src/index.ts:1275`

```ts
SYSTEM_PHASES = [
  "input",
  "prePhysics",
  "physics",
  "postPhysics",
  "update",
  "presentation",
] as const
```

## SystemPhase

来源：`packages/sdk/src/index.ts:1283`

```ts
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
```

## Geometry

来源：`packages/sdk/src/index.ts:1284`

```ts
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
```

## GRAPH_TYPES

来源：`packages/sdk/src/index.ts:1288`

```ts
GRAPH_TYPES = ["float", "vec2", "vec3", "vec4", "bool"] as const
```

## GraphType

来源：`packages/sdk/src/index.ts:1289`

```ts
export type GraphType = typeof GRAPH_TYPES[number];
```

## GraphValue

来源：`packages/sdk/src/index.ts:1290`

```ts
export type GraphValue = number | boolean | Vec2 | Vec3 | Vec4;
```

## GraphParameter

来源：`packages/sdk/src/index.ts:1291`

```ts
export interface GraphParameter {
  name: string;
  type: GraphType;
  default: GraphValue;
}
```

## GRAPH_INPUT_TYPES

来源：`packages/sdk/src/index.ts:1296`

```ts
GRAPH_INPUT_TYPES = {
  uv: "vec2", uv1: "vec2", positionWorld: "vec3", normalWorld: "vec3",
  viewDirectionWorld: "vec3", vertexColor: "vec4", index: "float",
  screenSize: "vec2", texelSize: "vec2",
  pixelCoord: "vec2", outputSize: "vec2",
  positionLocal: "vec3", normalLocal: "vec3", vertexIndex: "float", instanceIndex: "float",
} as const
```

## GraphInputName

来源：`packages/sdk/src/index.ts:1303`

```ts
export type GraphInputName = keyof typeof GRAPH_INPUT_TYPES;
```

## GRAPH_OPERATIONS

来源：`packages/sdk/src/index.ts:1304`

```ts
GRAPH_OPERATIONS = {
  unary: ["sin", "cos", "abs", "floor", "ceil", "fract", "negate", "saturate", "normalize", "length", "safeSqrt"] as const,
  binary: ["add", "subtract", "multiply", "safeDivide", "min", "max", "dot", "cross", "step", "lessThan", "lessEqual", "greaterThan", "greaterEqual", "equal", "and", "or"] as const,
  ternary: ["mix", "clamp", "smoothstep", "select"] as const,
} as const
```

## GraphNode

来源：`packages/sdk/src/index.ts:1309`

```ts
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
```

## Graph

来源：`packages/sdk/src/index.ts:1329`

```ts
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
  parameters?: readonly GraphParameter[];
}
```

## MaterialGraphs

来源：`packages/sdk/src/index.ts:1334`

```ts
export interface MaterialGraphs {
  baseColor?: Graph;
  emissive?: Graph;
  roughness?: Graph;
  metalness?: Graph;
  opacity?: Graph;
  /** Absolute, unsided world-space normal; engine applies material boundary orientation. */
  normalWorld?: Graph;
}
```

## VertexGraphs

来源：`packages/sdk/src/index.ts:1343`

```ts
export interface VertexGraphs {
  /** Absolute object-local position after built-in morph, skin and instance transforms. */
  position?: Graph;
  /** Unsided object-local normal in the same domain; zero keeps the normalized input normal. */
  normal?: Graph;
}
```

## MaterialInput

来源：`packages/sdk/src/index.ts:1349`

```ts
export interface MaterialInput {
  id: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  texture?: AssetDefinition | string;
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
```

## MaterialDefinition

来源：`packages/sdk/src/index.ts:1378`

```ts
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
```

## PostProcessInput

来源：`packages/sdk/src/index.ts:1381`

```ts
export interface PostProcessInput {
  id: string;
  buffers?: readonly MaterialBufferInput[];
  textures?: readonly MaterialTextureInput[];
  /** Linear HDR vec4 output. Frame channels: scene.color, scene.normal, scene.depth, or an earlier pass ID. */
  graph: Graph;
  enabled?: boolean;
}
```

## PostProcessDefinition

来源：`packages/sdk/src/index.ts:1389`

```ts
export interface PostProcessDefinition extends PostProcessInput {
  readonly kind: "postprocess";
}
```

## ComputeInput

来源：`packages/sdk/src/index.ts:1392`

```ts
export interface ComputeInput {
  id: string;
  graph: Graph;
  outputType: GraphType;
  count: number;
  workgroupSize?: number;
  buffers?: readonly { name: string; type: GraphType }[];
  textures?: readonly ComputeTextureBinding[];
}
```

## ComputeDefinition

来源：`packages/sdk/src/index.ts:1401`

```ts
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
```

## AssetInput

来源：`packages/sdk/src/index.ts:1404`

```ts
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
```

## AssetDefinition

来源：`packages/sdk/src/index.ts:1414`

```ts
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
```

## MeshDefinition

来源：`packages/sdk/src/index.ts:1417`

```ts
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## LightDefinition

来源：`packages/sdk/src/index.ts:1423`

```ts
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
```

## LightPatch

来源：`packages/sdk/src/index.ts:1447`

```ts
export interface LightPatch { intensity?: number; color?: Vec3; target?: Vec3; visible?: boolean }
```

## LightOverride

来源：`packages/sdk/src/index.ts:1448`

```ts
export interface LightOverride extends LightPatch { entity: string }
```

## LightService

来源：`packages/sdk/src/index.ts:1449`

```ts
export interface LightService {
  /** Merge a patch into a live entity's declared light overrides. */
  set(entity: string, patch: LightPatch): void;
  /** Remove overrides, restoring the authored light values. */
  reset(entity: string): void;
  /** Detached active overrides for renderer integration. */
  visuals(): readonly LightOverride[];
}
```

## EntityInput

来源：`packages/sdk/src/index.ts:1457`

```ts
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
```

## PrefabInput

来源：`packages/sdk/src/index.ts:1469`

```ts
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
```

## PrefabDefinition

来源：`packages/sdk/src/index.ts:1472`

```ts
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
```

## SceneInput

来源：`packages/sdk/src/index.ts:1475`

```ts
export interface SceneInput {
  id: string;
  camera?: {
    position: Vec3;
    target: Vec3;
    /** Perspective by default. Orthographic currently supports raster mode only. */
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
```

## SceneDefinition

来源：`packages/sdk/src/index.ts:1518`

```ts
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
```

## SystemInput

来源：`packages/sdk/src/index.ts:1521`

```ts
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
```

## SystemDefinition

来源：`packages/sdk/src/index.ts:1531`

```ts
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
```

## GameInput

来源：`packages/sdk/src/index.ts:1534`

```ts
export interface GameInput {
  id: string;
  scene: SceneDefinition;
  systems?: readonly SystemDefinition[];
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
```

## GameDefinition

来源：`packages/sdk/src/index.ts:1553`

```ts
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
```

## GameInstance

来源：`packages/sdk/src/index.ts:1556`

```ts
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
```

## defineComponent

来源：`packages/sdk/src/index.ts:1560`

```ts
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S>;
```

## defineMaterial

来源：`packages/sdk/src/index.ts:1566`

```ts
export function defineMaterial(input: MaterialInput): MaterialDefinition;
```

## definePostProcess

来源：`packages/sdk/src/index.ts:1569`

```ts
export function definePostProcess(input: PostProcessInput): PostProcessDefinition;
```

## defineCompute

来源：`packages/sdk/src/index.ts:1572`

```ts
export function defineCompute(input: ComputeInput): ComputeDefinition;
```

## defineAsset

来源：`packages/sdk/src/index.ts:1575`

```ts
export function defineAsset(input: AssetInput): AssetDefinition;
```

## definePrefab

来源：`packages/sdk/src/index.ts:1578`

```ts
export function definePrefab(input: PrefabInput): PrefabDefinition;
```

## defineScene

来源：`packages/sdk/src/index.ts:1581`

```ts
export function defineScene(input: SceneInput): SceneDefinition;
```

## defineSystem

来源：`packages/sdk/src/index.ts:1584`

```ts
export function defineSystem(input: SystemInput): SystemDefinition;
```

## defineGame

来源：`packages/sdk/src/index.ts:1587`

```ts
export function defineGame(input: GameInput): GameDefinition;
```

## instantiateGame

来源：`packages/sdk/src/index.ts:1591`

```ts
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance;
```
