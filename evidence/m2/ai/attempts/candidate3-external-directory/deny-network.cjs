const fs=require('node:fs'),p=require('node:path');
const denied=(kind,target)=>{const error=new Error('OFFLINE_NETWORK_DENIED '+kind+' '+String(target));fs.appendFileSync(p.join(__dirname,'offline-network-denials.txt'),error.message+'\n');throw error;};
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=(...args)=>denied(name+'.request',args[0]);mod.get=(...args)=>denied(name+'.get',args[0]);}
globalThis.fetch=(...args)=>Promise.reject(new Error('OFFLINE_NETWORK_DENIED fetch '+String(args[0])));
const net=require('node:net'),connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const options=Array.isArray(args[0])?args[0][0]:args[0];const pipe=typeof options==='object'?options?.path:typeof options==='string'?options:null;if(pipe&&pipe.startsWith('\\\\?\\pipe\\'))return connect.apply(this,args);return denied('socket.connect',JSON.stringify(args[0]));};
