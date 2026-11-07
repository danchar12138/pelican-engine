import { defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "StreamingState", schema: {
  initialized: { type: "boolean", default: false },
  nextBuilding: { type: "number", default: 0 },
  lastBuilding: { type: "string", default: "" },
  lastX: { type: "number", default: 0 },
  lastZ: { type: "number", default: 0 },
} });
const ground = defineMaterial({ id: "ground", color: "#3a8065", roughness: 0.9 });
const pillar = defineMaterial({ id: "pillar", color: "#e0ad53", roughness: 0.7 });
const playerMaterial = defineMaterial({ id: "player", color: "#70ddf2", roughness: 0.6 });
const floorPrefab = definePrefab({ id: "chunk-floor", mesh: { geometry: { kind: "box", size: [7.8, 0.2, 7.8] }, material: ground } });
const markerPrefab = definePrefab({ id: "chunk-marker", mesh: { geometry: { kind: "box", size: [0.6, 1.8, 0.6] }, material: pillar } });
const walk = defineSystem({ id: "streaming-demo", phase: "update", reads: ["StreamingState", "Transform"], writes: ["StreamingState", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.streaming.configure({ chunkSize: 8, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 });
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++)
      ctx.streaming.defineChunk({ x, z, entities: [
        { id: `floor:${x}:${z}`, prefab: "chunk-floor", transform: { position: [x * 8 + 4, -0.1, z * 8 + 4] } },
        { id: `marker:${x}:${z}`, prefab: "chunk-marker", transform: { position: [x * 8 + 4, 0.9, z * 8 + 4] } },
      ] });
    ctx.camera.follow("player", { distance: 12, height: 11, lookHeight: 0 });
    ctx.setComponent("state", State, { initialized: true });
  }
  const position = ctx.getTransform("player").position;
  const next: [number, number, number] = [
    Math.max(-23, Math.min(23, position[0] + ctx.input.axis("left", "right") * dt * 4)),
    position[1],
    Math.max(-23, Math.min(23, position[2] + ctx.input.axis("up", "down") * dt * 4)),
  ];
  ctx.setTransform("player", { position: next });
  ctx.streaming.setFocus(next);
  if (ctx.input.pressed("build")) {
    const x = Math.floor(next[0] / 8), z = Math.floor(next[2] / 8);
    const id = `built:${state.nextBuilding}`;
    ctx.streaming.addEntity(x, z, { id, prefab: "chunk-marker", transform: { position: [next[0] + 1, 0.9, next[2]] } });
    ctx.setComponent("state", State, { nextBuilding: state.nextBuilding + 1, lastBuilding: id, lastX: x, lastZ: z });
  }
  if (ctx.input.pressed("remove") && state.lastBuilding) {
    ctx.streaming.removeEntity(state.lastX, state.lastZ, state.lastBuilding);
    ctx.setComponent("state", State, { lastBuilding: "" });
  }
  const visible = ctx.streaming.inspect().chunks.filter(chunk => chunk.active).length;
  ctx.ui.setText("status", `Arrows: move | B: build | X: remove last | active chunks: ${visible}`);
} });

export default defineGame({
  id: "streaming-world", components: [State], systems: [walk],
  prefabs: [floorPrefab, markerPrefab], materials: [ground, pillar, playerMaterial],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"], build: ["b"], remove: ["x"] },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | B: build | X: remove last", x: 16, y: 16 }],
  scene: defineScene({ id: "streaming-world", camera: { position: [8, 14, 16], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "player", transform: { position: [0, 0.45, 0] }, mesh: { geometry: { kind: "box", size: [0.7, 0.9, 0.7] }, material: playerMaterial } },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
