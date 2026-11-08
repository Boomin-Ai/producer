import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { handoff, validSignature, validatePacket } from './protocol.mjs';
import { Bridge } from './relay.mjs';
import { Listener } from './client.mjs';
import { resultFrom, safeText } from './github.mjs';

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
 const config={peer:'windows',repo:env.REPO,issues:[131],actors:['ikleveland'],stateDir:directory,workerCwd:directory,maxRunsPerHour:6};
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
