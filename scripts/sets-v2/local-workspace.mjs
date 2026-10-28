// Starts the isolated, loopback-only workspace used by Sets v2 development.
// All credentials and durable data live outside the repository in the dev profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {parseEnv} from 'node:util';
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
// Review sessions run a fixed bundle. Wrangler's live esbuild watcher can
// restart the local service while the desktop is issuing module commands.
// Build once on service startup; source edits require an explicit restart.
const buildDirectory=path.join(profile,'build');fs.mkdirSync(buildDirectory,{recursive:true});
const workerBundle=path.join(buildDirectory,'worker.mjs');
const {buildSync}=createRequire(path.join(root,'package.json'))('esbuild');
buildSync({entryPoints:[path.join(root,'server/src/index.ts')],outfile:workerBundle,bundle:true,format:'esm',platform:'browser',target:'es2022'});
// Use the same Workers runtime and persistent namespace identities directly.
// This local review service has no watcher, inspector proxy, or rebuild loop.
fs.copyFileSync(workspace,'/private/tmp/producer-sets-v2-local-workspace.json');fs.chmodSync('/private/tmp/producer-sets-v2-local-workspace.json',0o600);
const {Miniflare,convertV4MiniflareOptions}=createRequire(path.join(root,'server/package.json'))('miniflare');
const runtime=new Miniflare(convertV4MiniflareOptions({
 name:'producer-sets-v2-local',rootPath:buildDirectory,modules:true,scriptPath:workerBundle,
 compatibilityDate:'2026-08-01',host:'127.0.0.1',port:8795,cf:false,logRequests:false,
 resourcePersistencePath:path.join(profile,'worker-state/v3'),
 isolatedResourcePersistencePath:path.join(profile,'worker-state/v3'),
 bindings:{INSTAGRAM_APP_ID:'',FACEBOOK_APP_ID:'',THREADS_APP_ID:'',...parseEnv(fs.readFileSync(envFile,'utf8'))},
 d1Databases:{DB:'11111111-2222-3333-4444-555555555555'},r2Buckets:{MEDIA:'producer-media'},
 durableObjects:{REALTIME:{className:'RealtimeHub',useSQLite:true},ROOMSTATE:{className:'RoomState',useSQLite:true}},
 assets:{directory:path.join(root,'server/public'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}},
 telemetry:{enabled:false},
}));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await runtime.dispose();process.exit(0);});
await runtime.ready;
console.log('Local Sets v2 fixed-bundle runtime ready on 127.0.0.1:8795');
