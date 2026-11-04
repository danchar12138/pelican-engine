const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');const root=p.resolve(__dirname,'..');
const mode=process.argv[2];if(!['setup','check','build'].includes(mode))throw Error('mode must be setup/check/build');
const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',p.join(root,'candidate5/threecat/threecat.ps1'),mode,...(mode==='setup'?['--offline']:['--project',p.join(root,'外部游戏 空格')])];
const env={...process.env,npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',NODE_OPTIONS:'--require="'+p.join(__dirname,'deny-network.cjs').split(p.sep).join('/')+'"'};
console.log('OFFLINE '+mode+': all Node HTTP/HTTPS/fetch/socket operations denied; npm offline; loopback dead proxy');
const r=cp.spawnSync('powershell.exe',args,{cwd:root,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
