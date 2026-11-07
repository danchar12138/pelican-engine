import { defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const actor = defineMaterial({ id: "actor", color: "#5fd6e7", roughness: 0.8 });
const platform = defineMaterial({ id: "platform", color: "#536a7d", roughness: 0.9 });
const goal = defineMaterial({ id: "goal", color: "#f3c55f", roughness: 0.8 });
const move = defineSystem({ id: "move", phase: "update", reads: ["Transform"], writes: ["Transform"], run(ctx, dt) {
  const position = ctx.getTransform("player").position;
  const x = Math.max(-6.5, Math.min(6.5, position[0] + ctx.input.axis("left", "right") * 3 * dt));
  const y = Math.max(-3.5, Math.min(3.5, position[1] + ctx.input.axis("down", "up") * 3 * dt));
  ctx.setTransform("player", { position: [x, y, position[2]] });
} });

export default defineGame({
  id: "orthographic-2d", systems: [move], materials: [actor, platform, goal],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"] },
  render: { mode: "raster" },
  ui: [{ id: "help", kind: "text", text: "Arrow keys: move | orthographic raster", x: 16, y: 16, width: 450 }],
  scene: defineScene({ id: "flat-world", camera: {
    position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8,
  }, environment: { background: "#172534", ambientIntensity: 1 }, entities: [
    { id: "player", transform: { position: [-4, 0, 0.3] }, mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: actor } },
    { id: "floor", transform: { position: [0, -2.5, 0] }, mesh: { geometry: { kind: "box", size: [12, 0.4, 0.2] }, material: platform } },
    { id: "goal", transform: { position: [4, 1, 0] }, mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: goal } },
    { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
  ] }),
});
