import { defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "GameState", schema: {
  yaw: { type: "number", default: 0 }, pitch: { type: "number", default: 0.35 },
  distance: { type: "number", default: 6 }, score: { type: "number", default: 0 },
  next: { type: "number", default: 0 }, collected: { type: "json", default: [] },
} });
const Thrown = defineComponent({ id: "Thrown", schema: { ready: { type: "boolean", default: false }, born: { type: "number", default: 0 } } });
const floor = defineMaterial({ id: "floor", color: "#334f48", roughness: 0.8 });
const paint = defineMaterial({ id: "paint", color: "#48d2c2", roughness: 0.24, metalness: 0.25 });
const crystal = defineMaterial({ id: "crystal", color: "#eece68", roughness: 0.16, metalness: 0.65 });
const prop = definePrefab({ id: "prop", mesh: { geometry: { kind: "box", size: [0.45, 0.45, 0.45] }, material: paint },
  rigidBody: { type: "dynamic", mass: 0.5, restitution: 0.35, collider: { shape: "box", size: [0.45, 0.45, 0.45] } }, components: [{ component: Thrown }] });
const pickup = definePrefab({ id: "pickup", mesh: { geometry: { kind: "sphere", radius: 0.3 }, material: crystal } });
const positions = [[-3, 0.5, -3], [3, 0.5, -3], [3, 0.5, 3], [-3, 0.5, 3]] as const;
const control = defineSystem({ id: "control", phase: "input", structural: true, run(ctx, dt) {
  const state = ctx.getComponent("state", State), pointer = ctx.input.pointer();
  ctx.input.setPointerLock(true);
  const looking = pointer.locked || (pointer.buttons & 2) !== 0;
  const yaw = state.yaw - (looking ? pointer.delta[0] * 0.003 : 0);
  const pitch = Math.max(0.05, Math.min(1.25, state.pitch + (looking ? pointer.delta[1] * 0.003 : 0)));
  const distance = Math.max(3, Math.min(12, state.distance + pointer.wheel[1] * 0.003));
  ctx.setComponent("state", State, { yaw, pitch, distance });
  const x = ctx.input.axis("left", "right"), z = ctx.input.axis("forward", "back"), length = Math.max(1, Math.hypot(x, z));
  ctx.physics.moveCharacter("player", [(Math.cos(yaw) * x + Math.sin(yaw) * z) * dt * 4 / length, 0, (-Math.sin(yaw) * x + Math.cos(yaw) * z) * dt * 4 / length]);
  if (ctx.input.pressed("jump") && ctx.physics.grounded("player")) ctx.physics.setVelocity("player", [0, 5, 0]);
  if (ctx.input.pressed("spawn") && ctx.query(Thrown).length < 12) {
    const p = ctx.getTransform("player").position;
    ctx.entities.spawn({ id: `prop-${state.next}`, prefab: "prop", transform: { position: [p[0] - Math.sin(yaw), p[1] + 0.6, p[2] - Math.cos(yaw)] }, components: { Thrown: { born: ctx.time.elapsed } } });
    ctx.setComponent("state", State, { next: state.next + 1 });
  }
  const activated = ctx.events("ui.activate").map(event => (event.payload as { id: string }).id);
  if (ctx.input.pressed("restart") || activated.includes("restart")) {
    ctx.physics.teleport("player", { position: [0, 1, 0] }, { resetVelocity: true });
    for (const id of ctx.query(Thrown)) ctx.entities.destroy(id);
    for (const [index, position] of positions.entries()) if (!ctx.entities.isAlive(`pickup-${index}`)) ctx.entities.spawn({ id: `pickup-${index}`, prefab: "pickup", transform: { position } });
    ctx.setComponent("state", State, { score: 0, collected: [] });
  }
  if (activated.includes("save")) ctx.storage.save("game");
  if (activated.includes("load")) ctx.storage.load("game");
} });
const presentation = defineSystem({ id: "game", phase: "postPhysics", structural: true, run(ctx) {
  const state = ctx.getComponent("state", State), p = ctx.getTransform("player").position;
  const collected = state.collected as number[];
  for (const [index, position] of positions.entries()) if (!collected.includes(index) && Math.hypot(p[0] - position[0], p[2] - position[2]) < 0.7) {
    collected.push(index); ctx.entities.destroy(`pickup-${index}`);
  }
  ctx.setComponent("state", State, { collected, score: collected.length });
  for (const id of ctx.query(Thrown)) {
    const thrown = ctx.getComponent(id, Thrown);
    if (!thrown.ready) { ctx.physics.setVelocity(id, [-Math.sin(state.yaw) * 8, 3, -Math.cos(state.yaw) * 8]); ctx.setComponent(id, Thrown, { ready: true }); }
    if (ctx.time.elapsed - thrown.born > 4) ctx.entities.destroy(id);
  }
  const d = state.distance * Math.cos(state.pitch);
  ctx.camera.setPose([p[0] + Math.sin(state.yaw) * d, p[1] + 0.7 + Math.sin(state.pitch) * state.distance, p[2] + Math.cos(state.yaw) * d], [p[0], p[1] + 0.4, p[2]]);
  ctx.ui.setText("score", collected.length === 4 ? "Complete" : `Crystals ${collected.length} / 4`);
} });
export default defineGame({ id: "pointer-game", components: [State, Thrown], systems: [control, presentation], prefabs: [prop, pickup], materials: [floor, paint, crystal],
  input: { left: ["a", "ArrowLeft"], right: ["d", "ArrowRight"], forward: ["w", "ArrowUp"], back: ["s", "ArrowDown"], jump: [" "], spawn: ["e"], restart: ["r"] },
  ui: [{ id: "score", kind: "text", text: "Crystals 0 / 4", x: 16, y: 16 },
    { id: "save", kind: "button", text: "Save", anchor: "bottom-left", x: 16, y: 48, width: 80 },
    { id: "load", kind: "button", text: "Load", anchor: "bottom-left", x: 104, y: 48, width: 80 },
    { id: "restart", kind: "button", text: "Restart", anchor: "bottom-left", x: 192, y: 48, width: 90 }],
  scene: defineScene({ id: "arena", camera: { position: [0, 4, 7], target: [0, 1, 0] }, environment: { background: "#1a242a", ambientIntensity: 0.7 }, entities: [
    { id: "state", components: [{ component: State }] },
    { id: "player", transform: { position: [0, 1, 0] }, mesh: { geometry: { kind: "box", size: [0.6, 1.3, 0.6] }, material: paint }, character: { radius: 0.3, height: 1.3, speed: 4 } },
    { id: "floor", transform: { position: [0, -0.25, 0] }, mesh: { geometry: { kind: "box", size: [14, 0.5, 14] }, material: floor }, rigidBody: { type: "fixed", collider: { shape: "box", size: [14, 0.5, 14] } } },
    ...positions.map((position, index) => ({ id: `pickup-${index}`, prefab: pickup, transform: { position } })),
    { id: "sun", transform: { position: [4, 8, 5] }, light: { kind: "directional", intensity: 3, castShadow: true } },
  ] }),
});
