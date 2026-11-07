import { defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "DialogueDemo", schema: {
  initialized: { type: "boolean", default: false },
} });
const dialogue = defineSystem({ id: "dialogue-demo", phase: "update", reads: ["DialogueDemo"], writes: ["DialogueDemo"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.quests.define({ id: "supplies", title: "Gather supplies", objectives: [
      { id: "herbs", label: "Collect herbs", target: 3 },
    ] });
    ctx.dialogue.define({ id: "guide", start: "hello", nodes: [
      { id: "hello", speaker: "Guide", text: "Welcome, traveler.", next: "ask" },
      { id: "ask", speaker: "Guide", text: "Can you gather some herbs?", choices: [
        { id: "yes", text: "I can help", next: "thanks" },
        { id: "no", text: "Not now", next: "later" },
      ] },
      { id: "thanks", speaker: "Guide", text: "Thank you. Bring back three herbs." },
      { id: "later", speaker: "Guide", text: "Come back when you are ready." },
    ] });
    ctx.dialogue.start("conversation", "guide");
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("restart")) {
    ctx.dialogue.close("conversation");
    ctx.dialogue.start("conversation", "guide");
    ctx.quests.reset("supplies");
  }
  for (const event of ctx.events("ui.activate")) {
    const payload = event.payload as { id: string };
    const session = ctx.dialogue.inspect("conversation");
    if (!session.node) continue;
    if (payload.id === "next" && session.node.choices.length === 0) ctx.dialogue.advance("conversation");
    if ((payload.id === "yes" || payload.id === "no") && session.node.choices.some(choice => choice.id === payload.id)) {
      ctx.dialogue.choose("conversation", payload.id);
      if (payload.id === "yes" && ctx.quests.inspect("supplies").status === "inactive") ctx.quests.start("supplies");
    }
  }
  const current = ctx.dialogue.inspect("conversation"), node = current.node;
  ctx.ui.setText("line", node ? `${node.speaker}: ${node.text}` : "Conversation finished. Press R to restart.");
  ctx.ui.setVisible("next", !!node && node.choices.length === 0);
  ctx.ui.setVisible("yes", !!node && node.choices.some(choice => choice.id === "yes"));
  ctx.ui.setVisible("no", !!node && node.choices.some(choice => choice.id === "no"));
  ctx.ui.setText("quest", `Quest status: ${ctx.quests.inspect("supplies").status}`);
} });

export default defineGame({ id: "dialogue-demo", components: [State], systems: [dialogue],
  input: { restart: ["r"] },
  ui: [
    { id: "line", kind: "text", text: "Conversation", x: 16, y: 16, width: 500 },
    { id: "next", kind: "button", text: "Continue", x: 16, y: 90, width: 200 },
    { id: "yes", kind: "button", text: "I can help", x: 16, y: 90, width: 200, visible: false },
    { id: "no", kind: "button", text: "Not now", x: 230, y: 90, width: 200, visible: false },
    { id: "quest", kind: "text", text: "Quest status", x: 16, y: 150, width: 500 },
  ],
  scene: defineScene({ id: "dialogue", camera: { position: [0, 3, 5], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
