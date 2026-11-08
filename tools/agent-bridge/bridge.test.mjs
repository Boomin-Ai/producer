import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { handoff, validSignature, validatePacket } from './protocol.mjs';
import { Bridge } from './relay.mjs';
import { Listener } from './client.mjs';
import { resultFrom, safeText, trustedAcknowledgement } from './github.mjs';
import { Codex, workerEnvironment, workerSandbox, workerArguments, inspectWorkerTools, verifyWorkerSandbox } from './codex.mjs';
import { EventEmitter } from 'node:events';

const secret = 'test-only-credential-with-sufficient-entropy';
const env = { REPO:'Boomin-Ai/producer', ALLOWED_ISSUES:'131', ALLOWED_ACTORS:'ikleveland', WINDOWS_TOKEN:secret, MAC_TOKEN:'another-test-credential', GITHUB_WEBHOOK_SECRET:secret };
const sign = (body, key=secret) => 'sha256=' + createHmac('sha256',key).update(body).digest('hex');
const payload = (id=123) => ({action:'created', repository:{full_name:env.REPO}, issue:{number:131}, sender:{login:'ikleveland'}, comment:{id, user:{login:'ikleveland'}, created_at:new Date().toISOString(), body:'[BRIDGE TO WINDOWS]\nInspect the agreed Windows handoff.'}});
const packet = () => handoff(payload(),'issue_comment',env);

test('GitHub HMAC matches the official vector and rejects tampering, missing signatures and wrong secrets',async()=>{
 assert(await validSignature('Hello, World!','sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',"It's a Secret to Everybody"));
 assert(!await validSignature('changed',sign('original'),secret));
 assert(!await validSignature('original',null,secret));
 assert(!await validSignature('original',sign('original'),'wrong'));
 assert(await validSignature('Mac → Windows ✓',sign('Mac → Windows ✓'),secret));
});
test('routing accepts only explicit new allowlisted handoffs; progress, ACKs, edits, wrong actors/repos/issues and old replay cannot wake agents',()=>{
 assert.equal(packet().to,'windows');
 for (const body of ['[MAC] progress','[WINDOWS BRIDGE ACK] done','ordinary\n[BRIDGE TO WINDOWS]','[BRIDGE TO WINDOWS] trailing ambiguity']) {const p=payload();p.comment.body=body;assert.equal(handoff(p,'issue_comment',env),null);}
 for (const mutate of [p=>p.action='edited',p=>p.repository.full_name='other/repo',p=>p.issue.number=132,p=>p.sender.login='outsider',p=>p.comment.user.login='outsider',p=>p.comment.created_at='2000-01-01T00:00:00Z']) {const p=payload();mutate(p);assert.equal(handoff(p,'issue_comment',env),null);}
 const p=payload(); p.comment.body='[BRIDGE TO MAC]\r\nReady';assert.equal(handoff(p,'issue_comment',env).to,'mac');
});
test('client independently rejects forged route, URL, author and event identity',()=>{
 const config={repo:env.REPO,issues:[131],actors:['ikleveland']};
 assert(validatePacket(packet(),'windows',config));
 for(const change of [{to:'mac'},{url:'https://evil.example/'},{actor:'outsider'},{id:'github-999'}]) assert(!validatePacket({...packet(),...change},'windows',config));
});

class Storage {
 constructor(){this.values=new Map();this.serial=Promise.resolve();}
 async get(k){return structuredClone(this.values.get(k));}
 async put(k,v){this.values.set(k,structuredClone(v));}
 async delete(k){for(const key of Array.isArray(k)?k:[k])this.values.delete(key);}
 async list({prefix=''}={}){return new Map([...this.values].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,structuredClone(v)]));}
 async setAlarm(){}
 transaction(fn){const result=this.serial.then(()=>fn(this));this.serial=result.catch(()=>{});return result;}
}
function fixture(){
 globalThis.WebSocketRequestResponsePair=class {constructor(a,b){this.a=a;this.b=b;}};
 const sockets=[];const storage=new Storage();
 const ctx={storage,setWebSocketAutoResponse:()=>{},getWebSockets:peer=>sockets.filter(s=>!peer||s.peer===peer),acceptWebSocket:(ws,tags)=>{ws.peer=tags[0];sockets.push(ws);}};
 return {relay:new Bridge(ctx,env),storage,sockets};
}
function webhook(p, signature){const body=JSON.stringify(p);return new Request('https://relay.example/github',{method:'POST',headers:{'x-github-event':'issue_comment','x-hub-signature-256':signature??sign(body)},body});}
test('relay verifies signatures, deduplicates simultaneous deliveries and isolates ACKs by peer',async()=>{
 const {relay,storage,sockets}=fixture();
 assert.equal((await relay.fetch(webhook(payload(),'sha256='+'0'.repeat(64)))).status,401);
 const answers=await Promise.all([relay.fetch(webhook(payload())),relay.fetch(webhook(payload()))]);
 assert.deepEqual((await Promise.all(answers.map(r=>r.json()))).map(r=>r.result).sort(),['accepted','duplicate']);
 assert.equal((await storage.list({prefix:'event:'})).size,1);
 await relay.webSocketMessage({deserializeAttachment:()=>({peer:'mac'})},JSON.stringify({type:'ack',id:'github-123'}));
 assert.equal((await storage.get('event:windows:github-123')).acknowledgedAt,undefined);
 await relay.webSocketMessage({deserializeAttachment:()=>({peer:'windows'})},JSON.stringify({type:'ack',id:'github-123'}));
 assert((await storage.get('event:windows:github-123')).acknowledgedAt);
});
test('one-time WebSocket tickets require peer auth and preserve unacknowledged replay after reconnect',async()=>{
 const {relay,storage,sockets}=fixture();
 assert.equal((await relay.fetch(new Request('https://relay.example/ticket?peer=windows',{method:'POST'}))).status,401);
 const result=await relay.fetch(new Request('https://relay.example/ticket?peer=windows',{method:'POST',headers:{'x-peer-proof':sign('peer authentication')}}));
 assert.equal(result.status,200);const {ticket}=await result.json();
 await relay.fetch(webhook(payload()));
 const StandardResponse=globalThis.Response;
 globalThis.WebSocketPair=class {constructor(){this[0]={};this[1]={sent:[],send(value){this.sent.push(JSON.parse(value));},serializeAttachment(value){this.attachment=value;},close(){}};}};
 globalThis.Response=class extends StandardResponse {constructor(body,options){if(options?.status===101){super(null,{status:200});this.socket=options.webSocket;}else super(body,options);}};
 try{
  const request=()=>new Request(`https://relay.example/ws?ticket=${ticket}`,{headers:{upgrade:'websocket'}});
  await relay.fetch(request());
  assert.equal(sockets[0].sent.filter(e=>e.type==='handoff').length,1);
  assert.equal((await relay.fetch(request())).status,401);
  assert.equal((await storage.get('event:windows:github-123')).acknowledgedAt,undefined);
  const again=await relay.fetch(new Request('https://relay.example/ticket?peer=windows',{method:'POST',headers:{'x-peer-proof':sign('peer authentication')}}));
  const next=await again.json();
  await relay.fetch(new Request(`https://relay.example/ws?ticket=${next.ticket}`,{headers:{upgrade:'websocket'}}));
  assert.equal(sockets[1].sent.filter(e=>e.type==='handoff').length,1);
 }finally{globalThis.Response=StandardResponse;}
});

async function local(t){
 const directory=await mkdtemp(join(tmpdir(),'producer-bridge-test-'));
 t.after(async()=>{assert(resolve(directory).startsWith(resolve(tmpdir())+sep));assert(directory.includes('producer-bridge-test-'));await rm(directory,{recursive:true,force:true});});
 const stateDir=join(directory,'state'),workerCwd=join(directory,'worker');await mkdir(stateDir);await mkdir(join(workerCwd,'.git'),{recursive:true});
 const config={peer:'windows',repo:env.REPO,issues:[131],actors:['ikleveland'],stateDir,workerCwd,maxRunsPerHour:6};
 const listener=new Listener(config);listener.state={pending:[],completed:[],failed:[],runs:[]};
 return listener;
}
test('listener acknowledges only after durable storage and deduplicates pending, completed and failed events',async t=>{
 const l=await local(t);l.running=true;const messages=[];const ws={send:x=>messages.push(JSON.parse(x))};
 await l.receive(packet(),ws);await l.receive(packet(),ws);
 assert.equal(l.state.pending.length,1);assert.equal(messages.length,2);
 assert.equal(JSON.parse(await readFile(join(l.config.stateDir,'state.json'),'utf8')).pending[0].id,packet().id);
 l.state.pending=[];l.state.failed=[{packet:packet()}];await l.receive(packet(),ws);assert.equal(l.state.pending.length,0);
 const failed=await local(t);failed.running=true;failed.save=async()=>{throw new Error('disk full');};
 const acks=[];await assert.rejects(failed.receive(packet(),{send:m=>acks.push(m)}));assert.equal(acks.length,0);
});
test('one handoff wakes one worker turn; failed turns do not automatically retry or acknowledge success',async t=>{
 const l=await local(t);let runs=0;
 l.reference=async()=>({handoff:'test'});l.acknowledge=async()=>({url:'https://github.com/test-ack'});
 l.worker=async()=>({run:async()=>{runs++;return{turnId:'turn-1',report:JSON.stringify({status:'completed',summary:'verified',checks:[]})};}});
 l.state.pending=[packet()];await l.drain();await l.drain();
 assert.equal(runs,1);assert.deepEqual(l.state.completed,[packet().id]);assert.equal(l.state.lastCompleted.turnId,'turn-1');
 const failed=await local(t);let attempts=0;failed.reference=async()=>({handoff:'test'});failed.worker=async()=>({run:async()=>{attempts++;throw new Error('test failure');}});
 failed.state.pending=[packet()];await failed.drain();await failed.drain();
 assert.equal(attempts,1);assert.equal(failed.state.failed.length,1);assert.equal(failed.state.completed.length,0);
});
test('local PAUSED switch and hourly run budget prevent unintended wake loops',async t=>{
 const l=await local(t);l.state.pending=[packet()];l.worker=async()=>{throw new Error('must not start');};
 await writeFile(join(l.config.stateDir,'PAUSED'),'paused');await l.drain();assert.equal(l.state.pending.length,1);
 await rm(join(l.config.stateDir,'PAUSED'));l.state.runs=Array(6).fill(Date.now());await l.drain();assert.equal(l.state.pending.length,1);
});
test('completed inference is not task success: a blocked result posts one bounded ACK and remains failed for review',async t=>{
 const l=await local(t);let acks=0;
 l.reference=async()=>({handoff:'test'});l.acknowledge=async()=>{acks++;return{url:'https://github.com/ack'};};
 l.worker=async()=>({run:async()=>({turnId:'blocked-turn',report:JSON.stringify({status:'blocked',summary:'Needs agreed source ownership',checks:[]})})});
 l.state.pending=[packet()];await l.drain();await l.drain();
 assert.equal(acks,1);assert.equal(l.state.completed.length,0);assert.equal(l.state.failed.length,1);
 assert.equal(l.state.lastCompleted,undefined);
});
test('host broker bounds structured results and removes credential/invitation/link text before posting',()=>{
 assert.equal(resultFrom('{"status":"completed","summary":"ok","checks":[]}').status,'completed');
 assert.throws(()=>resultFrom('{"status":"completed","summary":"ok","checks":"unbounded"}'));
 assert.throws(()=>resultFrom(JSON.stringify({status:'completed',summary:'x'.repeat(2001),checks:[]})));
 const text=safeText('https://secret.example/gi_private ghp_abcdefghijklmnopqrstuvwxyz Bearer private gr_private');
 assert(!text.includes('secret.example'));assert(!text.includes('ghp_'));assert(!text.includes('gr_private'));assert(!text.includes('Bearer private'));
});
test('worker environment omits inherited provider secrets and process injection settings',()=>{
 const clean=workerEnvironment({PATH:'/safe/bin',HOME:'/home/operator',LANG:'en_US.UTF-8',GH_TOKEN:'private-gh',GITHUB_TOKEN:'private-gh2',CLOUDFLARE_API_TOKEN:'private-cf',AWS_SECRET_ACCESS_KEY:'private-aws',OPENAI_API_KEY:'private-model-key',NODE_OPTIONS:'--require=/private/injection.js',DYLD_INSERT_LIBRARIES:'/private/injection',OPENSSL_CONF:'/private/config'},'darwin');
 assert.deepEqual(clean,{PATH:'/safe/bin',HOME:'/home/operator',LANG:'en_US.UTF-8',OPENSSL_CONF:'/dev/null',NODE_OPTIONS:'--openssl-config=/dev/null'});
});
test('worker scope denies credential ancestors, private state, symlink aliases and shared Git metadata',async t=>{
 const l=await local(t),home=join(l.config.workerCwd,'..','operator');await mkdir(join(home,'.config','gh'),{recursive:true});
 const deps=join(home,'runtime');await mkdir(deps);
 const context={home,environment:{}};
 const scope=await workerSandbox({...l.config,workerReadableRoots:[deps]},context);
 assert.equal(scope.permissions,'producer_bridge');assert.equal(scope.profile.filesystem[':root'],'deny');assert.equal(scope.profile.filesystem[scope.cwd],'write');assert.equal(scope.profile.filesystem[await realpath(deps)],'read');assert.equal(scope.profile.network.enabled,false);assert.equal(scope.profile.extends,undefined);
 for(const root of [home,join(home,'.config'),join(home,'.config','gh'),l.config.stateDir])await assert.rejects(workerSandbox({...l.config,workerReadableRoots:[root]},context),/private host credentials/);
 const metadata=join(home,'repo','.git');await mkdir(join(metadata,'objects'),{recursive:true});await assert.rejects(workerSandbox({...l.config,workerReadableRoots:[metadata]},context),/Only shared Git objects/);
 assert.equal((await workerSandbox({...l.config,workerReadableRoots:[join(metadata,'objects')]},context)).profile.filesystem[await realpath(join(metadata,'objects'))],'read');
 const alias=join(home,'credential-alias');await symlink(join(home,'.config','gh'),alias,process.platform==='win32'?'junction':'dir');await assert.rejects(workerSandbox({...l.config,workerReadableRoots:[alias]},context),/private host credentials/);
 await writeFile(join(l.config.workerCwd,'.git-file'),'gitdir: elsewhere');await rm(join(l.config.workerCwd,'.git'),{recursive:true});await writeFile(join(l.config.workerCwd,'.git'),'gitdir: elsewhere');await assert.rejects(workerSandbox(l.config),/independent clone/);
});
test('every worker turn selects the named profile, never legacy sandbox fields or automatic approval',async t=>{
 const l=await local(t),execution=await workerSandbox(l.config),args=workerArguments(execution,['node_repl']);
 assert(args.includes('features.apps=false'));assert(args.includes('features.plugins=false'));assert.deepEqual(args.slice(args.indexOf('mcp_servers={}')+1,-2),['-c','mcp_servers.node_repl.enabled=false']);assert(!args.some(arg=>arg.includes('mcp_servers."')));assert(args.includes('default_permissions="producer_bridge"'));assert(!args.includes('--sandbox'));
 for(const name of ['node.repl','"node_repl"','node_repl.enabled','node repl','node_repl\n','x'.repeat(201)])assert.throws(()=>workerArguments(execution,[name]),/Invalid MCP server name/);
 const rpc=new EventEmitter();let sent;
 rpc.call=async(method,params)=>{assert.equal(method,'turn/start');sent=params;queueMicrotask(()=>{rpc.emit('notification',{method:'item/completed',params:{threadId:'thread',item:{type:'agentMessage',text:'{"status":"completed"}'}}});rpc.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});});return {turn:{id:'turn'}};};
 const result=await Codex.prototype.run.call(rpc,'thread','inspect only',1000,'test-model',undefined,execution);
 assert.equal(result.turnId,'turn');assert.equal(sent.permissions,'producer_bridge');assert.equal(sent.approvalPolicy,'never');assert.equal(sent.cwd,execution.cwd);assert.equal(sent.sandbox,undefined);assert.equal(sent.sandboxPolicy,undefined);
 await assert.rejects(Codex.prototype.run.call(rpc,'thread','unsafe',1000),/restricted named worker profile/);
});
test('unsupported or ignored permission profiles fail a non-secret canary before inference',async t=>{
 const l=await local(t),execution=await workerSandbox(l.config);let calls=0;
 const rpc={call:async(method,params)=>{calls++;assert.equal(method,'command/exec');assert.equal(params.permissionProfile,'producer_bridge');assert.equal(params.sandboxPolicy,undefined);return {exitCode:41,stdout:''};}};
 await assert.rejects(verifyWorkerSandbox(rpc,execution,l.config.stateDir),/probe failed/);assert.equal(calls,1);assert.deepEqual(await readdir(l.config.stateDir),[]);
 rpc.call=async()=>({exitCode:0,stdout:'restricted-worker-sandbox-verified'});await verifyWorkerSandbox(rpc,execution,l.config.stateDir);assert.deepEqual(await readdir(l.config.stateDir),[]);
});
test('worker tool configuration is checked, inherited MCP names require explicit disable, and enabled apps fail closed',async()=>{
 const config={features:{apps:false,plugins:false},web_search:'disabled',mcp_servers:{node_repl:{command:'not forwarded'},off:{enabled:false}}};
 const rpc={call:async()=>({config})};assert.deepEqual(await inspectWorkerTools(rpc),['node_repl']);config.mcp_servers.node_repl.enabled=false;assert.deepEqual(await inspectWorkerTools(rpc),[]);config.features.apps=true;await assert.rejects(inspectWorkerTools(rpc),/not explicitly disabled/);
});
test('only a trusted host author can satisfy public ACK deduplication',()=>{
 const config={peer:'mac',actors:['ikleveland']},event={id:'github-123'},body='[MAC BRIDGE ACK]\nEvent: github-123\nResult: completed';
 assert.equal(trustedAcknowledgement([{body,user:{login:'outsider'}}],config,event),undefined);
 const real={body,user:{login:'iKleveland'},html_url:'https://github.com/trusted'};
 assert.equal(trustedAcknowledgement([{body,user:{login:'outsider'}},real],config,event),real);
});
test('public results redact private key blocks, token assignments and bare peer credentials without losing commit SHA',()=>{
 const values=['private-mac','private-cf','private-camel','private-password','private-api', 'test-key-material'];
 const text=safeText('MAC_TOKEN=private-mac CLOUDFLARE_API_TOKEN="private-cf" apiKey:private-camel password=private-password "api_key":"private-api"\n-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-material\n-----END OPENSSH PRIVATE KEY-----\n'+ 'a'.repeat(64)+'\nCheckout: '+ 'b'.repeat(40));
 for(const value of values)assert(!text.includes(value));assert(!text.includes('a'.repeat(64)));assert(text.includes('b'.repeat(40)));
});
