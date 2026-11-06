import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";
const red = defineMaterial({ id: "red", color: "#e45d45", roughness: 0.45 });
const teal = defineMaterial({ id: "teal", color: "#23b8a7", roughness: 0.45 });
const stats = defineComponent({ id: "AngularStats", schema: {
  centered: { type: "vec3", default: [0,0,0] }, offset: { type: "vec3", default: [0,0,0] }, error: { type: "string", default: "" },
} });
const controls = defineSystem({ id: "angular-controls", phase: "prePhysics", reads: ["Transform", "AngularStats"], writes: ["AngularStats"], run(ctx) {
  for (const event of ctx.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean }; if (!input.pressed) continue;
    if (input.key === "i") {
      const c = ctx.getTransform("centered").position, p = ctx.getTransform("offset").position;
      ctx.physics.impulseAtPoint("centered", [1,0,0], c);
      ctx.physics.impulseAtPoint("offset", [1,0,0], [p[0], p[1] + 0.4, p[2]]);
    }
    if (input.key === "t") ctx.physics.torqueImpulse("offset", [0,0,0.2]);
    if (input.key === "v") ctx.physics.setAngularVelocity("centered", [0,0,1]);
    if (input.key === "f") { try { ctx.physics.torqueImpulse("anchor", [0,0,1]); } catch (error) { ctx.setComponent("stats", stats, { error: String(error).match(/TC_[A-Z_]+/)?.[0] ?? "unknown" }); } }
  }
} });
const observe = defineSystem({ id: "angular-observe", phase: "postPhysics", reads: ["AngularStats"], writes: ["AngularStats"], run(ctx) {
  ctx.setComponent("stats", stats, { centered: ctx.physics.angularVelocity("centered"), offset: ctx.physics.angularVelocity("offset") });
} });
export default defineGame({ id: "angular-physics", components: [stats], systems: [controls, observe],
  scene: defineScene({ id: "scene", gravity: [0,0,0], camera: { position: [0,0,7], target: [0,0,0], fov: 45 }, environment: { background: "#101b25", ambientIntensity: 0.6 }, entities: [
    { id: "centered", transform: { position: [-1,0,0] }, mesh: { geometry: { kind: "box", size: [1,1,1] }, material: red }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "box", size: [1,1,1] } } },
    { id: "offset", transform: { position: [1,0,0] }, mesh: { geometry: { kind: "box", size: [1,1,1] }, material: teal }, rigidBody: { type: "dynamic", mass: 2, collider: { shape: "box", size: [1,1,1] } } },
    { id: "anchor", transform: { position: [0,-3,0] }, rigidBody: { type: "fixed", collider: { shape: "box", size: [1,1,1] } } },
    { id: "stats", components: [{ component: stats }] }, { id: "light", transform: { position: [2,4,5] }, light: { kind: "directional", intensity: 3 } },
  ] }),
});
