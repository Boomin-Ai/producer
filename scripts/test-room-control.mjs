import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../src/lib/roomControl.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
const {RoomControlLink}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
let timerId=0;
const timers=new Map();
const delays=new Map();
globalThis.window={setTimeout:(fn,ms)=>{timers.set(++timerId,fn);delays.set(timerId,ms);return timerId;},setInterval:(fn,ms)=>{timers.set(++timerId,fn);delays.set(timerId,ms);return timerId;},clearTimeout:id=>{timers.delete(id);delays.delete(id);},clearInterval:id=>{timers.delete(id);delays.delete(id);}};
const sockets=[];
globalThis.WebSocket=class {
  static OPEN=1;
  readyState=1;
  sent=[];
  constructor(){sockets.push(this);}
  send(frame){this.sent.push(JSON.parse(frame));}
  close(){this.readyState=3;}
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const session={signaling_ticket:'test',signaling_url:'/room?ticket=test'};
let resolveOld;
let calls=0;
const frames=[];
let opened=0,closed=0;
const link=new RoomControlLink({origin:'https://room.test',session:()=>++calls===1?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve(session),onFrame:frame=>frames.push(frame),onOpen:()=>opened++,onClose:()=>closed++,renewAfterMs:105000});
link.start();link.stop();link.start();await tick();
resolveOld(session);await tick();
assert.equal(sockets.length,1,'A stopped pending ticket must not open a second publisher');
const old=sockets[0];old.onopen();assert.equal(opened,1);
link.start();await tick();assert.equal(sockets.length,1,'Starting an open link must be idempotent');
link.stop();link.start();await tick();
const current=sockets[1];current.onopen();
const currentTimers=[...timers.keys()];
old.onclose();old.onmessage({data:JSON.stringify({type:'error',code:'publisher_busy'})});
assert.equal(closed,0,'A stale socket close must not notify or retry');
assert.deepEqual(frames,[],'A stale socket must not surface old publisher errors');
assert.deepEqual([...timers.keys()],currentTimers,'Old cleanup must preserve current renewal and heartbeat');
assert.equal(link.send({type:'ping'}),true);
assert.deepEqual(current.sent.at(-1),{type:'ping'});
link.stop();assert.equal(timers.size,0);
console.log('PASS: stopped ticket requests and stale socket callbacks cannot create publishers or disrupt a replacement connection.');

const runTimer=async(ms)=>{
  const id=[...timers.keys()].find(id=>delays.get(id)===ms);
  assert.ok(id,`Expected timer at ${ms} ms`);
  const callback=timers.get(id);timers.delete(id);delays.delete(id);
  await callback();await tick();
};
let ticketCalls=0;
const renewed=new RoomControlLink({origin:'https://room.test',session:async()=>{ticketCalls++;return session;},onFrame:()=>{},renewAfterMs:105000});
renewed.start();await tick();
const publisher=sockets.at(-1);publisher.onopen();
for(let renewal=0;renewal<3;renewal++){
  await runTimer(105000);
  const refresh=publisher.sent.at(-1);
  assert.equal(refresh.type,'auth.refresh');
  const expiryId=[...timers.keys()].find(id=>delays.get(id)===6000);
  const staleExpiry=timers.get(expiryId);
  publisher.onmessage({data:JSON.stringify({type:'room.authorized',request_id:refresh.request_id})});
  staleExpiry();
  assert.equal(publisher.readyState,1,'Successful renewal must preserve the same publisher socket');
  assert.equal([...delays.values()].filter(ms=>ms===6000).length,0,'Acknowledged renewal must clear its expiry timer');
}
assert.equal(ticketCalls,4);
const oldRenewal=timers.get([...timers.keys()].find(id=>delays.get(id)===105000));
renewed.stop();renewed.start();await tick();const nextRenewalSocket=sockets.at(-1);nextRenewalSocket.onopen();
await oldRenewal();assert.equal(ticketCalls,5,'A canceled renewal cannot mint another ticket in a replacement generation');
renewed.stop();assert.equal(timers.size,0);
console.log('PASS: three acknowledged permission renewals preserve the publisher connection and cancel each renewal timeout.');

// A socket can reach OPEN before its open event is dispatched. Source updates
// from React/IPC must not get ahead of the host's scene registration, including
// on reconnect. Keep only the latest complete source catalog while waiting.
const startup=new RoomControlLink({origin:'https://room.test',session:async()=>session,onFrame:()=>{},onOpen:()=>startup.publishScenes([{id:'one',name:'One'}],'one')});
startup.start();await tick();
const firstPublisher=sockets.at(-1);
startup.publishSources([],['old'],[]);
startup.publishSources([],['latest'],[]);
assert.deepEqual(firstPublisher.sent,[],'Source truth must wait for publisher registration even when the transport is OPEN');
firstPublisher.onopen();
assert.deepEqual(firstPublisher.sent.map(frame=>frame.type),['scene.publish','room.sources.publish']);
assert.deepEqual(firstPublisher.sent.at(-1).participants,['latest']);
firstPublisher.readyState=3;firstPublisher.onclose();await runTimer(1000);
const replacement=sockets.at(-1);
startup.publishSources([],['reconnected'],[]);
assert.deepEqual(replacement.sent,[],'Replacement sockets must register before publishing sources');
replacement.onopen();
assert.deepEqual(replacement.sent.map(frame=>frame.type),['scene.publish','room.sources.publish']);
replacement.readyState=0;startup.publishSources([],['discard'],[]);
startup.stop();startup.start();await tick();
const restarted=sockets.at(-1);restarted.onopen();
assert.deepEqual(restarted.sent.map(frame=>frame.type),['scene.publish'],'Stopped sessions must discard queued source catalogs');
startup.stop();assert.equal(timers.size,0);
console.log('PASS: startup and reconnect publish scenes before the latest source catalog; stopped sessions discard queued work.');

const protocolSession={...session,role:'host',publisher_protocol:1};
const emit=(socket,frame)=>socket.onmessage({data:JSON.stringify(frame)});
const publications=socket=>socket.sent.filter(frame=>frame.type==='scene.publish');
const acknowledge=(socket,request=publications(socket).at(-1).request_id,epoch=1)=>emit(socket,{type:'scene.published',publisher_protocol:1,request_id:request,epoch,sequence:0});

const received=[],states=[];
const hosted=new RoomControlLink({origin:'https://room.test',session:async()=>protocolSession,onFrame:f=>received.push(f),onPublisherState:s=>states.push(s),onOpen:()=>hosted.publishScenes([{id:'one',name:'One'}],'one')});
hosted.start();await tick();const hostedSocket=sockets.at(-1);hostedSocket.onopen();
hosted.publishScenes([{id:'one',name:'One'}],'one');
assert.equal(publications(hostedSocket).length,1,'An unchanged directory must not duplicate an outstanding registration');
hosted.publishSources([],['old'],[]);hosted.publishSources([],['latest'],[]);
hosted.send({type:'audience.configure',enabled:false});hosted.send({type:'audience.configure',enabled:true});
hosted.send({type:'set.presented',receipt:{output:'program',revision:1}});
hosted.send({type:'set.presented',receipt:{output:'program',revision:2}});
hosted.send({type:'set.presented',receipt:{output:'portrait',revision:3}});
assert.equal(hosted.send({type:'audience.signal',to:'old',payload:{}}),false,'Media signals cannot queue across ownership claims');
hosted.acknowledge('old-command','applied');
assert.deepEqual(hostedSocket.sent.map(f=>f.type),['scene.publish']);
const firstRequest=publications(hostedSocket)[0].request_id;
for(const frame of [
  {type:'scene.state',scenes:[],epoch:99},
  {type:'scene.published',publisher_protocol:1,epoch:1,sequence:0},
  {type:'scene.published',publisher_protocol:1,request_id:crypto.randomUUID(),epoch:1,sequence:0},
  {type:'scene.published',publisher_protocol:2,request_id:firstRequest,epoch:1,sequence:0},
  {type:'scene.published',publisher_protocol:1,request_id:firstRequest,epoch:0,sequence:0},
  {type:'scene.published',publisher_protocol:1,request_id:firstRequest,epoch:1,sequence:-1},
])emit(hostedSocket,frame);
assert.equal(hosted.publisherReady,false,'A snapshot, foreign receipt, or malformed receipt cannot grant ownership');
assert.equal(hostedSocket.sent.length,1);
acknowledge(hostedSocket);
assert.equal(hosted.publisherReady,true);
assert.equal(hosted.publisherEpoch,1);
assert.deepEqual(hostedSocket.sent.map(f=>f.type),['scene.publish','room.sources.publish','audience.configure','set.presented','set.presented']);
assert.deepEqual(hostedSocket.sent[1].participants,['latest']);
assert.equal(hostedSocket.sent[2].enabled,true);
assert.deepEqual(hostedSocket.sent.slice(3).map(f=>[f.receipt.output,f.receipt.revision]),[['program',2],['portrait',3]]);
assert.deepEqual(states.at(-1),{phase:'ready',confirmed:true});
assert.equal(received.filter(f=>f.type==='scene.published').length,1,'Only a correlated receipt reaches the view');
hostedSocket.readyState=3;hostedSocket.onclose();await runTimer(1000);
const hostedReplacement=sockets.at(-1);hostedReplacement.onopen();
assert.deepEqual(hostedReplacement.sent.map(f=>f.type),['scene.publish']);
acknowledge(hostedSocket,firstRequest);
assert.equal(hosted.publisherReady,false,'A retired socket cannot acknowledge its replacement');
acknowledge(hostedReplacement,undefined,2);
assert.equal(hosted.publisherEpoch,2,'A replacement takes only its own acknowledged epoch');
assert.deepEqual(hostedReplacement.sent.slice(1).map(f=>f.type),['room.sources.publish','audience.configure','set.presented','set.presented']);
hosted.stop();assert.equal(timers.size,0);
console.log('PASS: negotiated ownership requires the current request receipt; catalogs, audience and both output receipts coalesce and replay after reconnect.');

const recoveryStates=[];
const recovery=new RoomControlLink({origin:'https://room.test',session:async()=>protocolSession,onFrame:()=>{},onPublisherState:s=>recoveryStates.push(s),onOpen:()=>recovery.publishScenes([{id:'one',name:'One'}],'one')});
recovery.start();await tick();const waiting=sockets.at(-1);waiting.onopen();
const rejectedRequest=publications(waiting).at(-1).request_id;
emit(waiting,{type:'error',code:'publisher_busy'});emit(waiting,{type:'error',code:'stale_publisher'});
assert.equal(recovery.publisherEpoch,null,'A rejected claim cannot authorize queued host work');
recovery.publishSources([],['newest-after-rejection'],[]);
assert.equal(publications(waiting).length,1);
assert.equal([...delays.values()].filter(ms=>ms===1000).length,1,'Repeated errors share one bounded retry');
await runTimer(1000);
assert.equal(publications(waiting).length,2,'Retry occurs even if the old owner closes without sending another error');
assert.notEqual(publications(waiting).at(-1).request_id,rejectedRequest);
assert.equal(publications(waiting).some(f=>'force'in f||'takeover'in f),false);
acknowledge(waiting,rejectedRequest);assert.equal(recovery.publisherReady,false);
acknowledge(waiting,undefined,2);
assert.deepEqual(waiting.sent.at(-1).participants,['newest-after-rejection']);
assert.deepEqual(recoveryStates.at(-1),{phase:'ready',confirmed:true});
emit(waiting,{type:'error',code:'stale_publisher'});
await runTimer(1000); // a valid receipt reset the retry budget
acknowledge(waiting,undefined,3);
recovery.stop();assert.equal(timers.size,0);
console.log('PASS: temporary predecessor conflicts recover without a host_unavailable trigger, stale receipts, or a forced takeover.');

const budgetStates=[];
const budget=new RoomControlLink({origin:'https://room.test',session:async()=>protocolSession,onFrame:()=>{},onPublisherState:s=>budgetStates.push(s),onOpen:()=>budget.publishScenes([{id:'one',name:'One'}],'one')});
budget.start();await tick();const rival=sockets.at(-1);rival.onopen();
emit(rival,{type:'error',code:'publisher_busy'});
for(const delay of [1000,2000,4000,8000,15000]){
  await runTimer(delay);emit(rival,{type:'error',code:'publisher_busy'});
}
assert.equal(publications(rival).length,6,'A continuing live-host conflict has only five automatic retries');
assert.deepEqual(budgetStates.at(-1),{phase:'rejected',code:'publisher_busy',retrying:false});
budget.publishScenes([{id:'two',name:'Two'}],'two');budget.publishSources([],['blocked'],[]);
assert.equal(rival.sent.length,6,'New source and scene updates cannot restart an exhausted claim');
assert.equal([...delays.values()].some(ms=>[1000,2000,4000,8000,15000].includes(ms)),false);
budget.stop();assert.equal(timers.size,0);
console.log('PASS: a real active-host conflict stays rejected after the finite retry budget; later scene edits cannot silently reclaim it.');

const deadlineStates=[];
const deadline=new RoomControlLink({origin:'https://room.test',session:async()=>protocolSession,onFrame:()=>{},onPublisherState:s=>deadlineStates.push(s),onOpen:()=>deadline.publishScenes([{id:'one',name:'One'}],'one')});
deadline.start();await tick();const quiet=sockets.at(-1);quiet.onopen();
const quietRequest=publications(quiet).at(-1).request_id;
await runTimer(6000);
assert.deepEqual(deadlineStates.at(-1),{phase:'rejected',code:'publisher_ack_timeout',retrying:true});
const canceledRetry=[...timers.keys()].find(id=>delays.get(id)===1000);
const retryCallback=timers.get(canceledRetry);
deadline.stop();deadline.start();await tick();const fresh=sockets.at(-1);fresh.onopen();
retryCallback();acknowledge(quiet,quietRequest);
assert.equal(publications(fresh).length,1,'A canceled retry cannot mutate the next generation');
acknowledge(fresh);assert.equal(deadline.publisherReady,true);
deadline.stop();assert.equal(timers.size,0);
console.log('PASS: a missing receipt retries with a deadline; stop fences queued retry callbacks and old acknowledgements.');

let legacyTicketCalls=0;
const compatible=new RoomControlLink({origin:'https://room.test',session:async()=>{legacyTicketCalls++;return session;},onFrame:()=>{},onOpen:()=>compatible.publishScenes([{id:'one',name:'One'}],'one')});
compatible.start();await tick();const legacyHosted=sockets.at(-1);compatible.publishSources([],['queued'],[]);legacyHosted.onopen();
assert.deepEqual(legacyHosted.sent.map(f=>f.type),['scene.publish','room.sources.publish']);
assert.equal('request_id'in legacyHosted.sent[0],false,'An old backend keeps its original scene wire shape');
emit(legacyHosted,{type:'error',code:'publisher_busy'});const rejected=legacyHosted.sent.length;
compatible.publishSources([],['retained'],[]);
assert.equal(compatible.send({type:'set.presented',receipt:{}}),false);
assert.equal(compatible.send({type:'audience.configure',enabled:true}),true,'Complete audience state queues while rejected');
compatible.acknowledge('rejected-command','applied');
assert.equal(legacyHosted.sent.length,rejected);
await runTimer(1000);assert.equal(legacyHosted.readyState,3);
legacyHosted.onclose();await runTimer(1000);
const legacyReplacement=sockets.at(-1);legacyReplacement.onopen();
assert.equal(legacyTicketCalls,2,'Legacy recovery rechecks permission through a fresh session');
assert.deepEqual(legacyReplacement.sent.map(f=>f.type),['scene.publish','room.sources.publish','audience.configure']);
assert.deepEqual(legacyReplacement.sent[1].participants,['retained']);
compatible.stop();assert.equal(timers.size,0);
console.log('PASS: legacy and independent servers preserve ordered source delivery; rejection recovery uses a fresh authorized socket.');

const moderator=new RoomControlLink({origin:'https://room.test',session:async()=>({...protocolSession,role:'mod'}),onFrame:()=>{},onOpen:()=>moderator.publishScenes([{id:'one',name:'One'}],'one')});
moderator.start();await tick();const mod=sockets.at(-1);mod.onopen();
assert.deepEqual(mod.sent,[],'A known moderator session cannot register a guessed initial host role');
assert.ok(moderator.sourceAction('source.visibility','camera',true));
assert.equal(mod.sent.at(-1).type,'room.action');
moderator.stop();assert.equal(timers.size,0);
console.log('PASS: moderator sockets keep normal control commands without publishing host ownership.');

const reconnectFence=new RoomControlLink({origin:'https://room.test',session:async()=>session,onFrame:()=>{}});
reconnectFence.start();await tick();const oldTransport=sockets.at(-1);oldTransport.onopen();oldTransport.readyState=3;oldTransport.onclose();
const transportTimer=[...timers.keys()].find(id=>delays.get(id)===1000);
const staleTransportRetry=timers.get(transportTimer);
reconnectFence.stop();reconnectFence.start();await tick();const socketsBefore=sockets.length;
staleTransportRetry();await tick();assert.equal(sockets.length,socketsBefore,'A queued canceled transport retry cannot create another publisher socket');
reconnectFence.stop();assert.equal(timers.size,0);
console.log('PASS: canceled transport retries, renewal callbacks and acknowledged expiry callbacks cannot interfere with successor sockets.');
