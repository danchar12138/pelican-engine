/** M0 sidecar only: these are experimental contracts, not the production SDK. */
export type ChunkCoord = [number, number];
export type Vec3 = [number, number, number];
export interface WorldOrigin {
  chunk: ChunkCoord;
  offset: Vec3;
}
export interface WorldPoint {
  chunk: ChunkCoord;
  local: Vec3;
}
export interface WorldConfig {
  seed: number;
  chunkSize: number;
  cellsPerChunk: number;
  bounds: { min: ChunkCoord; max: ChunkCoord };
  navMaxStep: number;
}
export interface HeightEdit {
  chunk: ChunkCoord;
  x: number;
  z: number;
  height: number;
}
export interface ChunkData {
  id: string;
  coord: ChunkCoord;
  version: number;
  heights: number[];
}
export interface WorldSnapshot {
  format: "pelican-m0-world";
  version: 1;
  config: WorldConfig;
  origin: WorldOrigin;
  /** Global integer grid vertex coordinates; shared borders have one persistent value. */
  edits: { vertex: ChunkCoord; height: number }[];
  revisions: { coord: ChunkCoord; version: number }[];
  resident: ChunkData[];
}
export interface WorldRenderState {
  epoch: number;
  origin: WorldOrigin;
  chunks: {
    id: string;
    coord: ChunkCoord;
    version: number;
    positions: number[];
    indices: number[];
  }[];
}
export interface WorldCollisionState {
  epoch: number;
  origin: WorldOrigin;
  chunks: {
    id: string;
    coord: ChunkCoord;
    version: number;
    heights: number[];
    cells: number;
    cellSize: number;
    offset: Vec3;
  }[];
}
export interface NavigationNode {
  id: string;
  coord: ChunkCoord;
  cell: ChunkCoord;
  height: number;
  position: Vec3;
  neighbors: string[];
}
export interface WorldNavigationState {
  epoch: number;
  origin: WorldOrigin;
  versions: { id: string; version: number }[];
  nodes: NavigationNode[];
  blockedCells: number;
}
export interface NavigationAddress {
  chunk: ChunkCoord;
  cell: ChunkCoord;
}
export interface PathResult {
  epoch: number;
  found: boolean;
  visited: number;
  nodes: NavigationNode[];
}
export type TransactionReason =
  | "load"
  | "unload"
  | "edit"
  | "restore"
  | "origin";
export interface WorldTransaction {
  epoch: number;
  reason: TransactionReason;
  config: WorldConfig;
  origin: WorldOrigin;
  /** Complete prospective resident set, not a delta. Small finite prototype only. */
  chunks: ChunkData[];
}
export interface PreparedWorldUpdate {
  /** Must be synchronous, must not notify observers / reenter the world. */
  commit(): void;
  /** Must undo even a partially failed commit; synchronous and nonthrowing. */
  rollback(): void;
  /** Release uncommitted preparation; synchronous and nonthrowing. */
  discard(): void;
}
export interface WorldAdapter {
  name: string;
  prepare(
    transaction: WorldTransaction,
  ): PreparedWorldUpdate | Promise<PreparedWorldUpdate>;
  dispose?(): void;
}
export interface WorldProbeOptions {
  seed?: number;
  chunkSize?: number;
  cellsPerChunk?: number;
  bounds?: WorldConfig["bounds"];
  origin?: WorldOrigin;
  navMaxStep?: number;
  /** Optional async I/O scheduling hook. Real seeded height/mesh generation follows it. */
  beforeBuild?: (
    request: { coord: ChunkCoord; generation: number; version: number },
    signal: AbortSignal,
  ) => Promise<void>;
  /** Optional extra consumers in addition to built-in render / physics / navigation. */
  adapters?: WorldAdapter[];
}
export interface ChunkLoadResult {
  status: "loaded" | "already-loaded" | "cancelled" | "stale";
  id: string;
  generation: number;
  version: number;
}
export interface WorldInspection {
  disposed: boolean;
  faulted: boolean;
  epoch: number;
  origin: WorldOrigin;
  resident: { id: string; version: number }[];
  pending: { id: string; generation: number }[];
  persistentEdits: number;
  persistentRevisions: number;
  consumers: {
    renderEpoch: number;
    physicsEpoch: number;
    navEpoch: number;
    consistent: boolean;
    mismatches: string[];
  };
  metrics: {
    loadRequests: number;
    cancelledLoads: number;
    staleResults: number;
    committedTransactions: number;
    failedTransactions: number;
    discardedPreparations: number;
    prepareWallMs: number;
    commitWallMs: number;
  };
  resources: {
    residentHeightValues: number;
    renderScalars: number;
    collisionHeightValues: number;
    navNodes: number;
    navEdges: number;
  };
}
export interface WorldProbe {
  loadChunk(coord: ChunkCoord): Promise<ChunkLoadResult>;
  cancelLoad(coord: ChunkCoord): boolean;
  unloadChunk(
    coord: ChunkCoord,
  ): Promise<{ status: "unloaded" | "absent" | "stale"; id: string }>;
  applyEdits(edits: HeightEdit[]): Promise<void>;
  setOrigin(origin: WorldOrigin): Promise<void>;
  snapshot(): WorldSnapshot;
  restore(snapshot: WorldSnapshot): Promise<void>;
  inspect(): WorldInspection;
  getRenderState(): WorldRenderState;
  getCollisionState(): WorldCollisionState;
  getNavigationState(): WorldNavigationState;
  sampleHeight(
    point: WorldPoint,
  ): { height: number; chunkId: string; version: number } | null;
  findPath(start: NavigationAddress, goal: NavigationAddress): PathResult;
  toLocal(point: WorldPoint): Vec3;
  fromLocal(point: Vec3): WorldPoint;
  dispose(): void;
}
