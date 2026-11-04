import { defineComponent, defineGame, defineMaterial, definePrefab, defineScene, defineSystem } from "@threecat/sdk";
import { fox, chime } from "./assets";
const floor = defineMaterial({ id: "floor", color: "#253b50", roughness: 0.85 });
const edge = defineMaterial({ id: "edge", color: "#132336", roughness: 0.6 });
const cyan = defineMaterial({ id: "cyan", color: "#4ce7dc", roughness: 0.25, metalness: 0.55 });
const amber = defineMaterial({ id: "amber", color: "#ffbe59", roughness: 0.3, metalness: 0.65 });
const pink = defineMaterial({ id: "pink", color: "#ed6487", roughness: 0.4 });
export const GridState = defineComponent({ id: "GridState", schema: {
  restored: { type: "number", default: 0 }, restart: { type: "number", default: 0 },
  exitOnline: { type: "boolean", default: false }, escaped: { type: "boolean", default: false },
  speed: { type: "number", default: 3.6 }, gateHeight: { type: "number", default: 1.4 }
} });
export const EnergyCore = defineComponent({ id: "EnergyCore", schema: {
  charge: { type: "number", default: 0 }, restored: { type: "boolean", default: false }
} });
export const Capacitor = defineComponent({ id: "Capacitor", schema: { source: { type: "string", default: "" }, reward: { type: "number", default: 1 } } });
const reward = definePrefab({ id: "capacitor-reward", mesh: { geometry: { kind: "box", size: [0.45,0.45,0.45] }, material: amber }, rigidBody: { type: "dynamic", mass: 1, restitution: 0.4, friction: 0.7, collider: { shape: "box", size: [0.45,0.45,0.45] } }, components: [{ component: Capacitor }] });
const base = definePrefab({ id: "core-base", mesh: { geometry: { kind: "box", size: [2.1,0.25,2.1] }, material: edge } });
const core = definePrefab({ id: "energy-core", mesh: { geometry: { kind: "sphere", radius: 0.6, segments: 28 }, material: amber }, components: [{ component: EnergyCore }] });
const controls = defineSystem({ id: "relay-controls", phase: "prePhysics", reads: ["GridState","Transform"], writes: ["Transform"], run(ctx,dt) {
  if (ctx.input.pressed("save")) ctx.storage.save("core-relay");
  else if (ctx.input.pressed("load")) ctx.storage.load("core-relay");
  else if (ctx.input.pressed("reset")) ctx.scenes.load("relay-yard");
  const state = ctx.getComponent("player",GridState);
  let x = ctx.input.axis("left","right"), z = ctx.input.axis("forward","back");
  const length = Math.hypot(x,z);
  if (length > 1) { x /= length; z /= length; }
  const vertical = ctx.physics.velocity("player")[1];
  ctx.physics.setVelocity("player",state.escaped ? [0,vertical,0] : [x*state.speed,vertical,z*state.speed]);
  if (length > 0 && !state.escaped) {
    ctx.setTransform("player",{ rotation: [0,Math.atan2(x,z),0] });
  }
  if (ctx.input.pressed("jump") && ctx.physics.grounded("player")) ctx.physics.setVelocity("player",[0,6.5,0]);
  const clip = length > 0 && !state.escaped ? "Run" : "Survey";
  if (ctx.animation.state("player").clip !== clip) ctx.animation.play("player",clip,{ fade: 0.15 });
} });
const restoration = defineSystem({ id: "core-restoration", phase: "update", reads: ["GridState","EnergyCore","Transform"], writes: ["GridState","EnergyCore","Capacitor","Transform"], structural: true, run(ctx,dt) {
  const player = ctx.getTransform("player").position;
  const state = ctx.getComponent("player",GridState);
  let hint = "Hold E beside a core to repair it";
  for (const id of ctx.query(EnergyCore)) {
    const value = ctx.getComponent(id,EnergyCore), at = ctx.getTransform(id).position;
    if (!value.restored && Math.hypot(player[0]-at[0],player[2]-at[2]) < 1.65) {
      hint = "Hold E: restore " + id + "  " + Math.floor(value.charge*100) + "%";
      if (ctx.input.held("interact")) {
        value.charge = Math.min(1,value.charge + dt/1.2);
        if (value.charge >= 1) {
          value.restored = true; state.restored += 1; state.speed = 3.6 + state.restored*0.4;
          ctx.entities.spawn({ id: "reward-"+id, prefab: "capacitor-reward", transform: { position: [at[0]+1.1,3,at[2]] }, components: { Capacitor: { source: id } } });
          ctx.audio.play("restore");
        }
        ctx.setComponent(id,EnergyCore,value);
      }
    }
    ctx.setTransform(id,{ position: [at[0],value.restored ? 1.6 : 0.9,at[2]], rotation: [0,ctx.time.elapsed*(value.restored ? 1.8 : 0.3),0], scale: value.restored ? [0.7,1.4,0.7] : [1,1,1] });
  }
  if (Math.hypot(player[0],player[2]-5.3) < 1.6 && !state.exitOnline) {
    hint = state.restored < 3 ? "Exit offline: restore all three cores first" : "Hold E: reboot exit  " + Math.floor(state.restart*100) + "%";
    if (state.restored === 3 && ctx.input.held("interact")) {
      state.restart = Math.min(1,state.restart + dt/1.5);
      if (state.restart >= 1) { state.exitOnline = true; ctx.audio.play("restore"); }
    }
  }
  if (state.exitOnline) {
    state.gateHeight = Math.min(4.5,state.gateHeight + dt*2.4);
    ctx.setTransform("exit-gate",{ position: [0,state.gateHeight,7] });
    hint = "Exit online! Walk south through the raised gate";
    if (player[2] > 8.1 && Math.abs(player[0]) < 1.7) state.escaped = true;
  }
  ctx.setComponent("player",GridState,state);
  ctx.ui.setText("mission",state.escaped ? "RELAY RESTORED / Expedition complete" : state.restored === 3 ? "03 / RETURN TO THE SOUTH CONSOLE" : "01 / RESTORE THE THREE ENERGY CORES");
  ctx.ui.setText("score","CORES  " + state.restored + " / 3   |   BOOST  +" + (state.restored*0.4).toFixed(1) + "   |   EXIT " + (state.exitOnline ? "ONLINE" : "OFFLINE"));
  ctx.ui.setProgress("progress",state.restored/3);
  ctx.ui.setText("hint",state.escaped ? "All cores restored. Exit rebooted. F9: checkpoint / R: restart" : hint);
  ctx.ui.setText("storage","F5: save / F9: load  |  " + ctx.storage.status().state);
} });
const yard = defineScene({ id: "relay-yard", camera: { position: [18,22,12], target: [0,0,0], fov: 49, far: 150 }, environment: { background: "#101c30", ambientIntensity: 2, lighting: "studio" }, entities: [
  { id: "player", transform: { position: [0,0.75,4] }, model: { asset: fox, scale: 0.013, offset: [0,-0.7,0], animation: { clip: "Survey" } }, character: { radius: 0.3, height: 1.4, speed: 4.8, jumpSpeed: 6.5 }, components: [{ component: GridState }] },
  { id: "floor", transform: { position: [0,-0.3,0] }, mesh: { geometry: { kind: "box", size: [18,0.6,21] }, material: floor }, rigidBody: { type: "fixed", collider: { shape: "box", size: [18,0.6,21] } } },
  { id: "west-wall", transform: { position: [-8.8,0.6,0] }, mesh: { geometry: { kind: "box", size: [0.3,1.2,21] }, material: edge }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.3,1.2,21] } } },
  { id: "east-wall", transform: { position: [8.8,0.6,0] }, mesh: { geometry: { kind: "box", size: [0.3,1.2,21] }, material: edge }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.3,1.2,21] } } },
  { id: "north-wall", transform: { position: [0,0.6,-10] }, mesh: { geometry: { kind: "box", size: [18,1.2,0.3] }, material: edge }, rigidBody: { type: "fixed", collider: { shape: "box", size: [18,1.2,0.3] } } },
  { id: "base-west", prefab: base, transform: { position: [-5,0.12,0] } },
  { id: "base-north", prefab: base, transform: { position: [0,0.12,-6] } },
  { id: "base-east", prefab: base, transform: { position: [5,0.12,0] } },
  { id: "core-west", prefab: core, transform: { position: [-5,0.9,0] } },
  { id: "core-north", prefab: core, transform: { position: [0,0.9,-6] } },
  { id: "core-east", prefab: core, transform: { position: [5,0.9,0] } },
  { id: "center-obstacle", transform: { position: [0,0.6,-1] }, mesh: { geometry: { kind: "box", size: [2.3,1.2,2.3] }, material: edge }, rigidBody: { type: "fixed", collider: { shape: "box", size: [2.3,1.2,2.3] } } },
  { id: "console", transform: { position: [-1.6,0.6,5.3] }, mesh: { geometry: { kind: "box", size: [0.6,1.2,0.6] }, material: cyan } },
  { id: "exit-gate", transform: { position: [0,1.4,7] }, mesh: { geometry: { kind: "box", size: [3.5,2.8,0.4] }, material: pink }, rigidBody: { type: "kinematic", collider: { shape: "box", size: [3.5,2.8,0.4] } } },
  { id: "exit-left", transform: { position: [-2,1.7,7] }, mesh: { geometry: { kind: "box", size: [0.4,3.4,0.6] }, material: cyan }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.4,3.4,0.6] } } },
  { id: "exit-right", transform: { position: [2,1.7,7] }, mesh: { geometry: { kind: "box", size: [0.4,3.4,0.6] }, material: cyan }, rigidBody: { type: "fixed", collider: { shape: "box", size: [0.4,3.4,0.6] } } },
  { id: "exit-top", transform: { position: [0,3.5,7] }, mesh: { geometry: { kind: "box", size: [4.4,0.3,0.6] }, material: cyan } },
  { id: "sun", transform: { position: [-6,14,8] }, light: { kind: "directional", intensity: 4, color: "#fff0d5", target: [0,0,0], castShadow: true, shadow: { extent: 18, mapSize: 2048 } } },
  { id: "core-light", transform: { position: [0,5,-4] }, light: { kind: "point", intensity: 50, color: "#4ce7dc" } }
] });
export default defineGame({ id: "three-core-relay", scene: yard, components: [GridState,EnergyCore,Capacitor], prefabs: [reward,base,core], assets: [fox,chime], materials: [floor,edge,cyan,amber,pink], systems: [controls,restoration],
  input: { forward: ["w","ArrowUp"], back: ["s","ArrowDown"], left: ["a","ArrowLeft"], right: ["d","ArrowRight"], jump: [" "], interact: ["e"], save: ["F5","ui:save"], load: ["F9","ui:load"], reset: ["r","ui:reset"] },
  sounds: [{ id: "restore", asset: chime, volume: 0.5 }],
  ui: [
    { id: "title", kind: "text", text: "T H R E E   C O R E   R E L A Y", x: 20, y: 18, width: 650 },
    { id: "mission", kind: "text", text: "Restore power. Reboot the south exit.", x: 20, y: 70, width: 650 },
    { id: "score", kind: "text", text: "CORES 0 / 3", x: 20, y: 120, width: 650 },
    { id: "progress", kind: "bar", value: 0, x: 20, y: 172, width: 340 },
    { id: "hint", kind: "text", text: "Hold E beside a core", anchor: "bottom-left", x: 20, y: 18, width: 820 },
    { id: "keys", kind: "text", text: "WASD / ARROWS: move   SPACE: jump   HOLD E: repair / reboot", anchor: "bottom-left", x: 20, y: 70, width: 820 },
    { id: "storage", kind: "text", text: "F5 save / F9 load", anchor: "top-right", x: 18, y: 174, width: 230 },
    { id: "save", kind: "button", text: "SAVE", anchor: "top-right", x: 18, y: 18, width: 100 },
    { id: "load", kind: "button", text: "LOAD", anchor: "top-right", x: 18, y: 70, width: 100 },
    { id: "reset", kind: "button", text: "RESET", anchor: "top-right", x: 18, y: 122, width: 100 }
  ]
});
