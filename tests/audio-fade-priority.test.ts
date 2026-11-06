import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { chromium } from "playwright";
import { createServer } from "vite";
import { SDK_VERSION, defineGame, defineScene, defineSystem, instantiateGame } from "../packages/sdk/src/index.ts";
import { createGameServices, GAME_SERVICES_MAX_VOICES } from "../packages/runtime/src/game-services.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";

test("public fade drives a continuous real Chromium Web Audio graph without GPU and cleans up", { timeout: 60000 }, async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, fs: { strict: false } }, logLevel: "error" });
  const http = createHttpServer((req, res) => {
    if (req.url === "/__fade_blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>fade</title>"); }
    else server.middlewares(req, res);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/__fade_blank`);
    const result = await page.evaluate(`(async () => {
      const { prepareGameplay } = await import('/packages/renderer/src/gameplay.ts');
      const { RuntimeHost } = await import('/packages/runtime/src/host.ts');
      const sdk = await import('/packages/sdk/src/index.ts');
      const THREE = await import('/node_modules/three/build/three.webgpu.js');
      const Native = window.AudioContext; let context;
      window.AudioContext = class extends Native { constructor() { super(); context=this; } };
      const count=8000*4, bytes=new ArrayBuffer(44+count*2), v=new DataView(bytes);
      const text=(at,s)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
      text(0,'RIFF');v.setUint32(4,36+count*2,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,count*2,true);
      for(let i=0;i<count;i++)v.setInt16(44+i*2,Math.round(Math.sin(2*Math.PI*220*i/8000)*12000),true);
      const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
      const scene={id:'s',entities:[],environment:{background:'#000',ambientIntensity:1},camera:{position:[0,0,1],target:[0,0,0],fov:50,near:.1,far:100},gravity:[0,0,0]};
      const ir={format:'pelican.scene',version:1,engineVersion:sdk.SDK_VERSION,gameId:'fade',scene,scenes:[],components:[],prefabs:[],materials:[],computes:[],systems:[{id:'control',phase:'update',source:{file:'game.ts',line:1,column:1,length:1}}],input:{},ui:[],assets:[{id:'a',type:'audio',path:url,metadata:{duration:4}}],audioBuses:[{id:'music',volume:1}],sounds:[{id:'s',asset:'a',volume:1,loop:true,bus:'music'}]};
      const content=await prepareGameplay(ir,location.href,{getSize:v=>v.set(800,600)});
      const analyser=context.createAnalyser();analyser.fftSize=1024;analyser.connect(context.destination);
      const connect=GainNode.prototype.connect;
      GainNode.prototype.connect=function(dest,...args){return connect.call(this,dest===context.destination?analyser:dest,...args)};
      const start=AudioBufferSourceNode.prototype.start,stop=AudioBufferSourceNode.prototype.stop;
      let starts=0,stops=0;
      AudioBufferSourceNode.prototype.start=function(...args){starts++;return start.apply(this,args)};
      AudioBufferSourceNode.prototype.stop=function(...args){stops++;return stop.apply(this,args)};
      let command=()=>{}, voice;
      const system=sdk.defineSystem({id:'control',run:ctx=>command(ctx.audio)});
      const game=sdk.defineGame({id:'fade',scene:sdk.defineScene({id:'s',entities:[]}),systems:[system],audioBuses:[{id:'music',volume:1}],sounds:[{id:'s',asset:'a',bus:'music',loop:true}]});
      const host=new RuntimeHost(ir,{fixedDt:.01,plugins:[content.services.factory]});
      host.attach(sdk.instantiateGame(game,host.facade));
      const camera=new THREE.PerspectiveCamera(),objects=new Map();
      const action=fn=>{command=fn;host.step();command=()=>{};content.present(camera,objects,.01,999)};
      const signal=async ms=>{await new Promise(r=>setTimeout(r,ms));const a=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(a);return Math.max(...a.map(Math.abs))};
      await context.resume();action(a=>{voice=a.play('s')});let baseline=await signal(110);
      for(let i=0;i<8&&baseline<.05;i++)baseline=await signal(110);
      action(a=>a.fadeBus('music',0,.6));
      const early=await signal(80),mid=await signal(180),late=await signal(190);
      const gain=content.inspect().audio.busVolumes[0].volume;
      const saved=host.snapshot();
      action(a=>a.busVolume('music',1));const reset=await signal(100);
      host.restore(saved);content.present(camera,objects,.01,999);
      const restored=await signal(50);
      action(a=>a.pause(voice));const paused=await signal(70);
      action(a=>a.resume(voice));const resumed=await signal(100);
      action(a=>a.stop(voice));const silent=await signal(70);
      let oldest;
      action(a=>{for(let i=0;i<32;i++){const id=a.play('s');if(i===0)oldest=id}});
      const beforeEviction={starts,stops};
      action(a=>a.play('s',{priority:10}));
      const afterEviction={starts,stops,voices:content.inspect().audio.voices.length,oldestGone:!content.inspect().audio.voices.some(v=>v.id===oldest)};
      host.dispose();await content.dispose();const closed=context.state;
      GainNode.prototype.connect=connect;AudioBufferSourceNode.prototype.start=start;AudioBufferSourceNode.prototype.stop=stop;URL.revokeObjectURL(url);
      return {baseline,early,mid,late,gain,reset,restored,paused,resumed,silent,starts,stops,closed,beforeEviction,afterEviction};
    })()`) as Record<string, unknown>;
    const n = (key: string) => result[key] as number;
    assert.ok(n("baseline") > .1, JSON.stringify(result));
    assert.ok(n("early") > n("mid") && n("mid") > n("late") && n("late") > .01, JSON.stringify(result));
    assert.ok(n("early") < n("baseline") * .99 && n("early") > n("baseline") * .5, JSON.stringify(result));
    assert.ok(n("gain") > .98, JSON.stringify(result)); // simulation ticks do not advance during wall-clock fade
    assert.ok(n("reset") > n("late") * 2 && n("restored") > .05, JSON.stringify(result));
    assert.ok(n("paused") < .001 && n("resumed") > .05 && n("silent") < .001, JSON.stringify(result));
    assert.ok(n("starts") >= 2 && n("stops") >= 2 && result.closed === "closed", JSON.stringify(result));
    const before = result.beforeEviction as { starts: number; stops: number };
    const after = result.afterEviction as { starts: number; stops: number; voices: number; oldestGone: boolean };
    assert.equal(after.voices, GAME_SERVICES_MAX_VOICES);
    assert.ok(after.oldestGone && after.stops === before.stops + 1 && after.starts === before.starts + 1, JSON.stringify(result));
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await server.close();
  }
});

test("public bus fade interpolates in ticks, restores legacy/current snapshots and priority evicts only lower voices", () => {
  const ir = {
    format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "fade",
    scene: { id: "s", entities: [], environment: { background: "#000", ambientIntensity: 1 }, camera: { position: [0, 0, 1], target: [0, 0, 0], fov: 50, near: .1, far: 100 }, gravity: [0, 0, 0] },
    scenes: [], components: [], prefabs: [], materials: [], computes: [], systems: [], input: {}, ui: [],
    assets: [{ id: "a", type: "audio", path: "a.wav" }], audioBuses: [{ id: "music", volume: 1 }],
    sounds: [{ id: "s", asset: "a", bus: "music", volume: 1, loop: true }],
  } as unknown as SceneIR;
  const driver = createGameServices(ir, { play() {}, state: () => ({ clip: null, time: 0, playing: false }) });
  const host = new RuntimeHost(ir, { fixedDt: .1, plugins: [driver.factory] });
  host.attach(instantiateGame(defineGame({ id: "fade", scene: defineScene({ id: "s", entities: [] }) }), host.facade));
  const audio = host.facade.audio;
  const gain = () => driver.inspect().audio.busVolumes![0];
  try {
    audio.fadeBus("music", 0, 1);
    host.step(2);
    assert.ok(Math.abs(gain().volume - .8) < 1e-10);
    const saved = host.snapshot();
    host.step(3);
    assert.ok(Math.abs(gain().volume - .5) < 1e-10);
    host.restore(saved);
    assert.ok(Math.abs(gain().volume - .8) < 1e-10);
    audio.fadeBus("music", 1, .4);
    host.step(2);
    assert.ok(Math.abs(gain().volume - .9) < 1e-10);
    audio.busVolume("music", .3);
    assert.deepEqual(gain(), { id: "music", volume: .3 });
    audio.fadeBus("music", .8, 0);
    assert.equal(gain().volume, .8);
    const before = host.snapshot();
    for (const call of [() => audio.fadeBus("no", 0, 1), () => audio.fadeBus("music", NaN, 1), () => audio.fadeBus("music", 1, -1), () => audio.play("s", { priority: 256 })]) {
      assert.throws(call, /TC_AUDIO_/);
      assert.deepEqual(host.snapshot(), before);
    }
    audio.fadeBus("music", 0, 1);
    const active = host.snapshot() as any;
    for (const change of [ (s: any) => { s.audio.busVolumes[0].fade.target = 3; }, (s: any) => { s.audio.busVolumes[0].fade.startedAt = 100; }, (s: any) => { s.audio.busVolumes[0].volume = .5; } ]) {
      const bad = structuredClone(active); change(bad.plugins["game-services"].payload);
      assert.throws(() => host.restore(bad), /TC_SERVICES_SNAPSHOT/);
      assert.deepEqual(host.snapshot(), active);
    }
    const legacy = structuredClone(before) as any;
    delete legacy.plugins["game-services"].payload.audio.busVolumes[0].fade;
    host.restore(legacy);
    assert.equal(gain().fade, undefined);
    const ids = Array.from({ length: GAME_SERVICES_MAX_VOICES }, () => audio.play("s"));
    const full = host.snapshot();
    assert.throws(() => audio.play("s"), /TC_AUDIO_VOICE_LIMIT/);
    assert.deepEqual(host.snapshot(), full);
    const high = audio.play("s", { priority: 5 });
    assert.equal(driver.inspect().audio.voices.length, GAME_SERVICES_MAX_VOICES);
    assert.ok(!driver.inspect().audio.voices.some(v => v.id === ids[0]));
    assert.equal(driver.inspect().audio.voices.at(-1)?.id, high);
    const snapshot = host.snapshot();
    assert.throws(() => audio.play("s", { priority: 0 }), /TC_AUDIO_VOICE_LIMIT/);
    assert.deepEqual(host.snapshot(), snapshot);
    host.restore(snapshot);
    assert.equal(driver.inspect().audio.voices.at(-1)?.priority, 5);
    const badPriority = structuredClone(snapshot) as any;
    badPriority.plugins["game-services"].payload.audio.voices.at(-1).priority = -1;
    assert.throws(() => host.restore(badPriority), /TC_SERVICES_SNAPSHOT/);
    assert.deepEqual(host.snapshot(), snapshot);
  } finally { host.dispose(); }
});
