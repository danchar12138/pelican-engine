# pelican 0.5.1 API 索引

由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。

## SDK_VERSION

来源：`packages/sdk/src/index.ts:2`

```ts
SDK_VERSION = "0.5.1"
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
  readonly input: InputService;
  readonly physics: PhysicsService;
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
  readonly ropes: RopeService;
  readonly cloth: ClothService;
  readonly fluid: FluidService;
  readonly softBodies: SoftBodyService;
}
```

## RopeCollider

来源：`packages/sdk/src/index.ts:128`

```ts
export type RopeCollider =
  | { kind: "sphere"; id: string; center: Vec3; radius: number }
  | { kind: "plane"; id: string; normal: Vec3; offset: number };
```

## RopeBodyCollider

来源：`packages/sdk/src/index.ts:132`

```ts
export interface RopeBodyCollider { readonly id: string; readonly entity: string }
```

## RopeVisualOptions

来源：`packages/sdk/src/index.ts:134`

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

来源：`packages/sdk/src/index.ts:142`

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

来源：`packages/sdk/src/index.ts:151`

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

来源：`packages/sdk/src/index.ts:176`

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

来源：`packages/sdk/src/index.ts:184`

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

来源：`packages/sdk/src/index.ts:196`

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

来源：`packages/sdk/src/index.ts:205`

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

来源：`packages/sdk/src/index.ts:219`

```ts
export interface IndexedParticleImpulse { index: number; impulse: Vec3 }
```

## IndexedParticleHit

来源：`packages/sdk/src/index.ts:221`

```ts
export interface IndexedParticleHit { index: number; position: Vec3; distance: number }
```

## ParticleAnchor

来源：`packages/sdk/src/index.ts:223`

```ts
export interface ParticleAnchor { index: number; position: Vec3 }
```

## RopeService

来源：`packages/sdk/src/index.ts:224`

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

来源：`packages/sdk/src/index.ts:247`

```ts
export type ClothCollider = RopeCollider;
```

## ClothTriangle

来源：`packages/sdk/src/index.ts:248`

```ts
export type ClothTriangle = readonly [number, number, number];
```

## ClothVisualOptions

来源：`packages/sdk/src/index.ts:249`

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

来源：`packages/sdk/src/index.ts:256`

```ts
export interface ClothBodyCollider { readonly id: string; readonly entity: string }
```

## ClothDefinition

来源：`packages/sdk/src/index.ts:257`

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

来源：`packages/sdk/src/index.ts:283`

```ts
export interface ClothContact { tick: number; particle: number; colliderId: string; penetration: number; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
```

## ClothSelfContact

来源：`packages/sdk/src/index.ts:284`

```ts
export interface ClothSelfContact { tick: number; firstParticle: number; secondParticle: number; penetration: number }
```

## ClothSurfaceContact

来源：`packages/sdk/src/index.ts:285`

```ts
export interface ClothSurfaceContact { tick: number; triangle: number; colliderId: string; penetration: number; barycentric: [number, number, number]; reactionImpulse?: Vec3; reactionAngularImpulse?: Vec3 }
```

## ClothState

来源：`packages/sdk/src/index.ts:286`

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

来源：`packages/sdk/src/index.ts:295`

```ts
export interface ClothVisualState {
  id: string; material: string; positions: Vec3[]; triangles: ClothTriangle[];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
```

## ClothService

来源：`packages/sdk/src/index.ts:299`

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

来源：`packages/sdk/src/index.ts:321`

```ts
export interface FluidVisualOptions { material: string; radius?: number; castShadow?: boolean; receiveShadow?: boolean }
```

## FluidBodyCollider

来源：`packages/sdk/src/index.ts:322`

```ts
export interface FluidBodyCollider { readonly id: string; readonly entity: string }
```

## SimulationContainer

来源：`packages/sdk/src/index.ts:324`

```ts
export interface SimulationContainer { min: Vec3; max: Vec3 }
```

## FluidDefinition

来源：`packages/sdk/src/index.ts:325`

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

来源：`packages/sdk/src/index.ts:337`

```ts
export interface FluidParticle { id: string; position: Vec3; radius: number }
```

## FluidState

来源：`packages/sdk/src/index.ts:338`

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

来源：`packages/sdk/src/index.ts:347`

```ts
export interface FluidVisualState {
  id: string; material: string; particles: FluidParticle[]; castShadow: boolean; receiveShadow: boolean;
}
```

## SimulationImpulse

来源：`packages/sdk/src/index.ts:351`

```ts
export interface SimulationImpulse { particle: string; impulse: Vec3 }
```

## SimulationForce

来源：`packages/sdk/src/index.ts:353`

```ts
export interface SimulationForce { particle: string; force: Vec3 }
```

## ParticleSimulationCollider

来源：`packages/sdk/src/index.ts:355`

```ts
export type ParticleSimulationCollider = RopeCollider | { kind: "box"; id: string; center: Vec3; halfExtents: Vec3 };
```

## SimulationParticleHit

来源：`packages/sdk/src/index.ts:357`

```ts
export interface SimulationParticleHit { particle: string; position: Vec3; distance: number }
```

## FluidService

来源：`packages/sdk/src/index.ts:358`

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

来源：`packages/sdk/src/index.ts:379`

```ts
export interface SoftBodyVisualOptions { material: string; castShadow?: boolean; receiveShadow?: boolean }
```

## SoftBodyBodyCollider

来源：`packages/sdk/src/index.ts:380`

```ts
export interface SoftBodyBodyCollider { readonly id: string; readonly entity: string }
```

## SoftBodyDefinition

来源：`packages/sdk/src/index.ts:381`

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

来源：`packages/sdk/src/index.ts:393`

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

来源：`packages/sdk/src/index.ts:405`

```ts
export interface SoftBodyVisualState {
  id: string; material: string; positions: Vec3[]; triangles: [number, number, number][];
  uvs: Vec2[]; castShadow: boolean; receiveShadow: boolean;
}
```

## SoftBodyService

来源：`packages/sdk/src/index.ts:409`

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

来源：`packages/sdk/src/index.ts:432`

```ts
export interface NavigationCell { readonly x: number; readonly y: number }
```

## NavigationObstacleUpdate

来源：`packages/sdk/src/index.ts:434`

```ts
export interface NavigationObstacleUpdate { readonly cell: NavigationCell; readonly blocked: boolean }
```

## NavigationCostUpdate

来源：`packages/sdk/src/index.ts:436`

```ts
export interface NavigationCostUpdate { readonly cell: NavigationCell; readonly cost: number }
```

## NavigationGrid

来源：`packages/sdk/src/index.ts:437`

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

来源：`packages/sdk/src/index.ts:448`

```ts
export interface NavigationPathOptions { readonly allowDiagonal?: boolean }
```

## NavigationAgentDefinition

来源：`packages/sdk/src/index.ts:450`

```ts
export interface NavigationAgentDefinition {
  id: string;
  entity: string;
  grid: string;
  /** World-space X/Z coordinates of grid cell (0, 0)'s lower corner; defaults to [0, 0]. */
  origin?: Vec2;
  /** World units per cell; defaults to 1. */
  cellSize?: number;
  /** World units per second; defaults to 1. */
  speed?: number;
  allowDiagonal?: boolean;
}
```

## NavigationAgentState

来源：`packages/sdk/src/index.ts:462`

```ts
export interface NavigationAgentState {
  id: string;
  entity: string;
  grid: string;
  target: NavigationCell | null;
  status: "idle" | "planning" | "moving" | "arrived" | "blocked" | "missing";
  /** Stable diagnostic code when movement is blocked or the entity was removed. */
  error: string | null;
  path: readonly NavigationCell[];
  cursor: number;
}
```

## NavigationService

来源：`packages/sdk/src/index.ts:473`

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
  stopAgent(id: string): void;
  inspectAgent(id: string): NavigationAgentState;
  listAgents(): readonly NavigationAgentState[];
  destroyAgent(id: string): void;
  destroyGrid(id: string): void;
  destroyOwner(owner: string): void;
}
```

## WorldStreamingOptions

来源：`packages/sdk/src/index.ts:497`

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

来源：`packages/sdk/src/index.ts:507`

```ts
export interface WorldChunkDefinition {
  x: number;
  z: number;
  /** Root entities with declared prefabs and absolute world-space transforms. */
  entities: readonly SpawnInput[];
}
```

## WorldStreamingService

来源：`packages/sdk/src/index.ts:513`

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

来源：`packages/sdk/src/index.ts:536`

```ts
export type RenderMode = "raster" | "hybrid" | "path";
```

## RenderCapabilities

来源：`packages/sdk/src/index.ts:537`

```ts
export interface RenderCapabilities {
  backend: "webgpu" | "webgl2" | "uninitialized";
  compute: boolean;
  availableModes: readonly RenderMode[];
}
```

## RenderSettings

来源：`packages/sdk/src/index.ts:542`

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

来源：`packages/sdk/src/index.ts:553`

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

来源：`packages/sdk/src/index.ts:563`

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

来源：`packages/sdk/src/index.ts:572`

```ts
export interface RenderBufferReference {
  id: string;
  type: GraphType;
  count: number;
}
```

## RenderBufferBindings

来源：`packages/sdk/src/index.ts:577`

```ts
export interface RenderBufferBindings {
  bind(target: string, name: string, buffer: ComputeBufferHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderBufferReference>>;
}
```

## MaterialTextureInput

来源：`packages/sdk/src/index.ts:582`

```ts
export interface MaterialTextureInput extends ComputeTextureBinding {
  /** Initial managed texture ID; asset import uses computeTextures/createTexture. */
  texture?: string;
  width?: number;
  height?: number;
}
```

## RenderTextureReference

来源：`packages/sdk/src/index.ts:588`

```ts
export interface RenderTextureReference extends ComputeTextureSize {
  id: string;
  format: "rgba32float";
}
```

## RenderTextureBindings

来源：`packages/sdk/src/index.ts:592`

```ts
export interface RenderTextureBindings {
  bind(target: string, name: string, texture: ComputeTextureHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderTextureReference>>;
}
```

## PostProcessState

来源：`packages/sdk/src/index.ts:597`

```ts
export interface PostProcessState {
  id: string;
  enabled: boolean;
  parameters: Readonly<Record<string, GraphValue>>;
}
```

## PostProcessService

来源：`packages/sdk/src/index.ts:602`

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

来源：`packages/sdk/src/index.ts:612`

```ts
export interface ComputeBufferHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
}
```

## ComputeTaskHandle

来源：`packages/sdk/src/index.ts:617`

```ts
export interface ComputeTaskHandle {
  readonly owner: number;
  readonly id: number;
}
```

## ComputeBufferInput

来源：`packages/sdk/src/index.ts:621`

```ts
export interface ComputeBufferInput {
  id: string;
  type: GraphType;
  count: number;
  data?: readonly GraphValue[];
}
```

## ComputeTextureHandle

来源：`packages/sdk/src/index.ts:627`

```ts
export interface ComputeTextureHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
  readonly kind: "texture";
}
```

## ComputeTextureSize

来源：`packages/sdk/src/index.ts:633`

```ts
export interface ComputeTextureSize {
  width: number;
  height: number;
}
```

## ComputeTextureDataInput

来源：`packages/sdk/src/index.ts:637`

```ts
export interface ComputeTextureDataInput extends ComputeTextureSize {
  id: string;
  /** Linear rgba32float texels in row-major order, without color-space conversion. */
  data?: readonly Vec4[];
  asset?: never;
}
```

## ComputeTextureAssetInput

来源：`packages/sdk/src/index.ts:643`

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

来源：`packages/sdk/src/index.ts:650`

```ts
export type ComputeTextureInput = ComputeTextureDataInput | ComputeTextureAssetInput;
```

## ComputeTextureBinding

来源：`packages/sdk/src/index.ts:651`

```ts
export interface ComputeTextureBinding {
  name: string;
  filter?: "nearest" | "linear";
  wrapU?: "clamp" | "repeat" | "mirror";
  wrapV?: "clamp" | "repeat" | "mirror";
}
```

## ComputeDispatchInput

来源：`packages/sdk/src/index.ts:657`

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

来源：`packages/sdk/src/index.ts:669`

```ts
export interface ComputeTaskState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code: string; message: string; remediation: string };
}
```

## ComputeService

来源：`packages/sdk/src/index.ts:673`

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

## InputService

来源：`packages/sdk/src/index.ts:693`

```ts
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
```

## PhysicsService

来源：`packages/sdk/src/index.ts:699`

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

来源：`packages/sdk/src/index.ts:742`

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

来源：`packages/sdk/src/index.ts:756`

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

来源：`packages/sdk/src/index.ts:767`

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

来源：`packages/sdk/src/index.ts:781`

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

来源：`packages/sdk/src/index.ts:792`

```ts
export interface UILayoutPatch {
  anchor?: UIElementState["anchor"];
  x?: number; y?: number; width?: number; color?: string;
}
```

## UIService

来源：`packages/sdk/src/index.ts:796`

```ts
export interface UIService {
  /** Create a dynamic element and return its generation; declared elements remain in game.ui. */
  create(definition: UIElementDefinition): number;
  /** Remove a dynamically created element; authored elements can be hidden instead. */
  remove(id: string): void;
  get(id: string): UIElementState;
  /** Atomically update layout properties. World labels use x/y as screen-pixel offsets. */
  setLayout(id: string, patch: UILayoutPatch): void;
  setText(id: string, text: string): void;
  setProgress(id: string, value: number): void;
  setVisible(id: string, visible: boolean): void;
}
```

## InventoryItemDefinition

来源：`packages/sdk/src/index.ts:809`

```ts
export interface InventoryItemDefinition {
  id: string;
  maxStack?: number;
  label?: string;
  tags?: readonly string[];
}
```

## InventoryDefinition

来源：`packages/sdk/src/index.ts:815`

```ts
export interface InventoryDefinition {
  id: string;
  /** Explicit grouping label, not an entity lifetime binding. */
  owner: string;
  capacity: number;
}
```

## InventorySlot

来源：`packages/sdk/src/index.ts:821`

```ts
export interface InventorySlot { item: string; count: number }
```

## InventoryState

来源：`packages/sdk/src/index.ts:822`

```ts
export interface InventoryState {
  id: string;
  owner: string;
  slots: readonly (InventorySlot | null)[];
}
```

## InventoryService

来源：`packages/sdk/src/index.ts:828`

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
  destroy(id: string): void;
  destroyOwner(owner: string): void;
}
```

## AudioService

来源：`packages/sdk/src/index.ts:846`

```ts
export interface AudioService {
  play(
    id: string,
    options?: { volume?: number; loop?: boolean; entity?: string; bus?: string; priority?: number },
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

来源：`packages/sdk/src/index.ts:861`

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

来源：`packages/sdk/src/index.ts:870`

```ts
export interface SceneService {
  current(): string;
  load(id: string): void;
}
```

## ModelDefinition

来源：`packages/sdk/src/index.ts:874`

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

来源：`packages/sdk/src/index.ts:891`

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

来源：`packages/sdk/src/index.ts:905`

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

来源：`packages/sdk/src/index.ts:913`

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

来源：`packages/sdk/src/index.ts:926`

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

来源：`packages/sdk/src/index.ts:933`

```ts
export interface AudioBusDefinition {
  id: string;
  volume?: number;
}
```

## SYSTEM_PHASES

来源：`packages/sdk/src/index.ts:937`

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

来源：`packages/sdk/src/index.ts:945`

```ts
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
```

## Geometry

来源：`packages/sdk/src/index.ts:946`

```ts
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
```

## GRAPH_TYPES

来源：`packages/sdk/src/index.ts:950`

```ts
GRAPH_TYPES = ["float", "vec2", "vec3", "vec4", "bool"] as const
```

## GraphType

来源：`packages/sdk/src/index.ts:951`

```ts
export type GraphType = typeof GRAPH_TYPES[number];
```

## GraphValue

来源：`packages/sdk/src/index.ts:952`

```ts
export type GraphValue = number | boolean | Vec2 | Vec3 | Vec4;
```

## GraphParameter

来源：`packages/sdk/src/index.ts:953`

```ts
export interface GraphParameter {
  name: string;
  type: GraphType;
  default: GraphValue;
}
```

## GRAPH_INPUT_TYPES

来源：`packages/sdk/src/index.ts:958`

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

来源：`packages/sdk/src/index.ts:965`

```ts
export type GraphInputName = keyof typeof GRAPH_INPUT_TYPES;
```

## GRAPH_OPERATIONS

来源：`packages/sdk/src/index.ts:966`

```ts
GRAPH_OPERATIONS = {
  unary: ["sin", "cos", "abs", "floor", "ceil", "fract", "negate", "saturate", "normalize", "length", "safeSqrt"] as const,
  binary: ["add", "subtract", "multiply", "safeDivide", "min", "max", "dot", "cross", "step", "lessThan", "lessEqual", "greaterThan", "greaterEqual", "equal", "and", "or"] as const,
  ternary: ["mix", "clamp", "smoothstep", "select"] as const,
} as const
```

## GraphNode

来源：`packages/sdk/src/index.ts:971`

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

来源：`packages/sdk/src/index.ts:991`

```ts
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
  parameters?: readonly GraphParameter[];
}
```

## MaterialGraphs

来源：`packages/sdk/src/index.ts:996`

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

来源：`packages/sdk/src/index.ts:1005`

```ts
export interface VertexGraphs {
  /** Absolute object-local position after built-in morph, skin and instance transforms. */
  position?: Graph;
  /** Unsided object-local normal in the same domain; zero keeps the normalized input normal. */
  normal?: Graph;
}
```

## MaterialInput

来源：`packages/sdk/src/index.ts:1011`

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

来源：`packages/sdk/src/index.ts:1038`

```ts
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
```

## PostProcessInput

来源：`packages/sdk/src/index.ts:1041`

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

来源：`packages/sdk/src/index.ts:1049`

```ts
export interface PostProcessDefinition extends PostProcessInput {
  readonly kind: "postprocess";
}
```

## ComputeInput

来源：`packages/sdk/src/index.ts:1052`

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

来源：`packages/sdk/src/index.ts:1061`

```ts
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
```

## AssetInput

来源：`packages/sdk/src/index.ts:1064`

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

来源：`packages/sdk/src/index.ts:1074`

```ts
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
```

## MeshDefinition

来源：`packages/sdk/src/index.ts:1077`

```ts
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## LightDefinition

来源：`packages/sdk/src/index.ts:1083`

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

## EntityInput

来源：`packages/sdk/src/index.ts:1106`

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

来源：`packages/sdk/src/index.ts:1118`

```ts
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
```

## PrefabDefinition

来源：`packages/sdk/src/index.ts:1121`

```ts
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
```

## SceneInput

来源：`packages/sdk/src/index.ts:1124`

```ts
export interface SceneInput {
  id: string;
  camera?: {
    position: Vec3;
    target: Vec3;
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
  entities: readonly EntityInput[];
}
```

## SceneDefinition

来源：`packages/sdk/src/index.ts:1161`

```ts
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
```

## SystemInput

来源：`packages/sdk/src/index.ts:1164`

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

来源：`packages/sdk/src/index.ts:1174`

```ts
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
```

## GameInput

来源：`packages/sdk/src/index.ts:1177`

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

来源：`packages/sdk/src/index.ts:1196`

```ts
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
```

## GameInstance

来源：`packages/sdk/src/index.ts:1199`

```ts
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
```

## defineComponent

来源：`packages/sdk/src/index.ts:1203`

```ts
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S>;
```

## defineMaterial

来源：`packages/sdk/src/index.ts:1209`

```ts
export function defineMaterial(input: MaterialInput): MaterialDefinition;
```

## definePostProcess

来源：`packages/sdk/src/index.ts:1212`

```ts
export function definePostProcess(input: PostProcessInput): PostProcessDefinition;
```

## defineCompute

来源：`packages/sdk/src/index.ts:1215`

```ts
export function defineCompute(input: ComputeInput): ComputeDefinition;
```

## defineAsset

来源：`packages/sdk/src/index.ts:1218`

```ts
export function defineAsset(input: AssetInput): AssetDefinition;
```

## definePrefab

来源：`packages/sdk/src/index.ts:1221`

```ts
export function definePrefab(input: PrefabInput): PrefabDefinition;
```

## defineScene

来源：`packages/sdk/src/index.ts:1224`

```ts
export function defineScene(input: SceneInput): SceneDefinition;
```

## defineSystem

来源：`packages/sdk/src/index.ts:1227`

```ts
export function defineSystem(input: SystemInput): SystemDefinition;
```

## defineGame

来源：`packages/sdk/src/index.ts:1230`

```ts
export function defineGame(input: GameInput): GameDefinition;
```

## instantiateGame

来源：`packages/sdk/src/index.ts:1234`

```ts
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance;
```
