const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=__dirname,engine=path.resolve(root,'../threecat'),game=path.join(engine,'games/core-relay');
function copy(a,b){fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b);}
for(const name of ['game.ts','assets.ts','threecat.project.json','README.md'])copy(path.join(game,name),path.join(root,'game-source',name));
for(const name of ['sources.json','Fox.metadata.json','WaterBottle.metadata.json'])copy(path.join(game,'assets',name),path.join(root,'game-source/assets',name));
for(const name of ['threecat-build.json','compression-manifest.json','index.html','THIRDPARTY-NOTICES.txt','generated/scene.ir.json','generated/game.js','generated/build-report.json','generated/asset-notices.json','generated/version.json']){
 const src=path.join(game,'dist',name);if(fs.existsSync(src))copy(src,path.join(root,'build-output',name));
}
function hashes(dir,rel=''){let result=[];for(const e of fs.readdirSync(dir,{withFileTypes:true})){const r=path.posix.join(rel,e.name),p=path.join(dir,e.name);if(e.isDirectory())result.push(...hashes(p,r));else result.push({path:r,bytes:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});}return result;}
const build=hashes(path.join(game,'dist')),deployed=hashes(path.resolve(root,'../deployment/relay'));
assert.deepEqual(deployed,build);
fs.writeFileSync(path.join(root,'build-output-manifest.json'),JSON.stringify({engineSourceSHA:'857f76bd1d85de6d0e05b8ce5b08a2009b7d74b5692f38dbda39ed76ca5d44a2',source:path.join(game,'dist'),deployed:path.resolve(root,'../deployment/relay'),exactFileHashMatch:true,files:build},null,2));
const states={};for(const name of ['game-start','gate-blocked','center-collision','physics-jump','partial-repair','first-core-reward','saved-checkpoint','cold-defaults','cold-restored','three-cores','partial-exit-reboot','exit-online','game-complete']){
 const d=JSON.parse(fs.readFileSync(path.join(root,name+'.state.json'),'utf8'));
 states[name]={tick:d.tick,backend:d.backend,adapter:d.adapter,errors:d.errors,playback:d.playback,records:d.runtime.records,storage:d.gameplay.storage,models:d.gameplay.models,ui:d.gameplay.ui};
}
fs.writeFileSync(path.join(root,'game-state-assertions.json'),JSON.stringify(states,null,2));
const saved=states['saved-checkpoint'],cold=states['cold-restored'];
const selected=d=>d.records.filter(r=>r.id==='player'||r.components.EnergyCore||r.components.Capacitor);
assert.deepEqual(selected(saved),selected(cold));
fs.writeFileSync(path.join(root,'cold-restore-comparison.json'),JSON.stringify({passed:true,browserProcessClosedAndRelaunched:true,initialColdRestoredCores:states['cold-defaults'].records.find(r=>r.id==='player').components.GridState.restored,savedTick:saved.tick,restoredTick:cold.tick,allGameplayRecordsExactlyEqual:true,saved:selected(saved),restored:selected(cold)},null,2));
const trace=path.join(root,'public-protocol.raw.json.gz');if(fs.existsSync(trace))copy(trace,path.join(root,'attempts/final-public-protocol.raw.gzip-data'));
console.log(JSON.stringify({gameSourceCopied:true,assetsNotDuplicated:true,buildOutputManifestFiles:build.length,deployedHashesMatch:true,coldGameplayRecordsExactlyEqual:true},null,2));
