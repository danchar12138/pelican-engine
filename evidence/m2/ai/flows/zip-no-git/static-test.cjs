const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('../threecat/node_modules/playwright');
const requests=[],errors=[];let context,page;
const evidence={url:'http://127.0.0.1:4321/relay/',server:'independent Node static server',servedRoot:path.resolve(__dirname,'../deployment'),requests,errors};
async function launch(){
 context=await chromium.launchPersistentContext(path.resolve(__dirname,'../production-browser-profile'),{headless:false,viewport:{width:960,height:540},args:['--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 page=context.pages()[0];page.on('pageerror',e=>errors.push(String(e)));
 page.on('response',r=>requests.push({url:r.url(),status:r.status(),fromServiceWorker:r.fromServiceWorker()}));
 await page.goto(evidence.url,{waitUntil:'networkidle'});
 await page.getByText('01 / RESTORE THE THREE ENERGY CORES',{exact:true}).waitFor({timeout:60000});
 assert.equal(await page.evaluate(()=>typeof window.__threecat),'undefined');
 const gpu=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!a)return null;return{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter};});
 assert(gpu);assert.equal(gpu.isFallbackAdapter,false);assert(!/swiftshader|llvmpipe|software/i.test(JSON.stringify(gpu)));evidence.adapter=gpu;
}
async function hold(key,ms){await page.keyboard.down(key);await new Promise(r=>setTimeout(r,ms));await page.keyboard.up(key);await new Promise(r=>setTimeout(r,100));}
function findSnapshot(value){
 if(!value||typeof value!=='object')return null;
 if(value.transforms?.player && value.components?.player?.GridState)return value;
 for(const item of Object.values(value)){const result=findSnapshot(item);if(result)return result;}
 return null;
}
async function savedSummary(){
 const rows=await page.evaluate(()=>Object.entries(localStorage));
 for(const [key,text]of rows){
  let data;try{data=JSON.parse(text);}catch{continue;}
  if(data.format!=='threecat.save')continue;
  const records=data.runtime?.world?.entities,player=records?.find(r=>r.id==='player');
  if(player)return {key,format:data.format,bytes:Buffer.byteLength(text),sha256:crypto.createHash('sha256').update(text).digest('hex'),tick:data.runtime.scheduler.tick,player:player.transform,grid:player.components.GridState,west:records.find(r=>r.id==='core-west').components,rewards:records.filter(r=>r.components.Capacitor),models:data.runtime.plugins?.['$engine.models']?.payload?.animation};
 }
 evidence.storageStructure=rows.map(([key,text])=>({key,bytes:Buffer.byteLength(text),prefix:text.slice(0,1800)}));
 throw Error('No public serializable game snapshot found in browser storage');
}
(async()=>{try{
 await launch();evidence.productionControlAbsent=true;
 const ir=await (await fetch(evidence.url+'generated/scene.ir.json')).json();
 const gate=ir.scene.entities.find(e=>e.id==='exit-gate');assert.equal(gate.rigidBody.type,'kinematic');evidence.exitGateBody='kinematic';
 await page.screenshot({path:path.join(__dirname,'static-cold-start.png')});
 await hold('a',1300);await hold('w',1000);
 await page.getByText(/Hold E: restore core-west/).waitFor({timeout:10000});
 await page.keyboard.down('e');
 try{await page.getByText(/CORES\s+1\s*\/\s*3/).waitFor({timeout:20000});}finally{await page.keyboard.up('e');}
 await page.getByRole('button',{name:'SAVE',exact:true}).click();
 await page.getByText(/F5: save \/ F9: load.*saved/).waitFor({timeout:10000});
 evidence.saved=await savedSummary();assert.equal(evidence.saved.grid.restored,1);
 await page.screenshot({path:path.join(__dirname,'static-saved.png')});
 await context.close();context=null;
 await launch();await page.getByText(/CORES\s+0\s*\/\s*3/).waitFor();
 await page.keyboard.press('F9');await page.getByText(/CORES\s+1\s*\/\s*3/).waitFor({timeout:15000});
 await page.getByText(/F5: save \/ F9: load.*loaded/).waitFor({timeout:15000});
 evidence.restored=await savedSummary();assert.equal(evidence.restored.sha256,evidence.saved.sha256);
 await page.screenshot({path:path.join(__dirname,'static-cold-restored.png')});
 assert.equal((await fetch('http://127.0.0.1:4321/__threecat/control')).status,404);
 assert(requests.filter(r=>r.status>=400 && !r.url.includes('favicon')).length===0);
 assert(requests.some(r=>/fox.*\.glb/i.test(r.url)));
 assert(requests.every(r=>new URL(r.url).origin==='http://127.0.0.1:4321'));
 assert.deepEqual(errors,[]);
 evidence.passed=true;evidence.distColdStart=true;evidence.productionColdSaveRestore=true;evidence.nativeKeyboardRepair=true;
 console.log(JSON.stringify(evidence,null,2));
 }finally{if(context){evidence.lastDOM=await page.locator('body').innerText();await page.screenshot({path:path.join(__dirname,'static-last-frame.png')});await context.close();}fs.writeFileSync(path.join(__dirname,'static-verification.json'),JSON.stringify(evidence,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1;});
