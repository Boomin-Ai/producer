import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {arena} from './make-arena.mjs';
import {validateScene,validateControl} from './contract.mjs';
const require=createRequire(new URL('../../package.json',import.meta.url));
const {build}=require('esbuild');
const temporary=await mkdtemp(path.join(tmpdir(),'producer-scene3d-bundle-'));
const bundle=path.join(temporary,'renderer.js');
await build({entryPoints:[fileURLToPath(new URL('./renderer.mjs',import.meta.url))],bundle:true,format:'esm',outfile:bundle,minify:true,legalComments:'inline'});
const js=await readFile(bundle), token=randomBytes(24).toString('hex');
let state={revision:0,anchor:Date.now(),elapsed:0,paused:false,cue:'neutral'};
const telemetry={};const maxBody=32000;
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://127.0.0.1'),parts=url.pathname.split('/').filter(Boolean);
 if(parts.shift()!==token){res.writeHead(404);res.end();return;}
 const allowed=req.headers.origin===origin || req.headers.origin==='http://localhost:1436' || req.headers.origin==='http://127.0.0.1:1436';
 if(allowed&&req.headers.origin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
 if(req.method==='OPTIONS'&&allowed){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Content-Type'});res.end();return;}
 if(req.headers.origin && !allowed){json(res,{error:'Origin denied'},403);return;}
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'");
 const route=parts.at(-1),portrait=parts[0]==='portrait';
 if(req.method==='GET'&&route==='renderer.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
 if(req.method==='GET'&&route==='scene.json'){json(res,validateScene(arena(portrait)));return;}
 if(req.method==='GET'&&route==='control'){json(res,state);return;}
 if(req.method==='GET'&&route==='report'){json(res,{state,telemetry});return;}
 if(req.method==='POST'&&(route==='telemetry'||route==='control')){
  let body='',length=0;for await(const chunk of req){length+=chunk.length;if(length>maxBody){json(res,{error:'Too large'},413);return;}body+=chunk;}
  const value=JSON.parse(body);
  if(route==='control'){
   const elapsed=state.paused?state.elapsed:Date.now()-state.anchor;
   if(!['pause','resume','neutral','blue','gold'].includes(value.action)){json(res,{error:'Unknown cue'},400);return;}
   state=validateControl({...state,revision:state.revision+1,elapsed,anchor:Date.now()-elapsed,paused:value.action==='pause'?true:value.action==='resume'?false:state.paused,cue:['blue','gold','neutral'].includes(value.action)?value.action:state.cue});
   json(res,state);return;
  }
  if(!['background','foreground'].includes(value.pass)){json(res,{error:'Unknown pass'},400);return;}
  telemetry[`${portrait?'portrait':'landscape'}/${value.pass}`]={...value,receivedAt:Date.now()};json(res,{ok:true});return;
 }
 if(req.method==='GET'&&route==='view'){
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style></head><body><script type="module" src="./renderer.js"></script></body></html>');return;
 }
 res.writeHead(404);res.end();
 }catch(e){json(res,{error:String(e)},400);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,root=`${origin}/${token}`;
const manifest={pid:process.pid,origin,root,background:`${root}/landscape/view?pass=background`,foreground:`${root}/landscape/view?pass=foreground`,portraitBackground:`${root}/portrait/view?pass=background`,portraitForeground:`${root}/portrait/view?pass=foreground`,report:`${root}/report`,control:`${root}/control`};
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify(manifest));
async function close(){server.close();await rm(temporary,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
