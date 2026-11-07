import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "GamepadDemo", schema: {
  initialized: { type: "boolean", default: false }, presses: { type: "number", default: 0 },
} });
const actor = defineMaterial({ id: "actor", color: "#6ad9e7", roughness: 0.8 });
const move = defineSystem({ id: "gamepad-demo", phase: "update", reads: ["GamepadDemo", "Transform"], writes: ["GamepadDemo", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.input.setGamepadMode("game");
    ctx.input.setGamepadDeadzone(0.15);
    ctx.setComponent("state", State, { initialized: true });
  }
  const pad = ctx.input.gamepad(), position = ctx.getTransform("actor").position;
  const horizontal = pad.axes[0] ? pad.axes[0] : ctx.input.axis("left", "right");
  const vertical = pad.axes[1] ? -pad.axes[1] : ctx.input.axis("down", "up");
  ctx.setTransform("actor", { position: [Math.max(-6, Math.min(6, position[0] + horizontal * 3 * dt)),
    Math.max(-3, Math.min(3, position[1] + vertical * 3 * dt)), position[2]] });
  const presses = state.presses + Number(ctx.input.pressed("action"));
  if (presses !== state.presses) ctx.setComponent("state", State, { presses });
  ctx.ui.setText("status", `Arrows or left stick: move | Space or button 0: action | pad: ${pad.connected ? pad.index : "none"} | presses: ${presses}`);
} });

export default defineGame({ id: "gamepad-demo", components: [State], systems: [move], materials: [actor],
  input: {
    left: ["ArrowLeft", "gamepad:axis:0:negative", "gamepad:button:14"],
    right: ["ArrowRight", "gamepad:axis:0:positive", "gamepad:button:15"],
    up: ["ArrowUp", "gamepad:axis:1:negative", "gamepad:button:12"],
    down: ["ArrowDown", "gamepad:axis:1:positive", "gamepad:button:13"],
    action: [" ", "gamepad:button:0"],
  },
  render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows or gamepad: move", x: 16, y: 16, width: 720 }],
  scene: defineScene({ id: "gamepad", camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "actor", mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: actor } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
