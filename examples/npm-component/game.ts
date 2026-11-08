import {
  defineGame,
  defineGameRuntime,
  defineMaterial,
  defineScene,
} from "pelican-engine";

type Dependencies = {
  roundTrip(value: number): number;
  show(value: number, bytes: number): void;
};
const paint = defineMaterial({
  id: "paint",
  color: "#49b9c7",
  roughness: 0.24,
  metalness: 0.35,
});
export default defineGame({
  id: "npm-component",
  services: { physics3d: "disabled" },
  ...defineGameRuntime<{ ticks: number }, Dependencies>({
    version: "counter-v1",
    state: () => ({ ticks: 0 }),
    validateState(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("ticks" in value) ||
        !Number.isSafeInteger(value.ticks) ||
        Number(value.ticks) < 0
      )
        throw new Error("COUNTER_STATE: Expected nonnegative integer ticks.");
    },
    async setup(scope) {
      const { strToU8, strFromU8, zlibSync, unzlibSync } = await import(
        "fflate"
      );
      scope.signal.throwIfAborted();
      const output = scope.own(document.createElement("output"), (element) =>
        element.remove(),
      );
      output.dataset.pelicanNpmCounter = "";
      Object.assign(output.style, {
        position: "fixed",
        left: "16px",
        top: "16px",
        color: "white",
        background: "#142329",
        padding: "8px",
        font: "14px sans-serif",
      });
      document.body.append(output);
      const resize = () => {
        output.style.maxWidth = `${Math.max(1, window.innerWidth - 32)}px`;
      };
      scope.listen(window, "resize", resize);
      resize();
      return {
        roundTrip(value) {
          const bytes = zlibSync(strToU8(JSON.stringify({ ticks: value })));
          const restored = JSON.parse(strFromU8(unzlibSync(bytes)));
          if (restored.ticks !== value)
            throw new Error("COUNTER_CODEC: npm round trip changed the state.");
          return bytes.length;
        },
        show(value, bytes) {
          output.textContent = `${value} ticks | ${bytes} compressed bytes`;
        },
      };
    },
    systems: [
      {
        id: "counter",
        run(ctx, _dt, state, _scope, dependencies) {
          state.value.ticks++;
          const bytes = dependencies.roundTrip(state.value.ticks);
          dependencies.show(state.value.ticks, bytes);
          ctx.setTransform("shape", {
            rotation: [0, state.value.ticks / 120, 0],
          });
          const actions = ctx
            .events("ui.activate")
            .map((event) => (event.payload as { id: string }).id);
          if (!["saving", "loading"].includes(ctx.storage.status().state)) {
            if (actions.includes("save")) ctx.storage.save("counter");
            else if (actions.includes("load")) ctx.storage.load("counter");
          }
        },
      },
    ],
  }),
  ui: [
    { id: "save", kind: "button", text: "Save", x: 16, y: 64, width: 80 },
    { id: "load", kind: "button", text: "Load", x: 104, y: 64, width: 80 },
  ],
  scene: defineScene({
    id: "main",
    camera: { position: [0, 1, 4], target: [0, 0, 0] },
    entities: [
      { id: "shape", mesh: { material: paint, geometry: { kind: "box" } } },
    ],
  }),
});
