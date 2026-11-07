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
