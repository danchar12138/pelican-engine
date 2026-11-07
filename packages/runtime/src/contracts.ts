/** Shared M1 contracts. These contain no renderer, platform or third-party objects. */
import type {
  ComponentData,
  ComponentSchema,
  Transform,
  TransformPatch,
  SpawnInput,
  EntityHandle,
  EntityRef,
  SystemPhase,
} from "../../sdk/src/index.ts";
export type {
  EntityHandle,
  EntityRef,
  SystemPhase,
} from "../../sdk/src/index.ts";
export { SYSTEM_PHASES } from "../../sdk/src/index.ts";

export interface RuntimeComponentDefinition {
  id: string;
  schema: ComponentSchema;
  version?: number;
}
export type RuntimeEntityInput = SpawnInput;
export interface EntityRecord {
  id: string;
  prefab?: string;
  parent?: string;
  transform: Transform;
  components: Record<string, ComponentData>;
}
export interface WorldSnapshot {
  format: "pelican.world";
  version: 1;
  components: RuntimeComponentDefinition[];
  entities: EntityRecord[];
}
export interface WorldAccess {
  reads?: readonly string[];
  writes?: readonly string[];
  structural?: boolean;
}
export interface WorldOptions {
  components?: readonly RuntimeComponentDefinition[];
  entities?: readonly RuntimeEntityInput[];
  initialCapacity?: number;
}
export interface RuntimeWorld {
  registerComponent(definition: RuntimeComponentDefinition): void;
  spawn(input: RuntimeEntityInput): EntityHandle;
  destroy(entity: EntityRef): void;
  resolve(id: string): EntityHandle;
  id(entity: EntityRef): string;
  /** Entity identity and hierarchy metadata without reading component values. */
  identity(entity: EntityRef): { id: string; prefab?: string; parent?: string };
  isAlive(entity: EntityRef): boolean;
  getTransform(entity: EntityRef): Transform;
  setTransform(entity: EntityRef, patch: TransformPatch): void;
  getComponent(entity: EntityRef, component: string): ComponentData;
  setComponent(
    entity: EntityRef,
    component: string,
    patch: ComponentData,
  ): void;
  addComponent(
    entity: EntityRef,
    component: string,
    data?: ComponentData,
  ): void;
  removeComponent(entity: EntityRef, component: string): void;
  query(...components: string[]): string[];
  records(): EntityRecord[];
  queue(command: WorldCommand): void;
  flush(): void;
  runSystem<T>(id: string, access: WorldAccess, operation: () => T): T;
  snapshot(): WorldSnapshot;
  restore(snapshot: WorldSnapshot): void;
  inspect(): {
    entities: number;
    capacity: number;
    components: number;
    pendingCommands: number;
    revision: number;
    disposed: boolean;
  };
  dispose(): void;
}
export type WorldCommand =
  | { type: "spawn"; entity: RuntimeEntityInput }
  | { type: "destroy"; entity: EntityRef }
  | {
      type: "addComponent";
      entity: EntityRef;
      component: string;
      data?: ComponentData;
    }
  | { type: "removeComponent"; entity: EntityRef; component: string };

export interface ScheduledSystem extends WorldAccess {
  id: string;
  phase?: SystemPhase;
  before?: readonly string[];
  after?: readonly string[];
  run(dt: number): void;
}
