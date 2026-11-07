import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "Physics2DDemo", schema: { initialized: { type: "boolean", default: false }, contacts: { type: "number", default: 0 } } });
const groundMaterial = defineMaterial({ id: "ground-material", color: "#526b7c", roughness: 0.9 });
const playerMaterial = defineMaterial({ id: "player-material", color: "#69d5e6", roughness: 0.7 });
const physics = defineSystem({ id: "physics2d-demo", phase: "update", reads: ["Physics2DDemo", "Transform"], writes: ["Physics2DDemo", "Transform"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.physics2d.create({ id: "ground-body", entity: "ground", type: "fixed", collider: { shape: "box", halfExtents: [4, 0.25] } });
    ctx.physics2d.create({ id: "player-body", entity: "player", type: "dynamic", collider: { shape: "box", halfExtents: [0.45, 0.45] }, mass: 1 });
    ctx.physics2d.create({ id: "pivot-body", entity: "pivot", type: "fixed", collider: { shape: "compound", parts: [] } });
    ctx.physics2d.create({ id: "arm-body", entity: "arm", type: "dynamic", collider: { shape: "box", halfExtents: [0.2, 0.9] }, mass: 1 });
    ctx.physics2d.createJoint({ id: "hinge", kind: "revolute", bodyA: "pivot-body", bodyB: "arm-body", anchorB: [0, 0.9] });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("reset")) {
    ctx.entities.setTransform("player", { position: [0, 2, 0], rotation: [0, 0, 0] });
    ctx.physics2d.setVelocity("player-body", [0, 0]);
    ctx.physics2d.setAngularVelocity("player-body", 0);
  }
  const velocity = ctx.physics2d.inspect("player-body").velocity;
  ctx.physics2d.setVelocity("player-body", [ctx.input.axis("left", "right") * 3, velocity[1]]);
  if (ctx.input.pressed("jump")) ctx.physics2d.applyImpulse("player-body", [0, 5]);
  if (ctx.input.pressed("kick")) ctx.physics2d.applyImpulse("arm-body", [2, 0]);
  const started = ctx.events("physics2d.collision.started").length;
  if (started) ctx.setComponent("state", State, { contacts: state.contacts + started });
  const body = ctx.physics2d.inspect("player-body");
  ctx.ui.setText("status", `Arrows: move | Space: impulse | J: swing | R: reset | y ${body.position[1].toFixed(2)} | contacts ${state.contacts + started}`);
} });

export default defineGame({ id: "physics2d-demo", components: [State], systems: [physics], materials: [groundMaterial, playerMaterial],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], jump: [" "], reset: ["r"], kick: ["j"] }, render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | Space: impulse | J: swing | R: reset", x: 16, y: 16, width: 640 }],
  scene: defineScene({ id: "physics2d", physics2d: { gravity: [0, -9.81] },
    camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "ground", transform: { position: [0, -2, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.5, 0.2] }, material: groundMaterial } },
      { id: "player", transform: { position: [0, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.9, 0.9, 0.2] }, material: playerMaterial } },
      { id: "pivot", transform: { position: [3, 1.7, 0] } },
      { id: "arm", transform: { position: [3, 0.8, 0] }, mesh: { geometry: { kind: "box", size: [0.4, 1.8, 0.2] }, material: playerMaterial } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
