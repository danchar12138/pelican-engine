import type {
  AnimationService,
  AudioService,
  CameraService,
  InputService,
  PhysicsService,
  SceneService,
  StorageService,
  UIService,
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
}
export interface RuntimePluginContext {
  world: RuntimeWorld;
  scene: SceneIR;
  events(type?: string): RuntimeEvent[];
  emit(type: string, payload: unknown): RuntimeEvent;
}
export interface RuntimePlugin {
  id: string;
  version?: string;
  services?: Partial<RuntimeServices>;
  systems?: readonly ScheduledSystem[];
  inspect?(): unknown;
  snapshot(): unknown;
  validateSnapshot(value: unknown): void;
  validateWorld?(value: unknown, world: WorldSnapshot): void;
  restore(value: unknown): void;
  dispose(): void;
}
export type RuntimePluginFactory = (
  context: RuntimePluginContext,
) => RuntimePlugin;
