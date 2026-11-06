/** Renderer-internal HDR output targets, never exported by the game SDK. */
export interface TracePresentationTargets {
  color: GPUTexture;
  normal: GPUTexture;
  depth: GPUTexture;
}
