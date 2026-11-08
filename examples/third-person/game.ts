import {
  defineGame,
  defineGameRuntime,
  defineMaterial,
  defineScene,
} from "pelican-engine";

const floor = defineMaterial({
  id: "floor",
  color: "#3c4841",
  roughness: 0.85,
});
const player = defineMaterial({
  id: "player",
  color: "#67b8c7",
  roughness: 0.28,
  metalness: 0.2,
});
export default defineGame({
  id: "third-person",
  ...defineGameRuntime<{ jumps: number }>({
    version: "player-v1",
    state: () => ({ jumps: 0 }),
    validateState(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("jumps" in value) ||
        !Number.isSafeInteger(value.jumps) ||
        Number(value.jumps) < 0
      )
        throw new Error("PLAYER_STATE: Expected nonnegative integer jumps.");
    },
    systems: [
      {
        id: "player.control",
        phase: "input",
        run(ctx, dt, state) {
          const x = ctx.input.axis("left", "right"),
            z = ctx.input.axis("forward", "back");
          const scale = (4 * dt) / Math.max(1, Math.hypot(x, z));
          ctx.physics.moveCharacter("player", [x * scale, 0, z * scale]);
          if (ctx.input.pressed("jump") && ctx.physics.grounded("player")) {
            ctx.physics.setVelocity("player", [0, 6, 0]);
            state.value.jumps++;
          }
          const actions = ctx
            .events("ui.activate")
            .map((event) => (event.payload as { id: string }).id);
          const storage = ctx.storage.status();
          if (!["saving", "loading"].includes(storage.state)) {
            if (ctx.input.pressed("save") || actions.includes("save"))
              ctx.storage.save("progress");
            else if (ctx.input.pressed("load") || actions.includes("load"))
              ctx.storage.load("progress");
          }
          ctx.ui.setText(
            "state",
            `Jumps ${state.value.jumps} | ${storage.state}`,
          );
        },
      },
    ],
  }),
  input: {
    left: ["a", "A", "ArrowLeft"],
    right: ["d", "D", "ArrowRight"],
    forward: ["w", "W", "ArrowUp"],
    back: ["s", "S", "ArrowDown"],
    jump: [" "],
    save: ["k", "K"],
    load: ["l", "L"],
  },
  ui: [
    { id: "state", kind: "text", text: "Jumps 0", x: 16, y: 16 },
    { id: "save", kind: "button", text: "Save", x: 16, y: 56, width: 80 },
    { id: "load", kind: "button", text: "Load", x: 104, y: 56, width: 80 },
  ],
  scene: defineScene({
    id: "main",
    environment: {
      lighting: "studio",
      ambientIntensity: 0.15,
      background: "#243039",
    },
    follow: {
      entity: "player",
      distance: 6,
      height: 3,
      lookHeight: 0.5,
      smoothing: 0.15,
    },
    entities: [
      {
        id: "player",
        transform: { position: [0, 1.5, 0] },
        mesh: {
          geometry: { kind: "box", size: [0.6, 1.2, 0.6] },
          material: player,
        },
        character: { radius: 0.3, height: 1.2, speed: 4, jumpSpeed: 6 },
      },
      {
        id: "floor",
        transform: { position: [0, -0.25, 0] },
        mesh: {
          geometry: { kind: "box", size: [20, 0.5, 20] },
          material: floor,
        },
        rigidBody: {
          type: "fixed",
          collider: { shape: "box", size: [20, 0.5, 20] },
        },
      },
      {
        id: "wall",
        transform: { position: [2, 1, 0] },
        mesh: { geometry: { kind: "box", size: [0.5, 2, 4] }, material: floor },
        rigidBody: {
          type: "fixed",
          collider: { shape: "box", size: [0.5, 2, 4] },
        },
      },
      {
        id: "sun",
        transform: { position: [4, 8, 5] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
});
