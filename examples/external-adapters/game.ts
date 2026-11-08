import {
  defineGame,
  defineScene,
  defineSystem,
  defineMaterial,
  defineRenderExtension,
} from "pelican-engine";

const material = defineMaterial({
  id: "adapterSurface",
  roughness: 1,
  buffers: [
    { name: "palette", type: "vec3", count: 1, buffer: "adapterPalette" },
  ],
  graphs: {
    baseColor: {
      nodes: [
        { id: "zero", op: "float", value: 0 },
        { id: "color", op: "readBuffer", buffer: "palette", inputs: ["zero"] },
      ],
      output: "color",
    },
  },
});
const extension = defineRenderExtension({
  id: "external-palette",
  version: "1",
  materials: [material],
  computeBuffers: [
    { id: "adapterPalette", type: "vec3", count: 1, data: [[0.2, 0.4, 0.6]] },
  ],
  systems: [defineSystem({ id: "external.consume", phase: "update" })],
  async create(scope) {
    const { connectPaletteWorker } = await import("./palette-client.ts");
    const worker = connectPaletteWorker(scope);
    const socketURL = new URLSearchParams(location.search).get("socket");
    const socket = socketURL
      ? await (
          await import("./socket-client.ts")
        ).connectSocket(scope, socketURL)
      : undefined;
    let color: [number, number, number] = [0.2, 0.4, 0.6],
      received = 0,
      request = 0,
      epoch = 0;
    worker.send({ epoch, request: ++request });
    const validate = (value: unknown): void => {
      const state = value as {
        color: number[];
        received: number;
        request: number;
      };
      if (
        !state ||
        !Array.isArray(state.color) ||
        state.color.length !== 3 ||
        state.color.some(
          (channel) => !Number.isFinite(channel) || channel < 0 || channel > 1,
        ) ||
        !Number.isSafeInteger(state.received) ||
        state.received < 0 ||
        !Number.isSafeInteger(state.request) ||
        state.request < 0
      )
        throw new Error(
          "PALETTE_SAVE: Expected a finite color and non-negative counters.",
        );
    };
    return {
      systems: {
        "external.consume"(ctx) {
          if (
            ctx.input.pressed("refresh") ||
            ctx
              .events("ui.activate")
              .some(
                (event) => (event.payload as { id: string }).id === "refresh",
              )
          ) {
            worker.send({ epoch, request: ++request });
            socket?.send({ value: 0.55 });
          }
          for (const reply of worker.drain())
            if (reply.epoch === epoch) {
              color = Array.from(reply.color) as [number, number, number];
              received++;
            }
          for (const reply of socket?.drain() ?? []) {
            color[0] = Math.max(0, Math.min(1, reply.value));
          }
          ctx.compute.writeBuffer(ctx.compute.resolve("adapterPalette"), [
            color,
          ]);
          ctx.ui.setText(
            "state",
            `Palette ${color.map((value) => value.toFixed(2)).join(", ")} | ${received}`,
          );
        },
      },
      snapshot: () => ({ color: [...color], received, request }),
      validateSnapshot: validate,
      restore(value) {
        validate(value);
        const saved = value as unknown as {
          color: [number, number, number];
          received: number;
          request: number;
        };
        color = [...saved.color];
        received = saved.received;
        request = saved.request;
        // Invalidate in-flight worker replies rather than accepting pre-restore external work.
        epoch++;
        worker.clear();
        socket?.clear();
      },
    };
  },
});
export default defineGame({
  id: "external-adapters",
  extensions: [extension],
  services: { physics3d: "disabled" },
  input: { refresh: [" "] },
  ui: [
    {
      id: "refresh",
      kind: "button",
      text: "Refresh",
      x: 16,
      y: 16,
      width: 120,
    },
    { id: "state", kind: "text", text: "Palette", x: 16, y: 64 },
  ],
  scene: defineScene({
    id: "main",
    environment: { background: "#182329", ambientIntensity: 1 },
    camera: { position: [0, 0, 4], target: [0, 0, 0] },
    entities: [
      {
        id: "surface",
        mesh: { material, geometry: { kind: "plane", size: [3, 2] } },
      },
    ],
  }),
});
