import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

test("compiled public game drives audio buses in Chromium without GPU", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-audio-bus-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const engineRoot = fileURLToPath(new URL("../", import.meta.url));
  const samples = 8000 * 4, pcm = Buffer.alloc(44 + samples * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + samples * 2, 4); pcm.write("WAVEfmt ", 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 8000) * 12000), 44 + i * 2);
  await writeFile(path.join(root, "chime.wav"), pcm);
  await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
  await writeFile(path.join(root, "game.ts"), `
import { defineAsset, defineGame, defineScene, defineSystem } from "pelican-engine";
const audio = defineAsset({id:"tone",type:"audio",path:"chime.wav"});
const system = defineSystem({id:"audio",run(ctx) {
  if (ctx.time.tick === 1) ctx.audio.play("tone");
  if (ctx.time.tick === 2) ctx.audio.busVolume("music", 0.25);
  if (ctx.time.tick === 3) ctx.audio.pause("voice:1");
  if (ctx.time.tick === 4) ctx.audio.resume("voice:1");
}});
export default defineGame({id:"bus-game",assets:[audio],audioBuses:[{id:"music",volume:0.5}],sounds:[{id:"tone",asset:audio,bus:"music",loop:true}],systems:[system],scene:defineScene({id:"scene",entities:[]})});
`);
  const compiled = await compileProject({ projectRoot: root, outDir: "out", engineRoot });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const js = await readFile(path.join(root, "out/game.js"), "utf8");
  const wav = await readFile(path.join(root, "chime.wav"));
  const server = await createServer({ configFile: false, server: { middlewareMode: true, fs: { strict: false } }, logLevel: "error" });
  const http = createHttpServer((req, res) => {
    if (req.url === "/__compiled_audio") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Audio</title>"); }
    else if (req.url === "/__compiled.wav") { res.setHeader("Content-Type", "audio/wav"); res.end(wav); }
    else server.middlewares(req, res);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/__compiled_audio`);
    await page.addScriptTag({ content: "window.__name = target => target;" });
    const result = await page.evaluate(async ({ ir, code }) => {
      const rendererURL = "/packages/renderer/src/gameplay.ts", hostURL = "/packages/runtime/src/host.ts", threeURL = "/node_modules/three/build/three.webgpu.js";
      const { prepareGameplay } = await import(rendererURL);
      const { RuntimeHost } = await import(hostURL);
      const THREE = await import(threeURL);
      const Native = window.AudioContext; let context: AudioContext;
      window.AudioContext = class extends Native { constructor() { super(); context = this; } };
      ir.assets[0].path = "/__compiled.wav";
      const content = await prepareGameplay(ir, location.href, { getSize: (v: any) => v.set(800, 600) } as any);
      const analyser = context!.createAnalyser(); analyser.fftSize = 1024; analyser.connect(context!.destination);
      const connect = GainNode.prototype.connect;
      GainNode.prototype.connect = function(this: GainNode, destination: any, ...args: any[]) { return connect.call(this, destination === context!.destination ? analyser : destination, ...args); } as typeof connect;
      const moduleURL = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const game = await import(/* @vite-ignore */ moduleURL);
      const host = new RuntimeHost(ir, { fixedDt: 0.01, plugins: [content.services.factory] });
      host.attach(game.createGame(host.facade));
      const camera = new THREE.PerspectiveCamera(), objects = new Map();
      const step = () => { host.step(); content.present(camera, objects, .01, 999); };
      const signal = async () => { await new Promise(resolve => setTimeout(resolve, 160)); const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values); return Math.max(...values.map(Math.abs)); };
      await context!.resume(); step(); let initial = await signal();
      for (let i = 0; i < 8 && initial < .001; i++) initial = await signal();
      step(); const quieter = await signal(); step(); const paused = await signal(); step(); const resumed = await signal();
      const state = content.inspect(); host.dispose(); await content.dispose();
      GainNode.prototype.connect = connect; URL.revokeObjectURL(moduleURL);
      return { initial, quieter, paused, resumed, voices: state.audio.voices.length, closed: context!.state };
    }, { ir: compiled.ir!, code: js });
    assert.ok(result.initial > .001, JSON.stringify(result));
    assert.ok(Math.abs(result.quieter / result.initial - .5) < .15, JSON.stringify(result));
    assert.ok(result.paused < .001, JSON.stringify(result));
    assert.ok(result.resumed > .001, JSON.stringify(result));
    assert.equal(result.voices, 1);
    assert.equal(result.closed, "closed");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await server.close();
  }
});

test("public game bus routing and master gain produce real Web Audio signals without GPU", { timeout: 60000 }, async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, fs: { strict: false } }, logLevel: "error" });
  const http = createHttpServer((req, res) => {
    if (req.url === "/__bus_blank") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Audio</title>"); }
    else server.middlewares(req, res);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/__bus_blank`);
    const result = await page.evaluate(`(async () => {
      const { prepareGameplay } = await import('/packages/renderer/src/gameplay.ts');
      const { RuntimeHost } = await import('/packages/runtime/src/host.ts');
      const sdk = await import('/packages/sdk/src/index.ts');
      const THREE = await import('/node_modules/three/build/three.webgpu.js');
      const NativeContext = window.AudioContext; let context;
      window.AudioContext = class extends NativeContext { constructor(...a) { super(...a); context = this; } };
      const count = 8000 * 4, bytes = new ArrayBuffer(44 + count * 2), v = new DataView(bytes);
      const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
      text(0,'RIFF'); v.setUint32(4,36+count*2,true); text(8,'WAVE'); text(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,8000,true); v.setUint32(28,16000,true); v.setUint16(32,2,true); v.setUint16(34,16,true); text(36,'data'); v.setUint32(40,count*2,true);
      for(let i=0;i<count;i++) v.setInt16(44+i*2,Math.round(Math.sin(2*Math.PI*220*i/8000)*12000),true);
      const url = URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
      const scene = {id:'s',entities:[],environment:{background:'#000',ambientIntensity:1},camera:{position:[0,0,1],target:[0,0,0],fov:50,near:.1,far:100},gravity:[0,0,0]};
      const ir = {format:'pelican.scene',version:1,engineVersion:sdk.SDK_VERSION,gameId:'audio',scene,scenes:[],components:[],prefabs:[],materials:[],computes:[],systems:[{id:'control',phase:'update',source:{file:'game.ts',line:1,column:1,length:1}}],input:{},ui:[],assets:[{id:'a',type:'audio',path:url,metadata:{duration:4}}],audioBuses:[{id:'music',volume:.5},{id:'effects',volume:1}],sounds:[{id:'s',asset:'a',volume:1,loop:true,bus:'music'}]};
      const content = await prepareGameplay(ir,location.href,{getSize:v=>v.set(800,600)});
      const analyser = context.createAnalyser(); analyser.fftSize=1024; analyser.connect(context.destination);
      const connect = GainNode.prototype.connect;
      GainNode.prototype.connect = function(dest,...args) { return connect.call(this,dest===context.destination?analyser:dest,...args); };
      let command = () => {}, voice;
      const system = sdk.defineSystem({id:'control',run:ctx=>command(ctx.audio)});
      const game = sdk.defineGame({id:'audio',scene:sdk.defineScene({id:'s',entities:[]}),systems:[system],audioBuses:[{id:'music',volume:.5},{id:'effects'}],sounds:[{id:'s',asset:'a',bus:'music',loop:true}]});
      const host = new RuntimeHost(ir,{fixedDt:.01,plugins:[content.services.factory]});
      host.attach(sdk.instantiateGame(game,host.facade));
      const camera = new THREE.PerspectiveCamera(), objects = new Map();
      const action = fn => { command=fn; host.step(); command=()=>{}; content.present(camera,objects,.01,999); };
      const signal = async () => { await new Promise(r=>setTimeout(r,140)); const a=new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(a); return Math.max(...a.map(Math.abs)); };
      await context.resume();
      const createGain = context.createGain.bind(context); let calls=0, failed=false;
      context.createGain = () => { if (++calls===2) throw new Error('injected gain failure'); return createGain(); };
      try { action(a=>{voice=a.play('s')}); } catch (e) { failed=String(e).includes('injected gain failure'); }
      context.createGain = createGain;
      content.present(camera,objects,.01,999); let initial=await signal();
      for (let i=0; i<8 && initial<.01; i++) initial=await signal();
      action(a=>a.busVolume('music',.25)); const bus=await signal();
      action(a=>a.volume(.5)); const master=await signal();
      action(a=>a.pause(voice)); const paused=await signal();
      action(a=>a.resume(voice)); const resumed=await signal();
      action(a=>{a.stop(voice); voice=a.play('s',{bus:'effects'});}); const override=await signal();
      const saved=host.snapshot(); action(a=>a.busVolume('effects',0)); const muted=await signal();
      host.restore(saved); content.present(camera,objects,.01,999); const restored=await signal();
      action(a=>a.play('s'));
      action(a=>a.busVolume('effects',0)); const onlyMusic=await signal();
      action(a=>{a.busVolume('music',0);a.busVolume('effects',1);}); const onlyEffects=await signal();
      const inspection = JSON.stringify(content.inspect());
      host.dispose(); await content.dispose(); const closed=context.state; GainNode.prototype.connect=connect; URL.revokeObjectURL(url);
      return {initial,bus,master,paused,resumed,override,muted,restored,onlyMusic,onlyEffects,closed,failed,inspection};
    })()`) as Record<string, number | string>;
    const n = (key: string) => result[key] as number;
    assert.ok(n("initial") > .1, JSON.stringify(result));
    assert.ok(Math.abs(n("bus") / n("initial") - .5) < .08, JSON.stringify(result));
    assert.ok(Math.abs(n("master") / n("bus") - .5) < .08, JSON.stringify(result));
    assert.ok(n("paused") < .001 && n("muted") < .001, JSON.stringify(result));
    assert.ok(Math.abs(n("resumed") / n("master") - 1) < .08, JSON.stringify(result));
    assert.ok(Math.abs(n("override") / n("initial") - 1) < .08, JSON.stringify(result));
    assert.ok(Math.abs(n("restored") / n("override") - 1) < .08, JSON.stringify(result));
    assert.ok(Math.abs(n("onlyMusic") / n("master") - 1) < .08, JSON.stringify(result));
    assert.ok(Math.abs(n("onlyEffects") / n("override") - 1) < .08, JSON.stringify(result));
    assert.equal(result.closed, "closed");
    assert.equal(result.failed, true);
    assert.doesNotMatch(result.inspection as string, /AudioContext|GainNode|AudioBuffer/);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await server.close();
  }
});

test("audio pause uses real Chromium sources and fixed-tick offsets without GPU", { timeout: 60000 }, async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, fs: { strict: false } }, logLevel: "error" });
  const http = createHttpServer((req, res) => {
    if (req.url === "/__audio_blank") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><title>Audio test</title>");
    } else server.middlewares(req, res);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/__audio_blank`);
    const moduleResponse = await page.request.get(`http://127.0.0.1:${address.port}/packages/renderer/src/gameplay.ts`);
    assert.equal(moduleResponse.status(), 200, await moduleResponse.text());
    const result = await page.evaluate(`(async () => {
      const { prepareGameplay } = await import('/packages/renderer/src/gameplay.ts');
      const THREE = await import('/node_modules/three/build/three.webgpu.js');
      const NativeContext = window.AudioContext;
      let context;
      window.AudioContext = class extends NativeContext { constructor() { super(); context = this; } };
      const starts = [], stops = [];
      const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start = function(when, offset) { starts.push(offset); return start.call(this, when, offset); };
      AudioBufferSourceNode.prototype.stop = function(...args) { stops.push(true); return stop.apply(this, args); };
      const samples = 8000 * 4, bytes = new ArrayBuffer(44 + samples * 2), v = new DataView(bytes);
      const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
      text(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      text(36, 'data'); v.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * i / 8000) * 12000), true);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const scene = { id: 's', entities: [], environment: { background: '#000', ambientIntensity: 1 }, camera: { position: [0,0,1], target: [0,0,0], fov: 50, near: .1, far: 100 }, gravity: [0,0,0] };
      const ir = { gameId: 'audio', scene, scenes: [], prefabs: [], input: {}, ui: [], assets: [{ id: 'a', type: 'audio', path: url, metadata: { duration: 4 } }], sounds: [{ id: 's', asset: 'a', volume: 1, loop: false }] };
      const content = await prepareGameplay(ir, location.href, { getSize: (v) => v.set(800, 600) });
      const analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.connect(context.destination);
      const gainConnect = GainNode.prototype.connect;
      GainNode.prototype.connect = function(destination, ...args) {
        return gainConnect.call(this, destination === context.destination ? analyser : destination, ...args);
      };
      const signal = () => { const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values); return Math.max(...values.map(Math.abs)); };
      const plugin = content.services.factory({ scene: ir, events: () => [], world: { isAlive: () => false } });
      const api = plugin.services.audio, step = () => plugin.systems[0].run(.25);
      const camera = new THREE.PerspectiveCamera(), objects = new Map();
      const present = () => content.present(camera, objects, .01, 999);
      await context.suspend();
      const id = api.play('s'); step(); present();
      const lockedStarts = starts.length;
      await context.resume(); present();
      await new Promise(resolve => setTimeout(resolve, 150));
      const playingSignal = signal();
      api.pause(id); present();
      await new Promise(resolve => setTimeout(resolve, 150));
      const pausedSignal = signal();
      api.resume(id); present();
      await new Promise(resolve => setTimeout(resolve, 150));
      const resumedSignal = signal();
      api.pause(id); present();
      api.play('s', { loop: true }); present(); step(); step();
      const saved = plugin.snapshot();
      api.resume(id); present();
      plugin.restore(saved); present();
      step(); api.resume(id); present();
      const result = { starts, stops: stops.length, lockedStarts, audioDevice: content.inspect().audioDevice, playingSignal, pausedSignal, resumedSignal };
      await content.dispose();
      GainNode.prototype.connect = gainConnect;
      window.AudioContext = undefined;
      const unavailable = await prepareGameplay(ir, location.href, { getSize: (v) => v.set(800, 600) });
      const unavailablePlugin = unavailable.services.factory({ scene: ir, events: () => [], world: { isAlive: () => false } });
      const missingId = unavailablePlugin.services.audio.play('s');
      unavailablePlugin.services.audio.pause(missingId);
      unavailablePlugin.systems[0].run(.25);
      unavailablePlugin.services.audio.resume(missingId);
      result.unavailable = unavailable.inspect().audioDevice;
      result.unavailableVoices = unavailable.services.inspect().audio.voices.length;
      await unavailable.dispose(); URL.revokeObjectURL(url);
      return result;
    })()`) as { playingSignal: number; pausedSignal: number; resumedSignal: number } & Record<string, unknown>;
    const { playingSignal, pausedSignal, resumedSignal, ...rest } = result;
    assert.deepEqual(rest, { starts: [0.25, 0.25, 0, 0.25, 0.5, 0.25], stops: 4, lockedStarts: 0, audioDevice: "running", unavailable: "unavailable", unavailableVoices: 1 });
    assert.ok(playingSignal > 0.05, `Expected audible waveform, got ${playingSignal}`);
    assert.ok(pausedSignal < 0.001, `Expected silence after pause, got ${pausedSignal}`);
    assert.ok(resumedSignal > 0.05, `Expected waveform after resume, got ${resumedSignal}`);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await server.close();
  }
});
