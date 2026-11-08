import type { TerrainGeometry, Vec2, Vec3 } from "../../sdk/src/index.ts";

const fail = (detail: string): never => { throw new Error(`TC_TERRAIN_GEOMETRY: ${detail}; supply a bounded finite height grid.`); };
export function terrainGeometry(input: TerrainGeometry): TerrainGeometry {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      typeof input.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.id) ||
      !Number.isSafeInteger(input.columns) || input.columns < 2 || input.columns > 64 ||
      !Number.isSafeInteger(input.rows) || input.rows < 2 || input.rows > 64 ||
      !Number.isFinite(input.cellSize) || input.cellSize < 0.001 || input.cellSize > 1e4 ||
      !Array.isArray(input.origin) || input.origin.length !== 3 || input.origin.some(v => !Number.isFinite(v) || Math.abs(v) > 1e6) ||
      !Array.isArray(input.heights) || input.heights.length !== input.columns * input.rows ||
      Array.from(input.heights).some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e5) ||
      (input.friction !== undefined && (!Number.isFinite(input.friction) || input.friction < 0 || input.friction > 100)) ||
      (input.restitution !== undefined && (!Number.isFinite(input.restitution) || input.restitution < 0 || input.restitution > 1))) return fail("Invalid id, dimensions, spacing, origin, heights or material properties");
  const result: TerrainGeometry = { id: input.id, columns: input.columns, rows: input.rows, cellSize: input.cellSize,
    origin: [input.origin[0], input.origin[1], input.origin[2]], heights: [...input.heights], ...(input.friction === undefined ? {} : { friction: input.friction }), ...(input.restitution === undefined ? {} : { restitution: input.restitution }) };
  const [ox, oy, oz] = result.origin;
  for (let row = 0; row < result.rows; row++) for (let column = 0; column < result.columns; column++) {
    const x = ox + column * result.cellSize, z = oz + row * result.cellSize, y = oy + result.heights[row * result.columns + column];
    if (![x, y, z].every(v => Number.isFinite(Math.fround(v)) && Math.abs(v) <= 1e6) ||
        (column > 0 && Math.fround(x) === Math.fround(x - result.cellSize)) ||
        (row > 0 && Math.fround(z) === Math.fround(z - result.cellSize))) return fail(`Grid '${input.id}' collapses at float32 precision`);
  }
  return result;
}
/** One topology and f32 geometry source for native collision, raster and tracing. */
export function terrainMesh(definition: TerrainGeometry): { positions: Vec3[]; triangles: [number, number, number][]; uvs: Vec2[] } {
  const positions: Vec3[] = [], triangles: [number, number, number][] = [], uvs: Vec2[] = [];
  for (let row = 0; row < definition.rows; row++) for (let column = 0; column < definition.columns; column++) {
    positions.push([Math.fround(definition.origin[0] + column * definition.cellSize), Math.fround(definition.origin[1] + definition.heights[row * definition.columns + column]), Math.fround(definition.origin[2] + row * definition.cellSize)]);
    uvs.push([column / (definition.columns - 1), row / (definition.rows - 1)]);
    if (column + 1 < definition.columns && row + 1 < definition.rows) {
      const a = row * definition.columns + column, b = a + 1, c = a + definition.columns, d = c + 1;
      triangles.push([a, c, b], [b, c, d]);
    }
  }
  return { positions, triangles, uvs };
}
export function terrainHeight(definition: TerrainGeometry, x: number, z: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return fail("Sample coordinates must be finite");
  const coordinate = (i: number, axis: 0 | 2) => Math.fround(definition.origin[axis] + i * definition.cellSize);
  if (x < coordinate(0, 0) || z < coordinate(0, 2) || x > coordinate(definition.columns - 1, 0) || z > coordinate(definition.rows - 1, 2)) return null;
  const locate = (value: number, count: number, axis: 0 | 2) => {
    let low = 0, high = count - 1;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (coordinate(middle, axis) <= value) low = middle; else high = middle; }
    return Math.min(low, count - 2);
  };
  const column = locate(x, definition.columns, 0), row = locate(z, definition.rows, 2);
  const point = (c: number, r: number): Vec3 => [coordinate(c, 0), Math.fround(definition.origin[1] + definition.heights[r * definition.columns + c]), coordinate(r, 2)];
  const a = point(column, row), b = point(column + 1, row), c = point(column, row + 1), d = point(column + 1, row + 1);
  const u = Math.max(0, Math.min(1, (x - a[0]) / (b[0] - a[0]))), v = Math.max(0, Math.min(1, (z - a[2]) / (c[2] - a[2])));
  return u + v <= 1 ? a[1] * (1 - u - v) + b[1] * u + c[1] * v : b[1] * (1 - v) + c[1] * (1 - u) + d[1] * (u + v - 1);
}
