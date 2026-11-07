import { defineAsset, defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const sheet = defineAsset({ id: "sheet", path: "assets/atlas.png", type: "texture", license: "MIT", source: "Procedural Pelican Engine sprite example" });
const material = defineMaterial({ id: "sprite-material", texture: sheet, color: "#ffffff", transparent: true, roughness: 1 });
const State = defineComponent({ id: "SpriteDemo", schema: { initialized: { type: "boolean", default: false } } });
const sprites = defineSystem({ id: "sprite-demo", phase: "update", reads: ["SpriteDemo", "Transform"], writes: ["SpriteDemo", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.sprites.create({ id: "hero-sprite", entity: "hero", material: "sprite-material", size: [2, 2],
      columns: 4, rows: 1, animation: { first: 0, last: 3, fps: 6, loop: true } });
    ctx.setComponent("state", State, { initialized: true });
  }
  const position = ctx.getTransform("hero").position;
  ctx.setTransform("hero", { position: [Math.max(-5, Math.min(5, position[0] + ctx.input.axis("left", "right") * dt * 3)), position[1], position[2]] });
  if (ctx.input.pressed("pause")) {
    if (ctx.sprites.inspect("hero-sprite").playing) ctx.sprites.pause("hero-sprite");
    else ctx.sprites.resume("hero-sprite");
  }
  const sprite = ctx.sprites.inspect("hero-sprite");
  ctx.ui.setText("status", `Left/right: move | Space: pause | frame ${sprite.frame + 1}/4`);
} });

export default defineGame({ id: "sprite-atlas", assets: [sheet], materials: [material], components: [State], systems: [sprites],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], pause: [" "] },
  render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Left/right: move | Space: pause", x: 16, y: 16, width: 450 }],
  scene: defineScene({ id: "sprites", camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "hero", transform: { position: [0, 0, 0] } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
