import {
  defineGame,
  defineScene,
  defineMaterial,
  engineStartup,
  onEngineStartup,
} from "pelican-engine";

// Replace this small DOM view with a browser-compatible npm UI component.
// It runs before runtime setup so downloads are observable, and is Node-safe.
if (typeof document !== "undefined") {
  const owner = new AbortController();
  const label = document.createElement("output");
  label.dataset.pelicanStartupFeedback = "";
  label.style.cssText =
    "position:fixed;left:16px;bottom:16px;z-index:101;color:white;font:14px system-ui";
  document.body.append(label);
  const render = (state: ReturnType<typeof engineStartup>) => {
    label.textContent = state.message;
    if (state.stage === "ready") {
      owner.abort();
      label.remove();
    }
  };
  onEngineStartup(render, owner.signal);
  window.addEventListener(
    "pagehide",
    () => {
      owner.abort();
      label.remove();
    },
    { once: true, signal: owner.signal },
  );
}
const surface = defineMaterial({
  id: "surface",
  color: "#609b91",
  roughness: 0.45,
});
export default defineGame({
  id: "startup-feedback",
  services: { physics3d: "disabled" },
  scene: defineScene({
    id: "main",
    camera: { position: [4, 3, 6], target: [0, 0, 0] },
    entities: [
      { id: "object", mesh: { geometry: { kind: "box" }, material: surface } },
      {
        id: "sun",
        transform: { position: [3, 6, 4] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
});
