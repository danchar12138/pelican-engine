import { defineAsset, defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";
const chime = defineAsset({ id: "chime", type: "audio", path: "assets/chime.wav", license: "MIT", source: "pelican procedural PCM synthesis" });
const state = defineComponent({ id: "AudioState", schema: {
  target: { type: "string", default: "" }, control: { type: "string", default: "" }, error: { type: "string", default: "" },
} });
const controls = defineSystem({ id: "audio-controls", phase: "prePhysics", reads: ["AudioState"], writes: ["AudioState"], run(ctx) {
  for (const event of ctx.events("input.key")) {
    const input = event.payload as { key: string; pressed: boolean };
    if (!input.pressed) continue;
    const current = ctx.getComponent("state", state);
    try {
      if (input.key === "p" && !current.target) {
        const target = ctx.audio.play("chime", { loop: true });
        const control = ctx.audio.play("chime", { loop: true, bus: "effects" });
        ctx.setComponent("state", state, { target, control });
      } else if (input.key === "a" && current.target) ctx.audio.pause(current.target);
      else if (input.key === "r" && current.target) ctx.audio.resume(current.target);
      else if (input.key === "m") ctx.audio.busVolume("music", 0.25);
      else if (input.key === "u") ctx.audio.busVolume("music", 1);
      else if (input.key === "s" && current.target) {
        ctx.audio.stop(current.target); ctx.audio.stop(current.control);
        ctx.setComponent("state", state, { target: "", control: "" });
      }
    } catch (error) { ctx.setComponent("state", state, { error: String(error) }); }
  }
} });
export default defineGame({ id: "audio-pause", assets: [chime], audioBuses: [{ id: "music" }, { id: "effects" }], sounds: [{ id: "chime", asset: chime, volume: 0.5, bus: "music" }], components: [state], systems: [controls],
  scene: defineScene({ id: "scene", camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 }, environment: { background: "#172022", ambientIntensity: 1 }, entities: [{ id: "state", components: [{ component: state }] }] }),
});
