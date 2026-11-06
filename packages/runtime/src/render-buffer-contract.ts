import type { ComputeBufferHandle, RenderBufferReference } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "./compute-contract.ts";

/** Private CPU identity bridge. Native GPU resources remain renderer-owned APIs. */
export interface RenderBufferProvider {
  describe(handle: ComputeBufferHandle): RenderBufferReference;
  resource(id: string): ComputeExecutionInput;
  /** Single render owner publishes logical pins; restore may set these before peer buffers restore. */
  setPins(ids: readonly string[]): void;
}
