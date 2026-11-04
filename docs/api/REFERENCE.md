# threecat 0.2.0-m2.0 API 索引

由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。

## SDK_VERSION

来源：`packages/sdk/src/index.ts:2`

```ts
SDK_VERSION = "0.2.0-m2.0"
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
  prefab?: string;
  parent?: string;
  transform?: TransformPatch;
  components?: Record<string, ComponentData>;
}
```

## EntityCommands

来源：`packages/sdk/src/index.ts:69`

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

来源：`packages/sdk/src/index.ts:90`

```ts
export interface GameEvent {
  readonly type: string;
  readonly tick: number;
  readonly sequence: number;
  readonly payload: unknown;
}
```

## SystemContext

来源：`packages/sdk/src/index.ts:96`

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
  readonly animation: AnimationService;
  readonly camera: CameraService;
  readonly ui: UIService;
  readonly audio: AudioService;
  readonly storage: StorageService;
  readonly scenes: SceneService;
}
```

## InputService

来源：`packages/sdk/src/index.ts:115`

```ts
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
```

## PhysicsService

来源：`packages/sdk/src/index.ts:121`

```ts
export interface PhysicsService {
  moveCharacter(entity: string, displacement: Vec3): void;
  grounded(entity: string): boolean;
  velocity(entity: string): Vec3;
  setVelocity(entity: string, velocity: Vec3): void;
  impulse(entity: string, impulse: Vec3): void;
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    options?: { exclude?: readonly string[]; includeTriggers?: boolean },
  ): { entity: string; distance: number; point: Vec3; normal: Vec3 } | null;
}
```

## AnimationService

来源：`packages/sdk/src/index.ts:134`

```ts
export interface AnimationService {
  play(
    entity: string,
    clip: string,
    options?: { fade?: number; speed?: number; loop?: boolean },
  ): void;
  state(entity: string): {
    clip: string | null;
    time: number;
    playing: boolean;
  };
}
```

## CameraService

来源：`packages/sdk/src/index.ts:146`

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

## UIService

来源：`packages/sdk/src/index.ts:159`

```ts
export interface UIService {
  setText(id: string, text: string): void;
  setProgress(id: string, value: number): void;
  setVisible(id: string, visible: boolean): void;
}
```

## AudioService

来源：`packages/sdk/src/index.ts:164`

```ts
export interface AudioService {
  play(
    id: string,
    options?: { volume?: number; loop?: boolean; entity?: string },
  ): string;
  stop(voice: string): void;
  volume(value: number): void;
}
```

## StorageService

来源：`packages/sdk/src/index.ts:172`

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

来源：`packages/sdk/src/index.ts:181`

```ts
export interface SceneService {
  current(): string;
  load(id: string): void;
}
```

## ModelDefinition

来源：`packages/sdk/src/index.ts:185`

```ts
export interface ModelDefinition {
  castShadow?: boolean;
  receiveShadow?: boolean;
  asset: AssetDefinition | string;
  scale?: number;
  offset?: Vec3;
  rotation?: Vec3;
  animation?: { clip: string; speed?: number; loop?: boolean };
}
```

## RigidBodyDefinition

来源：`packages/sdk/src/index.ts:194`

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

来源：`packages/sdk/src/index.ts:208`

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

来源：`packages/sdk/src/index.ts:216`

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

来源：`packages/sdk/src/index.ts:229`

```ts
export interface SoundDefinition {
  id: string;
  asset: AssetDefinition | string;
  volume?: number;
  loop?: boolean;
}
```

## SYSTEM_PHASES

来源：`packages/sdk/src/index.ts:235`

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

来源：`packages/sdk/src/index.ts:243`

```ts
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
```

## Geometry

来源：`packages/sdk/src/index.ts:244`

```ts
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
```

## GraphType

来源：`packages/sdk/src/index.ts:248`

```ts
export type GraphType = "float" | "vec3";
```

## GraphNode

来源：`packages/sdk/src/index.ts:249`

```ts
export type GraphNode =
  | { id: string; op: "float"; value: number }
  | { id: string; op: "vec3"; value: Vec3 }
  | { id: string; op: "time" }
  | { id: string; op: "add" | "multiply"; inputs: readonly [string, string] }
  | { id: string; op: "sin"; inputs: readonly [string] };
```

## Graph

来源：`packages/sdk/src/index.ts:255`

```ts
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
}
```

## MaterialInput

来源：`packages/sdk/src/index.ts:259`

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

来源：`packages/sdk/src/index.ts:267`

```ts
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
```

## ComputeInput

来源：`packages/sdk/src/index.ts:270`

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

来源：`packages/sdk/src/index.ts:277`

```ts
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
```

## AssetInput

来源：`packages/sdk/src/index.ts:280`

```ts
export interface AssetInput {
  id: string;
  path: string;
  type: "texture" | "binary" | "model" | "audio";
  source?: string;
  license?: string;
  attribution?: string;
}
```

## AssetDefinition

来源：`packages/sdk/src/index.ts:288`

```ts
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
```

## MeshDefinition

来源：`packages/sdk/src/index.ts:291`

```ts
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## LightDefinition

来源：`packages/sdk/src/index.ts:297`

```ts
export interface LightDefinition {
  kind: "directional" | "point";
  color?: string;
  intensity?: number;
  castShadow?: boolean;
  target?: Vec3;
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

来源：`packages/sdk/src/index.ts:312`

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

来源：`packages/sdk/src/index.ts:324`

```ts
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
```

## PrefabDefinition

来源：`packages/sdk/src/index.ts:327`

```ts
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
```

## SceneInput

来源：`packages/sdk/src/index.ts:330`

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

来源：`packages/sdk/src/index.ts:355`

```ts
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
```

## SystemInput

来源：`packages/sdk/src/index.ts:358`

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

来源：`packages/sdk/src/index.ts:368`

```ts
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
```

## GameInput

来源：`packages/sdk/src/index.ts:371`

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
  scenes?: readonly SceneDefinition[];
  input?: Readonly<Record<string, readonly string[]>>;
  ui?: readonly UIElementDefinition[];
  sounds?: readonly SoundDefinition[];
}
```

## GameDefinition

来源：`packages/sdk/src/index.ts:385`

```ts
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
```

## GameInstance

来源：`packages/sdk/src/index.ts:388`

```ts
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
```

## defineComponent

来源：`packages/sdk/src/index.ts:392`

```ts
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S>;
```

## defineMaterial

来源：`packages/sdk/src/index.ts:398`

```ts
export function defineMaterial(input: MaterialInput): MaterialDefinition;
```

## defineCompute

来源：`packages/sdk/src/index.ts:401`

```ts
export function defineCompute(input: ComputeInput): ComputeDefinition;
```

## defineAsset

来源：`packages/sdk/src/index.ts:404`

```ts
export function defineAsset(input: AssetInput): AssetDefinition;
```

## definePrefab

来源：`packages/sdk/src/index.ts:407`

```ts
export function definePrefab(input: PrefabInput): PrefabDefinition;
```

## defineScene

来源：`packages/sdk/src/index.ts:410`

```ts
export function defineScene(input: SceneInput): SceneDefinition;
```

## defineSystem

来源：`packages/sdk/src/index.ts:413`

```ts
export function defineSystem(input: SystemInput): SystemDefinition;
```

## defineGame

来源：`packages/sdk/src/index.ts:416`

```ts
export function defineGame(input: GameInput): GameDefinition;
```

## instantiateGame

来源：`packages/sdk/src/index.ts:420`

```ts
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance;
```
