// Start the isolated dev services before opening the native window.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const run=(command,args)=>{const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});if(result.status!==0)throw Error(`${command} failed`);};
if(process.platform!=='darwin')throw Error('This launcher requires the macOS native dev bundle.');
const app=path.join(root,'src-tauri/target/sets-v2-dev/Producer Sets v2 Dev.app');
if(!fs.existsSync(app))throw Error('Build and stage the native dev bundle first: npm run dev:sets-v2-room -- --prepare');
const label='ai.boomin.producer.sets-v2-vite';
const check=spawnSync('/bin/launchctl',['print',`gui/${process.getuid()}/${label}`],{stdio:'ignore'});
let frontendReady=false;
try{const response=await fetch('http://127.0.0.1:1436/',{signal:AbortSignal.timeout(1000)});frontendReady=response.ok;await response.body?.cancel();}catch{}
if(!frontendReady){
 const logs=path.join(os.homedir(),'Library/Logs/ai.boomin.producer.sets-v2-dev');fs.mkdirSync(logs,{recursive:true});
 const domain=`gui/${process.getuid()}`;
 if(check.status===0)run('/bin/launchctl',['bootout',`${domain}/${label}`]);
 const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const plist=path.join(logs,'vite.plist'),log=path.join(logs,'vite.log');
 // A working directory is required before Node resolves the nearest package.json.
 // Register for this login only, matching the isolated workspace service.
 fs.writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,path.join(root,'node_modules/vite/bin/vite.js'),root,'--host','127.0.0.1','--port','1436','--strictPort'].map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,{mode:0o600});
 run('/bin/launchctl',['bootstrap',domain,plist]);
}
run(process.execPath,['scripts/sets-v2/local-workspace.mjs','--background']);
async function ready(url,expected){
 for(let i=0;i<60;i++){
  try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});await response.body?.cancel();if(!expected||response.status===expected)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw Error(`Dev service is unavailable: ${url}. The app was not opened.`);
}
await Promise.all([ready('http://127.0.0.1:1436/',200),ready('http://127.0.0.1:8795/v1/session')]);
run('/usr/bin/open',['--env','PRODUCER_SETS_V2_LOCAL_WORKSPACE=1','--env',`PRODUCER_DEV_MODULE_CONFIG_DIR=${path.join(root,'src-tauri/target/sets-v2-dev/module-config')}`,app]);
console.log('Native dev opened after frontend and workspace readiness checks.');
