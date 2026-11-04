import type {
  ComponentSchema,
  Geometry,
  Graph,
  GraphType,
  LightDefinition,
  Transform,
  Vec3,
} from "../../packages/sdk/src/index.ts";
export const IR_VERSION = 1 as const;
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
  components: Record<string, Record<string, unknown>>;
}
export interface SceneIR {
  format: "threecat.scene";
  version: 1;
  engineVersion: string;
  gameId: string;
  scene: {
    id: string;
    camera: {
      position: Vec3;
      target: Vec3;
      fov: number;
      near: number;
      far: number;
    };
    environment: { background: string; ambientIntensity: number };
    entities: EntityIR[];
  };
  components: { id: string; schema: ComponentSchema; source: SourceLocation }[];
  prefabs: EntityIR[];
  materials: {
    id: string;
    color: string;
    roughness: number;
    metalness: number;
    texture?: string;
    graph?: GraphIR;
    source: SourceLocation;
  }[];
  computes: {
    id: string;
    count: number;
    workgroupSize: number;
    graph: GraphIR;
    outputType: GraphType;
    source: SourceLocation;
  }[];
  systems: { id: string; phase: "update"; source: SourceLocation }[];
  assets: {
    id: string;
    type: "texture" | "binary";
    path: string;
    sourcePath: string;
    hash: string;
    source: SourceLocation;
  }[];
}
export interface CompileOptions {
  projectRoot: string;
  outDir: string;
  engineRoot?: string;
}
export interface BuildReport {
  format: "threecat.build-report";
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
