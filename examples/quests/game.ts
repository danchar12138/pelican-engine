import { defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";
import type { QuestProgressUpdate } from "pelican-engine";

const State = defineComponent({ id: "QuestDemo", schema: {
  initialized: { type: "boolean", default: false },
  rewarded: { type: "boolean", default: false },
} });
const quest = defineSystem({ id: "quest-demo", phase: "update", reads: ["QuestDemo"], writes: ["QuestDemo"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.inventory.defineItem({ id: "coin", label: "Coin", maxStack: 100 });
    ctx.inventory.create({ id: "bag", owner: "player", capacity: 4 });
    ctx.quests.define({ id: "supplies", title: "Gather supplies", objectives: [
      { id: "herbs", label: "Collect herbs", target: 3 },
      { id: "report", label: "Report to the guide", target: 1 },
    ] });
    ctx.quests.start("supplies");
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("reset")) {
    ctx.quests.reset("supplies");
    ctx.quests.start("supplies");
    ctx.setComponent("state", State, { rewarded: false });
  }
  const current = ctx.quests.inspect("supplies");
  if (current.status === "active") {
    const updates: QuestProgressUpdate[] = [];
    if (ctx.input.pressed("collect")) updates.push({ objective: "herbs", amount: 1 });
    if (ctx.input.pressed("report")) updates.push({ objective: "report", amount: 1 });
    if (updates.length) ctx.quests.advanceBatch("supplies", updates);
  }
  const result = ctx.quests.inspect("supplies");
  if (result.status === "completed" && !ctx.getComponent("state", State).rewarded) {
    ctx.inventory.add("bag", "coin", 5);
    ctx.setComponent("state", State, { rewarded: true });
  }
  const progress = result.objectives.map(item => `${item.label}: ${item.progress}/${item.target}`).join(" | ");
  ctx.ui.setText("quest", `${result.title}: ${result.status} | ${progress}`);
  ctx.ui.setText("coins", `Coins: ${ctx.inventory.count("bag", "coin")}`);
} });

export default defineGame({ id: "quests-demo", components: [State], systems: [quest],
  input: { collect: ["c"], report: ["t"], reset: ["r"] },
  ui: [
    { id: "help", kind: "text", text: "C: collect | T: report | R: reset", x: 16, y: 16, width: 600 },
    { id: "quest", kind: "text", text: "Quest", x: 16, y: 70, width: 600 },
    { id: "coins", kind: "text", text: "Coins: 0", x: 16, y: 124, width: 300 },
  ],
  scene: defineScene({ id: "quests", camera: { position: [0, 3, 5], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
