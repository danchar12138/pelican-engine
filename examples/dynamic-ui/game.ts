import { defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";

type Slot = { id: string; generation: number } | null;
const State = defineComponent({ id: "MenuState", schema: {
  slots: { type: "string", default: "[]" },
} });
const menu = defineSystem({ id: "dynamic-menu", phase: "update", reads: ["MenuState"], writes: ["MenuState"], run(ctx) {
  const state = ctx.getComponent("state", State);
  const slots = JSON.parse(state.slots) as Slot[];
  let changed = false;
  for (const event of ctx.events("ui.activate")) {
    const payload = event.payload as { id: string; generation?: number };
    if (payload.id === "add") {
      let index = slots.findIndex(slot => slot === null);
      if (index < 0) index = slots.length;
      if (index >= 6) continue;
      const id = `item:${index}`;
      const generation = ctx.ui.create({ id, kind: "button", text: `Item ${index + 1} — remove`,
        x: 16, y: 110 + index * 48, width: 220, color: "#ffffff" });
      slots[index] = { id, generation };
      changed = true;
    } else {
      const index = slots.findIndex(slot => slot?.id === payload.id && slot.generation === payload.generation);
      if (index >= 0) {
        ctx.ui.remove(payload.id);
        slots[index] = null;
        changed = true;
      }
    }
  }
  if (changed) ctx.setComponent("state", State, { slots: JSON.stringify(slots) });
  ctx.ui.setText("hint", `Items: ${slots.filter(slot => slot !== null).length}/6`);
} });

export default defineGame({
  id: "dynamic-ui", components: [State], systems: [menu],
  ui: [
    { id: "hint", kind: "text", text: "Items: 0/6", x: 16, y: 16, width: 220 },
    { id: "add", kind: "button", text: "Add item", x: 16, y: 62, width: 220 },
  ],
  scene: defineScene({ id: "dynamic-ui", camera: { position: [0, 3, 5], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
