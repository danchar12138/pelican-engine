const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {fork,spawn}=require('node:child_process');
const root=__dirname;
async function main(){
 const server=fork(path.join(root,'static-server.cjs'),[],{cwd:path.dirname(root),windowsHide:true,silent:true});
 const output=fs.createWriteStream(path.join(root,'static-server.stdout.txt')),errors=fs.createWriteStream(path.join(root,'static-server.stderr.txt'));
 server.stdout.pipe(output);server.stderr.pipe(errors);
 const exit=new Promise(resolve=>server.on('exit',(code,signal)=>resolve({code,signal})));
 try{
  const end=Date.now()+15000;while(true){try{if((await fetch('http://127.0.0.1:4321/relay/')).ok)break;}catch{}if(Date.now()>end)throw Error('Static readiness timeout');await new Promise(r=>setTimeout(r,100));}
  const test=spawn(process.execPath,[path.join(root,'static-test.cjs')],{cwd:root,windowsHide:true});
  let stdout='',stderr='';test.stdout.on('data',d=>stdout+=d);test.stderr.on('data',d=>stderr+=d);
  const code=await new Promise(resolve=>test.on('exit',resolve));
  fs.writeFileSync(path.join(root,'managed-static-test.stdout.txt'),stdout);fs.writeFileSync(path.join(root,'managed-static-test.stderr.txt'),stderr);
  const entry={command:'node report/static-test.cjs',exitCode:code,cwd:path.dirname(root),stdout:'managed-static-test.stdout.txt',stderr:'managed-static-test.stderr.txt'};
  fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify(entry)+'\n');assert.equal(code,0,stderr);
 }finally{
  server.send('shutdown');const stopped=await exit;assert.equal(stopped.code,0);
  const entry={command:'node report/static-server.cjs',exitCode:stopped.code,cwd:path.dirname(root),stdout:'static-server.stdout.txt',stderr:'static-server.stderr.txt',shutdown:'IPC after static browser test completed; no HTTP control endpoints'};
  fs.writeFileSync(path.join(root,'static-server.command.json'),JSON.stringify(entry,null,2));fs.appendFileSync(path.join(root,'commands.jsonl'),JSON.stringify(entry)+'\n');
 }
 console.log(JSON.stringify({passed:true,staticServerClosed:true,browsersClosed:true,stdout:'static-server.stdout.txt',requests:'static-verification.json'}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
