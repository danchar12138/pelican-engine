import type {
  ComponentSchema,
  Geometry,
  Graph,
  GraphType,
  GraphParameter,
  GraphInputName,
  MaterialGraphs,
  VertexGraphs,
  MaterialBufferInput,
  MaterialTextureInput,
  ComputeBufferInput,
  ComputeTextureInput,
  ComputeTextureBinding,
  LightDefinition,
  RigidBodyDefinition,
  CharacterDefinition,
  UIElementDefinition,
  Transform,
  Vec3,
  RenderSettings,
} from "../../sdk/src/index.ts";
export const IR_VERSION = 1 as const;
export { SYSTEM_PHASES } from "../../sdk/src/index.ts";
import type { SystemPhase } from "../../sdk/src/index.ts";
export type { SystemPhase } from "../../sdk/src/index.ts";
/** Missing access fields mean legacy unrestricted access, not an empty access set. */
export interface SystemIR {
  id: string;
  phase: SystemPhase;
  before?: string[];
  after?: string[];
  reads?: string[];
  writes?: string[];
  structural?: boolean;
  source: SourceLocation;
}
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  length: number;
}
export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  suggestion: string;
  source?: SourceLocation;
}
export interface GraphIR extends Graph {
  outputType: GraphType;
  nodeTypes: Record<string, GraphType>;
  requiredInputs?: GraphInputName[];
  textureIds?: string[];
  textureSlots?: Record<string, ComputeTextureBinding>;
  bufferTypes?: Record<string, GraphType>;
  frameChannels?: string[];
  historyChannels?: string[];
}
export interface PostProcessIR {
  id: string;
  buffers?: readonly MaterialBufferInput[];
  textures?: readonly MaterialTextureInput[];
  enabled: boolean;
  graph: GraphIR;
  source: SourceLocation;
}
export interface EntityIR {
  id: string;
  parent?: string;
  prefab?: string;
  transform: Transform;
  mesh?: {
    geometry: Geometry;
    material: string;
    castShadow: boolean;
    receiveShadow: boolean;
  };
  light?: LightDefinition;
  model?: {
    material?: string;
    materialSlots?: Record<string, string>;
    castShadow?: boolean;
    receiveShadow?: boolean;
    asset: string;
    scale: number;
    offset?: Vec3;
    rotation?: Vec3;
    animation?: { clip: string; speed: number; loop: boolean };
  };
  rigidBody?: {
    type: RigidBodyDefinition["type"];
    collider: RigidBodyDefinition["collider"];
    mass: number;
    friction: number;
    restitution: number;
    trigger: boolean;
  };
  character?: CharacterDefinition & { jumpSpeed: number; gravity: number };
  components: Record<string, Record<string, unknown>>;
}
export interface SceneIR {
  format: "pelican.scene";
  version: 1;
  engineVersion: string;
  gameId: string;
  render?: RenderSettings;
  postProcesses?: PostProcessIR[];
  computeBuffers?: ComputeBufferInput[];
  computeTextures?: ComputeTextureInput[];
  scene: {
    id: string;
    camera: {
      position: Vec3;
      target: Vec3;
      fov: number;
      near: number;
      far: number;
    };
    environment: {
      background: string;
      ambientIntensity: number;
      lighting?: "none" | "studio";
    };
    follow?: {
      entity: string;
      distance: number;
      height: number;
      lookHeight: number;
      yaw: number;
      smoothing: number;
    };
    gravity: Vec3;
    entities: EntityIR[];
  };
  /** Additional resolved scenes; primary `scene` remains the default entry. */
  scenes?: SceneIR["scene"][];
  input?: Record<string, string[]>;
  ui?: {
    id: string;
    kind: "text" | "bar" | "button" | "input";
    text: string;
    value: number;
    visible: boolean;
    anchor:
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right"
      | "center";
    x: number;
    y: number;
    width: number;
    color: string;
    world?: { entity: string; offset: Vec3; occlude: boolean };
  }[];
  sounds?: { id: string; asset: string; volume: number; loop: boolean; bus?: string }[];
  audioBuses?: { id: string; volume: number }[];
  components: { id: string; schema: ComponentSchema; source: SourceLocation }[];
  prefabs: EntityIR[];
  materials: {
    id: string;
    color: string;
    roughness: number;
    metalness: number;
    texture?: string;
    graph?: GraphIR;
    graphs?: Partial<Record<keyof MaterialGraphs, GraphIR>>;
    vertex?: Partial<Record<keyof VertexGraphs, GraphIR>>;
    buffers?: MaterialBufferInput[];
    textures?: MaterialTextureInput[];
    parameters?: GraphParameter[];
    emissive?: string;
    emissiveIntensity?: number;
    opacity?: number;
    alphaTest?: number;
    side?: "front" | "back" | "double";
    transmission?: number;
    ior?: number;
    specularIntensity?: number;
    specularColor?: string;
    attenuationColor?: string;
    attenuationDistance?: number;
    source: SourceLocation;
  }[];
  computes: {
    id: string;
    count: number;
    workgroupSize: number;
    graph: GraphIR;
    outputType: GraphType;
    source: SourceLocation;
    buffers?: { name: string; type: GraphType }[];
    textures?: ComputeTextureBinding[];
  }[];
  systems: SystemIR[];
  assets: {
    id: string;
    type: "texture" | "binary" | "model" | "audio";
    path: string;
    sourcePath: string;
    hash: string;
    metadata?: Record<string, unknown>;
    colorSpace?: "srgb" | "linear";
    sourceInfo?: { source?: string; license?: string; attribution?: string };
    source: SourceLocation;
  }[];
  assetNotices?: {
    id: string;
    path: string;
    license: string | null;
    attribution?: string;
    source?: string;
  }[];
}
export interface CompileOptions {
  projectRoot: string;
  outDir: string;
  engineRoot?: string;
}
export interface BuildReport {
  format: "pelican.build-report";
  version: 1;
  success: boolean;
  engineVersion: string;
  compilerVersion: string;
  project: { id: string; entry: string };
  diagnostics: Diagnostic[];
  inputs: { path: string; root: "project" | "engine"; hash: string }[];
  outputs: string[];
  incremental: {
    cacheHit: boolean;
    changedInputs: string[];
    reused: string[];
    schemaHash: string;
    defaultsHash: string;
  };
  hotReload: {
    strategy: "cold-start" | "reuse" | "patch" | "restart";
    preserveState: boolean;
    defaults: "new-entities-only";
    reason: string;
  };
  modules: string[];
  limitations: string[];
  durationMs: number;
}
export interface CompileResult {
  success: boolean;
  diagnostics: Diagnostic[];
  report: BuildReport;
  ir?: SceneIR;
}
