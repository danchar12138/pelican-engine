const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const {chromium}=require('../threecat/node_modules/playwright');
const root=__dirname;
const commands=[];
let context,page;
const errors=[];
async function launch(){
 context=await chromium.launchPersistentContext(path.resolve(root,'../browser-profile'),{headless:false,viewport:{width:960,height:540},args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 page=context.pages()[0];
 page.on('pageerror',e=>errors.push(String(e)));
 const deadline=Date.now()+60000;
 while(true){try{const response=await fetch('http://127.0.0.1:4319/');if(response.ok)break;}catch{}if(Date.now()>deadline)throw Error('Dev server readiness deadline');await new Promise(r=>setTimeout(r,100));}
 await page.goto('http://127.0.0.1:4319/?automation=1');
 await page.waitForFunction(()=>typeof window.__threecat?.command==='function',null,{timeout:60000});
 let d; const end=Date.now()+60000;
 do {d=await cmd({type:'inspect'}); if(d.ready) return d; await new Promise(r=>setTimeout(r,50));} while(Date.now()<end);
 throw Error('GPU initialization timed out');
}
async function cmd(command){
 const result=await page.evaluate(c=>window.__threecat.command(c),command);
 commands.push({time:new Date().toISOString(),command,result});
 assert.equal(result.status,'succeeded',JSON.stringify(result.diagnostics));
 if(result.data?.errors) assert.deepEqual(result.data.errors,[]);
 return result.data;
}
async function inspect(){return cmd({type:'inspect'});}
async function step(count){return cmd({type:'step',count});}
async function key(key,pressed){await cmd({type:'input',key,pressed});}
async function hold(keyName,count){await key(keyName,true);let d=await step(count);await key(keyName,false);await step(1);return d;}
function grid(d){return d.game.components.player.GridState;}
function pos(d){return d.game.transforms.player.position;}
async function go(x,z){
 for(const [axis,target,neg,positive] of [[0,x,'a','d'],[2,z,'w','s']]){
  for(let i=0;i<6;i++){
   const d=await inspect(),delta=target-pos(d)[axis];
   if(Math.abs(delta)<0.14) break;
   await hold(delta<0?neg:positive,Math.max(1,Math.min(120,Math.round(Math.abs(delta)*60/grid(d).speed))));
  }
  const d=await inspect(); assert(Math.abs(pos(d)[axis]-target)<0.25,'Could not reach waypoint '+[x,z]+' actual '+pos(d));
 }
}
async function evidence(name){
 const d=await inspect();
 fs.writeFileSync(path.join(root,name+'.state.json'),JSON.stringify(d,null,2));
 await page.screenshot({path:path.join(root,name+'.png')});
 console.log(name,JSON.stringify({tick:d.tick,position:pos(d),grid:grid(d),storage:d.gameplay.storage}));
 return d;
}
async function snapshot(name){const d=await cmd({type:'snapshot'});fs.writeFileSync(path.join(root,name+'.snapshot.json'),JSON.stringify(d,null,2));return d;}
(async()=>{
 try {
  let d=await launch();
  assert.equal(d.backend,'WebGPUBackend');assert.equal(d.adapter.isFallbackAdapter,false);assert(!/swiftshader|llvmpipe|software/i.test(d.adapter.vendor+' '+d.adapter.architecture));
  assert.equal(d.compiledIR.gameId,'three-core-relay');
  assert.equal(d.compiledIR.scene.entities.find(e=>e.id==='exit-gate').rigidBody.type,'kinematic','Final gate must be kinematic');
  await step(30);await evidence('game-start');
  await key('a',true);await step(10);
  const moving=await cmd({type:'snapshot'});
  const animation=moving.runtime.plugins['$engine.models'].payload.animation;
  assert.equal(animation.animations[0].currentClip,'Run');
  assert(animation.animations[0].actions.some(a=>a.clip==='Run' && a.playing && a.time>0));
  fs.writeFileSync(path.join(root,'running-animation.json'),JSON.stringify(animation,null,2));
  await page.screenshot({path:path.join(root,'running-animation.png')});
  await key('a',false);await step(1);await go(0,4);
  await hold('s',100);d=await evidence('gate-blocked');assert(pos(d)[2]<6.6);assert.equal(grid(d).exitOnline,false);
  const contactPosition=pos(d);
  await hold('e',120);d=await inspect();assert.equal(grid(d).restored,0);assert.equal(grid(d).restart,0);
  await hold('w',120);d=await evidence('center-collision');assert(pos(d)[2]>0.3,'Center block failed to collide');
  assert(contactPosition[2]-pos(d)[2]>3,'Character must move away from kinematic gate after contact');
  fs.writeFileSync(path.join(root,'game-kinematic-retreat.json'),JSON.stringify({passed:true,gateBody:'kinematic',contact:contactPosition,away:pos(d),movedAway:true,resolvedByEngine:true},null,2));
  await go(-5,0);const ground=pos(await inspect())[1];
  await key(' ',true);await step(12);await key(' ',false);d=await evidence('physics-jump');assert(pos(d)[1]>ground+0.5);await step(100);
  await hold('e',30);d=await evidence('partial-repair');assert(d.game.components['core-west'].EnergyCore.charge>0.3);assert.equal(grid(d).restored,0);
  await hold('e',60);d=await evidence('first-core-reward');assert.equal(grid(d).restored,1);assert.equal(grid(d).speed,4);assert(d.game.transforms['reward-core-west']);
  await step(120);d=await inspect();assert(d.game.transforms['reward-core-west'].position[1]<0.5,'Reward rigid body did not fall onto floor');
  await go(-5,-6);await go(0,-6);await hold('e',30);
  await hold('F5',1);
  for(let i=0;i<50;i++){d=await inspect();if(d.gameplay.storage.state==='saved')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(d.gameplay.storage.state,'saved');
  const saved=await evidence('saved-checkpoint');await snapshot('saved-checkpoint');
  await context.close();context=null;
  d=await launch();assert.equal(grid(d).restored,0,'Cold world did not begin at defaults');await evidence('cold-defaults');
  await hold('F9',1);
  for(let i=0;i<50;i++){d=await inspect();if(d.gameplay.storage.state==='loaded')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(d.gameplay.storage.state,'loaded');assert.deepEqual(grid(d),grid(saved));
  assert.deepEqual(d.game.components['core-north'],saved.game.components['core-north']);
  assert(d.game.transforms['reward-core-west']);assert(Math.abs(pos(d)[0]-pos(saved)[0])<0.02);
  await evidence('cold-restored');
  await hold('e',60);d=await inspect();assert.equal(grid(d).restored,2);
  await go(5,-6);await go(5,0);await hold('e',85);d=await evidence('three-cores');assert.equal(grid(d).restored,3);assert.equal(grid(d).exitOnline,false);
  assert.equal(d.runtime.records.filter(r=>r.components.Capacitor).length,3);
  await go(5,5.3);await go(0,5.3);await hold('e',30);d=await evidence('partial-exit-reboot');assert(grid(d).restart>0.25);assert.equal(grid(d).exitOnline,false);
  await hold('e',90);await step(90);d=await evidence('exit-online');assert.equal(grid(d).exitOnline,true);assert.equal(grid(d).gateHeight,4.5);assert.equal(d.game.transforms['exit-gate'].position[1],4.5);
  await hold('s',70);d=await evidence('game-complete');assert.equal(grid(d).escaped,true);
  const finalSnapshot=await snapshot('game-complete');
  assert.equal(d.gameplay.models.instances,1);assert.equal(d.gameplay.models.playing,1);assert(d.gameplay.models.owned.skeletons>0);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'gameplay-verification.json'),JSON.stringify({passed:true,gameplayChanged:true,gpuRendered:true,saveBrowserColdStart:true,earlyExitBlocked:true,centerCollision:true,jump:true,partialRepair:true,runtimePrefabRewards:3,dynamicRewardsFall:true,speedReward:true,rebootRequired:true,physicalGate:true,escaped:true,modelAnimation:true,adapter:d.adapter,backend:d.backend,browserCache:chromium.executablePath(),errors},null,2));
 }finally{
  if(context)await context.close();
  fs.writeFileSync(path.join(root,'public-protocol.raw.json.gz'),zlib.gzipSync(JSON.stringify(commands)));
  fs.writeFileSync(path.join(root,'browser-errors.json'),JSON.stringify(errors,null,2));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
