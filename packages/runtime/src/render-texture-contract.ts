import type { ComputeTextureHandle, RenderTextureReference } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "./compute-contract.ts";

/** CPU-only bridge; native texture ownership stays in the renderer. */
export interface RenderTextureProvider {
  describe(handle: ComputeTextureHandle): RenderTextureReference;
  resource(id: string): ComputeExecutionInput;
  setPins(ids: readonly string[]): void;
}
