/** Pelican Engine public API. No renderer or GPU implementation types escape this module. */
export const SDK_VERSION = "0.3.9";
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}
export type TransformPatch = Partial<Transform>;
export type Field =
  | { type: "number"; default: number }
  | { type: "boolean"; default: boolean }
  | { type: "string"; default: string }
  | { type: "vec3"; default: Vec3 };
export type ComponentSchema = Readonly<Record<string, Field>>;
export interface ComponentDefinition<
  S extends ComponentSchema = ComponentSchema,
> {
  readonly kind: "component";
  readonly id: string;
  readonly schema: S;
}
export type ComponentValue<S extends ComponentSchema> = {
  -readonly [K in keyof S]: S[K]["type"] extends "number"
    ? number
    : S[K]["type"] extends "boolean"
      ? boolean
      : S[K]["type"] extends "vec3"
        ? Vec3
        : string;
};
export type ComponentData = Record<string, number | boolean | string | Vec3>;
export interface ComponentInstance {
  component: ComponentDefinition | string;
  value?: ComponentData;
}
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
export interface EntityHandle {
  readonly world: number;
  readonly index: number;
  readonly generation: number;
}
export type EntityRef = string | EntityHandle;
export interface SpawnInput {
  id: string;
  prefab?: string;
  parent?: string;
  transform?: TransformPatch;
  components?: Record<string, ComponentData>;
}
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
export interface GameEvent {
  readonly type: string;
  readonly tick: number;
  readonly sequence: number;
  readonly payload: unknown;
}
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
/** Integer cells on a finite 2D orthogonal grid; not continuous, flying or underwater navigation.
 * Searches allocate sparse state and depend on available memory. At most 2^32-1 cells may be defined.
 * Owners are explicit strings and are not automatically tied to entities. */
export interface NavigationCell { readonly x: number; readonly y: number }
/** One obstacle change for an orthogonal navigation grid. */
export interface NavigationObstacleUpdate { readonly cell: NavigationCell; readonly blocked: boolean }
export interface NavigationGrid {
  readonly id: string;
  readonly owner: string;
  readonly width: number;
  readonly height: number;
  readonly blocked?: readonly NavigationCell[];
  /** Maximum distinct search cells, including endpoints; defaults to 65536. Raising it increases memory and CPU use. */
  readonly searchCellBudget?: number;
}
export interface NavigationService {
  createGrid(grid: NavigationGrid): void;
  /** Returns a detached description, including the current blocked cells. */
  getGrid(id: string): NavigationGrid;
  isBlocked(id: string, cell: NavigationCell): boolean;
  setBlocked(id: string, cell: NavigationCell, blocked: boolean): void;
  /** Validates the entire batch before committing; the last change for a repeated cell wins. */
  setBlockedBatch(id: string, updates: readonly NavigationObstacleUpdate[]): void;
  findPath(id: string, start: NavigationCell, end: NavigationCell): readonly NavigationCell[];
  destroyGrid(id: string): void;
  destroyOwner(owner: string): void;
}
export type RenderMode = "raster" | "hybrid" | "path";
export interface RenderCapabilities {
  backend: "webgpu" | "webgl2" | "uninitialized";
  compute: boolean;
  availableModes: readonly RenderMode[];
}
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
export interface MaterialBufferInput {
  /** Shared slot declaration for material and postprocess graphs. */
  name: string;
  type: GraphType;
  /** Optional initial logical compute-buffer ID. */
  buffer?: string;
  /** Optional exact element count required by this slot. */
  count?: number;
}
export interface RenderBufferReference {
  id: string;
  type: GraphType;
  count: number;
}
export interface RenderBufferBindings {
  bind(target: string, name: string, buffer: ComputeBufferHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderBufferReference>>;
}
export interface MaterialTextureInput extends ComputeTextureBinding {
  /** Initial managed texture ID; asset import uses computeTextures/createTexture. */
  texture?: string;
  width?: number;
  height?: number;
}
export interface RenderTextureReference extends ComputeTextureSize {
  id: string;
  format: "rgba32float";
}
export interface RenderTextureBindings {
  bind(target: string, name: string, texture: ComputeTextureHandle): void;
  unbind(target: string, name: string): void;
  state(target: string): Readonly<Record<string, RenderTextureReference>>;
}
export interface PostProcessState {
  id: string;
  enabled: boolean;
  parameters: Readonly<Record<string, GraphValue>>;
}
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
export interface ComputeBufferHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
}
export interface ComputeTaskHandle {
  readonly owner: number;
  readonly id: number;
}
export interface ComputeBufferInput {
  id: string;
  type: GraphType;
  count: number;
  data?: readonly GraphValue[];
}
export interface ComputeTextureHandle {
  readonly owner: number;
  readonly index: number;
  readonly generation: number;
  readonly kind: "texture";
}
export interface ComputeTextureSize {
  width: number;
  height: number;
}
export interface ComputeTextureDataInput extends ComputeTextureSize {
  id: string;
  /** Linear rgba32float texels in row-major order, without color-space conversion. */
  data?: readonly Vec4[];
  asset?: never;
}
export interface ComputeTextureAssetInput {
  id: string;
  asset: AssetDefinition | string;
  width?: never;
  height?: never;
  data?: never;
}
export type ComputeTextureInput = ComputeTextureDataInput | ComputeTextureAssetInput;
export interface ComputeTextureBinding {
  name: string;
  filter?: "nearest" | "linear";
  wrapU?: "clamp" | "repeat" | "mirror";
  wrapV?: "clamp" | "repeat" | "mirror";
}
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
export interface ComputeTaskState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error?: { code: string; message: string; remediation: string };
}
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
export interface InputService {
  held(action: string): boolean;
  pressed(action: string): boolean;
  released(action: string): boolean;
  axis(negative: string, positive: string): number;
}
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
export interface UIService {
  setText(id: string, text: string): void;
  setProgress(id: string, value: number): void;
  setVisible(id: string, visible: boolean): void;
}
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
export interface StorageService {
  save(slot: string): void;
  load(slot: string): void;
  status(): {
    state: "idle" | "saving" | "loading" | "saved" | "loaded" | "failed";
    slot: string | null;
    error: string | null;
  };
}
export interface SceneService {
  current(): string;
  load(id: string): void;
}
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
export interface CharacterDefinition {
  radius: number;
  height: number;
  speed: number;
  jumpSpeed?: number;
  /** Downward acceleration magnitude in world units/s^2; defaults to 9.81. Scene.gravity is a signed vector. */
  gravity?: number;
}
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
export interface SoundDefinition {
  id: string;
  asset: AssetDefinition | string;
  volume?: number;
  loop?: boolean;
  bus?: string;
}
export interface AudioBusDefinition {
  id: string;
  volume?: number;
}
export const SYSTEM_PHASES = [
  "input",
  "prePhysics",
  "physics",
  "postPhysics",
  "update",
  "presentation",
] as const;
export type SystemPhase = (typeof SYSTEM_PHASES)[number];
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
export const GRAPH_TYPES = ["float", "vec2", "vec3", "vec4", "bool"] as const;
export type GraphType = typeof GRAPH_TYPES[number];
export type GraphValue = number | boolean | Vec2 | Vec3 | Vec4;
export interface GraphParameter {
  name: string;
  type: GraphType;
  default: GraphValue;
}
export const GRAPH_INPUT_TYPES = {
  uv: "vec2", uv1: "vec2", positionWorld: "vec3", normalWorld: "vec3",
  viewDirectionWorld: "vec3", vertexColor: "vec4", index: "float",
  screenSize: "vec2", texelSize: "vec2",
  pixelCoord: "vec2", outputSize: "vec2",
  positionLocal: "vec3", normalLocal: "vec3", vertexIndex: "float", instanceIndex: "float",
} as const;
export type GraphInputName = keyof typeof GRAPH_INPUT_TYPES;
export const GRAPH_OPERATIONS = {
  unary: ["sin", "cos", "abs", "floor", "ceil", "fract", "negate", "saturate", "normalize", "length", "safeSqrt"] as const,
  binary: ["add", "subtract", "multiply", "safeDivide", "min", "max", "dot", "cross", "step", "lessThan", "lessEqual", "greaterThan", "greaterEqual", "equal", "and", "or"] as const,
  ternary: ["mix", "clamp", "smoothstep", "select"] as const,
} as const;
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
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
  parameters?: readonly GraphParameter[];
}
export interface MaterialGraphs {
  baseColor?: Graph;
  emissive?: Graph;
  roughness?: Graph;
  metalness?: Graph;
  opacity?: Graph;
  /** Absolute, unsided world-space normal; engine applies material boundary orientation. */
  normalWorld?: Graph;
}
export interface VertexGraphs {
  /** Absolute object-local position after built-in morph, skin and instance transforms. */
  position?: Graph;
  /** Unsided object-local normal in the same domain; zero keeps the normalized input normal. */
  normal?: Graph;
}
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
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
export interface PostProcessInput {
  id: string;
  buffers?: readonly MaterialBufferInput[];
  textures?: readonly MaterialTextureInput[];
  /** Linear HDR vec4 output. Frame channels: scene.color, scene.normal, scene.depth, or an earlier pass ID. */
  graph: Graph;
  enabled?: boolean;
}
export interface PostProcessDefinition extends PostProcessInput {
  readonly kind: "postprocess";
}
export interface ComputeInput {
  id: string;
  graph: Graph;
  outputType: GraphType;
  count: number;
  workgroupSize?: number;
  buffers?: readonly { name: string; type: GraphType }[];
  textures?: readonly ComputeTextureBinding[];
}
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
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
export interface AssetDefinition extends AssetInput {
  readonly kind: "asset";
}
export interface MeshDefinition {
  geometry: Geometry;
  material: MaterialDefinition | string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}
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
export interface PrefabInput extends Omit<EntityInput, "prefab" | "parent"> {
  extends?: PrefabDefinition | string;
}
export interface PrefabDefinition extends PrefabInput {
  readonly kind: "prefab";
}
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
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
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
export interface SystemDefinition extends SystemInput {
  readonly kind: "system";
}
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
export interface GameDefinition extends GameInput {
  readonly kind: "game";
}
export interface GameInstance {
  update(dt: number): void;
  dispose(): void;
}
export function defineComponent<const S extends ComponentSchema>(input: {
  id: string;
  schema: S;
}): ComponentDefinition<S> {
  return { ...input, kind: "component" };
}
export function defineMaterial(input: MaterialInput): MaterialDefinition {
  return { ...input, kind: "material" };
}
export function definePostProcess(input: PostProcessInput): PostProcessDefinition {
  return { ...input, kind: "postprocess" };
}
export function defineCompute(input: ComputeInput): ComputeDefinition {
  return { ...input, kind: "compute" };
}
export function defineAsset(input: AssetInput): AssetDefinition {
  return { ...input, kind: "asset" };
}
export function definePrefab(input: PrefabInput): PrefabDefinition {
  return { ...input, kind: "prefab" };
}
export function defineScene(input: SceneInput): SceneDefinition {
  return { ...input, kind: "scene" };
}
export function defineSystem(input: SystemInput): SystemDefinition {
  return { ...input, kind: "system" };
}
export function defineGame(input: GameInput): GameDefinition {
  return { ...input, kind: "game" };
}
/** Runtime wrapper used by compiled game.js. Source declarations are never imported by the compiler. */
export function instantiateGame(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance {
  let disposed = false;
  const systems = [...(game.systems ?? [])];
  engine.configureGameSystems?.(systems);
  return {
    update(dt) {
      if (disposed)
        throw new Error("TC_RUNTIME_DISPOSED: Game has been disposed.");
      if (!Number.isFinite(dt) || dt < 0)
        throw new Error(
          "TC_RUNTIME_DT: Expected a finite, non-negative timestep.",
        );
      if (engine.runGameSystems) engine.runGameSystems(systems, dt);
      else {
        // Compatibility for the M0 facade harness; the M1 browser host always owns scheduling.
        const context = new Proxy(engine, {
          get(target, key, receiver) {
            if (
              ["time", "entities", "random", "emit", "events"].includes(
                String(key),
              )
            )
              throw new Error(
                `TC_RUNTIME_SERVICE_UNAVAILABLE: ${String(key)} requires a pelican runtime host.`,
              );
            return Reflect.get(target, key, receiver);
          },
        }) as SystemContext;
        for (const system of systems) system.run(context, dt);
      }
    },
    dispose() {
      disposed = true;
      systems.length = 0;
    },
  };
}
