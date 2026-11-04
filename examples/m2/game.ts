import {
  defineAsset,
  defineComponent,
  defineGame,
  defineMaterial,
  definePrefab,
  defineScene,
  defineSystem,
} from "@threecat/sdk";

const fox = defineAsset({
  id: "fox",
  type: "model",
  path: "assets/Fox.glb",
  license: "CC0-1.0 AND CC-BY-4.0",
  source:
    "KhronosGroup/glTF-Sample-Assets@8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Fox",
  attribution:
    "Model: PixelMannen (2014), CC0. Rigging and animation: tomkranis (2014), CC-BY-4.0. glTF conversion: AsoboStudio and scurest (2017), CC-BY-4.0.",
});
const bottle = defineAsset({
  id: "bottle",
  type: "model",
  path: "assets/WaterBottle.glb",
  license: "CC0-1.0",
  source:
    "KhronosGroup/glTF-Sample-Assets@8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/WaterBottle",
  attribution: "Microsoft (2017), CC0.",
});
const chime = defineAsset({
  id: "chime",
  type: "audio",
  path: "assets/chime.wav",
  license: "MIT",
  source: "threecat procedural PCM synthesis",
});
const slate = defineMaterial({
  id: "slate",
  color: "#667b85",
  roughness: 0.82,
});
const dark = defineMaterial({ id: "dark", color: "#243a48", roughness: 0.7 });
const gold = defineMaterial({
  id: "gold",
  color: "#edbc55",
  roughness: 0.2,
  metalness: 0.8,
});
const teal = defineMaterial({
  id: "teal",
  color: "#3bdfc7",
  roughness: 0.25,
  metalness: 0.4,
});
const danger = defineMaterial({
  id: "danger",
  color: "#ec5566",
  roughness: 0.2,
  metalness: 0.25,
});
const fallingCrate = definePrefab({
  id: "falling-crate",
  mesh: { geometry: { kind: "box", size: [0.6, 0.6, 0.6] }, material: gold },
  rigidBody: {
    type: "dynamic",
    mass: 1,
    collider: { shape: "box", size: [0.6, 0.6, 0.6] },
  },
});
const foxCompanion = definePrefab({
  id: "fox-companion",
  model: {
    asset: fox,
    scale: 0.013,
    offset: [0, -0.7, 0],
    animation: { clip: "Survey" },
  },
  character: { radius: 0.3, height: 1.4, speed: 3 },
});
export const Progress = defineComponent({
  id: "Progress",
  schema: {
    collected: { type: "number", default: 0 },
    health: { type: "number", default: 3 },
    hurtAt: { type: "number", default: -120 },
    won: { type: "boolean", default: false },
  },
});
export const Relic = defineComponent({
  id: "Relic",
  schema: { taken: { type: "boolean", default: false } },
});
const plinth = definePrefab({
  id: "plinth",
  mesh: { geometry: { kind: "box", size: [1.5, 0.4, 1.5] }, material: dark },
  rigidBody: {
    type: "fixed",
    collider: { shape: "box", size: [1.5, 0.4, 1.5] },
  },
});
const control = defineSystem({
  id: "control",
  phase: "prePhysics",
  reads: ["Progress", "Transform"],
  writes: ["Progress", "Transform"],
  structural: true,
  run(ctx, dt) {
    if (ctx.input.pressed("save")) ctx.storage.save("journey");
    else if (ctx.input.pressed("load")) ctx.storage.load("journey");
    else if (ctx.input.pressed("restart")) ctx.scenes.load("courtyard");
    if (ctx.scenes.current() !== "courtyard") return;
    if (ctx.input.pressed("spawn")) {
      const at = ctx.getTransform("player").position;
      ctx.entities.spawn({
        id: "spawned-crate-" + ctx.time.tick,
        prefab: "falling-crate",
        transform: { position: [at[0] + 2, 3, at[2]] },
      });
    }
    if (ctx.input.pressed("companion") && !ctx.entities.isAlive("companion"))
      ctx.entities.spawn({
        id: "companion",
        prefab: "fox-companion",
        transform: { position: [-6, 0.75, 3] },
      });
    const progress = ctx.getComponent("player", Progress);
    if (progress.health <= 0) return;
    let x = ctx.input.axis("left", "right"),
      z = ctx.input.axis("forward", "back");
    const length = Math.hypot(x, z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    if (length > 0) {
      ctx.physics.moveCharacter("player", [x * 4.3 * dt, 0, z * 4.3 * dt]);
      ctx.setTransform("player", { rotation: [0, Math.atan2(x, z), 0] });
    }
    if (ctx.input.pressed("jump") && ctx.physics.grounded("player"))
      ctx.physics.setVelocity("player", [0, 6.5, 0]);
    const clip = length > 0 ? "Run" : "Survey";
    if (ctx.animation.state("player").clip !== clip)
      ctx.animation.play("player", clip, { fade: 0.15 });
    if (ctx.input.held("orbitLeft")) ctx.camera.orbit(-dt);
    if (ctx.input.held("orbitRight")) ctx.camera.orbit(dt);
    const sentinel = ctx.getTransform("sentinel");
    ctx.setTransform("sentinel", {
      position: [
        Math.sin(ctx.time.elapsed * 1.3) * 4.8,
        sentinel.position[1],
        -8,
      ],
    });
  },
});
const quest = defineSystem({
  id: "quest",
  phase: "update",
  reads: ["Transform", "Progress", "Relic"],
  writes: ["Progress", "Relic", "Transform"],
  run(ctx) {
    if (ctx.scenes.current() !== "courtyard") {
      ctx.ui.setText("mission", "Journey complete. Press R to play again.");
      ctx.ui.setText("score", "3 relics recovered");
      ctx.ui.setProgress("progress", 1);
      ctx.ui.setText(
        "hint",
        "All three relics recovered through public SDK gameplay.",
      );
      return;
    }
    if (ctx.input.pressed("restart")) return;
    const position = ctx.getTransform("player").position,
      progress = ctx.getComponent("player", Progress);
    if (progress.health > 0) {
      if (ctx.input.pressed("interact"))
        for (const id of ctx.query(Relic)) {
          const relic = ctx.getComponent(id, Relic),
            at = ctx.getTransform(id).position;
          if (
            !relic.taken &&
            Math.hypot(position[0] - at[0], position[2] - at[2]) < 2.3
          ) {
            ctx.setComponent(id, Relic, { taken: true });
            ctx.setTransform(id, { position: [at[0], -10, at[2]] });
            ctx.setComponent("player", Progress, {
              collected: ctx.getComponent("player", Progress).collected + 1,
            });
            ctx.audio.play("collect", { volume: 0.45 });
          }
        }
      const enemy = ctx.getTransform("sentinel").position;
      if (
        Math.hypot(position[0] - enemy[0], position[2] - enemy[2]) < 1.15 &&
        ctx.time.tick - progress.hurtAt > 90
      ) {
        ctx.setComponent("player", Progress, {
          health: progress.health - 1,
          hurtAt: ctx.time.tick,
        });
        ctx.audio.play("collect", { volume: 0.2 });
      }
      if (
        ctx.getComponent("player", Progress).collected === 3 &&
        position[2] < -15.5 &&
        Math.abs(position[0]) < 2
      ) {
        const storage = ctx.storage.status();
        if (storage.state === "saving" || storage.state === "loading") return;
        ctx.setComponent("player", Progress, { won: true });
        ctx.scenes.load("sanctuary");
        return;
      }
    }
    const now = ctx.getComponent("player", Progress);
    ctx.ui.setText(
      "mission",
      now.health <= 0
        ? "Out of hearts. Press R to retry."
        : "Find the three relics, then enter the northern gate.",
    );
    ctx.ui.setText(
      "score",
      "Relics " + now.collected + " / 3   Hearts " + now.health + " / 3",
    );
    ctx.ui.setProgress("progress", now.collected / 3);
    const storage = ctx.storage.status();
    ctx.ui.setText(
      "hint",
      storage.state === "failed"
        ? "Save error: " + storage.error
        : "E: collect nearby relic | F5: save | F9: load | " + storage.state,
    );
  },
});
const courtyard = defineScene({
  id: "courtyard",
  camera: { position: [0, 4.5, 11], target: [0, 0.8, 3], fov: 52, far: 120 },
  follow: {
    entity: "player",
    distance: 7,
    height: 4,
    lookHeight: 0.35,
    smoothing: 0.15,
  },
  environment: {
    background: "#9eb7c7",
    ambientIntensity: 1.8,
    lighting: "studio",
  },
  entities: [
    {
      id: "player",
      transform: { position: [0, 0.75, 4] },
      model: {
        asset: fox,
        scale: 0.013,
        offset: [0, -0.7, 0],
        animation: { clip: "Survey" },
      },
      character: { radius: 0.3, height: 1.4, speed: 4.3, jumpSpeed: 6.5 },
      components: [{ component: Progress }],
    },
    {
      id: "floor",
      transform: { position: [0, -0.3, -6] },
      mesh: { geometry: { kind: "box", size: [22, 0.6, 32] }, material: slate },
      rigidBody: {
        type: "fixed",
        collider: { shape: "box", size: [22, 0.6, 32] },
      },
    },
    {
      id: "wall-left",
      transform: { position: [-10, 1.2, -6] },
      mesh: { geometry: { kind: "box", size: [0.6, 2.4, 32] }, material: dark },
      rigidBody: {
        type: "fixed",
        collider: { shape: "box", size: [0.6, 2.4, 32] },
      },
    },
    {
      id: "wall-right",
      transform: { position: [10, 1.2, -6] },
      mesh: { geometry: { kind: "box", size: [0.6, 2.4, 32] }, material: dark },
      rigidBody: {
        type: "fixed",
        collider: { shape: "box", size: [0.6, 2.4, 32] },
      },
    },
    {
      id: "wall-south",
      transform: { position: [0, 1.2, 9.5] },
      mesh: { geometry: { kind: "box", size: [20, 2.4, 0.6] }, material: dark },
      rigidBody: {
        type: "fixed",
        collider: { shape: "box", size: [20, 2.4, 0.6] },
      },
    },
    {
      id: "obstacle",
      transform: { position: [2.5, 0.8, -5] },
      mesh: { geometry: { kind: "box", size: [3, 1.6, 1] }, material: dark },
      rigidBody: {
        type: "fixed",
        collider: { shape: "box", size: [3, 1.6, 1] },
      },
    },
    {
      id: "crate",
      transform: { position: [-2, 0.7, 1] },
      mesh: {
        geometry: { kind: "box", size: [1.2, 1.2, 1.2] },
        material: gold,
      },
      rigidBody: {
        type: "dynamic",
        mass: 2,
        collider: { shape: "box", size: [1.2, 1.2, 1.2] },
      },
    },
    {
      id: "relic-a",
      transform: { position: [0, 0.8, -2] },
      model: { asset: bottle, scale: 4 },
      components: [{ component: Relic }],
    },
    {
      id: "relic-b",
      transform: { position: [-4, 0.8, -9] },
      model: { asset: bottle, scale: 4 },
      components: [{ component: Relic }],
    },
    {
      id: "relic-c",
      transform: { position: [4, 0.8, -13] },
      model: { asset: bottle, scale: 4 },
      components: [{ component: Relic }],
    },
    { id: "pedestal-a", prefab: plinth, transform: { position: [0, 0.2, -2] } },
    {
      id: "pedestal-b",
      prefab: plinth,
      transform: { position: [-4, 0.2, -9] },
    },
    {
      id: "pedestal-c",
      prefab: plinth,
      transform: { position: [4, 0.2, -13] },
    },
    {
      id: "sentinel",
      transform: { position: [0, 0.8, -8] },
      mesh: {
        geometry: { kind: "sphere", radius: 0.65, segments: 24 },
        material: danger,
      },
      rigidBody: {
        type: "kinematic",
        trigger: true,
        collider: { shape: "sphere", radius: 0.65 },
      },
    },
    {
      id: "gate-left",
      transform: { position: [-2, 1.8, -17] },
      mesh: {
        geometry: { kind: "box", size: [0.5, 3.6, 0.5] },
        material: teal,
      },
    },
    {
      id: "gate-right",
      transform: { position: [2, 1.8, -17] },
      mesh: {
        geometry: { kind: "box", size: [0.5, 3.6, 0.5] },
        material: teal,
      },
    },
    {
      id: "gate-top",
      transform: { position: [0, 3.4, -17] },
      mesh: {
        geometry: { kind: "box", size: [4.5, 0.5, 0.5] },
        material: teal,
      },
    },
    {
      id: "sun",
      transform: { position: [-6, 12, 8] },
      light: {
        kind: "directional",
        color: "#fff2d4",
        intensity: 3.5,
        target: [0, 0, -6],
        shadow: { extent: 21, mapSize: 2048 },
        castShadow: true,
      },
    },
    {
      id: "gate-light",
      transform: { position: [0, 3, -16] },
      light: { kind: "point", color: "#5effd5", intensity: 30 },
    },
  ],
});
const sanctuary = defineScene({
  id: "sanctuary",
  camera: { position: [4, 3, 6], target: [0, 1, 0] },
  environment: {
    background: "#152a39",
    ambientIntensity: 2,
    lighting: "studio",
  },
  entities: [
    {
      id: "reward",
      transform: { position: [0, 1, 0] },
      model: { asset: bottle, scale: 8 },
    },
    {
      id: "display",
      transform: { position: [0, -0.2, 0] },
      mesh: { geometry: { kind: "box", size: [5, 0.4, 5] }, material: gold },
    },
    {
      id: "sun",
      transform: { position: [3, 8, 4] },
      light: {
        kind: "directional",
        intensity: 4,
        color: "#fff2d4",
        castShadow: true,
      },
    },
  ],
});
export default defineGame({
  id: "m2-fox-journey",
  scene: courtyard,
  scenes: [sanctuary],
  systems: [control, quest],
  assets: [fox, bottle, chime],
  materials: [slate, dark, gold, teal, danger],
  input: {
    spawn: ["b", "B"],
    companion: ["n", "N"],
    forward: ["w", "W", "ArrowUp"],
    back: ["s", "S", "ArrowDown"],
    left: ["a", "A", "ArrowLeft"],
    right: ["d", "D", "ArrowRight"],
    jump: [" "],
    interact: ["e", "E"],
    save: ["F5", "ui:save"],
    load: ["F9", "ui:load"],
    restart: ["r", "R", "ui:restart"],
    orbitLeft: ["q", "Q"],
    orbitRight: ["t", "T"],
  },
  sounds: [{ id: "collect", asset: chime, volume: 0.6 }],
  ui: [
    {
      id: "mission",
      kind: "text",
      text: "Find three relics",
      x: 16,
      y: 16,
      width: 570,
    },
    {
      id: "score",
      kind: "text",
      text: "Relics 0 / 3",
      x: 16,
      y: 70,
      width: 260,
    },
    { id: "progress", kind: "bar", value: 0, x: 16, y: 118, width: 260 },
    {
      id: "hint",
      kind: "text",
      text: "E: collect | F5 save | F9 load",
      anchor: "bottom-left",
      x: 16,
      y: 16,
      width: 610,
    },
    {
      id: "controls",
      kind: "text",
      text: "WASD / arrows: move | Space: jump | Q/T: orbit",
      anchor: "bottom-left",
      x: 16,
      y: 66,
      width: 610,
    },
    {
      id: "save",
      kind: "button",
      text: "Save",
      anchor: "top-right",
      x: 16,
      y: 16,
      width: 100,
    },
    {
      id: "load",
      kind: "button",
      text: "Load",
      anchor: "top-right",
      x: 16,
      y: 66,
      width: 100,
    },
    {
      id: "restart",
      kind: "button",
      text: "Restart",
      anchor: "top-right",
      x: 16,
      y: 116,
      width: 100,
    },
  ],
});
