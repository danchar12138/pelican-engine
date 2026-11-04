const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict');
const read=f=>JSON.parse(fs.readFileSync(p.join(__dirname,f),'utf8').replace(/^\uFEFF/,''));
(async()=>{const servers=[read('dev-server.json'),read('static-server.json')];for(const s of servers){let ready=false;for(let i=0;i<80;i++){try{const r=await fetch(s.url);if(r.status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(ready,true,'server ready '+s.url);}console.log(JSON.stringify({ready:true,servers},null,2));})().catch(e=>{console.error(e);process.exit(1);});
