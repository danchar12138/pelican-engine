import {
  defineGame,
  defineScene,
  defineSystem,
  defineMaterial,
  renderQuality,
} from "pelican-engine";
const paint = defineMaterial({
  id: "paint",
  color: "#298b9d",
  roughness: 0.24,
  metalness: 0.45,
});
const floor = defineMaterial({ id: "floor", color: "#8d9499", roughness: 0.8 });
const quality = defineSystem({
  id: "quality",
  run(ctx) {
    for (const event of ctx.events("ui.activate")) {
      const { id } = event.payload as { id: string };
      if (id === "prepare") ctx.render.prepare("path");
      if (id === "high" || id === "medium" || id === "low")
        ctx.render.configure(renderQuality(id));
    }
    const prepared = ctx.render.preparation("path");
    ctx.ui.setText(
      "status",
      `${ctx.render.state().mode} | path preparation: ${prepared.status}${prepared.error ? ` | ${prepared.error}` : ""}`,
    );
  },
});
export default defineGame({
  id: "render-quality",
  services: { physics3d: "disabled" },
  systems: [quality],
  // Omitted render starts in high-quality raster. The buttons explicitly select tracing.
  ui: [
    {
      id: "high",
      kind: "button",
      text: "High / Path",
      x: 16,
      y: 16,
      width: 120,
    },
    {
      id: "medium",
      kind: "button",
      text: "Medium / Hybrid",
      x: 16,
      y: 60,
      width: 155,
    },
    {
      id: "low",
      kind: "button",
      text: "Low / Raster",
      x: 16,
      y: 104,
      width: 135,
    },
    {
      id: "prepare",
      kind: "button",
      text: "Prepare Path",
      x: 16,
      y: 148,
      width: 135,
    },
    { id: "status", kind: "text", text: "raster", x: 16, y: 196 },
  ],
  scene: defineScene({
    id: "main",
    camera: { position: [0, 2, 6], target: [0, 1, 0] },
    entities: [
      {
        id: "shape",
        transform: { position: [0, 1, 0] },
        mesh: {
          material: paint,
          geometry: { kind: "sphere", radius: 1, segments: 96 },
        },
      },
      {
        id: "floor",
        transform: { position: [0, -0.1, 0] },
        mesh: {
          material: floor,
          geometry: { kind: "box", size: [10, 0.2, 10] },
        },
      },
      {
        id: "sun",
        transform: { position: [3, 8, 5] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
});
