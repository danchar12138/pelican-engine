import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "Character2DDemo", schema: {
  initialized: { type: "boolean", default: false }, vertical: { type: "number", default: 0 },
} });
const ground = defineMaterial({ id: "ground", color: "#536c7c", roughness: 0.9 });
const actor = defineMaterial({ id: "actor", color: "#66d5e5", roughness: 0.7 });
const move = defineSystem({ id: "character2d-demo", phase: "update", reads: ["Character2DDemo", "Transform"], writes: ["Character2DDemo", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.physics2d.create({ id: "ground-body", entity: "ground", type: "fixed", collider: { shape: "box", halfExtents: [4, 0.25] } });
    ctx.physics2d.create({ id: "wall-body", entity: "wall", type: "fixed", collider: { shape: "box", halfExtents: [0.25, 1] } });
    ctx.physics2d.create({ id: "character-body", entity: "character", type: "kinematic", collider: { shape: "capsule", halfHeight: 0.45, radius: 0.3 } });
    ctx.physics2d.attachCharacter("character-body", { offset: 0.01, snapToGround: 0.08 });
    ctx.setComponent("state", State, { initialized: true });
  }
  const character = ctx.physics2d.characterState("character-body");
  let vertical = state.vertical;
  if (!character.deferred) {
    if (character.grounded && vertical < 0) vertical = 0;
    if (character.grounded && ctx.input.pressed("jump")) vertical = 5;
    vertical = Math.max(-15, vertical - 9.81 * dt);
    ctx.physics2d.moveCharacter("character-body", [ctx.input.axis("left", "right") * 3 * dt, vertical * dt]);
    ctx.setComponent("state", State, { vertical });
  }
  ctx.ui.setText("status", `Arrows: move | Space: jump | grounded: ${character.grounded} | deferred: ${character.deferred}`);
} });

export default defineGame({ id: "physics2d-character", components: [State], systems: [move], materials: [ground, actor],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], jump: [" "] }, render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | Space: jump", x: 16, y: 16, width: 640 }],
  scene: defineScene({ id: "character2d", physics2d: { gravity: [0, -9.81] },
    camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "ground", transform: { position: [0, -2, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.5, 0.2] }, material: ground } },
      { id: "wall", transform: { position: [2, -0.75, 0] }, mesh: { geometry: { kind: "box", size: [0.5, 2, 0.2] }, material: ground } },
      { id: "character", transform: { position: [0, 1.5, 0.2] }, mesh: { geometry: { kind: "box", size: [0.6, 1.5, 0.2] }, material: actor } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
