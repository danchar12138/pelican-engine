import {
  defineGame,
  defineScene,
  defineMaterial,
  loadRuntimeJSON,
  type JsonValue,
  type Vec3,
} from "pelican-engine";

const material = defineMaterial({
  id: "dynamic",
  buffers: [{ name: "color", type: "vec3", count: 1, buffer: "palette" }],
  graphs: {
    baseColor: {
      nodes: [
        { id: "index", op: "float", value: 0 },
        { id: "color", op: "readBuffer", buffer: "color", inputs: ["index"] },
      ],
      output: "color",
    },
  },
});
export default defineGame({
  id: "dynamic-resources",
  services: { physics3d: "disabled" },
  computeBuffers: [
    { id: "palette", type: "vec3", count: 1, data: [[0.15, 0.5, 0.7]] },
  ],
  systems: [{ kind: "system", id: "publish" }],
  runtime: {
    version: "palette-v1",
    async create(scope) {
      const validate = (value: unknown): Vec3 => {
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value.some(
            (channel) =>
              typeof channel !== "number" ||
              !Number.isFinite(channel) ||
              channel < 0 ||
              channel > 1,
          )
        )
          throw new Error(
            "PALETTE_DATA: Expected three linear channels in [0,1].",
          );
        return [...value] as [number, number, number];
      };
      // Local data URL makes the starter independent of a server. ?palette=https://... is an author-selected CORS endpoint.
      let color = await loadRuntimeJSON(scope, {
        url:
          new URLSearchParams(location.search).get("palette") ??
          "data:application/json,[0.8,0.18,0.06]",
        maxBytes: 4096,
        decode: validate,
      });
      return {
        systems: {
          publish(ctx) {
            ctx.compute.writeBuffer(ctx.compute.resolve("palette"), [color]);
          },
        },
        snapshot: () => [...color],
        validateSnapshot(value: JsonValue) {
          validate(value);
        },
        restore(value: JsonValue) {
          color = validate(value);
        },
      };
    },
  },
  scene: defineScene({
    id: "main",
    environment: { lighting: "studio", ambientIntensity: 0.1 },
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
    entities: [
      {
        id: "surface",
        mesh: { material, geometry: { kind: "sphere", radius: 1 } },
      },
    ],
  }),
});
