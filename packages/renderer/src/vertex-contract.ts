import type * as THREE from "three";
import type { Vec2, Vec3 } from "../../sdk/src/index.ts";

/** Private, post-morph/skin/instance and pre-world vertex domain. */
export interface VertexEvaluationInput {
  positionLocal: Vec3;
  normalLocal: Vec3;
  vertexIndex: number;
  instanceIndex: number;
  uv?: Vec2;
  uv1?: Vec2;
}
export interface VertexEvaluationResult {
  position: Vec3;
  normal?: Vec3;
}
export type VertexTextureSampler = (asset: string, uv: Vec2) => readonly [number, number, number, number];
export interface SurfaceVertexDeformer {
  evaluate(mesh: THREE.Mesh, materialUuid: string, input: VertexEvaluationInput): VertexEvaluationResult | undefined;
  /** Flat copied scalar state; changing graph inputs invalidates the mesh triangle cache. */
  signature(mesh: THREE.Mesh): readonly unknown[];
}
