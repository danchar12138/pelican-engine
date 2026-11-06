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
export interface RuntimePluginContext {
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
  /** Engine boundary after each fixed tick; never awaited inside a game system. */
  settle?(): Promise<void>;
  dispose(): void;
}
export type RuntimePluginFactory = (
  context: RuntimePluginContext,
) => RuntimePlugin;
