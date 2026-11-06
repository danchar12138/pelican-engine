# pelican 0.3.5 API 索引

由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。

## SDK_VERSION

来源：`packages/sdk/src/index.ts:2`

```ts
SDK_VERSION = "0.3.5"
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
  readonly animation: AnimationService;
  readonly camera: CameraService;
  readonly ui: UIService;
  readonly audio: AudioService;
  readonly storage: StorageService;
  readonly scenes: SceneService;
  readonly render: RenderService;
  readonly compute: ComputeService;
  readonly navigation: NavigationService;
}
```

## NavigationCell

来源：`packages/sdk/src/index.ts:123`

```ts
export interface NavigationCell { readonly x: number; readonly y: number }
```

## NavigationGrid

来源：`packages/sdk/src/index.ts:124`

```ts
export interface NavigationGrid {
  readonly id: string;
  readonly owner: string;
  readonly width: number;
  readonly height: number;
  readonly blocked?: readonly NavigationCell[];
  /** Maximum distinct search cells, including endpoints; defaults to 65536. Raising it increases memory and CPU use. */
  readonly searchCellBudget?: number;
}
```

## NavigationService

来源：`packages/sdk/src/index.ts:133`

```ts
export interface NavigationService {
  createGrid(grid: NavigationGrid): void;
  /** Returns a detached description, including the current blocked cells. */
  getGrid(id: string): NavigationGrid;
  isBlocked(id: string, cell: NavigationCell): boolean;
  setBlocked(id: string, cell: NavigationCell, blocked: boolean): void;
  findPath(id: string, start: NavigationCell, end: NavigationCell): readonly NavigationCell[];
  destroyGrid(id: string): void;
  destroyOwner(owner: string): void;
}
```

## RenderMode

来源：`packages/sdk/src/index.ts:143`

```ts
export type RenderMode = "raster" | "hybrid" | "path";
```

## RenderCapabilities

来源：`packages/sdk/src/index.ts:144`

```ts
export interface RenderCapabilities {
  backend: "webgpu" | "webgl2" | "uninitialized";
  compute: boolean;
  availableModes: readonly RenderMode[];
}
```

## RenderSettings

来源：`packages/sdk/src/index.ts:149`

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

来源：`packages/sdk/src/index.ts:160`

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

来源：`packages/sdk/src/index.ts:170`

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

来源：`packages/sdk/src/index.ts:179`

```ts
export interface RenderBufferReference {
  id: string;
  type: GraphType;
  count: number;
}
```

## RenderBufferBindings

来源：`packages/sdk/src/index.ts:184`

```ts
export interface RenderBufferBindings {
  bind(target: string, name: string, buffer: ComputeBufferHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderBufferReference>>;
}
```

## MaterialTextureInput

来源：`packages/sdk/src/index.ts:189`

```ts
export interface MaterialTextureInput extends ComputeTextureBinding {
  /** Initial managed texture ID; asset import uses computeTextures/createTexture. */
  texture?: string;
  width?: number;
  height?: number;
}
```

## RenderTextureReference

来源：`packages/sdk/src/index.ts:195`

```ts
export interface RenderTextureReference extends ComputeTextureSize {
  id: string;
  format: "rgba32float";
}
```

## RenderTextureBindings

来源：`packages/sdk/src/index.ts:199`

```ts
export interface RenderTextureBindings {
  bind(target: string, name: string, texture: ComputeTextureHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderTextureReference>>;
}
```

## PostProcessState

来源：`packages/sdk/src/index.ts:204`

```ts
export interface PostProcessState {
  id: string;
  enabled: boolean;
  parameters: Readonly<Record<string, GraphValue>>;
}
```

## PostProcessService

来源：`packages/sdk/src/index.ts:209`

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

来源：`packages/sdk/src/index.ts:219`

```ts
export interface ComputeBufferHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
}
```

## ComputeTaskHandle

来源：`packages/sdk/src/index.ts:224`

```ts
export interface ComputeTaskHandle {
  readonly owner: number;
  readonly id: number;
}
```

## ComputeBufferInput

来源：`packages/sdk/src/index.ts:228`

```ts
export interface ComputeBufferInput {
  id: string;
  type: GraphType;
  count: number;
  data?: readonly GraphValue[];
}
```

## ComputeTextureHandle

来源：`packages/sdk/src/index.ts:234`

```ts
export interface ComputeTextureHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
  readonly kind: "texture";
}
```

## ComputeTextureSize

来源：`packages/sdk/src/index.ts:240`

```ts
export interface ComputeTextureSize {
  width: number;
  height: number;
}
```

## ComputeTextureDataInput

来源：`packages/sdk/src/index.ts:244`

```ts
export interface ComputeTextureDataInput extends ComputeTextureSize {
  id: string;
  /** Linear rgba32float texels in row-major order, without color-space conversion. */
  data?: readonly Vec4[];
  asset?: never;
}
```

## ComputeTextureAssetInput

来源：`packages/sdk/src/index.ts:250`

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

来源：`packages/sdk/src/index.ts:257`

```ts
export type ComputeTextureInput = ComputeTextureDataInput | ComputeTextureAssetInput;
```

## ComputeTextureBinding

来源：`packages/sdk/src/index.ts:258`

```ts
export interface ComputeTextureBinding {
  name: string;
  filter?: "nearest" | "linear";
  wrapU?: "clamp" | "repeat" | "mirror";
  wrapV?: "clamp" | "repeat" | "mirror";
}
```

## ComputeDispatchInput

来源：`packages/sdk/src/index.ts:264`

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

来源：`packages/sdk/src/index.ts:276`

```ts
export interface ComputeTaskState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code: string; message: string; remediation: string };
}
```

## ComputeService

来源：`packages/sdk/src/index.ts:280`

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

来源：`packages/sdk/src/index.ts:300`

```ts
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
```

## PhysicsService

来源：`packages/sdk/src/index.ts:306`

```ts
export interface PhysicsService {
  moveCharacter(entity: string, displacement: Vec3): void;
  grounded(entity: string): boolean;
  velocity(entity: string): Vec3;
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
}
```

## AnimationService

来源：`packages/sdk/src/index.ts:326`

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

来源：`packages/sdk/src/index.ts:338`

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

来源：`packages/sdk/src/index.ts:351`

```ts
export interface UIService {
  setText(id: string, text: string): void;
  setProgress(id: string, value: number): void;
  setVisible(id: string, visible: boolean): void;
}
```

## AudioService

来源：`packages/sdk/src/index.ts:356`

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

来源：`packages/sdk/src/index.ts:371`

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

来源：`packages/sdk/src/index.ts:380`

```ts
export interface SceneService {
  current(): string;
  load(id: string): void;
}
```

## ModelDefinition

来源：`packages/sdk/src/index.ts:384`

```ts
export interface ModelDefinition {
  /** Optional whole-model material override; omitted keeps the asset's original materials. */
  material?: MaterialDefinition | string;
  /** Replace all asset material slots with the given exact material name. Mutually exclusive with material. */
  materialSlots?: Record<string, MaterialDefinition | string>;
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

来源：`packages/sdk/src/index.ts:397`

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

来源：`packages/sdk/src/index.ts:411`

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

来源：`packages/sdk/src/index.ts:419`

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

来源：`packages/sdk/src/index.ts:432`

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

来源：`packages/sdk/src/index.ts:439`

```ts
export interface AudioBusDefinition {
  id: string;
  volume?: number;
}
```

## SYSTEM_PHASES

来源：`packages/sdk/src/index.ts:443`

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

来源：`packages/sdk/src/index.ts:451`

```ts
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
```

## Geometry

来源：`packages/sdk/src/index.ts:452`

```ts
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
```

## GRAPH_TYPES

来源：`packages/sdk/src/index.ts:456`

```ts
GRAPH_TYPES = ["float", "vec2", "vec3", "vec4", "bool"] as const
```

## GraphType

来源：`packages/sdk/src/index.ts:457`

```ts
export type GraphType = typeof GRAPH_TYPES[number];
```

## GraphValue

来源：`packages/sdk/src/index.ts:458`

```ts
export type GraphValue = number | boolean | Vec2 | Vec3 | Vec4;
```

## GraphParameter

来源：`packages/sdk/src/index.ts:459`

```ts
export interface GraphParameter {
  name: string;
  type: GraphType;
  default: GraphValue;
}
```

## GRAPH_INPUT_TYPES

来源：`packages/sdk/src/index.ts:464`

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

来源：`packages/sdk/src/index.ts:471`

```ts
export type GraphInputName = keyof typeof GRAPH_INPUT_TYPES;
```

## GRAPH_OPERATIONS

来源：`packages/sdk/src/index.ts:472`

```ts
GRAPH_OPERATIONS = {
  unary: ["sin", "cos", "abs", "floor", "ceil", "fract", "negate", "saturate", "normalize", "length", "safeSqrt"] as const,
  binary: ["add", "subtract", "multiply", "safeDivide", "min", "max", "dot", "cross", "step", "lessThan", "lessEqual", "greaterThan", "greaterEqual", "equal", "and", "or"] as const,
  ternary: ["mix", "clamp", "smoothstep", "select"] as const,
} as const
```

## GraphNode

来源：`packages/sdk/src/index.ts:477`

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

来源：`packages/sdk/src/index.ts:497`

```ts
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
  parameters?: readonly GraphParameter[];
}
```

## MaterialGraphs

来源：`packages/sdk/src/index.ts:502`

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

来源：`packages/sdk/src/index.ts:511`

```ts
export interface VertexGraphs {
  /** Absolute object-local position after built-in morph, skin and instance transforms. */
  position?: Graph;
  /** Unsided object-local normal in the same domain; zero keeps the normalized input normal. */
  normal?: Graph;
}
```

## MaterialInput

来源：`packages/sdk/src/index.ts:517`

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

来源：`packages/sdk/src/index.ts:544`

```ts
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
```

## PostProcessInput

来源：`packages/sdk/src/index.ts:547`

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

来源：`packages/sdk/src/index.ts:555`

```ts
export interface PostProcessDefinition extends PostProcessInput {
  readonly kind: "postprocess";
}
```

## ComputeInput

来源：`packages/sdk/src/index.ts:558`

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

来源：`packages/sdk/src/index.ts:567`

```ts
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
```

## AssetInput

来源：`packages/sdk/src/index.ts:570`

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

来源：`packages/sdk/src/index.ts:580`

```ts
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
```

## MeshDefinition

来源：`packages/sdk/src/index.ts:583`

```ts
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
```

## LightDefinition

来源：`packages/sdk/src/index.ts:589`

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

来源：`packages/sdk/src/index.ts:604`

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

来源：`packages/sdk/src/index.ts:616`

```ts
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
```

## PrefabDefinition

来源：`packages/sdk/src/index.ts:619`

```ts
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
```

## SceneInput

来源：`packages/sdk/src/index.ts:622`

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

来源：`packages/sdk/src/index.ts:647`

```ts
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
```

## SystemInput

来源：`packages/sdk/src/index.ts:650`

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

来源：`packages/sdk/src/index.ts:660`

```ts
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
```

## GameInput

来源：`packages/sdk/src/index.ts:663`

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

来源：`packages/sdk/src/index.ts:682`

```ts
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
```

## GameInstance

来源：`packages/sdk/src/index.ts:685`

```ts
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
```

## defineComponent

来源：`packages/sdk/src/index.ts:689`

```ts
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S>;
```

## defineMaterial

来源：`packages/sdk/src/index.ts:695`

```ts
export function defineMaterial(input: MaterialInput): MaterialDefinition;
```

## definePostProcess

来源：`packages/sdk/src/index.ts:698`

```ts
export function definePostProcess(input: PostProcessInput): PostProcessDefinition;
```

## defineCompute

来源：`packages/sdk/src/index.ts:701`

```ts
export function defineCompute(input: ComputeInput): ComputeDefinition;
```

## defineAsset

来源：`packages/sdk/src/index.ts:704`

```ts
export function defineAsset(input: AssetInput): AssetDefinition;
```

## definePrefab

来源：`packages/sdk/src/index.ts:707`

```ts
export function definePrefab(input: PrefabInput): PrefabDefinition;
```

## defineScene

来源：`packages/sdk/src/index.ts:710`

```ts
export function defineScene(input: SceneInput): SceneDefinition;
```

## defineSystem

来源：`packages/sdk/src/index.ts:713`

```ts
export function defineSystem(input: SystemInput): SystemDefinition;
```

## defineGame

来源：`packages/sdk/src/index.ts:716`

```ts
export function defineGame(input: GameInput): GameDefinition;
```

## instantiateGame

来源：`packages/sdk/src/index.ts:720`

```ts
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance;
```
