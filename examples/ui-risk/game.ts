import {
  defineComponent,
  defineGame,
  defineMaterial,
  defineScene,
  defineSystem,
} from "@threecat/sdk";

const Probe = defineComponent({
  id: "UiProbe",
  schema: {
    text: { type: "string", default: "" },
    submitted: { type: "number", default: 0 },
    buttons: { type: "number", default: 0 },
    worldClicks: { type: "number", default: 0 },
    blocked: { type: "boolean", default: true },
    gameMoves: { type: "number", default: 0 },
    gameKeyEvents: { type: "number", default: 0 },
  },
});
const teal = defineMaterial({ id: "teal", color: "#36d2bd", roughness: 0.35 });
const blue = defineMaterial({ id: "blue", color: "#324a70", roughness: 0.7 });
const controls = defineSystem({
  id: "controls",
  phase: "prePhysics",
  reads: ["UiProbe", "Transform"],
  writes: ["UiProbe", "Transform"],
  run(ctx, dt) {
    const state = ctx.getComponent("control", Probe);
    if (ctx.input.pressed("toggle")) {
      const blocked = !state.blocked;
      ctx.setComponent("control", Probe, { blocked });
      ctx.setTransform("occluder", { position: [blocked ? 0 : 4, 1.3, 2] });
    }
    if (ctx.input.held("move")) {
      const actor = ctx.getTransform("target");
      ctx.setTransform("target", {
        position: [
          actor.position[0] + dt,
          actor.position[1],
          actor.position[2],
        ],
      });
      ctx.setComponent("control", Probe, { gameMoves: state.gameMoves + 1 });
    }
  },
});
const events = defineSystem({
  id: "ui-events",
  phase: "update",
  reads: ["UiProbe"],
  writes: ["UiProbe"],
  run(ctx) {
    const keyEvents = ctx.events("input.key").length;
    if (keyEvents)
      ctx.setComponent("control", Probe, {
        gameKeyEvents:
          ctx.getComponent("control", Probe).gameKeyEvents + keyEvents,
      });
    for (const event of ctx.events("ui.text")) {
      const data = event.payload as { id: string; text: string };
      if (data.id === "name")
        ctx.setComponent("control", Probe, { text: data.text });
    }
    for (const event of ctx.events("ui.submit")) {
      const data = event.payload as { id: string; text: string };
      if (data.id === "name")
        ctx.setComponent("control", Probe, {
          submitted: ctx.getComponent("control", Probe).submitted + 1,
        });
    }
    for (const event of ctx.events("ui.activate")) {
      const data = event.payload as { id: string };
      if (data.id === "world-control")
        ctx.setComponent("control", Probe, {
          worldClicks: ctx.getComponent("control", Probe).worldClicks + 1,
        });
      else
        ctx.setComponent("control", Probe, {
          buttons: ctx.getComponent("control", Probe).buttons + 1,
        });
    }
    const state = ctx.getComponent("control", Probe);
    ctx.ui.setText(
      "summary",
      "文本：" +
        state.text +
        " | 提交 " +
        state.submitted +
        " | 按钮 " +
        state.buttons +
        " | 世界交互 " +
        state.worldClicks,
    );
  },
});
export default defineGame({
  id: "m2-ui-risk",
  scene: defineScene({
    id: "ui-risk",
    camera: { position: [0, 2.8, 7], target: [0, 1, 0], fov: 50 },
    environment: { background: "#142639", ambientIntensity: 1.4 },
    entities: [
      { id: "control", components: [{ component: Probe }] },
      {
        id: "target",
        transform: { position: [0, 0.5, 0] },
        mesh: { geometry: { kind: "box", size: [1, 1, 1] }, material: teal },
        rigidBody: {
          type: "fixed",
          collider: { shape: "box", size: [1, 1, 1] },
        },
      },
      {
        id: "occluder",
        transform: { position: [0, 1.3, 2] },
        mesh: {
          geometry: { kind: "box", size: [1.8, 2.6, 0.4] },
          material: blue,
        },
        rigidBody: {
          type: "fixed",
          collider: { shape: "box", size: [1.8, 2.6, 0.4] },
        },
      },
      {
        id: "ground",
        transform: { position: [0, -0.2, 0] },
        mesh: { geometry: { kind: "box", size: [10, 0.4, 8] }, material: blue },
      },
      {
        id: "sun",
        transform: { position: [3, 8, 5] },
        light: { kind: "directional", intensity: 3, castShadow: true },
      },
    ],
  }),
  systems: [controls, events],
  materials: [teal, blue],
  input: { move: ["w"], toggle: ["v", "V"] },
  ui: [
    {
      id: "title",
      kind: "text",
      text: "中文组合输入 / 焦点 / 世界 UI 风险验证",
      x: 16,
      y: 16,
      width: 610,
    },
    { id: "name", kind: "input", text: "", x: 16, y: 72, width: 400 },
    {
      id: "summary",
      kind: "text",
      text: "等待输入",
      x: 16,
      y: 128,
      width: 650,
    },
    {
      id: "one",
      kind: "button",
      text: "按钮一",
      anchor: "top-right",
      x: 16,
      y: 16,
      width: 140,
    },
    {
      id: "two",
      kind: "button",
      text: "按钮二",
      anchor: "top-right",
      x: 16,
      y: 72,
      width: 140,
    },
    {
      id: "world-control",
      kind: "button",
      text: "世界按钮",
      width: 140,
      world: { entity: "target", offset: [0, 1.2, 0], occlude: true },
    },
    {
      id: "help",
      kind: "text",
      text: "V 移开遮挡物；输入框中的 W 不应触发游戏移动；Enter 提交",
      anchor: "bottom-left",
      x: 16,
      y: 16,
      width: 740,
    },
  ],
});
