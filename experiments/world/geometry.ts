import type {
  ChunkCoord,
  ChunkData,
  NavigationAddress,
  Vec3,
  WorldCollisionState,
  WorldConfig,
  WorldNavigationState,
  WorldOrigin,
  WorldPoint,
  WorldRenderState,
  WorldTransaction,
} from "./types.ts";
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const key = (c: ChunkCoord): string => `${c[0]}:${c[1]}`;
export const chunkId = (c: ChunkCoord): string => `chunk:${key(c)}`;
export function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}
export const vector = (v: unknown, length: number): v is number[] =>
  Array.isArray(v) &&
  v.length === length &&
  v.every((n) => typeof n === "number" && Number.isFinite(n));
export const coordValid = (v: unknown): v is ChunkCoord =>
  vector(v, 2) && v.every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 1e9);
export function inside(c: ChunkCoord, config: WorldConfig): boolean {
  return c.every(
    (n, i) => n >= config.bounds.min[i] && n <= config.bounds.max[i],
  );
}
export function assertCoord(c: ChunkCoord, config: WorldConfig): void {
  if (!coordValid(c) || !inside(c, config))
    fail(
      "WORLD_COORD",
      "Expected an integer chunk coordinate inside configured bounds.",
    );
}
export function assertOrigin(o: WorldOrigin, config: WorldConfig): void {
  if (
    !o ||
    !coordValid(o.chunk) ||
    !vector(o.offset, 3) ||
    o.offset.some((n) => Math.abs(n) > config.chunkSize)
  )
    fail(
      "WORLD_ORIGIN",
      "Expected a chunk coordinate and finite local offset within one chunk size.",
    );
}
export function vertexKey(
  c: ChunkCoord,
  x: number,
  z: number,
  n: number,
): string {
  return key([c[0] * n + x, c[1] * n + z]);
}
export function baseHeight(gx: number, gz: number, seed: number): number {
  let h = Math.imul(gx | 0, 73856093) ^ Math.imul(gz | 0, 19349663) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295 - 0.5) * 0.12;
}
export function buildChunk(
  c: ChunkCoord,
  version: number,
  config: WorldConfig,
  edits: ReadonlyMap<string, number>,
): ChunkData {
  const n = config.cellsPerChunk,
    heights: number[] = [];
  for (let z = 0; z <= n; z++)
    for (let x = 0; x <= n; x++)
      heights.push(
        edits.get(vertexKey(c, x, z, n)) ??
          baseHeight(c[0] * n + x, c[1] * n + z, config.seed),
      );
  return { id: chunkId(c), coord: [...c], version, heights };
}
export function affectedChunks(
  vertex: ChunkCoord,
  config: WorldConfig,
): ChunkCoord[] {
  const n = config.cellsPerChunk;
  const candidates = (v: number): number[] =>
    v % n === 0 ? [v / n - 1, v / n] : [Math.floor(v / n)];
  const result: ChunkCoord[] = [];
  for (const x of candidates(vertex[0]))
    for (const z of candidates(vertex[1]))
      if (inside([x, z], config)) result.push([x, z]);
  return result;
}
export function localPoint(
  point: WorldPoint,
  origin: WorldOrigin,
  config: WorldConfig,
): Vec3 {
  return [
    (point.chunk[0] - origin.chunk[0]) * config.chunkSize +
      point.local[0] -
      origin.offset[0],
    point.local[1] - origin.offset[1],
    (point.chunk[1] - origin.chunk[1]) * config.chunkSize +
      point.local[2] -
      origin.offset[2],
  ];
}
export function normalizePoint(
  point: WorldPoint,
  config: WorldConfig,
): WorldPoint {
  const dx = Math.floor(point.local[0] / config.chunkSize),
    dz = Math.floor(point.local[2] / config.chunkSize);
  return {
    chunk: [point.chunk[0] + dx, point.chunk[1] + dz],
    local: [
      point.local[0] - dx * config.chunkSize,
      point.local[1],
      point.local[2] - dz * config.chunkSize,
    ],
  };
}
export function heightAt(
  heights: number[],
  n: number,
  x: number,
  z: number,
): number {
  const ix = Math.min(n - 1, Math.max(0, Math.floor(x))),
    iz = Math.min(n - 1, Math.max(0, Math.floor(z)));
  const fx = x - ix,
    fz = z - iz,
    a = iz * (n + 1) + ix;
  const ha = heights[a],
    hb = heights[a + 1],
    hc = heights[a + n + 1],
    hd = heights[a + n + 2];
  return fx + fz <= 1
    ? ha + (hb - ha) * fx + (hc - ha) * fz
    : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}
export function renderBuild(t: WorldTransaction): WorldRenderState {
  const n = t.config.cellsPerChunk,
    step = t.config.chunkSize / n;
  return {
    epoch: t.epoch,
    origin: clone(t.origin),
    chunks: t.chunks.map((c) => {
      const positions: number[] = [],
        indices: number[] = [];
      for (let z = 0; z <= n; z++)
        for (let x = 0; x <= n; x++)
          positions.push(
            ...localPoint(
              {
                chunk: c.coord,
                local: [x * step, c.heights[z * (n + 1) + x], z * step],
              },
              t.origin,
              t.config,
            ),
          );
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const a = z * (n + 1) + x;
          indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
        }
      return {
        id: c.id,
        coord: [...c.coord],
        version: c.version,
        positions,
        indices,
      };
    }),
  };
}
export function collisionBuild(t: WorldTransaction): WorldCollisionState {
  return {
    epoch: t.epoch,
    origin: clone(t.origin),
    chunks: t.chunks.map((c) => ({
      id: c.id,
      coord: [...c.coord],
      version: c.version,
      heights: [...c.heights],
      cells: t.config.cellsPerChunk,
      cellSize: t.config.chunkSize / t.config.cellsPerChunk,
      offset: localPoint(
        { chunk: c.coord, local: [0, 0, 0] },
        t.origin,
        t.config,
      ),
    })),
  };
}
export const navId = (a: NavigationAddress): string =>
  `${chunkId(a.chunk)}/cell:${a.cell[0]}:${a.cell[1]}`;
export function navBuild(t: WorldTransaction): WorldNavigationState {
  const n = t.config.cellsPerChunk,
    step = t.config.chunkSize / n;
  const result: WorldNavigationState = {
    epoch: t.epoch,
    origin: clone(t.origin),
    versions: t.chunks.map((c) => ({ id: c.id, version: c.version })),
    nodes: [],
    blockedCells: 0,
  };
  const grid = new Map<string, WorldNavigationState["nodes"][number]>();
  for (const c of t.chunks)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const a = z * (n + 1) + x,
          hs = [
            c.heights[a],
            c.heights[a + 1],
            c.heights[a + n + 1],
            c.heights[a + n + 2],
          ];
        if (Math.max(...hs) - Math.min(...hs) > t.config.navMaxStep) {
          result.blockedCells++;
          continue;
        }
        const height = heightAt(c.heights, n, x + 0.5, z + 0.5);
        const node = {
          id: navId({ chunk: c.coord, cell: [x, z] }),
          coord: [...c.coord] as ChunkCoord,
          cell: [x, z] as ChunkCoord,
          height,
          position: localPoint(
            {
              chunk: c.coord,
              local: [(x + 0.5) * step, height, (z + 0.5) * step],
            },
            t.origin,
            t.config,
          ),
          neighbors: [] as string[],
        };
        result.nodes.push(node);
        grid.set(key([c.coord[0] * n + x, c.coord[1] * n + z]), node);
      }
  for (const node of result.nodes)
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const other = grid.get(
        key([
          node.coord[0] * n + node.cell[0] + dx,
          node.coord[1] * n + node.cell[1] + dz,
        ]),
      );
      if (other && Math.abs(other.height - node.height) <= t.config.navMaxStep)
        node.neighbors.push(other.id);
    }
  return result;
}
