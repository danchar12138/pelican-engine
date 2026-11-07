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
  InventoryService,
  QuestService,
  DialogueService,
  LocalizationService,
  SpriteService,
  TilemapService,
  RopeService,
  ClothService,
  FluidService,
  SoftBodyService,
  Vec3,
} from "../../sdk/src/index.ts";
import type { SceneIR } from "../../compiler/src/types.ts";
import type {
  RuntimeWorld,
  ScheduledSystem,
  WorldSnapshot,
} from "./contracts.ts";
import type { RuntimeEvent } from "./events.ts";
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
  inventory: InventoryService;
  quests: QuestService;
  dialogue: DialogueService;
  i18n: LocalizationService;
  sprites: SpriteService;
  tilemaps: TilemapService;
  ropes: RopeService;
  cloth: ClothService;
  fluid: FluidService;
  softBodies: SoftBodyService;
}
/** Private bridge; native physics objects never cross this interface. */
export interface RopePhysicsSphere {
  center: Vec3;
  radius: number;
  centerOfMass: Vec3;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  inverseMass: Vec3;
  /** Symmetric world inverse inertia: xx, xy, xz, yy, yz, zz. */
  inverseInertia: readonly [number, number, number, number, number, number];
}
export interface RopePhysicsBridge {
  sampleSphere(entity: string): RopePhysicsSphere;
  /** Moment is the sum of contact angular impulses about the world origin. */
  applySphereReactions(reactions: readonly { entity: string; impulse: Vec3; moment: Vec3 }[]): void;
}
/** Private identity-only bridge; native 2D objects are not exposed. */
export interface Physics2DBridge { hasEntity(entity: string): boolean }
export interface RuntimePluginContext {
  /** Lazily resolved because physics may be registered after another plugin. */
  getRopePhysicsBridge?(): RopePhysicsBridge | undefined;
  /** Internal lazy bridge; tile maps may be registered before or after navigation. */
  getNavigationService?(): NavigationService | undefined;
  getPhysics2DBridge?(): Physics2DBridge | undefined;
  /** Internal lazy service bridge for explicit tile collision synchronization. */
  getPhysics2DService?(): Physics2DService | undefined;
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
  /** Engine boundary after each fixed tick; never awaited inside a game system. */
  settle?(): Promise<void>;
  dispose(): void;
}
export type RuntimePluginFactory = (
  context: RuntimePluginContext,
) => RuntimePlugin;
