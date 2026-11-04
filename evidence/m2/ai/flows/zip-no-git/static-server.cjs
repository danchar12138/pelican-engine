const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../deployment');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.glb':'model/gltf-binary','.wav':'audio/wav','.css':'text/css'};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const pathname=decodeURIComponent(url.pathname);
 const relative=pathname.endsWith('/')?pathname+'index.html':pathname;
 const file=path.resolve(root,'.'+relative);
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.stat(file,(err,stat)=>{
  if(err||!stat.isFile()){res.writeHead(404).end('Not found');console.log(JSON.stringify({url:req.url,status:404}));return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(file).pipe(res);console.log(JSON.stringify({url:req.url,status:200,bytes:stat.size}));
 });
});
server.listen(4321,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,root,pid:process.pid,engineImported:false})));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('message',message=>{if(message==='shutdown')server.close(()=>process.exit(0));});
