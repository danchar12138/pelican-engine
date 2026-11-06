import type { GraphType, GraphValue, RenderCapabilities, ComputeBufferInput, ComputeTextureInput, ComputeTextureSize, Vec4 } from "../../sdk/src/index.ts";
import type { SceneIR } from "../../compiler/src/types.ts";

/** Engine-private plain-data boundary; no graphics handles cross into the game SDK. */
export interface ComputeExecutionInput {
  key: string;
  type: GraphType;
  revision: number;
  values: readonly GraphValue[];
  /** Present only for a managed linear rgba32float texture. */
  texture?: Readonly<ComputeTextureSize>;
  /** Owner-authenticated dispatch-time CPU checkpoint, never a render view or task result. */
  captured?: true;
}
export interface ComputeExecutionRequest {
  kernel: SceneIR["computes"][number];
  inputs: Readonly<Record<string, ComputeExecutionInput>>;
  textures?: Readonly<Record<string, ComputeExecutionInput>>;
  output: { key: string; type: GraphType; count: number; retain?: boolean; texture?: Readonly<ComputeTextureSize> };
  parameters: Readonly<Record<string, GraphValue>>;
  time: number;
  signal: AbortSignal;
}
export interface ComputeExecutor {
  run(request: ComputeExecutionRequest): Promise<readonly GraphValue[]>;
  release(key: string): void;
  dispose(): void;
  commit?(key: string, revision: number): void;
  discard?(key: string): void;
  collect?(live: readonly { key: string; revision: number }[]): void;
}
export interface ComputeDriverOptions {
  kernels: readonly SceneIR["computes"][number][];
  capabilities: () => RenderCapabilities;
  time?: () => number;
  executor?: ComputeExecutor;
  buffers?: readonly ComputeBufferInput[];
  textures?: readonly ComputeTextureInput[];
  textureAssets?: { resolve(asset: string): Readonly<ComputeTextureSize & { data: readonly Vec4[] }>; dispose(): void };
}
