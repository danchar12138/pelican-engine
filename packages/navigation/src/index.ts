import { aStar } from "ngraph.path";
import type { NavigationCell, NavigationGrid, NavigationService } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";

type Grid = { id: string; owner: string; width: number; height: number; blocked: number[]; searchCellBudget?: number };
const DEFAULT_SEARCH_CELLS = 65536;
const fail = (code: string, detail: string): never => { throw new Error(`TC_NAVIGATION_${code}: ${detail}`); };
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function parseGrid(value: unknown): Grid {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("GRID", "Expected a grid definition.");
  const grid = value as NavigationGrid;
  // JavaScript arrays have a maximum length of 2^32 - 1; linear cell indices must fit it.
  if (!name(grid.id) || !name(grid.owner) || !Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width < 1 || grid.height < 1 || grid.width * grid.height > 0xffffffff)
    return fail("GRID", "Grid requires id, owner and positive integer dimensions with at most 4294967295 cells (JavaScript array length limit); split larger grids.");
  if (grid.blocked !== undefined && !Array.isArray(grid.blocked)) return fail("GRID", "blocked must be an array of cells.");
  if (grid.searchCellBudget !== undefined && (!Number.isSafeInteger(grid.searchCellBudget) || grid.searchCellBudget < 1 || grid.searchCellBudget > 0xffffffff))
    return fail("GRID", "searchCellBudget must be a positive integer no greater than 4294967295.");
  const result: Grid = { id: grid.id, owner: grid.owner, width: grid.width, height: grid.height, blocked: [], ...(grid.searchCellBudget === undefined ? {} : { searchCellBudget: grid.searchCellBudget }) };
  const seen = new Set<number>();
  for (const point of grid.blocked ?? []) {
    const index = cell(result, point);
    if (seen.has(index)) return fail("GRID", "Duplicate blocked cell.");
    seen.add(index);
    result.blocked.push(index);
  }
  result.blocked.sort((a, b) => a - b);
  return result;
}
function cell(grid: Grid, point: NavigationCell): number {
  if (!point || typeof point !== "object" || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= grid.width || point.y >= grid.height)
    return fail("CELL", `Cell must be within grid '${grid.id}'.`);
  return point.y * grid.width + point.x;
}
function definition(grid: Grid): NavigationGrid {
  return { id: grid.id, owner: grid.owner, width: grid.width, height: grid.height, blocked: grid.blocked.map((i) => ({ x: i % grid.width, y: Math.floor(i / grid.width) })), ...(grid.searchCellBudget === undefined ? {} : { searchCellBudget: grid.searchCellBudget }) };
}
function blockedIndex(grid: Grid, index: number): number {
  let lower = 0, upper = grid.blocked.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (grid.blocked[middle] < index) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}
function parseSnapshot(value: unknown): Map<string, Grid> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { grids?: unknown }).grids))
    return fail("SNAPSHOT", "Invalid navigation snapshot.");
  const result = new Map<string, Grid>();
  for (const item of (value as { grids: unknown[] }).grids) {
    const grid = parseGrid(item);
    if (result.has(grid.id)) return fail("SNAPSHOT", `Duplicate grid '${grid.id}'.`);
    result.set(grid.id, grid);
  }
  return result;
}
export const createNavigationPlugin: RuntimePluginFactory = () => {
  let grids = new Map<string, Grid>();
  let disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Navigation is disposed."); };
  const get = (id: string) => {
    alive();
    if (!name(id)) return fail("GRID", "Expected a non-empty grid id.");
    return grids.get(id) ?? fail("MISSING", `Grid '${id}' does not exist.`);
  };
  const service: NavigationService = {
    createGrid(input) {
      alive();
      const grid = parseGrid(input);
      if (grids.has(grid.id)) fail("DUPLICATE", `Grid '${grid.id}' already exists.`);
      grids.set(grid.id, grid);
    },
    getGrid(id) { return definition(get(id)); },
    isBlocked(id, point) {
      const grid = get(id), index = cell(grid, point);
      return grid.blocked[blockedIndex(grid, index)] === index;
    },
    setBlocked(id, point, blocked) {
      const grid = get(id), index = cell(grid, point);
      if (typeof blocked !== "boolean") fail("BLOCKED", "Expected a boolean.");
      const lower = blockedIndex(grid, index);
      const exists = grid.blocked[lower] === index;
      if (blocked && !exists) grid.blocked.splice(lower, 0, index);
      else if (!blocked && exists) grid.blocked.splice(lower, 1);
    },
    setBlockedBatch(id, updates) {
      const grid = get(id);
      if (!Array.isArray(updates))
        fail("BLOCKED", `Updates for grid '${id}' must be an array of cells and boolean blocked values.`);
      if (updates.length === 0) return;
      // Validate every entry before modifying the grid. Repeated cells use the last value.
      const changes = new Map<number, boolean>();
      for (const update of updates) {
        if (!update || typeof update !== "object" || typeof update.blocked !== "boolean")
          fail("BLOCKED", `Each update for grid '${id}' requires a cell and a boolean blocked value.`);
        changes.set(cell(grid, update.cell), update.blocked);
      }
      const blocked = new Set(grid.blocked);
      for (const [index, value] of changes) {
        if (value) blocked.add(index);
        else blocked.delete(index);
      }
      grid.blocked = [...blocked].sort((a, b) => a - b);
    },
    findPath(id, start, end) {
      const grid = get(id), from = cell(grid, start), to = cell(grid, end);
      const blocked = new Set(grid.blocked);
      if (blocked.has(from) || blocked.has(to)) fail("BLOCKED", "Start or destination is blocked.");
      const budget = grid.searchCellBudget ?? DEFAULT_SEARCH_CELLS;
      type Node = { id: number; x: number; y: number };
      const nodes = new Map<number, Node>();
      const node = (index: number): Node => {
        const existing = nodes.get(index);
        if (existing) return existing;
        if (nodes.size >= budget) return fail("CAPACITY", `Search on grid '${id}' exceeded searchCellBudget ${budget}; reduce or partition the search, or explicitly increase the budget after assessing memory and CPU cost.`);
        const result = { id: index, x: index % grid.width, y: Math.floor(index / grid.width) };
        nodes.set(index, result);
        return result;
      };
      // The target and each discovered neighbor share identity with getNode's result.
      const graph = {
        getNode: (index: number) => node(index),
        forEachLinkedNode(index: number, visit: (other: Node, link: { fromId: number; toId: number }) => void) {
          const x = index % grid.width, y = Math.floor(index / grid.width);
          const visitCell = (next: number) => {
            if (!blocked.has(next)) visit(node(next), { fromId: index, toId: next });
          };
          if (y > 0) visitCell(index - grid.width);
          if (x > 0) visitCell(index - 1);
          if (x + 1 < grid.width) visitCell(index + 1);
          if (y + 1 < grid.height) visitCell(index + grid.width);
        },
      };
      const finder = aStar(graph as Parameters<typeof aStar>[0], {
        heuristic: (a: Node, b: Node) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
      });
      const path = finder.find(from, to) as unknown as Node[];
      if (!path.length) return fail("UNREACHABLE", `Destination is unreachable on grid '${id}'.`);
      return path.reverse().map(({ x, y }) => ({ x, y }));
    },
    destroyGrid(id) { get(id); grids.delete(id); },
    destroyOwner(owner) {
      alive();
      if (!name(owner)) fail("OWNER", "Expected a non-empty owner.");
      for (const [id, grid] of grids) if (grid.owner === owner) grids.delete(id);
    },
  };
  const empty = () => ({ version: 1, grids: [] });
  return {
    id: "$engine.navigation", version: "1", services: { navigation: service },
    snapshot: () => ({ version: 1, grids: [...grids.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(definition) }),
    legacySnapshot: empty,
    validateSnapshot(value) { parseSnapshot(value); },
    restore(value) { alive(); grids = parseSnapshot(value); },
    dispose() { disposed = true; grids.clear(); },
  };
};
