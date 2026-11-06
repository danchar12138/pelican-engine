import type {
  AnimationService,
  AudioService,
  CameraService,
  InputService,
  PhysicsService,
  SceneService,
  StorageService,
  UIService,
  RenderService,
  ComputeService,
  NavigationService,
  RopeService,
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
  input: InputService;
  physics: PhysicsService;
  animation: AnimationService;
  camera: CameraService;
  ui: UIService;
  audio: AudioService;
  storage: StorageService;
  scenes: SceneService;
  render: RenderService;
  compute: ComputeService;
  navigation: NavigationService;
  ropes: RopeService;
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
export interface RuntimePluginContext {
  /** Lazily resolved because physics may be registered after another plugin. */
  getRopePhysicsBridge?(): RopePhysicsBridge | undefined;
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
  services?: Partial<RuntimeServices>;
  systems?: readonly ScheduledSystem[];
  inspect?(): unknown;
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
  /** Engine boundary after each fixed tick; never awaited inside a game system. */
  settle?(): Promise<void>;
  dispose(): void;
}
export type RuntimePluginFactory = (
  context: RuntimePluginContext,
) => RuntimePlugin;
