import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "AdventureState", schema: {
  initialized: { type: "boolean", default: false },
  cinematic: { type: "boolean", default: false },
} });
const ground = defineMaterial({ id: "ground", color: "#356a58", roughness: 0.9 });
const player = defineMaterial({ id: "player", color: "#e6a958", roughness: 0.6 });
const marker = defineMaterial({ id: "marker", color: "#4ca8bb", roughness: 0.5 });

const adventure = defineSystem({ id: "adventure-loop", phase: "update", reads: ["AdventureState"], writes: ["AdventureState"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.inventory.defineItem({ id: "crystal", label: "Crystal", maxStack: 10 });
    ctx.inventory.defineItem({ id: "sword", label: "Sword", tags: ["weapon"] });
    ctx.inventory.create({ id: "bag", owner: "player", capacity: 4 });
    ctx.inventory.add("bag", "sword", 1);
    ctx.inventory.createEquipment("gear", "player", [{ id: "hand", requiredTag: "weapon" }]);
    ctx.quests.define({ id: "gather", title: "Gather crystals", objectives: [{ id: "crystals", target: 3 }] });
    ctx.dialogue.define({ id: "guide", start: "offer", nodes: [
      { id: "offer", speaker: "Guide", text: "Can you gather three crystals?", choices: [
        { id: "accept", text: "Accept", next: "return" },
      ] },
      { id: "return", speaker: "Guide", text: "Return after gathering the crystals.", choices: [
        { id: "report", text: "Report back", next: "thanks", when: { variable: "ready", equals: true } },
      ] },
      { id: "thanks", speaker: "Guide", text: "Thank you for helping." },
    ] });
    ctx.dialogue.start("talk", "guide");
    ctx.camera.setPose([0, 5, 8], [0, 0, 0]);
    ctx.setComponent("state", State, { initialized: true });
  }

  let storageRequested = false;
  for (const event of ctx.events("ui.activate")) {
    const id = (event.payload as { id: string }).id;
    const session = ctx.dialogue.inspect("talk");
    const quest = ctx.quests.inspect("gather");
    if (id === "accept" && session.node?.id === "offer") {
      ctx.quests.start("gather");
      ctx.dialogue.choose("talk", "accept");
    } else if (id === "gather" && quest.status === "active" && quest.objectives[0].progress < 3) {
      ctx.inventory.add("bag", "crystal", 1);
      ctx.quests.advance("gather", "crystals");
    } else if (id === "report" && session.node?.id === "return" && quest.status === "completed") {
      ctx.dialogue.setVariable("talk", "ready", true);
      ctx.dialogue.choose("talk", "report");
    } else if (id === "equip" && ctx.inventory.inspectEquipment("gear").slots[0].item === null) {
      ctx.inventory.equip("gear", "hand", "bag", "sword");
    } else if (id === "camera") {
      const cinematic = !ctx.getComponent("state", State).cinematic;
      ctx.camera.moveTo(cinematic ? [3, 3, 5] : [0, 5, 8], [0, 0, 0], 1);
      ctx.setComponent("state", State, { cinematic });
    } else if (id === "save" && !storageRequested && !["saving", "loading"].includes(ctx.storage.status().state)) {
      ctx.storage.save("adventure");
      storageRequested = true;
    } else if (id === "load" && !storageRequested && !["saving", "loading"].includes(ctx.storage.status().state)) {
      ctx.storage.load("adventure");
      storageRequested = true;
    }
  }

  const quest = ctx.quests.inspect("gather"), session = ctx.dialogue.inspect("talk");
  if (session.status === "active") ctx.dialogue.setVariable("talk", "ready", quest.status === "completed");
  const node = session.node, equipped = ctx.inventory.inspectEquipment("gear").slots[0].item;
  ctx.ui.setText("dialogue", node ? `${node.speaker}: ${node.text}` : "Conversation complete.");
  ctx.ui.setText("status", `Quest: ${quest.status} | Crystals: ${ctx.inventory.count("bag", "crystal")} | Hand: ${equipped ?? "empty"}`);
  ctx.ui.setVisible("accept", node?.id === "offer");
  ctx.ui.setVisible("gather", quest.status === "active");
  ctx.ui.setVisible("report", node?.id === "return" && quest.status === "completed");
  ctx.ui.setVisible("equip", equipped === null);
} });

export default defineGame({ id: "gameplay-loop", components: [State], systems: [adventure], materials: [ground, player, marker],
  ui: [
    { id: "dialogue", kind: "text", text: "Guide", x: 16, y: 16, width: 520 },
    { id: "status", kind: "text", text: "Quest", x: 16, y: 72, width: 520 },
    { id: "accept", kind: "button", text: "Accept quest", x: 16, y: 130, width: 160 },
    { id: "gather", kind: "button", text: "Gather crystal", x: 16, y: 130, width: 160, visible: false },
    { id: "report", kind: "button", text: "Report back", x: 16, y: 130, width: 160, visible: false },
    { id: "equip", kind: "button", text: "Equip sword", x: 190, y: 130, width: 160 },
    { id: "camera", kind: "button", text: "Change camera", x: 16, y: 185, width: 160 },
    { id: "save", kind: "button", text: "Save", x: 190, y: 185, width: 75 },
    { id: "load", kind: "button", text: "Load", x: 275, y: 185, width: 75 },
  ],
  scene: defineScene({ id: "adventure", camera: { position: [0, 5, 8], target: [0, 0, 0] },
    environment: { background: "#223444", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "floor", transform: { position: [0, -0.15, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.3, 8] }, material: ground } },
      { id: "player", transform: { position: [-1, 0.5, 0] }, mesh: { geometry: { kind: "box", size: [0.7, 1, 0.7] }, material: player } },
      { id: "crystal", transform: { position: [1, 0.5, 0] }, mesh: { geometry: { kind: "sphere", radius: 0.45 }, material: marker } },
      { id: "sun", transform: { position: [4, 8, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
