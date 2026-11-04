/** threecat M0 public API. No renderer or GPU implementation types escape this module. */
export const SDK_VERSION = "0.0.1-m0.0";
export type Vec3 = readonly [number, number, number];
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
}
export type Geometry =
  | { kind: "box"; size?: Vec3 }
  | { kind: "sphere"; radius?: number; segments?: number }
  | { kind: "plane"; size?: readonly [number, number] };
export type GraphType = "float" | "vec3";
export type GraphNode =
  | { id: string; op: "float"; value: number }
  | { id: string; op: "vec3"; value: Vec3 }
  | { id: string; op: "time" }
  | { id: string; op: "add" | "multiply"; inputs: readonly [string, string] }
  | { id: string; op: "sin"; inputs: readonly [string] };
export interface Graph {
  nodes: readonly GraphNode[];
  output: string;
}
export interface MaterialInput {
  id: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  texture?: AssetDefinition | string;
  graph?: Graph;
}
export interface MaterialDefinition extends MaterialInput {
  readonly kind: "material";
}
export interface ComputeInput {
  id: string;
  graph: Graph;
  outputType: GraphType;
  count: number;
  workgroupSize?: number;
}
export interface ComputeDefinition extends ComputeInput {
  readonly kind: "compute";
}
export interface AssetInput {
  id: string;
  path: string;
  type: "texture" | "binary";
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
}
export interface EntityInput {
  id: string;
  prefab?: PrefabDefinition | string;
  parent?: string;
  transform?: TransformPatch;
  mesh?: MeshDefinition;
  light?: LightDefinition;
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
  environment?: { background?: string; ambientIntensity?: number };
  entities: readonly EntityInput[];
}
export interface SceneDefinition extends SceneInput {
  readonly kind: "scene";
}
export interface SystemInput {
  id: string;
  phase?: "update";
  run: (engine: EngineFacade, dt: number) => void;
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
  assets?: readonly AssetDefinition[];
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
  return {
    update(dt) {
      if (disposed)
        throw new Error("TC_RUNTIME_DISPOSED: Game has been disposed.");
      if (!Number.isFinite(dt) || dt < 0)
        throw new Error(
          "TC_RUNTIME_DT: Expected a finite, non-negative timestep.",
        );
      for (const system of systems) system.run(engine, dt);
    },
    dispose() {
      disposed = true;
      systems.length = 0;
    },
  };
}
