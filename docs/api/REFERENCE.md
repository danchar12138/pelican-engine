# threecat 0.1.0-m1.0 API 索引

由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。

## SDK_VERSION

来源：`packages/sdk/src/index.ts:2`

```ts
SDK_VERSION = "0.1.0-m1.0"
```

## Vec3

来源：`packages/sdk/src/index.ts:3`

```ts
export type Vec3 = readonly [number, number, number];
```

## Transform

来源：`packages/sdk/src/index.ts:4`

```ts
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
```

## TransformPatch

来源：`packages/sdk/src/index.ts:9`

```ts
export type TransformPatch = Partial<Transform>;
```

## Field

来源：`packages/sdk/src/index.ts:10`

```ts
export type Field =
  | { type: "number"; default: number }
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string }
  | { type: "vec3"; default: Vec3 };
```

## ComponentSchema

来源：`packages/sdk/src/index.ts:15`

```ts
export type ComponentSchema = Readonly<Record<string, Field>>;
```

## ComponentDefinition

来源：`packages/sdk/src/index.ts:16`

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

来源：`packages/sdk/src/index.ts:23`

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

来源：`packages/sdk/src/index.ts:32`

```ts
export type ComponentData = Record<string, number | boolean | string | Vec3>;
```

## ComponentInstance

来源：`packages/sdk/src/index.ts:33`

```ts
export interface ComponentInstance {
  component: ComponentDefinition | string;
  value?: ComponentData;
}
```

## EngineFacade

来源：`packages/sdk/src/index.ts:37`

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

来源：`packages/sdk/src/index.ts:56`

```ts
export interface EntityHandle {
  readonly world: number;
  readonly index: number;
  readonly generation: number;
}
```

## EntityRef

来源：`packages/sdk/src/index.ts:61`

```ts
export type EntityRef = string | EntityHandle;
```

## SpawnInput

来源：`packages/sdk/src/index.ts:62`

```ts
export interface SpawnInput {
  id: string;
  parent?: string;
  transform?: TransformPatch;
  components?: Record<string, ComponentData>;
}
```

## EntityCommands

来源：`packages/sdk/src/index.ts:68`

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

来源：`packages/sdk/src/index.ts:89`

```ts
export interface GameEvent {
  readonly type: string;
  readonly tick: number;
  readonly sequence: number;
  readonly payload: unknown;
}
```

## SystemContext

来源：`packages/sdk/src/index.ts:95`

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
}
```

## SYSTEM_PHASES

来源：`packages/sdk/src/index.ts:106`

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

来源：`packages/sdk/src/index.ts:114`

```ts
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
```

## Geometry

来源：`packages/sdk/src/index.ts:115`

```ts
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
```

## GraphType

来源：`packages/sdk/src/index.ts:119`

```ts
export type GraphType = "float" | "vec3";
```

## GraphNode

来源：`packages/sdk/src/index.ts:120`

```ts
export type GraphNode =
  | { id: string; op: "float"; value: number }
  | { id: string; op: "vec3"; value: Vec3 }
  | { id: string; op: "time" }
  | { id: string; op: "add" | "multiply"; inputs: readonly [string, string] }
  | { id: string; op: "sin"; inputs: readonly [string] };
```

## Graph

来源：`packages/sdk/src/index.ts:126`

```ts
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
}
```

## MaterialInput

来源：`packages/sdk/src/index.ts:130`

```ts
export interface MaterialInput {
  id: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  texture?: AssetDefinition | string;
  graph?: Graph;
}
```

## MaterialDefinition

来源：`packages/sdk/src/index.ts:138`

```ts
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
```

## ComputeInput

来源：`packages/sdk/src/index.ts:141`

```ts
export interface ComputeInput {
  id: string;
  graph: Graph;
  outputType: GraphType;
  count: number;
  workgroupSize?: number;
}
```

## ComputeDefinition

来源：`packages/sdk/src/index.ts:148`

```ts
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
```

## AssetInput

来源：`packages/sdk/src/index.ts:151`

```ts
export interface AssetInput {
  id: string;
  path: string;
  type: "texture" | "binary";
}
```

## AssetDefinition

来源：`packages/sdk/src/index.ts:156`

```ts
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
```

## MeshDefinition

来源：`packages/sdk/src/index.ts:159`

```ts
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## LightDefinition

来源：`packages/sdk/src/index.ts:165`

```ts
export interface LightDefinition {
  kind: "directional" | "point";
  color?: string;
  intensity?: number;
  castShadow?: boolean;
}
```

## EntityInput

来源：`packages/sdk/src/index.ts:171`

```ts
export interface EntityInput {
  id: string;
  prefab?: PrefabDefinition | string;
  parent?: string;
  transform?: TransformPatch;
  mesh?: MeshDefinition;
  light?: LightDefinition;
  components?: readonly ComponentInstance[];
}
```

## PrefabInput

来源：`packages/sdk/src/index.ts:180`

```ts
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
```

## PrefabDefinition

来源：`packages/sdk/src/index.ts:183`

```ts
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
```

## SceneInput

来源：`packages/sdk/src/index.ts:186`

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
  environment?: { background?: string; ambientIntensity?: number };
  entities: readonly EntityInput[];
}
```

## SceneDefinition

来源：`packages/sdk/src/index.ts:198`

```ts
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
```

## SystemInput

来源：`packages/sdk/src/index.ts:201`

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

来源：`packages/sdk/src/index.ts:211`

```ts
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
```

## GameInput

来源：`packages/sdk/src/index.ts:214`

```ts
export interface GameInput {
  id: string;
  scene: SceneDefinition;
  systems?: readonly SystemDefinition[];
  components?: readonly ComponentDefinition[];
  prefabs?: readonly PrefabDefinition[];
  materials?: readonly MaterialDefinition[];
  computes?: readonly ComputeDefinition[];
  assets?: readonly AssetDefinition[];
}
```

## GameDefinition

来源：`packages/sdk/src/index.ts:224`

```ts
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
```

## GameInstance

来源：`packages/sdk/src/index.ts:227`

```ts
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
```

## defineComponent

来源：`packages/sdk/src/index.ts:231`

```ts
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S>;
```

## defineMaterial

来源：`packages/sdk/src/index.ts:237`

```ts
export function defineMaterial(input: MaterialInput): MaterialDefinition;
```

## defineCompute

来源：`packages/sdk/src/index.ts:240`

```ts
export function defineCompute(input: ComputeInput): ComputeDefinition;
```

## defineAsset

来源：`packages/sdk/src/index.ts:243`

```ts
export function defineAsset(input: AssetInput): AssetDefinition;
```

## definePrefab

来源：`packages/sdk/src/index.ts:246`

```ts
export function definePrefab(input: PrefabInput): PrefabDefinition;
```

## defineScene

来源：`packages/sdk/src/index.ts:249`

```ts
export function defineScene(input: SceneInput): SceneDefinition;
```

## defineSystem

来源：`packages/sdk/src/index.ts:252`

```ts
export function defineSystem(input: SystemInput): SystemDefinition;
```

## defineGame

来源：`packages/sdk/src/index.ts:255`

```ts
export function defineGame(input: GameInput): GameDefinition;
```

## instantiateGame

来源：`packages/sdk/src/index.ts:259`

```ts
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance;
```
