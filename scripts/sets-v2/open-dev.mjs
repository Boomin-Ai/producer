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
if(!frontendReady&&check.status!==0){
 const logs=path.join(os.homedir(),'Library/Logs/ai.boomin.producer.sets-v2-dev');fs.mkdirSync(logs,{recursive:true});
 run('/bin/launchctl',['submit','-l',label,'-o',path.join(logs,'vite.log'),'-e',path.join(logs,'vite.log'),'--',process.execPath,path.join(root,'node_modules/vite/bin/vite.js'),root,'--host','127.0.0.1','--port','1436','--strictPort']);
}else if(!frontendReady){
 run('/bin/launchctl',['kickstart','-k',`gui/${process.getuid()}/${label}`]);
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
run('/usr/bin/open',[app]);
console.log('Native dev opened after frontend and workspace readiness checks.');
