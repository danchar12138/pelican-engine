import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";
const material = defineMaterial({ id: "box", color: "#20b6a1", roughness: 0.6 });
const state = defineComponent({ id: "RemovalState", schema: { initialHit: { type: "string", default: "" }, afterHit: { type: "string", default: "" }, alive: { type: "boolean", default: true } } });
const removeFirst = defineSystem({ id: "remove-first", phase: "input", reads: ["RemovalState"], writes: ["RemovalState", "Transform"], structural: true, run(ctx) {
  if (ctx.time.tick !== 1) return;
  const hit = ctx.physics.raycast([-1, 0, 5], [0, 0, -1], 10);
  ctx.setComponent("state", state, { initialHit: hit?.entity ?? "none" });
  ctx.entities.destroy("removed");
} });
const check = defineSystem({ id: "check", phase: "postPhysics", reads: ["RemovalState"], writes: ["RemovalState"], run(ctx) {
  const hit = ctx.physics.raycast([-1, 0, 5], [0, 0, -1], 10);
  ctx.setComponent("state", state, { afterHit: hit?.entity ?? "none", alive: ctx.entities.isAlive("removed") });
} });
export default defineGame({ id: "physics-first-removal", components: [state], systems: [removeFirst, check], scene: defineScene({ id: "scene", gravity: [0,0,0], camera: { position: [0,0,7], target: [0,0,0], fov: 45 }, environment: { background: "#17212a", ambientIntensity: 0.7 }, entities: [
  { id: "removed", transform: { position: [-1,0,0] }, mesh: { geometry: { kind: "box" }, material }, rigidBody: { type: "dynamic", collider: { shape: "box", size: [1,1,1] }, mass: 1 } },
  { id: "survivor", transform: { position: [1,0,0] }, mesh: { geometry: { kind: "box" }, material }, rigidBody: { type: "dynamic", collider: { shape: "box", size: [1,1,1] }, mass: 1 } },
  { id: "state", components: [{ component: state }] },
  { id: "light", transform: { position: [2,4,5] }, light: { kind: "directional", intensity: 3 } },
] }) });
