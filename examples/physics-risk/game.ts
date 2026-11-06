import {
  defineGame,
  defineScene,
  defineMaterial,
  defineSystem,
} from "pelican-engine";
const floor = defineMaterial({ id: "floor", color: "#405774", roughness: 0.8 });
const gold = defineMaterial({ id: "gold", color: "#f2ba5b", roughness: 0.45 });
const coral = defineMaterial({ id: "coral", color: "#e65d74", roughness: 0.5 });
const movement = defineSystem({
  id: "movement",
  phase: "prePhysics",
  reads: ["Transform"],
  writes: ["Transform"],
  run(ctx, dt) {
    const z = ctx.input.axis("forward", "back");
    ctx.physics.moveCharacter("player", [0, 0, z * 3.6 * dt]);
    if (ctx.input.pressed("open"))
      ctx.setTransform("gate", { position: [0, 5, 7] });
  },
});
export default defineGame({
  id: "m2-kinematic-contact-regression",
  scene: defineScene({
    id: "contact",
    camera: { position: [10, 9, 14], target: [0, 0.8, 5], fov: 45 },
    environment: { background: "#132334", ambientIntensity: 1.5 },
    entities: [
      {
        id: "player",
        transform: { position: [0, 0.75, 4] },
        mesh: {
          geometry: { kind: "box", size: [0.6, 1.4, 0.6] },
          material: gold,
        },
        character: { radius: 0.3, height: 1.4, speed: 3.6 },
      },
      {
        id: "floor",
        transform: { position: [0, -0.3, 0] },
        mesh: {
          geometry: { kind: "box", size: [18, 0.6, 21] },
          material: floor,
        },
        rigidBody: {
          type: "fixed",
          collider: { shape: "box", size: [18, 0.6, 21] },
        },
      },
      {
        id: "gate",
        transform: { position: [0, 1.4, 7] },
        mesh: {
          geometry: { kind: "box", size: [3.5, 2.8, 0.4] },
          material: coral,
        },
        rigidBody: {
          type: "kinematic",
          collider: { shape: "box", size: [3.5, 2.8, 0.4] },
        },
      },
      {
        id: "sun",
        transform: { position: [4, 10, 7] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
  systems: [movement],
  materials: [floor, gold, coral],
  input: { forward: ["w"], back: ["s"], open: ["e"] },
});
