import {
  defineGame,
  defineGameRuntime,
  defineMaterial,
  defineScene,
  loadRuntimeBytes,
  type Vec4,
} from "pelican-engine";

const image = defineMaterial({
  id: "image",
  roughness: 0.6,
  textures: [{ name: "image", texture: "downloaded", filter: "nearest" }],
  graphs: {
    baseColor: {
      nodes: [
        { id: "uv", op: "input", name: "uv" },
        { id: "sample", op: "sampleTexture", texture: "image", inputs: ["uv"] },
        { id: "rgb", op: "swizzle", components: "rgb", inputs: ["sample"] },
      ],
      output: "rgb",
    },
  },
});
const fallback =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR4XmO4oyHyX2TLpf8MGieM/j+7I/cfAFECCbFvDi5HAAAAAElFTkSuQmCC";
type Decoded = { width: number; height: number; data: Vec4[] };
export default defineGame({
  id: "dynamic-texture",
  services: { physics3d: "disabled" },
  computeTextures: [
    { id: "downloaded", width: 1, height: 1, data: [[0.1, 0.1, 0.1, 1]] },
  ],
  ...defineGameRuntime<{ published: boolean }, Decoded>({
    version: "image-v1",
    state: () => ({ published: false }),
    validateState(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("published" in value) ||
        typeof value.published !== "boolean"
      )
        throw new Error("IMAGE_STATE: Expected publication state.");
    },
    async setup(scope) {
      const bytes = await loadRuntimeBytes(scope, {
        url: new URLSearchParams(location.search).get("image") ?? fallback,
        maxBytes: 1048576,
      });
      const { decode, hasPngSignature } = await import("fast-png");
      scope.signal.throwIfAborted();
      // Check decoded dimensions before invoking the npm codec. Encoded-byte limits alone do not bound image memory.
      if (bytes.length < 33 || !hasPngSignature(bytes))
        throw new Error("IMAGE_FORMAT: Expected an RGBA8 PNG.");
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const width = header.getUint32(16),
        height = header.getUint32(20);
      if (
        header.getUint32(8) !== 13 ||
        header.getUint32(12) !== 0x49484452 ||
        !width ||
        !height ||
        width * height > 16384 ||
        bytes[24] !== 8 ||
        bytes[25] !== 6
      )
        throw new Error(
          "IMAGE_BUDGET: Expected RGBA8 PNG with at most 16384 pixels.",
        );
      const decoded = decode(bytes, { checkCrc: true });
      if (
        decoded.width !== width ||
        decoded.height !== height ||
        decoded.channels !== 4 ||
        decoded.depth !== 8
      )
        throw new Error("IMAGE_FORMAT: Decoded layout changed.");
      const linear = (value: number) =>
        value <= 0.04045
          ? value / 12.92
          : Math.pow((value + 0.055) / 1.055, 2.4);
      const data: Vec4[] = [];
      // PNG rows run top-to-bottom; material UV coordinates run bottom-to-top. RGB is sRGB; alpha is linear.
      for (let y = height - 1; y >= 0; y--)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4,
            p = decoded.data;
          data.push([
            linear(p[offset] / 255),
            linear(p[offset + 1] / 255),
            linear(p[offset + 2] / 255),
            p[offset + 3] / 255,
          ]);
        }
      return { width, height, data };
    },
    systems: [
      {
        id: "publish",
        run(ctx, _dt, state, _scope, decoded) {
          if (!state.value.published) {
            const previous = ctx.compute.resolveTexture("downloaded");
            const next = ctx.compute.createTexture({
              id: "decoded-image",
              ...decoded,
            });
            ctx.render.textures.bind("image", "image", next);
            ctx.compute.releaseTexture(previous);
            state.value.published = true;
          }
          // Restore keeps saved resource data even if setup fetched a newer image. Setup itself may still need the URL to be available.
          const active = ctx.render.textures.state("image").image;
          ctx.ui.setText(
            "state",
            `${active.width} x ${active.height} | managed image`,
          );
        },
      },
    ],
  }),
  ui: [{ id: "state", kind: "text", text: "Image", x: 16, y: 16 }],
  scene: defineScene({
    id: "main",
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
    entities: [
      {
        id: "surface",
        mesh: { material: image, geometry: { kind: "plane", size: [3, 3] } },
      },
    ],
  }),
});
