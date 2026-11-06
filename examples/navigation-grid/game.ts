import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";
import type { NavigationCell, SystemContext } from "pelican-engine";

// A route is stored as JSON because component fields are scalar or vec3. No
// mutable game-module state is needed to resume after a runtime snapshot.
const State = defineComponent({ id: "NavigationState", schema: {
  initialized: { type: "boolean", default: false },
  x: { type: "number", default: 0 }, y: { type: "number", default: 1 },
  path: { type: "string", default: "[]" }, cursor: { type: "number", default: 0 },
  progress: { type: "number", default: 0 },
  obstacles: { type: "number", default: 0 }, revision: { type: "number", default: 0 },
  moves: { type: "number", default: 0 }, error: { type: "string", default: "" },
} });
const player = defineMaterial({ id: "player-color", color: "#18d7df", roughness: 0.5 });
const obstacle = defineMaterial({ id: "obstacle-color", color: "#e44545", roughness: 0.7 });
const goal = defineMaterial({ id: "goal-color", color: "#f4ca47", roughness: 0.6 });
const tile = defineMaterial({ id: "tile-color", color: "#728799", roughness: 0.8 });
const line = defineMaterial({ id: "grid-line", color: "#283c4d", roughness: 0.8 });
const world = (cell: NavigationCell, height: number): [number, number, number] => [cell.x - 3, height, cell.y - 1];
const destination = { x: 6, y: 1 };

function plan(ctx: SystemContext, x: number, y: number, revision: number) {
  try {
    const path = ctx.navigation.findPath("board", { x, y }, destination);
    ctx.setComponent("state", State, { path: JSON.stringify(path), cursor: 0, progress: 0, revision: revision + 1, error: "" });
  } catch (error) {
    const message = String(error);
    if (!message.includes("TC_NAVIGATION_UNREACHABLE") && !message.includes("TC_NAVIGATION_CAPACITY") && !message.includes("TC_NAVIGATION_BLOCKED")) throw error;
    ctx.setComponent("state", State, { path: "[]", cursor: 0, progress: 0, revision: revision + 1, error: message });
  }
}

const navigate = defineSystem({ id: "navigate", phase: "update", reads: ["NavigationState", "Transform"], writes: ["NavigationState", "Transform"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.navigation.createGrid({ id: "board", owner: "level", width: 7, height: 3 });
    ctx.navigation.createGrid({ id: "budget-demo", owner: "level", width: 7, height: 1, searchCellBudget: 2 });
    ctx.setComponent("state", State, { initialized: true });
    plan(ctx, state.x, state.y, state.revision);
    return;
  }
  // B toggles the middle obstacle, U builds a wall, R clears it, C shows a
  // separate deliberately small search budget without destroying the route.
  for (const event of ctx.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    if (input.key === "c") {
      try { ctx.navigation.findPath("budget-demo", { x: 0, y: 0 }, { x: 6, y: 0 }); }
      catch (error) {
        const message = String(error);
        if (!message.includes("TC_NAVIGATION_CAPACITY")) throw error;
        ctx.setComponent("state", State, { error: message });
      }
      return;
    }
    if (input.key === "b" || input.key === "u" || input.key === "r") {
      const mode = input.key === "u" ? 2 : input.key === "r" ? 0 : state.obstacles === 1 ? 0 : 1;
      if (state.x === 3 && (mode === 2 || (mode === 1 && state.y === 1))) {
        ctx.setComponent("state", State, { error: "Cannot block the player's current cell." });
        return;
      }
      const height = ctx.navigation.getGrid("board").height;
      for (let y = 0; y < height; y++) {
        const blocked = mode === 2 || (mode === 1 && y === 1);
        ctx.navigation.setBlocked("board", { x: 3, y }, blocked);
        ctx.setTransform(`block-${y}`, { position: world({ x: 3, y }, ctx.navigation.isBlocked("board", { x: 3, y }) ? 0.4 : -5) });
      }
      ctx.setComponent("state", State, { obstacles: mode });
      // Replanning starts at the last completed cell, including mid-edge input.
      ctx.setTransform("player", { position: world({ x: state.x, y: state.y }, 0.38) });
      plan(ctx, state.x, state.y, state.revision);
      return;
    }
  }
  const path = JSON.parse(state.path) as NavigationCell[];
  const next = path[state.cursor + 1];
  if (next) {
    const progress = state.progress + 1;
    const fraction = progress / 12;
    ctx.setTransform("player", { position: world({ x: state.x + (next.x - state.x) * fraction, y: state.y + (next.y - state.y) * fraction }, 0.38) });
    if (progress === 12) ctx.setComponent("state", State, { x: next.x, y: next.y, cursor: state.cursor + 1, progress: 0, moves: state.moves + 1 });
    else ctx.setComponent("state", State, { progress });
  }
} });

export default defineGame({ id: "navigation-grid", components: [State], systems: [navigate],
  scene: defineScene({ id: "board-scene", camera: { position: [0, 8, 8], target: [0, 0, 0], fov: 45 },
    environment: { background: "#101a25", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [7, 0.18, 3] }, material: tile } },
      { id: "grid-v0", transform: { position: [-2.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-v1", transform: { position: [-1.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-v2", transform: { position: [-0.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-v3", transform: { position: [0.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-v4", transform: { position: [1.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-v5", transform: { position: [2.5, 0, 0] }, mesh: { geometry: { kind: "box", size: [0.025, 0.02, 3] }, material: line } },
      { id: "grid-h0", transform: { position: [0, 0, -0.5] }, mesh: { geometry: { kind: "box", size: [7, 0.02, 0.025] }, material: line } },
      { id: "grid-h1", transform: { position: [0, 0, 0.5] }, mesh: { geometry: { kind: "box", size: [7, 0.02, 0.025] }, material: line } },
      { id: "block-0", transform: { position: [0, -5, -1] }, mesh: { geometry: { kind: "box", size: [0.72, 0.8, 0.72] }, material: obstacle } },
      { id: "block-1", transform: { position: [0, -5, 0] }, mesh: { geometry: { kind: "box", size: [0.72, 0.8, 0.72] }, material: obstacle } },
      { id: "block-2", transform: { position: [0, -5, 1] }, mesh: { geometry: { kind: "box", size: [0.72, 0.8, 0.72] }, material: obstacle } },
      { id: "player", transform: { position: [-3, 0.38, 0] }, mesh: { geometry: { kind: "box", size: [0.55, 0.75, 0.55] }, material: player } },
      { id: "goal", transform: { position: [3, 0.12, 0] }, mesh: { geometry: { kind: "box", size: [0.6, 0.24, 0.6] }, material: goal } },
      { id: "sun", transform: { position: [2, 7, 3] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
