import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const temporary=await mkdtemp(path.join(tmpdir(),'producer-scene3d-room-'));
const manifestFile=path.join(temporary,'manifest.json'),children=[];
let closing=false;
function start(args,env={}){const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});children.push(child);return child;}
async function close(code=0){if(closing)return;closing=true;for(const c of children)c.kill('SIGTERM');await rm(temporary,{recursive:true,force:true});process.exit(code);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
const server=start(['scripts/scene3d/serve.mjs',manifestFile]);server.on('exit',()=>{if(!closing)void close(1);});
let manifest;
for(let i=0;i<100;i++){try{manifest=JSON.parse(await readFile(manifestFile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,100));}}
if(!manifest){await close(1);}
manifest.recordProof=process.argv.includes('--record-proof');
const vite=start(['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1436','--strictPort'],{VITE_SCENE3D_PROOF:JSON.stringify(manifest)});
vite.on('exit',()=>{if(!closing)void close(1);});
if(!process.argv.includes('--no-open')){
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1436/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const app=process.env.PRODUCER_SCENE3D_DEV_APP||path.resolve(root,'../producer-sets-v2/src-tauri/target/sets-v2-dev/Producer Sets v2 Dev.app');
 try{await access(app);}catch{console.error('Isolated Sets v2 dev app not found. Set PRODUCER_SCENE3D_DEV_APP or use --no-open.');await close(1);}
 const args=['--env','PRODUCER_DEV_MODULE_CONFIG_DIR=/private/tmp/producer-grand-arena-module-config','-n','--env','PRODUCER_SETS_V2_UI_PROBE=1','--env','PRODUCER_SETS_V2_APPLY_PROBE=0','--env','PRODUCER_SETS_V2_INSPECT=1','--env','PRODUCER_SETS_V2_LOCAL_WORKSPACE=1','--env','PRODUCER_SETS_V2_MODULE_PROBE=0',app];
 spawn('open',args,{stdio:'inherit'});
}
console.log('3D proof uses the isolated Producer 3D GPU lab room. Exit prototype removes its sources. Ctrl-C stops the local render server.');
