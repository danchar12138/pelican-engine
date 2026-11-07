import { defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "InventoryDemo", schema: {
  initialized: { type: "boolean", default: false },
  message: { type: "string", default: "P: take potion | R: return potion" },
} });
const inventory = defineSystem({ id: "inventory-demo", phase: "update", reads: ["InventoryDemo"], writes: ["InventoryDemo"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.inventory.defineItem({ id: "potion", label: "Potion", maxStack: 5, tags: ["consumable"] });
    ctx.inventory.defineItem({ id: "gem", label: "Gem", maxStack: 1 });
    ctx.inventory.create({ id: "bag", owner: "player", capacity: 4 });
    ctx.inventory.create({ id: "chest", owner: "scene", capacity: 4 });
    ctx.inventory.add("chest", "potion", 8);
    ctx.inventory.add("chest", "gem", 1);
    ctx.setComponent("state", State, { initialized: true });
  }
  try {
    if (ctx.input.pressed("take")) {
      ctx.inventory.transfer("chest", "bag", "potion", 1);
      ctx.setComponent("state", State, { message: "Moved one potion to the backpack." });
    }
    if (ctx.input.pressed("return")) {
      ctx.inventory.transfer("bag", "chest", "potion", 1);
      ctx.setComponent("state", State, { message: "Returned one potion to the chest." });
    }
  } catch (error) {
    const message = String(error);
    if (!message.includes("TC_INVENTORY_INSUFFICIENT") && !message.includes("TC_INVENTORY_FULL")) throw error;
    ctx.setComponent("state", State, { message });
  }
  const bag = ctx.inventory.inspect("bag"), chest = ctx.inventory.inspect("chest");
  const describe = (slots: typeof bag.slots) => slots.map(slot => slot ? `${slot.item} x${slot.count}` : "empty").join(" | ");
  ctx.ui.setText("bag", `Backpack: ${describe(bag.slots)}`);
  ctx.ui.setText("chest", `Chest: ${describe(chest.slots)}`);
  ctx.ui.setText("help", ctx.getComponent("state", State).message);
} });

export default defineGame({ id: "inventory-demo", components: [State], systems: [inventory],
  input: { take: ["p"], return: ["r"] },
  ui: [
    { id: "help", kind: "text", text: "P: take potion | R: return potion", x: 16, y: 16, width: 520 },
    { id: "bag", kind: "text", text: "Backpack", x: 16, y: 70, width: 520 },
    { id: "chest", kind: "text", text: "Chest", x: 16, y: 124, width: 520 },
  ],
  scene: defineScene({ id: "inventory", camera: { position: [0, 3, 5], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
