import type {
  EntityHandle,
  NavigationAgentDefinition,
  NavigationAgentState,
  NavigationCell,
  NavigationGrid,
  NavigationService,
  Vec2,
} from "../../sdk/src/index.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import type { RuntimePluginContext } from "../../runtime/src/plugins.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Agent = NavigationAgentState & {
  origin: Vec2;
  cellSize: number;
  speed: number;
  allowDiagonal: boolean;
  dirty: boolean;
};
type AgentSnapshot = { agents: Agent[]; agentCursor: number };
type GridLookup = (id: string) => NavigationGrid | undefined;
const MAX_AGENTS = 128;
const MAX_PATH = 65536;
const MAX_PLANS_PER_TICK = 8;
const MAX_SEGMENTS_PER_TICK = 64;
const fail = (code: string, message: string): never => { throw new Error(`TC_NAVIGATION_${code}: ${message}`); };
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const inGrid = (point: NavigationCell, grid: NavigationGrid) => !!point && typeof point === "object" &&
  Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) && point.x >= 0 && point.y >= 0 &&
  point.x < grid.width && point.y < grid.height;
const publicState = (agent: Agent): NavigationAgentState => cloneSerializable({
  id: agent.id, entity: agent.entity, grid: agent.grid, plane: agent.plane, rowDirection: agent.rowDirection, target: agent.target,
  status: agent.status, error: agent.error, path: agent.path, cursor: agent.cursor,
});

/** Fixed-step point agents. No native physics or renderer objects cross the public service. */
export function createNavigationAgents(
  context: RuntimePluginContext,
  navigation: Pick<NavigationService, "getGrid" | "findPath">,
) {
  let agents = new Map<string, Agent>(), handles = new Map<string, EntityHandle>(), cursor = 0, disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Navigation agents are disposed."); };
  const get = (id: string) => {
    alive();
    if (!name(id)) return fail("AGENT", "Expected a nonempty agent id.");
    return agents.get(id) ?? fail("AGENT_MISSING", `Agent '${id}' does not exist.`);
  };
  function create(input: NavigationAgentDefinition): void {
    alive();
    const value = cloneSerializable(input);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["id", "entity", "grid", "origin", "cellSize", "speed", "allowDiagonal", "plane", "rowDirection"].includes(key)) ||
        !name(value.id) || !name(value.entity) || !name(value.grid))
      return fail("AGENT", "Agent needs nonempty id, entity and grid names.");
    const origin = value.origin ?? [0, 0], cellSize = value.cellSize ?? 1, speed = value.speed ?? 1, allowDiagonal = value.allowDiagonal ?? false;
    const plane = value.plane ?? "xz", rowDirection = value.rowDirection ?? "positive";
    if (!Array.isArray(origin) || origin.length !== 2 || origin.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9) ||
        !Number.isFinite(cellSize) || cellSize < 0.001 || cellSize > 1e6 ||
        !Number.isFinite(speed) || speed <= 0 || speed > 1000 || typeof allowDiagonal !== "boolean" ||
        !["xz", "xy"].includes(plane) || !["positive", "negative"].includes(rowDirection))
      return fail("AGENT", "Origin must be finite, cellSize in [0.001,1e6], speed in (0,1000], and plane/rowDirection must be supported.");
    navigation.getGrid(value.grid);
    if (agents.has(value.id)) return fail("AGENT_DUPLICATE", `Agent '${value.id}' already exists.`);
    if ([...agents.values()].some(agent => agent.entity === value.entity))
      return fail("AGENT_ENTITY", `Entity '${value.entity}' already has a navigation agent.`);
    if (agents.size >= MAX_AGENTS) return fail("AGENT_CAPACITY", `At most ${MAX_AGENTS} agents may be created.`);
    if (!context.world.isAlive(value.entity)) return fail("AGENT_ENTITY", `Entity '${value.entity}' is not alive.`);
    const handle = context.world.resolve(value.entity);
    agents.set(value.id, { id: value.id, entity: value.entity, grid: value.grid,
      origin: [origin[0], origin[1]], cellSize, speed, allowDiagonal, plane, rowDirection,
      target: null, path: [], cursor: 0, status: "idle", error: null, dirty: false });
    handles.set(value.id, handle);
  }
  function target(id: string, point: NavigationCell): void {
    const agent = get(id), grid = navigation.getGrid(agent.grid);
    if (agent.status === "missing" || !handles.get(id) || !context.world.isAlive(handles.get(id)!))
      return fail("AGENT_ENTITY", `Entity '${agent.entity}' is no longer alive; create a new agent for its replacement.`);
    if (!inGrid(point, grid)) return fail("CELL", `Target must be within grid '${grid.id}'.`);
    agent.target = { x: point.x, y: point.y };
    agent.path = []; agent.cursor = 0; agent.status = "planning"; agent.error = null; agent.dirty = true;
  }
  function stop(id: string): void {
    const agent = get(id);
    agent.target = null; agent.path = []; agent.cursor = 0; agent.dirty = false;
    if (agent.status !== "missing") { agent.status = "idle"; agent.error = null; }
  }
  function remove(id: string): void { get(id); agents.delete(id); handles.delete(id); }
  function inspect(id: string): NavigationAgentState { return publicState(get(id)); }
  function list(): NavigationAgentState[] { alive(); return [...agents.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(publicState); }
  function dirtyGrid(grid: string): void {
    for (const agent of agents.values()) if (agent.grid === grid && agent.target && agent.status !== "missing") {
      agent.dirty = true; agent.status = "planning"; agent.error = null; agent.path = []; agent.cursor = 0;
    }
  }
  function assertGridUnused(id: string): void {
    const agent = [...agents.values()].find(item => item.grid === id);
    if (agent) return fail("GRID_IN_USE", `Destroy agent '${agent.id}' before destroying grid '${id}'.`);
  }
  function missing(agent: Agent): void {
    agent.status = "missing"; agent.error = "TC_NAVIGATION_AGENT_ENTITY";
    agent.dirty = false; agent.path = []; agent.cursor = 0; handles.delete(agent.id);
  }
  function tick(dt: number): void {
    alive();
    if (!Number.isFinite(dt) || dt < 0) return fail("AGENT_DT", "Fixed-step duration must be finite and nonnegative.");
    if (!agents.size) return;
    const ordered = [...agents.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const records = new Map(context.world.records().map(record => [record.id, record]));
    let plans = 0;
    const start = cursor % ordered.length;
    cursor = (start + MAX_PLANS_PER_TICK) % ordered.length;
    for (let offset = 0; offset < ordered.length; offset++) {
      const agent = ordered[(start + offset) % ordered.length], handle = handles.get(agent.id);
      if (agent.status === "missing") continue;
      if (!handle || !context.world.isAlive(handle)) { missing(agent); continue; }
      const record = records.get(agent.entity);
      if (!record) { missing(agent); continue; }
      const definition = resolveEntityDefinition(context.scene, record);
      if (record.parent !== undefined || definition?.rigidBody || definition?.character || context.getPhysics2DBridge?.()?.hasEntity(agent.entity)) {
        agent.status = "blocked"; agent.error = "TC_NAVIGATION_AGENT_BODY";
        agent.dirty = false; agent.path = []; agent.cursor = 0;
        continue;
      }
      if (!agent.target) continue;
      const position = context.world.getTransform(handle).position;
      const second = agent.plane === "xy" ? position[1] : position[2];
      const direction = agent.rowDirection === "negative" ? -1 : 1;
      const current = { x: Math.floor((position[0] - agent.origin[0]) / agent.cellSize),
        y: Math.floor((second - agent.origin[1]) / (agent.cellSize * direction)) };
      if (agent.status === "moving") {
        const next = agent.path[agent.cursor], previous = agent.path[Math.max(0, agent.cursor - 1)];
        if (next && (current.x !== previous.x || current.y !== previous.y) && (current.x !== next.x || current.y !== next.y)) {
          agent.dirty = true; agent.status = "planning"; agent.path = []; agent.cursor = 0;
        }
      }
      if (agent.dirty) {
        if (plans >= MAX_PLANS_PER_TICK) continue;
        plans++;
        try {
          const path = navigation.findPath(agent.grid, current, agent.target, { allowDiagonal: agent.allowDiagonal });
          if (path.length > MAX_PATH) return fail("AGENT_PATH", `Path for '${agent.id}' exceeds ${MAX_PATH} cells; partition the route.`);
          agent.path = path.map(cell => ({ x: cell.x, y: cell.y }));
          agent.cursor = 0; agent.status = "moving"; agent.error = null; agent.dirty = false;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = /^(TC_NAVIGATION_(?:UNREACHABLE|BLOCKED|CAPACITY|CELL|AGENT_PATH))\b/.exec(message)?.[1];
          if (!code) throw error;
          agent.status = "blocked"; agent.error = code; agent.dirty = false; agent.path = []; agent.cursor = 0;
          continue;
        }
      }
      if (agent.status !== "moving") continue;
      let remaining = agent.speed * dt, x = position[0], z = second, segments = 0;
      while (agent.cursor < agent.path.length && segments < MAX_SEGMENTS_PER_TICK) {
        const point = agent.path[agent.cursor];
        const tx = agent.origin[0] + (point.x + 0.5) * agent.cellSize;
        const tz = agent.origin[1] + direction * (point.y + 0.5) * agent.cellSize;
        const dx = tx - x, dz = tz - z, distance = Math.hypot(dx, dz);
        if (distance <= 1e-9) { x = tx; z = tz; agent.cursor++; segments++; continue; }
        if (remaining <= 0) break;
        const step = Math.min(remaining, distance);
        x += dx / distance * step; z += dz / distance * step; remaining -= step;
        if (step >= distance) { x = tx; z = tz; agent.cursor++; segments++; }
        else break;
      }
      if (x !== position[0] || z !== second)
        context.world.setTransform(handle, { position: agent.plane === "xy" ? [x, z, position[2]] : [x, position[1], z] });
      if (agent.cursor === agent.path.length) { agent.status = "arrived"; agent.error = null; }
    }
  }
  function parse(value: unknown, gridLookup: GridLookup): AgentSnapshot {
    const data = cloneSerializable(value) as { agents?: Agent[]; agentCursor?: number };
    if (!data || typeof data !== "object" || (data.agents !== undefined && !Array.isArray(data.agents)) ||
        (data.agentCursor !== undefined && (!Number.isSafeInteger(data.agentCursor) || data.agentCursor < 0)))
      return fail("AGENT_SNAPSHOT", "Invalid navigation agent snapshot.");
    const saved = data.agents ?? [], ids = new Set<string>(), entities = new Set<string>();
    if (saved.length > MAX_AGENTS) return fail("AGENT_CAPACITY", `At most ${MAX_AGENTS} agents may be restored.`);
    for (const agent of saved) {
      if (!agent || !name(agent.id) || !name(agent.entity) || !name(agent.grid) || ids.has(agent.id) || entities.has(agent.entity))
        return fail("AGENT_SNAPSHOT", "Agent identities must be unique and nonempty.");
      ids.add(agent.id); entities.add(agent.entity);
      // Older snapshots predate plane selection and use the original X/Z positive-row behavior.
      if (agent.plane === undefined) agent.plane = "xz";
      if (agent.rowDirection === undefined) agent.rowDirection = "positive";
      const grid = gridLookup(agent.grid);
      if (!grid || !["xz", "xy"].includes(agent.plane) || !["positive", "negative"].includes(agent.rowDirection) || !Array.isArray(agent.origin) || agent.origin.length !== 2 || agent.origin.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9) ||
          !Number.isFinite(agent.cellSize) || agent.cellSize < 0.001 || agent.cellSize > 1e6 ||
          !Number.isFinite(agent.speed) || agent.speed <= 0 || agent.speed > 1000 || typeof agent.allowDiagonal !== "boolean" || typeof agent.dirty !== "boolean" ||
          !["idle", "planning", "moving", "arrived", "blocked", "missing"].includes(agent.status) ||
          !(agent.error === null || (typeof agent.error === "string" && /^TC_NAVIGATION_[A-Z_]+$/.test(agent.error))) ||
          !Array.isArray(agent.path) || agent.path.length > MAX_PATH || !Number.isSafeInteger(agent.cursor) || agent.cursor < 0 || agent.cursor > agent.path.length ||
          (agent.target !== null && !inGrid(agent.target, grid)))
        return fail("AGENT_SNAPSHOT", `Invalid agent '${agent.id}' state.`);
      for (let i = 0; i < agent.path.length; i++) {
        const point = agent.path[i];
        if (!inGrid(point, grid)) return fail("AGENT_SNAPSHOT", `Agent '${agent.id}' has an invalid path cell.`);
        if (i) {
          const dx = Math.abs(point.x - agent.path[i - 1].x), dy = Math.abs(point.y - agent.path[i - 1].y);
          if (dx > 1 || dy > 1 || dx + dy === 0 || (!agent.allowDiagonal && dx + dy > 1))
            return fail("AGENT_SNAPSHOT", `Agent '${agent.id}' has non-adjacent path cells.`);
        }
      }
      if ((agent.status === "idle" && (agent.target !== null || agent.path.length !== 0 || agent.dirty)) ||
          (agent.status === "planning" && (!agent.target || !agent.dirty || agent.path.length !== 0)) ||
          (agent.status === "moving" && (!agent.target || agent.dirty || agent.cursor >= agent.path.length)) ||
          (agent.status === "arrived" && (!agent.target || agent.dirty || agent.path.length === 0 || agent.cursor !== agent.path.length)) ||
          ((agent.status === "blocked" || agent.status === "missing") && (agent.dirty || agent.path.length !== 0 || !agent.error)))
        return fail("AGENT_SNAPSHOT", `Agent '${agent.id}' has inconsistent status and path.`);
      if ((agent.status === "moving" || agent.status === "arrived") && agent.target &&
          (agent.path[agent.path.length - 1].x !== agent.target.x || agent.path[agent.path.length - 1].y !== agent.target.y))
        return fail("AGENT_SNAPSHOT", `Agent '${agent.id}' path does not end at its target.`);
    }
    return { agents: saved, agentCursor: data.agentCursor ?? 0 };
  }
  function snapshot(): AgentSnapshot {
    alive();
    for (const agent of agents.values()) {
      const handle = handles.get(agent.id);
      if (agent.status !== "missing" && (!handle || !context.world.isAlive(handle))) missing(agent);
    }
    return cloneSerializable({ agents: [...agents.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), agentCursor: cursor });
  }
  function validateWorld(data: AgentSnapshot, world: WorldSnapshot): void {
    const ids = new Set(world.entities.map(item => item.id));
    for (const agent of data.agents) if (agent.status !== "missing" && !ids.has(agent.entity))
      fail("AGENT_SNAPSHOT", `Agent '${agent.id}' entity '${agent.entity}' is missing from world snapshot.`);
  }
  function restore(data: AgentSnapshot): void {
    alive();
    const nextHandles = new Map<string, EntityHandle>();
    for (const agent of data.agents) if (agent.status !== "missing") nextHandles.set(agent.id, context.world.resolve(agent.entity));
    agents = new Map(data.agents.map(agent => [agent.id, agent])); handles = nextHandles; cursor = data.agentCursor;
  }
  return { create, target, stop, remove, inspect, list, dirtyGrid, assertGridUnused, tick, parse, snapshot, validateWorld, restore,
    dispose() { disposed = true; agents.clear(); handles.clear(); } };
}
