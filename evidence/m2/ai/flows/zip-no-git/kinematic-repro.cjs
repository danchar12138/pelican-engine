const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync,spawn}=require('node:child_process');
const {chromium}=require('../threecat/node_modules/playwright');
const engine=path.resolve(__dirname,'../threecat');
const result={engineSourceSHA:'857f76bd1d85de6d0e05b8ce5b08a2009b7d74b5692f38dbda39ed76ca5d44a2',cases:[]};
async function test(kind,port){
 const project=path.join(engine,'games','contact-repro-'+kind);fs.mkdirSync(project,{recursive:true});
 const source=fs.readFileSync(path.join(__dirname,'kinematic-repro-game.ts'),'utf8').replace('type:"kinematic"','type:"'+kind+'"');
 fs.writeFileSync(path.join(project,'game.ts'),source);
 fs.writeFileSync(path.join(project,'threecat.project.json'),JSON.stringify({entry:'game.ts',engine:{path:'../..',version:'0.2.0-m2.0'}},null,2));
 const check=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','./threecat.ps1','check','--project',project],{cwd:engine,encoding:'utf8'});
 fs.writeFileSync(path.join(__dirname,'repro-'+kind+'-check.stdout.txt'),check.stdout);fs.writeFileSync(path.join(__dirname,'repro-'+kind+'-check.stderr.txt'),check.stderr);assert.equal(check.status,0);
 const out=fs.openSync(path.join(__dirname,'repro-'+kind+'-dev.stdout.txt'),'w'),err=fs.openSync(path.join(__dirname,'repro-'+kind+'-dev.stderr.txt'),'w');
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','./threecat.ps1','dev','--project',project,'--port',String(port)],{cwd:engine,windowsHide:true,stdio:['ignore',out,err]});
 let browser;
 try{
  const end=Date.now()+30000;while(true){try{if((await fetch('http://127.0.0.1:'+port)).ok)break;}catch{}if(Date.now()>end)throw Error('repro readiness timeout');await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:false,args:['--enable-unsafe-webgpu']});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+port+'/?automation=1');await page.waitForFunction(()=>!!window.__threecat?.command);
  async function cmd(c){const r=await page.evaluate(c=>window.__threecat.command(c),c);assert.equal(r.status,'succeeded');return r.data;}
  const initial=await cmd({type:'inspect'});assert.equal(initial.backend,'WebGPUBackend');assert.equal(initial.adapter.isFallbackAdapter,false);assert.equal(initial.compiledIR.scene.entities.find(e=>e.id==='gate').rigidBody.type,kind);
  await cmd({type:'step',count:30});await cmd({type:'input',key:'s',pressed:true});let d=await cmd({type:'step',count:100});const contact=d.game.transforms.player.position;
  await cmd({type:'input',key:'s',pressed:false});await cmd({type:'step',count:1});await cmd({type:'input',key:'w',pressed:true});d=await cmd({type:'step',count:100});
  const away=d.game.transforms.player.position;
  const row={kind,port,contact,away,input:d.gameplay.input,errors:d.errors,movedAway:contact[2]-away[2]>3,checkExitCode:check.status,adapter:initial.adapter,backend:initial.backend};
  fs.writeFileSync(path.join(__dirname,'repro-'+kind+'-state.json'),JSON.stringify(d,null,2));result.cases.push(row);console.log(JSON.stringify(row));
 }finally{if(browser)await browser.close();const kill=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{encoding:'utf8'});result.cases.at(-1).cleanup={exitCode:kill.status,stdout:kill.stdout,stderr:kill.stderr};fs.closeSync(out);fs.closeSync(err);}
}
(async()=>{try{await test('kinematic',4323);await test('fixed',4324);assert.equal(result.cases[1].movedAway,true);assert.equal(result.cases[0].movedAway,true,'Kinematic regression: character must retreat from gate');result.resolvedByEngine=true;result.kinematicMovedAway=true;console.log(JSON.stringify(result,null,2));}finally{fs.writeFileSync(path.join(__dirname,'kinematic-repro-result.json'),JSON.stringify(result,null,2));}})().catch(e=>{console.error(e);process.exitCode=1});
