import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "AgentDemo", schema: {
  initialized: { type: "boolean", default: false },
  blocked: { type: "boolean", default: false },
} });
const floorMaterial = defineMaterial({ id: "floor", color: "#344c5a", roughness: 0.8 });
const obstacleMaterial = defineMaterial({ id: "obstacle", color: "#e48c61", roughness: 0.7 });
const firstMaterial = defineMaterial({ id: "first-agent", color: "#56cde8", roughness: 0.6 });
const secondMaterial = defineMaterial({ id: "second-agent", color: "#dfd27b", roughness: 0.6 });

const agents = defineSystem({ id: "agent-demo", phase: "update", reads: ["AgentDemo", "Transform"], writes: ["AgentDemo", "Transform"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.navigation.createGrid({ id: "board", owner: "scene", width: 8, height: 8 });
    ctx.navigation.createAgent({ id: "first", entity: "first", grid: "board", origin: [-4, -4], cellSize: 1, speed: 1.8, allowDiagonal: true });
    ctx.navigation.createAgent({ id: "second", entity: "second", grid: "board", origin: [-4, -4], cellSize: 1, speed: 1.5, allowDiagonal: true });
    ctx.navigation.setAgentTarget("first", { x: 7, y: 7 });
    ctx.navigation.setAgentTarget("second", { x: 6, y: 7 });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("toggle")) {
    const blocked = !state.blocked;
    ctx.navigation.setBlocked("board", { x: 3, y: 3 }, blocked);
    ctx.setTransform("obstacle", { position: [-0.5, blocked ? 0.5 : -5, -0.5] });
    ctx.setComponent("state", State, { blocked });
  }
  const current = ctx.navigation.listAgents();
  ctx.ui.setText("status", `B: toggle obstacle | ${current.map(agent => `${agent.id}: ${agent.status}`).join(" | ")}`);
} });

export default defineGame({
  id: "navigation-agents", components: [State], systems: [agents],
  materials: [floorMaterial, obstacleMaterial, firstMaterial, secondMaterial],
  input: { toggle: ["b"] },
  ui: [{ id: "status", kind: "text", text: "B: toggle obstacle", x: 16, y: 16 }],
  scene: defineScene({ id: "navigation-agents", camera: { position: [0, 11, 11], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.2, 8] }, material: floorMaterial } },
      { id: "obstacle", transform: { position: [-0.5, -5, -0.5] }, mesh: { geometry: { kind: "box", size: [0.9, 1, 0.9] }, material: obstacleMaterial } },
      { id: "first", transform: { position: [-3.5, 0.4, -3.5] }, mesh: { geometry: { kind: "box", size: [0.5, 0.8, 0.5] }, material: firstMaterial } },
      { id: "second", transform: { position: [-2.5, 0.4, -3.5] }, mesh: { geometry: { kind: "box", size: [0.5, 0.8, 0.5] }, material: secondMaterial } },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
