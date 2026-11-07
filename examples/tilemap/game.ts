import { defineAsset, defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";
import type { TilemapUpdate } from "pelican-engine";

const sheet = defineAsset({ id: "tiles", path: "assets/tiles.png", type: "texture", license: "MIT", source: "Procedural Pelican Engine tilemap example" });
const material = defineMaterial({ id: "tile-material", texture: sheet, color: "#ffffff", roughness: 1 });
const actor = defineMaterial({ id: "actor-material", color: "#67d9ec", roughness: 0.8 });
const State = defineComponent({ id: "TileDemo", schema: { initialized: { type: "boolean", default: false } } });
const tiles = defineSystem({ id: "tile-demo", phase: "update", reads: ["TileDemo"], writes: ["TileDemo"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.tilemaps.create({ id: "field", entity: "map-root", material: "tile-material", width: 10, height: 6,
      tileSize: [0.8, 0.8], offset: [-4, 2.4], columns: 2, rows: 2 });
    const updates: TilemapUpdate[] = [];
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++)
      updates.push({ x, y, frame: x === 0 || y === 0 || x === 9 || y === 5 ? 2 : (x + y) % 2 });
    ctx.tilemaps.setTiles("field", updates);
    ctx.navigation.createGrid({ id: "field-grid", owner: "scene", width: 10, height: 6 });
    ctx.tilemaps.syncNavigation("field", "field-grid", { blockedFrames: [2, 3] });
    ctx.navigation.createAgent({ id: "walker", entity: "walker", grid: "field-grid", origin: [-4, 2.4],
      cellSize: 0.8, plane: "xy", rowDirection: "negative", speed: 1.5, allowDiagonal: true });
    ctx.navigation.setAgentTarget("walker", { x: 8, y: 4 });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("toggle")) {
    const current = ctx.tilemaps.getTile("field", 5, 3);
    ctx.tilemaps.setTilesAndSyncNavigation("field", [{ x: 5, y: 3, frame: current === 3 ? 0 : 3 }],
      "field-grid", { blockedFrames: [2, 3] });
  }
  ctx.ui.setText("status", `B: toggle obstacle | frame: ${ctx.tilemaps.getTile("field", 5, 3)} | walker: ${ctx.navigation.inspectAgent("walker").status}`);
} });

export default defineGame({ id: "tilemap-demo", assets: [sheet], materials: [material, actor], components: [State], systems: [tiles],
  input: { toggle: ["b"] }, render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "B: toggle center tile", x: 16, y: 16, width: 450 }],
  scene: defineScene({ id: "tilemap", camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "map-root" },
      { id: "walker", transform: { position: [-2.8, 1.2, 0.3] }, mesh: { geometry: { kind: "box", size: [0.45, 0.45, 0.2] }, material: actor } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
