import type {
  AnimationControlService,
  AudioService,
  CameraService,
  InputService,
  GamepadInputService,
  PhysicsService,
  Physics2DService,
  SceneService,
  StorageService,
  UIService,
  RenderService,
  ComputeService,
  NavigationService,
  WorldStreamingService,
  TerrainService,
  TerrainGeometry,
  CinematicService,
  InventoryService,
  QuestService,
  DialogueService,
  LocalizationService,
  SpriteService,
  TilemapService,
  LightService,
  RopeService,
  ClothService,
  FluidService,
  SoftBodyService,
  Vec3,
  Vec4,
  ModelDefinition,
  AnimationRootMotionDelta,
} from "../../sdk/src/index.ts";
import type { SceneIR } from "../../compiler/src/types.ts";
import type {
  RuntimeWorld,
  ScheduledSystem,
  WorldSnapshot,
} from "./contracts.ts";
import type { RuntimeEvent } from "./events.ts";
import type { SimulationCouplingFrame } from "../../simulation/src/coupling-frame.ts";
export interface RuntimeServices {
  input: GamepadInputService;
  physics: PhysicsService;
  physics2d: Physics2DService;
  animation: AnimationControlService;
  camera: CameraService;
  ui: UIService;
  audio: AudioService;
  storage: StorageService;
  scenes: SceneService;
  render: RenderService;
  compute: ComputeService;
  navigation: NavigationService;
  streaming: WorldStreamingService;
  terrain: TerrainService;
  cinematics: CinematicService;
  inventory: InventoryService;
  quests: QuestService;
  dialogue: DialogueService;
  i18n: LocalizationService;
  sprites: SpriteService;
  tilemaps: TilemapService;
  lights: LightService;
  ropes: RopeService;
  cloth: ClothService;
  fluid: FluidService;
  softBodies: SoftBodyService;
}
/** Private bridge; native physics objects never cross this interface. */
export interface RopePhysicsBodyState {
  friction?: number;
  center: Vec3;
  /** Rigid-body origin and quaternion, provided by the physics owner for local attachments. */
  bodyPosition?: Vec3;
  bodyOrientation?: Vec4;
  centerOfMass: Vec3;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  inverseMass: Vec3;
  /** Symmetric world inverse inertia: xx, xy, xz, yy, yz, zz. */
  inverseInertia: readonly [number, number, number, number, number, number];
}
export interface RopePhysicsSphere extends RopePhysicsBodyState { radius: number }
export interface RopePhysicsBox extends RopePhysicsBodyState { halfExtents: Vec3; rotation: Vec3 }
/** Private sampled cloth collider. Native body and shape objects remain in physics. */
export type ClothPhysicsBody =
  | ({ kind: "sphere" } & RopePhysicsSphere)
  | ({ kind: "box" } & RopePhysicsBox);
export interface RopePhysicsBridge {
  sampleSphere(entity: string): RopePhysicsSphere;
  sampleClothBody(entity: string): ClothPhysicsBody;
  sampleRopeBody(entity: string): ClothPhysicsBody;
  sampleParticleBody(entity: string): ClothPhysicsBody;
  /** Moment is the sum of contact angular impulses about the world origin. */
  applySphereReactions(reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[]): void;
  /** Cloth may return reactions to dynamic, non-trigger spheres and boxes. */
  applyClothReactions(reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[]): void;
  applyRopeReactions(reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[]): void;
  applyParticleReactions(reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[]): void;
}
/** Private identity-only bridge; native 2D objects are not exposed. */
export interface Physics2DBridge { hasEntity(entity: string): boolean }
export interface TerrainPhysicsBridge {
  setTerrain(geometry: TerrainGeometry): void;
  removeTerrain(id: string): void;
}
export interface CinematicAnimationBridge {
  consumeRootMotion(entity: string): AnimationRootMotionDelta;
  claim(entity: string, owner: string, definition: ModelDefinition): unknown;
  reclaim(entity: string, owner: string, definition: ModelDefinition): void;
  validate(entity: string, payload: unknown, definition: ModelDefinition, clips?: readonly string[]): void;
  duration(entity: string, clip: string, definition?: ModelDefinition): number;
  rootMotionMode(entity: string): "extract" | "apply" | null;
  sample(entity: string, owner: string, clip: string, from: number, to: number, loop: boolean, rootMotion: boolean): void;
  release(entity: string, owner: string, payload: unknown, restore: boolean): void;
  abandon(entity: string, owner: string): void;
}
export interface RuntimePluginContext {
  getCinematicAnimationBridge?(): CinematicAnimationBridge | undefined;
  getCameraService?(): CameraService | undefined;
  getAudioService?(): AudioService | undefined;
  /** One host-owned transaction for shared rigid reactions and cross-material contacts. */
  couplingFrame?: SimulationCouplingFrame;
  getTerrainPhysicsBridge?(): TerrainPhysicsBridge | undefined;
  getTerrainService?(): TerrainService | undefined;
  /** Trusted synchronous checkpoints for terrain/nav transactions; never a game API. */
  getNavigationStateBridge?(): { snapshot(): unknown; restore(value: unknown): void } | undefined;
  /** Lazily resolved because physics may be registered after another plugin. */
  getRopePhysicsBridge?(): RopePhysicsBridge | undefined;
  /** Internal lazy bridge; tile maps may be registered before or after navigation. */
  getNavigationService?(): NavigationService | undefined;
  getPhysics2DBridge?(): Physics2DBridge | undefined;
  /** Internal lazy service bridge for explicit tile collision synchronization. */
  getPhysics2DService?(): Physics2DService | undefined;
  /** Internal lazy service bridge for spatial audio. */
  getPhysicsService?(): PhysicsService | undefined;
  /** Internal lazy service bridge for localized UI text. */
  getLocalizationService?(): LocalizationService | undefined;
  /** Host interval; supplied by RuntimeHost to engine plugins. */
  readonly fixedDt?: number;
  world: RuntimeWorld;
  scene: SceneIR;
  events(type?: string): RuntimeEvent[];
  emit(type: string, payload: unknown): RuntimeEvent;
}
export interface RuntimePlugin {
  id: string;
  version?: string;
  legacySnapshot?(): unknown;
  services?: Partial<Omit<RuntimeServices, "input">> & { input?: InputService & Partial<GamepadInputService> };
  systems?: readonly ScheduledSystem[];
  inspect?(): unknown;
  /** A failed native owner cannot provide a trustworthy rollback snapshot. */
  requiresRecovery?(): boolean;
  snapshot(): unknown;
  validateSnapshot(value: unknown): void;
  validateWorld?(value: unknown, world: WorldSnapshot): void;
  /** Cross-owner snapshot preflight before any plugin or World mutation. */
  validatePeers?(value: unknown, peers: Readonly<Record<string, { version?: string; payload: unknown }>>): void;
  restore(value: unknown): void;
  /** Synchronous engine-owned work after the physics phase and before postPhysics systems. */
  afterPhysics?(): void;
  /** Engine-private integration surface, not a game service. */
  ropePhysicsBridge?: RopePhysicsBridge;
  physics2DBridge?: Physics2DBridge;
  terrainPhysicsBridge?: TerrainPhysicsBridge;
  cinematicAnimationBridge?: CinematicAnimationBridge;
  /** Engine boundary after each fixed tick; never awaited inside a game system. */
  settle?(): Promise<void>;
  dispose(): void;
}
export type RuntimePluginFactory = (
  context: RuntimePluginContext,
) => RuntimePlugin;
