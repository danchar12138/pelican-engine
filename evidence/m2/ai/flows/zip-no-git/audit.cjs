const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../threecat');
const excluded=['node_modules','.threecat','games','dist'];
function scan(dir,rel=''){
 const result={};for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  assert.notEqual(e.name,'.git','Git metadata forbidden');
  if(!rel&&excluded.includes(e.name))continue;
  const p=path.join(dir,e.name),r=path.posix.join(rel,e.name);
  if(e.isDirectory())Object.assign(result,scan(p,r));else result[r]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 }return result;
}
const mode=process.argv[2],files=scan(root),baseline=path.join(__dirname,'engine-before.json');
if(mode==='before'){assert(!fs.existsSync(baseline),'Do not overwrite baseline');fs.writeFileSync(baseline,JSON.stringify({root,excluded,files},null,2));}
else{fs.writeFileSync(path.join(__dirname,'engine-after.json'),JSON.stringify({root,excluded,files},null,2));assert.deepEqual(files,JSON.parse(fs.readFileSync(baseline,'utf8')).files,'Engine modified');}
console.log(JSON.stringify({mode,fileCount:Object.keys(files).length,engineFilesModified:false,noGit:true,excluded},null,2));
