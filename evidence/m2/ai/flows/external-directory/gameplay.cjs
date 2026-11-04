const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../candidate5/threecat/node_modules/playwright');
const root=__dirname,read=f=>JSON.parse(fs.readFileSync(p.join(root,f),'utf8').replace(/^\uFEFF/,''));
const save=(f,v)=>fs.writeFileSync(p.join(root,f),JSON.stringify(v,null,2));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const server=read('dev-server.json'),browser=await chromium.launch({headless:false,args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 const checkpoints=[],consoleLog=[],inputs=[];let page;
 try {
  const context=await browser.newContext({viewport:{width:1280,height:720}});page=await context.newPage();page.on('console',m=>consoleLog.push({type:m.type(),text:m.text()}));page.on('pageerror',e=>consoleLog.push({type:'pageerror',text:e.message}));
  const ready=async()=>{await page.waitForFunction(()=>typeof window.__threecat?.command==='function',null,{timeout:45000});};
  const cmd=async c=>{const r=await page.evaluate(c=>window.__threecat.command(c),c);assert.equal(r.status,'succeeded',JSON.stringify(r));return r.data;};
  const inspect=async(label)=>{const d=await cmd({type:'inspect',limit:100});assert.equal(d.ready,true);assert.deepEqual(d.errors,[]);assert.deepEqual(d.runtime.diagnostics,[]);assert.notEqual(d.playback.state,'faulted');if(label){checkpoints.push({label,data:d});save('gameplay-checkpoints.json',checkpoints);}return d;};
  const state=d=>d.game.components.dispatch.Dispatch;
  const body=(d,id)=>d.runtime.plugins.states['$engine.physics'].bodies.find(b=>b.id===id);
  const key=async(k,down)=>{inputs.push({key:k,pressed:down});await page.keyboard[down?'down':'up'](k);};
  const tap=async k=>{await key(k,true);await key(k,false);await cmd({type:'step',count:1});};
  await page.goto(server.url+'/?automation=1');await ready();
  let d=await inspect('initial');assert.equal(d.backend,'WebGPUBackend');assert.equal(d.adapter.isFallbackAdapter,false);assert.equal(body(d,'shipment').type,'dynamic');assert.equal(state(d).missions,0);
  const initialY=body(d,'shipment').position[1];await cmd({type:'step',count:20});d=await inspect('falling');assert.ok(body(d,'shipment').position[1]<initialY-0.15,'dynamic cargo must fall');assert.ok(body(d,'shipment').velocity[1]<-1,'gravity must cause velocity');
  await cmd({type:'step',count:70});d=await inspect('settled');assert.ok(body(d,'shipment').position[1]>0.4&&body(d,'shipment').position[1]<0.8,'floor contact');assert.equal(state(d).delivered,false);assert.ok(d.runtime.plugins.states['$engine.models'].templates.some(t=>t.id==='courier-fox'&&t.animations.includes('Walk')));
  await page.screenshot({path:p.join(root,'01-ready.png')});
  await tap('e');d=await inspect('attached');assert.equal(state(d).attached,true);
  await key('w',true);await cmd({type:'step',count:25});d=await inspect('transporting');assert.ok(body(d,'courier').position[2]<2);assert.ok(body(d,'shipment').position[2]<0.7,'cargo transported through velocity');assert.equal(state(d).completed,false);
  await page.screenshot({path:p.join(root,'02-transport.png')});
  for(let i=0;i<16&&!state(d).delivered;i++){await cmd({type:'step',count:10});d=await inspect();}
  await key('w',false);d=await inspect('delivered');assert.equal(state(d).delivered,true);assert.equal(state(d).attached,false);assert.equal(state(d).completed,false);assert.ok(d.game.transforms['exit-gate'].position[1]>4);assert.ok(Math.abs(body(d,'shipment').position[2]+5)<1.3);
  await page.screenshot({path:p.join(root,'03-open-gate.png')});
  await key('a',true);await cmd({type:'step',count:30});await key('a',false);await inspect('walk-around-cargo');
  await key('w',true);for(let i=0;i<22&&!state(d).completed;i++){await cmd({type:'step',count:10});d=await inspect();}await key('w',false);d=await inspect('finished');assert.equal(state(d).completed,true);assert.equal(state(d).missions,1);assert.equal(state(d).credits,1);await cmd({type:'step',count:20});assert.equal(state(await inspect()).missions,1,'completion once');
  await tap('e');d=await inspect('reward');assert.equal(state(d).express,true);assert.equal(state(d).credits,0);
  const beforeX=body(d,'courier').position[0];await key('a',true);await cmd({type:'step',count:12});await key('a',false);d=await inspect('express-movement');assert.ok(beforeX-body(d,'courier').position[0]>0.85,'reward increases movement');
  await page.getByRole('button',{name:'保存任务 [K]',exact:true}).click();await cmd({type:'step',count:2});
  for(let i=0;i<40;i++){d=await inspect();if(d.runtime.plugins.states['game-services'].storage.state==='saved')break;await pause(50);}
  assert.equal(d.runtime.plugins.states['game-services'].storage.state,'saved');const savedState=state(d),savedBox=body(d,'shipment').position,savedPlayer=body(d,'courier').position;save('saved-task.json',{state:savedState,box:savedBox,player:savedPlayer,storage:d.runtime.plugins.states['game-services'].storage});await inspect('saved');await page.screenshot({path:p.join(root,'04-saved.png')});
  const storage=await context.storageState();save('browser-storage-summary.json',{origins:storage.origins.map(o=>({origin:o.origin,localStorage:o.localStorage.map(v=>({name:v.name,bytes:v.value.length}))}))});
  await page.reload();await ready();d=await inspect('refresh-baseline');assert.equal(state(d).missions,0);assert.equal(state(d).completed,false);assert.equal(state(d).express,false);
  await page.getByRole('button',{name:'恢复任务 [L]',exact:true}).click();await cmd({type:'step',count:2});
  for(let i=0;i<50;i++){d=await inspect();if(d.runtime.plugins.states['game-services'].storage.state==='loaded')break;await pause(50);}
  assert.equal(d.runtime.plugins.states['game-services'].storage.state,'loaded');assert.deepEqual(state(d),savedState);assert.ok(Math.abs(body(d,'shipment').position[2]-savedBox[2])<0.15);assert.ok(Math.abs(body(d,'courier').position[0]-savedPlayer[0])<0.15);await inspect('refresh-restored');await page.screenshot({path:p.join(root,'05-refresh-restored.png')});
  await page.close();page=await context.newPage();await page.goto(server.url+'/?automation=1');await ready();d=await inspect('new-page-baseline');assert.equal(state(d).missions,0);await tap('l');for(let i=0;i<50;i++){d=await inspect();if(d.runtime.plugins.states['game-services'].storage.state==='loaded')break;await pause(50);}assert.deepEqual(state(d),savedState);await inspect('new-page-restored');
  assert.equal(consoleLog.filter(x=>x.type==='pageerror').length,0,JSON.stringify(consoleLog));
  save('gameplay-result.json',{passed:true,engine:'candidate5/threecat',backend:d.backend,adapter:d.adapter,actualKeyboardInput:true,actualUIButtonSaveLoad:true,physicsFall:true,physicalTransport:true,gateOpened:true,missions:state(d).missions,reward:true,refreshColdRestore:true,newPageColdRestore:true,checkpoints:checkpoints.map(x=>x.label)});console.log('PASS gravity, transport, gate, completion, express reward, save, refresh cold restore, fresh-page restore');
 }catch(e){if(page)await page.screenshot({path:p.join(root,'gameplay-failure.png')}).catch(()=>{});throw e;}finally{save('gameplay-console.json',consoleLog);save('gameplay-inputs.json',inputs);await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
