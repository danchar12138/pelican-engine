import { defineAsset, defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "@threecat/sdk";

const fox = defineAsset({ id: "courier-fox", type: "model", path: "assets/Fox.glb", license: "CC0-1.0 AND CC-BY-4.0", source: "KhronosGroup/glTF-Sample-Assets@8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models/Fox", attribution: "Model PixelMannen (CC0); animation tomkranis; glTF conversion AsoboStudio and scurest (CC-BY-4.0)." });
const chime = defineAsset({ id: "receipt-chime", type: "audio", path: "assets/chime.wav", source: "threecat procedural PCM synthesis", license: "MIT" });
const navy = defineMaterial({ id: "night-blue", color: "#152a42", roughness: 0.82 });
const concrete = defineMaterial({ id: "dock-concrete", color: "#52677c", roughness: 0.9 });
const orange = defineMaterial({ id: "cargo-orange", color: "#ffae43", roughness: 0.45, metalness: 0.15 });
const mint = defineMaterial({ id: "arrival-mint", color: "#64f4cf", roughness: 0.35, metalness: 0.25 });
const pink = defineMaterial({ id: "gate-coral", color: "#ff6881", roughness: 0.6 });
const white = defineMaterial({ id: "lane-white", color: "#e5ecf6", roughness: 0.8 });

export const Dispatch = defineComponent({ id: "Dispatch", schema: {
  attached: { type: "boolean", default: false },
  delivered: { type: "boolean", default: false },
  completed: { type: "boolean", default: false },
  missions: { type: "number", default: 0 },
  credits: { type: "number", default: 0 },
  express: { type: "boolean", default: false },
  heading: { type: "vec3", default: [0, 0, -1] },
} });
const cargo = definePrefab({ id: "freight-crate", mesh: { geometry: { kind: "box", size: [1.1, 1.1, 1.1] }, material: orange, castShadow: true, receiveShadow: true }, rigidBody: { type: "dynamic", mass: 1.8, friction: 0.6, restitution: 0.08, collider: { shape: "box", size: [1.1, 1.1, 1.1] } } });

const movement = defineSystem({ id: "courier-and-tow", phase: "prePhysics", reads: ["Dispatch", "Transform"], writes: ["Dispatch", "Transform"], structural: false,
  run(ctx, dt) {
    const state = ctx.getComponent("dispatch", Dispatch);
    const x = ctx.input.axis("left", "right");
    const z = ctx.input.axis("forward", "back");
    const length = Math.hypot(x, z);
    const speed = state.express ? 4.5 : 3;
    if (length > 0) {
      const heading: [number, number, number] = [x / length, 0, z / length];
      ctx.setComponent("dispatch", Dispatch, { heading });
      ctx.physics.moveCharacter("courier", [heading[0] * speed * dt, 0, heading[2] * speed * dt]);
      ctx.setTransform("courier", { rotation: [0, Math.atan2(heading[0], heading[2]), 0] });
    }
    const clip = length > 0 ? "Walk" : "Survey";
    if (ctx.animation.state("courier").clip !== clip) ctx.animation.play("courier", clip, { fade: 0.16 });
    const player = ctx.getTransform("courier").position;
    const box = ctx.getTransform("shipment").position;
    if (ctx.input.pressed("interact") && !state.delivered && Math.hypot(player[0]-box[0], player[2]-box[2]) < 3) {
      ctx.setComponent("dispatch", Dispatch, { attached: !state.attached });
    }
    const towing = ctx.getComponent("dispatch", Dispatch);
    if (towing.attached && !towing.delivered) {
      const h = towing.heading;
      const vx = Math.max(-5, Math.min(5, (player[0]+h[0]*1.7-box[0])*7));
      const vz = Math.max(-5, Math.min(5, (player[2]+h[2]*1.7-box[2])*7));
      ctx.physics.setVelocity("shipment", [vx, ctx.physics.velocity("shipment")[1], vz]);
    }
  }
});

const dispatch = defineSystem({ id: "weigh-deliver-reward", phase: "postPhysics", reads: ["Dispatch", "Transform"], writes: ["Dispatch", "Transform"], structural: false,
  run(ctx) {
    const state = ctx.getComponent("dispatch", Dispatch);
    const box = ctx.getTransform("shipment").position;
    if (!state.delivered && Math.abs(box[0]) < 1.25 && Math.abs(box[2]+5) < 1.15 && box[1] < 1.2) {
      ctx.setComponent("dispatch", Dispatch, { delivered: true, attached: false });
      ctx.physics.setVelocity("shipment", [0, 0, 0]);
      ctx.audio.play("receipt");
      ctx.emit("freight.accepted", { entity: "shipment" });
    }
    const current = ctx.getComponent("dispatch", Dispatch);
    ctx.setTransform("exit-gate", { position: [0, current.delivered ? 4.6 : 1.3, -8] });
    const player = ctx.getTransform("courier").position;
    if (current.delivered && !current.completed && player[2] < -9.2 && Math.abs(player[0]) < 2.2) {
      ctx.setComponent("dispatch", Dispatch, { completed: true, missions: current.missions+1, credits: current.credits+1 });
      ctx.audio.play("receipt");
      ctx.emit("freight.completed", { missions: current.missions+1 });
    }
    const reward = ctx.getComponent("dispatch", Dispatch);
    if (reward.completed && !reward.express && reward.credits > 0 && ctx.input.pressed("interact") && player[2] < -9.2) {
      ctx.setComponent("dispatch", Dispatch, { credits: reward.credits-1, express: true });
      ctx.audio.play("receipt");
      ctx.emit("freight.express", { speed: 4.5 });
    }
    if (ctx.input.pressed("save")) ctx.storage.save("freight-slot");
    else if (ctx.input.pressed("load")) ctx.storage.load("freight-slot");
  }
});

const hud = defineSystem({ id: "shipping-board", phase: "presentation", reads: ["Dispatch", "Transform"], writes: [], structural: false,
  run(ctx) {
    const s = ctx.getComponent("dispatch", Dispatch);
    ctx.ui.setText("objective", s.completed ? "签收完成 · 在出口按 E 兑换疾速通行证" : s.delivered ? "货物已称重 · 闸门已开，向前进入终点" : s.attached ? "已连接牵引 · W 前往薄荷色称重台，E 松开" : "靠近橙色货箱按 E 连接牵引，然后按 W 运送");
    ctx.ui.setText("ledger", "任务 " + s.missions + "  /  运费券 " + s.credits + "  /  疾速 " + (s.express ? "已兑换" : "未兑换"));
    ctx.ui.setProgress("route", s.completed ? 1 : s.delivered ? 0.75 : s.attached ? 0.35 : 0);
    ctx.ui.setText("save-state", "存档 " + ctx.storage.status().state + " · K 保存 / L 恢复");
    ctx.ui.setText("box-label", s.delivered ? "已收货 ✓" : "货箱 · E 牵引");
  }
});

const dock = defineScene({ id: "freight-terminal", camera: { position: [13, 14, 17], target: [0, 0, -3], fov: 48 }, environment: { background: "#091322", ambientIntensity: 0.8, lighting: "studio" }, gravity: [0, -9.81, 0], entities: [
  { id: "dispatch", components: [{ component: Dispatch }] },
  { id: "dock-floor", transform: { position: [0, -0.3, -3] }, mesh: { geometry: { kind: "box", size: [12, 0.6, 22] }, material: concrete, receiveShadow: true }, rigidBody: { type: "fixed", collider: { shape: "box", size: [12, 0.6, 22] } } },
  { id: "courier", transform: { position: [0, 0.8, 3] }, model: { asset: fox, scale: 0.014, offset: [0, -0.7, 0], animation: { clip: "Survey" }, castShadow: true, receiveShadow: true }, character: { radius: 0.32, height: 1.4, speed: 3 } },
  { id: "shipment", prefab: cargo, transform: { position: [0, 2.8, 1] } },
  { id: "weigh-pad", transform: { position: [0, 0.035, -5] }, mesh: { geometry: { kind: "box", size: [3.4, 0.07, 2.9] }, material: mint, receiveShadow: true } },
  { id: "finish-pad", transform: { position: [0, 0.04, -10.5] }, mesh: { geometry: { kind: "box", size: [4.5, 0.08, 3] }, material: orange } },
  { id: "exit-gate", transform: { position: [0, 1.3, -8] }, mesh: { geometry: { kind: "box", size: [4.5, 2.6, 0.35] }, material: pink, castShadow: true }, rigidBody: { type: "kinematic", collider: { shape: "box", size: [4.5, 2.6, 0.35] } } },
  { id: "left-rail", transform: { position: [-5.5, 0.35, -3] }, mesh: { geometry: { kind: "box", size: [0.3, 0.7, 21] }, material: navy }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.3, 0.7, 21] } } },
  { id: "right-rail", transform: { position: [5.5, 0.35, -3] }, mesh: { geometry: { kind: "box", size: [0.3, 0.7, 21] }, material: navy }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.3, 0.7, 21] } } },
  { id: "lane-left", transform: { position: [-2.4, 0.02, -2] }, mesh: { geometry: { kind: "box", size: [0.07, 0.04, 16] }, material: white } },
  { id: "lane-right", transform: { position: [2.4, 0.02, -2] }, mesh: { geometry: { kind: "box", size: [0.07, 0.04, 16] }, material: white } },
  { id: "lamp", transform: { position: [5, 11, 6] }, light: { kind: "directional", color: "#fff0d6", intensity: 3.4, castShadow: true, target: [0, 0, -3], shadow: { extent: 16, mapSize: 2048 } } }
] });

export default defineGame({ id: "fox-freight-terminal", scene: dock, components: [Dispatch], prefabs: [cargo], assets: [fox, chime], materials: [navy, concrete, orange, mint, pink, white], systems: [movement, dispatch, hud],
  input: { forward: ["w", "ArrowUp"], back: ["s", "ArrowDown"], left: ["a", "ArrowLeft"], right: ["d", "ArrowRight"], interact: ["e", "ui:interact"], save: ["k", "ui:save"], load: ["l", "ui:load"] },
  sounds: [{ id: "receipt", asset: chime, volume: 0.3 }],
  ui: [
    { id: "title", kind: "text", text: "FOX FREIGHT / 狐狸货运站", anchor: "top-left", x: 24, y: 20, width: 440, color: "#64f4cf" },
    { id: "objective", kind: "text", text: "装载一只货箱，解锁终点", anchor: "top-left", x: 24, y: 64, width: 540 },
    { id: "ledger", kind: "text", text: "任务 0", anchor: "top-left", x: 24, y: 108, width: 440 },
    { id: "route", kind: "bar", value: 0, anchor: "top-left", x: 24, y: 152, width: 310, color: "#64f4cf" },
    { id: "controls", kind: "text", text: "WASD 移动 · E 牵引 / 兑换 · 真实重力运输", anchor: "bottom-left", x: 24, y: 108, width: 500 },
    { id: "save-state", kind: "text", text: "K 保存 / L 恢复", anchor: "bottom-left", x: 24, y: 64, width: 440 },
    { id: "interact", kind: "button", text: "E 连接 / 兑换", anchor: "bottom-right", x: 24, y: 152, width: 170 },
    { id: "save", kind: "button", text: "保存任务 [K]", anchor: "bottom-right", x: 24, y: 108, width: 170 },
    { id: "load", kind: "button", text: "恢复任务 [L]", anchor: "bottom-right", x: 24, y: 64, width: 170 },
    { id: "box-label", kind: "text", text: "货箱", width: 140, world: { entity: "shipment", offset: [0, 1.1, 0], occlude: true }, color: "#ffce82" }
  ]
});
