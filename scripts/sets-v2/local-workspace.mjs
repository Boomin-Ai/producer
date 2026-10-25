// Starts the isolated, loopback-only workspace used by Sets v2 development.
// All credentials and durable data live outside the repository in the dev profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),profile=path.join(os.homedir(),'Library/Application Support/ai.boomin.producer.sets-v2-dev/local-workspace');
const envFile=path.join(profile,'workspace.env'),workspace=path.join(profile,'workspace.json');
if(!fs.existsSync(envFile)||!fs.existsSync(workspace))throw Error('Initialize the private Sets v2 local workspace before starting it.');
// launchd owns the dev service independently of an interactive tool session.
// The job is loaded for this login only; no login-startup plist is installed.
if(process.argv.includes('--background')){
 if(process.platform!=='darwin')throw Error('Background dev service currently requires macOS launchd.');
 const label='ai.boomin.producer.sets-v2-local-workspace',domain=`gui/${process.getuid()}`,job=`${domain}/${label}`;
 const check=spawnSync('/bin/launchctl',['print',job],{stdio:'ignore'});
 if(check.status!==0){
  const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const log=path.join(profile,'service.log'),plist=path.join(profile,'service.plist');
  fs.closeSync(fs.openSync(log,'a',0o600));fs.chmodSync(log,0o600);
  fs.writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(fileURLToPath(import.meta.url))}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH??'/opt/homebrew/bin:/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`,{mode:0o600});
  const launched=spawnSync('/bin/launchctl',['bootstrap',domain,plist],{stdio:'inherit'});if(launched.status!==0)throw Error('Could not start the local workspace service.');
 }
 console.log('Local Sets v2 workspace is managed by launchd for this login.');process.exit(0);
}
let config=fs.readFileSync(path.join(root,'server/wrangler.toml'),'utf8').replace('name = "producer-server"','name = "producer-sets-v2-local"').replace('main = "src/index.ts"',`main = ${JSON.stringify(path.join(root,'server/src/index.ts'))}`).replace('REPLACE_WITH_YOUR_D1_ID','11111111-2222-3333-4444-555555555555').replace('directory = "./public"',`directory = ${JSON.stringify(path.join(root,'server/public'))}`);
const configFile=path.join(profile,'wrangler.toml');fs.writeFileSync(configFile,config,{mode:0o600});
fs.copyFileSync(workspace,'/private/tmp/producer-sets-v2-local-workspace.json');fs.chmodSync('/private/tmp/producer-sets-v2-local-workspace.json',0o600);
const child=spawn(path.join(root,'server/node_modules/.bin/wrangler'),['dev','--local','--config',configFile,'--env-file',envFile,'--persist-to',path.join(profile,'worker-state'),'--ip','127.0.0.1','--port','8795','--inspector-port','9237','--log-level','warn','--show-interactive-dev-session','false'],{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??0));
