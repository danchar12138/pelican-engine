import type { GraphType } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "../../runtime/src/compute-contract.ts";

/** Renderer-private committed GPU view, never part of the SDK or serialized state. */
export interface ComputeGpuView {
  buffer: GPUBuffer;
  type: GraphType;
  count: number;
  revision: number;
}
export interface ComputeResidentSource {
  resident(input: ComputeExecutionInput): ComputeGpuView;
}
export interface ComputeTextureGpuView {
  texture: GPUTexture;
  width: number;
  height: number;
  revision: number;
}
export interface ComputeTextureResidentSource {
  textureResident(input: ComputeExecutionInput): ComputeTextureGpuView;
}
