# Game-author recipes

> These are development-stage examples. Runtime behavior, hardware, input and snapshot restoration remain unverified under the current build-only policy.

Each recipe is a complete asset-free `game.ts` using only `pelican-engine`.
In a new installed game directory, create a minimal project with `npx --no-install pelican create --template minimal`, then replace its generated `game.ts` with one recipe. Back up any existing game work before replacing it. Use `npx --no-install pelican dev` or `npx --no-install pelican build` afterward.

For a source checkout or ZIP, use the same code and the engine CLI with the project directory; the corresponding editable originals are under `examples/`. The npm package includes this documentation, not those example directories or game assets.

Recipes are independent; use one at a time and adapt IDs, input, UI and rules to the game. Their feature limitations remain in `docs/npm/GAME-AUTHOR.md`.

## Recipes

- [Orthographic raster](#orthographic-raster) — Move simple 2D-positioned objects under an orthographic camera.
- [2D rigid bodies](#2d-rigid-bodies) — Move an XY body in an independent 2D physics world.
- [2D character](#2d-character) — Drive a kinematic character against 2D obstacles.
- [Gamepad input](#gamepad-input) — Combine standard gamepad input with keyboard bindings.
- [Dynamic UI](#dynamic-ui) — Create and remove reusable menu slots.
- [Inventory](#inventory) — Move stackable items between a backpack and a chest.
- [Quest objectives](#quest-objectives) — Advance objectives and grant a game-defined reward.
- [Branching dialogue](#branching-dialogue) — Display a conversation and start a quest from a choice.
- [Composed gameplay](#composed-gameplay) — Combine quests, inventory, equipment, conditional dialogue, camera and saves.
- [Localization](#localization) — Switch languages and format plural messages.
- [Grid navigation](#grid-navigation) — Move two point agents and change an obstacle.
- [Static world chunks](#static-world-chunks) — Load static chunks and build or remove markers.

## Orthographic raster

Move simple 2D-positioned objects under an orthographic camera.

Source checkout: `examples/orthographic-2d/game.ts`.

````ts
import { defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const actor = defineMaterial({ id: "actor", color: "#5fd6e7", roughness: 0.8 });
const platform = defineMaterial({ id: "platform", color: "#536a7d", roughness: 0.9 });
const goal = defineMaterial({ id: "goal", color: "#f3c55f", roughness: 0.8 });
const move = defineSystem({ id: "move", phase: "update", reads: ["Transform"], writes: ["Transform"], run(ctx, dt) {
  const position = ctx.getTransform("player").position;
  const x = Math.max(-6.5, Math.min(6.5, position[0] + ctx.input.axis("left", "right") * 3 * dt));
  const y = Math.max(-3.5, Math.min(3.5, position[1] + ctx.input.axis("down", "up") * 3 * dt));
  ctx.setTransform("player", { position: [x, y, position[2]] });
} });

export default defineGame({
  id: "orthographic-2d", systems: [move], materials: [actor, platform, goal],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"] },
  render: { mode: "raster" },
  ui: [{ id: "help", kind: "text", text: "Arrow keys: move | orthographic raster", x: 16, y: 16, width: 450 }],
  scene: defineScene({ id: "flat-world", camera: {
    position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8,
  }, environment: { background: "#172534", ambientIntensity: 1 }, entities: [
    { id: "player", transform: { position: [-4, 0, 0.3] }, mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: actor } },
    { id: "floor", transform: { position: [0, -2.5, 0] }, mesh: { geometry: { kind: "box", size: [12, 0.4, 0.2] }, material: platform } },
    { id: "goal", transform: { position: [4, 1, 0] }, mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: goal } },
    { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
  ] }),
});
````

## 2D rigid bodies

Move an XY body in an independent 2D physics world.

Source checkout: `examples/physics2d/game.ts`.

````ts
import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "Physics2DDemo", schema: { initialized: { type: "boolean", default: false }, contacts: { type: "number", default: 0 } } });
const groundMaterial = defineMaterial({ id: "ground-material", color: "#526b7c", roughness: 0.9 });
const playerMaterial = defineMaterial({ id: "player-material", color: "#69d5e6", roughness: 0.7 });
const physics = defineSystem({ id: "physics2d-demo", phase: "update", reads: ["Physics2DDemo", "Transform"], writes: ["Physics2DDemo", "Transform"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.physics2d.create({ id: "ground-body", entity: "ground", type: "fixed", collider: { shape: "box", halfExtents: [4, 0.25] } });
    ctx.physics2d.create({ id: "player-body", entity: "player", type: "dynamic", collider: { shape: "box", halfExtents: [0.45, 0.45] }, mass: 1 });
    ctx.physics2d.create({ id: "pivot-body", entity: "pivot", type: "fixed", collider: { shape: "compound", parts: [] } });
    ctx.physics2d.create({ id: "arm-body", entity: "arm", type: "dynamic", collider: { shape: "box", halfExtents: [0.2, 0.9] }, mass: 1 });
    ctx.physics2d.createJoint({ id: "hinge", kind: "revolute", bodyA: "pivot-body", bodyB: "arm-body", anchorB: [0, 0.9] });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("reset")) {
    ctx.entities.setTransform("player", { position: [0, 2, 0], rotation: [0, 0, 0] });
    ctx.physics2d.setVelocity("player-body", [0, 0]);
    ctx.physics2d.setAngularVelocity("player-body", 0);
  }
  const velocity = ctx.physics2d.inspect("player-body").velocity;
  ctx.physics2d.setVelocity("player-body", [ctx.input.axis("left", "right") * 3, velocity[1]]);
  if (ctx.input.pressed("jump")) ctx.physics2d.applyImpulse("player-body", [0, 5]);
  if (ctx.input.pressed("kick")) ctx.physics2d.applyImpulse("arm-body", [2, 0]);
  const started = ctx.events("physics2d.collision.started").length;
  if (started) ctx.setComponent("state", State, { contacts: state.contacts + started });
  const body = ctx.physics2d.inspect("player-body");
  ctx.ui.setText("status", `Arrows: move | Space: impulse | J: swing | R: reset | y ${body.position[1].toFixed(2)} | contacts ${state.contacts + started}`);
} });

export default defineGame({ id: "physics2d-demo", components: [State], systems: [physics], materials: [groundMaterial, playerMaterial],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], jump: [" "], reset: ["r"], kick: ["j"] }, render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | Space: impulse | J: swing | R: reset", x: 16, y: 16, width: 640 }],
  scene: defineScene({ id: "physics2d", physics2d: { gravity: [0, -9.81] },
    camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "ground", transform: { position: [0, -2, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.5, 0.2] }, material: groundMaterial } },
      { id: "player", transform: { position: [0, 2, 0] }, mesh: { geometry: { kind: "box", size: [0.9, 0.9, 0.2] }, material: playerMaterial } },
      { id: "pivot", transform: { position: [3, 1.7, 0] } },
      { id: "arm", transform: { position: [3, 0.8, 0] }, mesh: { geometry: { kind: "box", size: [0.4, 1.8, 0.2] }, material: playerMaterial } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````

## 2D character

Drive a kinematic character against 2D obstacles.

Source checkout: `examples/physics2d-character/game.ts`.

````ts
import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "Character2DDemo", schema: {
  initialized: { type: "boolean", default: false }, vertical: { type: "number", default: 0 },
} });
const ground = defineMaterial({ id: "ground", color: "#536c7c", roughness: 0.9 });
const actor = defineMaterial({ id: "actor", color: "#66d5e5", roughness: 0.7 });
const move = defineSystem({ id: "character2d-demo", phase: "update", reads: ["Character2DDemo", "Transform"], writes: ["Character2DDemo", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.physics2d.create({ id: "ground-body", entity: "ground", type: "fixed", collider: { shape: "box", halfExtents: [4, 0.25] } });
    ctx.physics2d.create({ id: "wall-body", entity: "wall", type: "fixed", collider: { shape: "box", halfExtents: [0.25, 1] } });
    ctx.physics2d.create({ id: "character-body", entity: "character", type: "kinematic", collider: { shape: "capsule", halfHeight: 0.45, radius: 0.3 } });
    ctx.physics2d.attachCharacter("character-body", { offset: 0.01, snapToGround: 0.08 });
    ctx.setComponent("state", State, { initialized: true });
  }
  const character = ctx.physics2d.characterState("character-body");
  let vertical = state.vertical;
  if (!character.deferred) {
    if (character.grounded && vertical < 0) vertical = 0;
    if (character.grounded && ctx.input.pressed("jump")) vertical = 5;
    vertical = Math.max(-15, vertical - 9.81 * dt);
    ctx.physics2d.moveCharacter("character-body", [ctx.input.axis("left", "right") * 3 * dt, vertical * dt]);
    ctx.setComponent("state", State, { vertical });
  }
  ctx.ui.setText("status", `Arrows: move | Space: jump | grounded: ${character.grounded} | deferred: ${character.deferred}`);
} });

export default defineGame({ id: "physics2d-character", components: [State], systems: [move], materials: [ground, actor],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], jump: [" "] }, render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | Space: jump", x: 16, y: 16, width: 640 }],
  scene: defineScene({ id: "character2d", physics2d: { gravity: [0, -9.81] },
    camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "ground", transform: { position: [0, -2, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.5, 0.2] }, material: ground } },
      { id: "wall", transform: { position: [2, -0.75, 0] }, mesh: { geometry: { kind: "box", size: [0.5, 2, 0.2] }, material: ground } },
      { id: "character", transform: { position: [0, 1.5, 0.2] }, mesh: { geometry: { kind: "box", size: [0.6, 1.5, 0.2] }, material: actor } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````

## Gamepad input

Combine standard gamepad input with keyboard bindings.

Source checkout: `examples/gamepad/game.ts`.

````ts
import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "GamepadDemo", schema: {
  initialized: { type: "boolean", default: false }, presses: { type: "number", default: 0 },
} });
const actor = defineMaterial({ id: "actor", color: "#6ad9e7", roughness: 0.8 });
const move = defineSystem({ id: "gamepad-demo", phase: "update", reads: ["GamepadDemo", "Transform"], writes: ["GamepadDemo", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.input.setGamepadMode("game");
    ctx.input.setGamepadDeadzone(0.15);
    ctx.setComponent("state", State, { initialized: true });
  }
  const pad = ctx.input.gamepad(), position = ctx.getTransform("actor").position;
  const horizontal = pad.axes[0] ? pad.axes[0] : ctx.input.axis("left", "right");
  const vertical = pad.axes[1] ? -pad.axes[1] : ctx.input.axis("down", "up");
  ctx.setTransform("actor", { position: [Math.max(-6, Math.min(6, position[0] + horizontal * 3 * dt)),
    Math.max(-3, Math.min(3, position[1] + vertical * 3 * dt)), position[2]] });
  const presses = state.presses + Number(ctx.input.pressed("action"));
  if (presses !== state.presses) ctx.setComponent("state", State, { presses });
  ctx.ui.setText("status", `Arrows or left stick: move | Space or button 0: action | pad: ${pad.connected ? pad.index : "none"} | presses: ${presses}`);
} });

export default defineGame({ id: "gamepad-demo", components: [State], systems: [move], materials: [actor],
  input: {
    left: ["ArrowLeft", "gamepad:axis:0:negative", "gamepad:button:14"],
    right: ["ArrowRight", "gamepad:axis:0:positive", "gamepad:button:15"],
    up: ["ArrowUp", "gamepad:axis:1:negative", "gamepad:button:12"],
    down: ["ArrowDown", "gamepad:axis:1:positive", "gamepad:button:13"],
    action: [" ", "gamepad:button:0"],
  },
  render: { mode: "raster" },
  ui: [{ id: "status", kind: "text", text: "Arrows or gamepad: move", x: 16, y: 16, width: 720 }],
  scene: defineScene({ id: "gamepad", camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "actor", mesh: { geometry: { kind: "box", size: [0.8, 0.8, 0.2] }, material: actor } },
      { id: "sun", transform: { position: [0, 3, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````

## Dynamic UI

Create and remove reusable menu slots.

Source checkout: `examples/dynamic-ui/game.ts`.

````ts
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
````

## Inventory

Move stackable items between a backpack and a chest.

Source checkout: `examples/inventory/game.ts`.

````ts
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
````

## Quest objectives

Advance objectives and grant a game-defined reward.

Source checkout: `examples/quests/game.ts`.

````ts
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
````

## Branching dialogue

Display a conversation and start a quest from a choice.

Source checkout: `examples/dialogue/game.ts`.

````ts
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
````

## Composed gameplay

Combine quests, inventory, equipment, conditional dialogue, camera and saves.

Source checkout: `examples/gameplay-loop/game.ts`.

````ts
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
````

## Localization

Switch languages and format plural messages.

Source checkout: `examples/localization/game.ts`.

````ts
import { defineComponent, defineGame, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "LocaleDemo", schema: {
  initialized: { type: "boolean", default: false },
  count: { type: "number", default: 0 },
} });
const language = defineSystem({ id: "locale-demo", phase: "update", reads: ["LocaleDemo"], writes: ["LocaleDemo"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.i18n.define("en-US", {
      greeting: "Hello, {name}!",
      items: { one: "{count} item", other: "{count} items" },
      fallback: "This line comes from the fallback catalog.",
    });
    ctx.i18n.define("zh-CN", {
      greeting: "你好，{name}！",
      items: { other: "{count} 件物品" },
    });
    ctx.i18n.setFallback("en-US");
    ctx.i18n.setLocale("zh-CN");
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("language")) ctx.i18n.setLocale(ctx.i18n.inspect().locale === "zh-CN" ? "en-US" : "zh-CN");
  const count = state.count + Number(ctx.input.pressed("add"));
  if (count !== state.count) ctx.setComponent("state", State, { count });
  ctx.ui.setText("greeting", ctx.i18n.text("greeting", { name: "Pelican" }));
  ctx.ui.setText("items", `${ctx.i18n.text("items", { count })} | ${ctx.i18n.number(count)}`);
  ctx.ui.setText("fallback", ctx.i18n.text("fallback"));
} });

export default defineGame({ id: "localization-demo", components: [State], systems: [language],
  input: { language: ["l"], add: ["c"] },
  ui: [
    { id: "help", kind: "text", text: "L: language | C: add item", x: 16, y: 16, width: 550 },
    { id: "greeting", kind: "text", text: "Greeting", x: 16, y: 70, width: 550 },
    { id: "items", kind: "text", text: "Items", x: 16, y: 124, width: 550 },
    { id: "fallback", kind: "text", text: "Fallback", x: 16, y: 178, width: 550 },
  ],
  scene: defineScene({ id: "localization", camera: { position: [0, 3, 5], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````

## Grid navigation

Move two point agents and change an obstacle.

Source checkout: `examples/navigation-agents/game.ts`.

````ts
import { defineComponent, defineGame, defineMaterial, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "AgentDemo", schema: {
  initialized: { type: "boolean", default: false },
  blocked: { type: "boolean", default: false },
} });
const floorMaterial = defineMaterial({ id: "floor", color: "#344c5a", roughness: 0.8 });
const obstacleMaterial = defineMaterial({ id: "obstacle", color: "#e48c61", roughness: 0.7 });
const firstMaterial = defineMaterial({ id: "first-agent", color: "#56cde8", roughness: 0.6 });
const secondMaterial = defineMaterial({ id: "second-agent", color: "#dfd27b", roughness: 0.6 });

const agents = defineSystem({ id: "agent-demo", phase: "update", reads: ["AgentDemo", "Transform"], writes: ["AgentDemo", "Transform"], run(ctx) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.navigation.createGrid({ id: "board", owner: "scene", width: 8, height: 8 });
    ctx.navigation.createAgent({ id: "first", entity: "first", grid: "board", origin: [-4, -4], cellSize: 1, speed: 1.8, allowDiagonal: true });
    ctx.navigation.createAgent({ id: "second", entity: "second", grid: "board", origin: [-4, -4], cellSize: 1, speed: 1.5, allowDiagonal: true });
    ctx.navigation.setAgentTarget("first", { x: 7, y: 7 });
    ctx.navigation.setAgentTarget("second", { x: 6, y: 7 });
    ctx.setComponent("state", State, { initialized: true });
  }
  if (ctx.input.pressed("toggle")) {
    const blocked = !state.blocked;
    ctx.navigation.setBlocked("board", { x: 3, y: 3 }, blocked);
    ctx.setTransform("obstacle", { position: [-0.5, blocked ? 0.5 : -5, -0.5] });
    ctx.setComponent("state", State, { blocked });
  }
  const current = ctx.navigation.listAgents();
  ctx.ui.setText("status", `B: toggle obstacle | ${current.map(agent => `${agent.id}: ${agent.status}`).join(" | ")}`);
} });

export default defineGame({
  id: "navigation-agents", components: [State], systems: [agents],
  materials: [floorMaterial, obstacleMaterial, firstMaterial, secondMaterial],
  input: { toggle: ["b"] },
  ui: [{ id: "status", kind: "text", text: "B: toggle obstacle", x: 16, y: 16 }],
  scene: defineScene({ id: "navigation-agents", camera: { position: [0, 11, 11], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "floor", transform: { position: [0, -0.1, 0] }, mesh: { geometry: { kind: "box", size: [8, 0.2, 8] }, material: floorMaterial } },
      { id: "obstacle", transform: { position: [-0.5, -5, -0.5] }, mesh: { geometry: { kind: "box", size: [0.9, 1, 0.9] }, material: obstacleMaterial } },
      { id: "first", transform: { position: [-3.5, 0.4, -3.5] }, mesh: { geometry: { kind: "box", size: [0.5, 0.8, 0.5] }, material: firstMaterial } },
      { id: "second", transform: { position: [-2.5, 0.4, -3.5] }, mesh: { geometry: { kind: "box", size: [0.5, 0.8, 0.5] }, material: secondMaterial } },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````

## Static world chunks

Load static chunks and build or remove markers.

Source checkout: `examples/streaming-world/game.ts`.

````ts
import { defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "pelican-engine";

const State = defineComponent({ id: "StreamingState", schema: {
  initialized: { type: "boolean", default: false },
  nextBuilding: { type: "number", default: 0 },
  lastBuilding: { type: "string", default: "" },
  lastX: { type: "number", default: 0 },
  lastZ: { type: "number", default: 0 },
} });
const ground = defineMaterial({ id: "ground", color: "#3a8065", roughness: 0.9 });
const pillar = defineMaterial({ id: "pillar", color: "#e0ad53", roughness: 0.7 });
const playerMaterial = defineMaterial({ id: "player", color: "#70ddf2", roughness: 0.6 });
const floorPrefab = definePrefab({ id: "chunk-floor", mesh: { geometry: { kind: "box", size: [7.8, 0.2, 7.8] }, material: ground } });
const markerPrefab = definePrefab({ id: "chunk-marker", mesh: { geometry: { kind: "box", size: [0.6, 1.8, 0.6] }, material: pillar } });
const walk = defineSystem({ id: "streaming-demo", phase: "update", reads: ["StreamingState", "Transform"], writes: ["StreamingState", "Transform"], run(ctx, dt) {
  const state = ctx.getComponent("state", State);
  if (!state.initialized) {
    ctx.streaming.configure({ chunkSize: 8, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 });
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++)
      ctx.streaming.defineChunk({ x, z, entities: [
        { id: `floor:${x}:${z}`, prefab: "chunk-floor", transform: { position: [x * 8 + 4, -0.1, z * 8 + 4] } },
        { id: `marker:${x}:${z}`, prefab: "chunk-marker", transform: { position: [x * 8 + 4, 0.9, z * 8 + 4] } },
      ] });
    ctx.camera.follow("player", { distance: 12, height: 11, lookHeight: 0 });
    ctx.setComponent("state", State, { initialized: true });
  }
  const position = ctx.getTransform("player").position;
  const next: [number, number, number] = [
    Math.max(-23, Math.min(23, position[0] + ctx.input.axis("left", "right") * dt * 4)),
    position[1],
    Math.max(-23, Math.min(23, position[2] + ctx.input.axis("up", "down") * dt * 4)),
  ];
  ctx.setTransform("player", { position: next });
  ctx.streaming.setFocus(next);
  if (ctx.input.pressed("build")) {
    const x = Math.floor(next[0] / 8), z = Math.floor(next[2] / 8);
    const id = `built:${state.nextBuilding}`;
    ctx.streaming.addEntity(x, z, { id, prefab: "chunk-marker", transform: { position: [next[0] + 1, 0.9, next[2]] } });
    ctx.setComponent("state", State, { nextBuilding: state.nextBuilding + 1, lastBuilding: id, lastX: x, lastZ: z });
  }
  if (ctx.input.pressed("remove") && state.lastBuilding) {
    ctx.streaming.removeEntity(state.lastX, state.lastZ, state.lastBuilding);
    ctx.setComponent("state", State, { lastBuilding: "" });
  }
  const visible = ctx.streaming.inspect().chunks.filter(chunk => chunk.active).length;
  ctx.ui.setText("status", `Arrows: move | B: build | X: remove last | active chunks: ${visible}`);
} });

export default defineGame({
  id: "streaming-world", components: [State], systems: [walk],
  prefabs: [floorPrefab, markerPrefab], materials: [ground, pillar, playerMaterial],
  input: { left: ["ArrowLeft"], right: ["ArrowRight"], up: ["ArrowUp"], down: ["ArrowDown"], build: ["b"], remove: ["x"] },
  ui: [{ id: "status", kind: "text", text: "Arrows: move | B: build | X: remove last", x: 16, y: 16 }],
  scene: defineScene({ id: "streaming-world", camera: { position: [8, 14, 16], target: [0, 0, 0] },
    environment: { background: "#172534", ambientIntensity: 1 }, entities: [
      { id: "state", components: [{ component: State }] },
      { id: "player", transform: { position: [0, 0.45, 0] }, mesh: { geometry: { kind: "box", size: [0.7, 0.9, 0.7] }, material: playerMaterial } },
      { id: "sun", transform: { position: [4, 10, 5] }, light: { kind: "directional", intensity: 3 } },
    ] }),
});
````
