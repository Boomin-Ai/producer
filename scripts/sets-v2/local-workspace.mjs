// Starts the isolated, loopback-only workspace used by Sets v2 development.
// All credentials and durable data live outside the repository in the dev profile.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),profile=path.join(os.homedir(),'Library/Application Support/ai.boomin.producer.sets-v2-dev/local-workspace');
const envFile=path.join(profile,'workspace.env'),workspace=path.join(profile,'workspace.json');
if(!fs.existsSync(envFile)||!fs.existsSync(workspace))throw Error('Initialize the private Sets v2 local workspace before starting it.');
let config=fs.readFileSync(path.join(root,'server/wrangler.toml'),'utf8').replace('name = "producer-server"','name = "producer-sets-v2-local"').replace('main = "src/index.ts"',`main = ${JSON.stringify(path.join(root,'server/src/index.ts'))}`).replace('REPLACE_WITH_YOUR_D1_ID','11111111-2222-3333-4444-555555555555').replace('directory = "./public"',`directory = ${JSON.stringify(path.join(root,'server/public'))}`);
const configFile=path.join(profile,'wrangler.toml');fs.writeFileSync(configFile,config,{mode:0o600});
fs.copyFileSync(workspace,'/private/tmp/producer-sets-v2-local-workspace.json');fs.chmodSync('/private/tmp/producer-sets-v2-local-workspace.json',0o600);
const child=spawn(path.join(root,'server/node_modules/.bin/wrangler'),['dev','--local','--config',configFile,'--env-file',envFile,'--persist-to',path.join(profile,'worker-state'),'--ip','127.0.0.1','--port','8795','--inspector-port','9237','--log-level','warn','--show-interactive-dev-session','false'],{cwd:root,stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??0));
