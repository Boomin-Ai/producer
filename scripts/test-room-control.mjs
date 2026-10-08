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
  publisher.onmessage({data:JSON.stringify({type:'room.authorized',request_id:refresh.request_id})});
  assert.equal(publisher.readyState,1,'Successful renewal must preserve the same publisher socket');
  assert.equal([...delays.values()].filter(ms=>ms===6000).length,0,'Acknowledged renewal must clear its expiry timer');
}
assert.equal(ticketCalls,4);
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

const recovery=new RoomControlLink({origin:'https://room.test',session:async()=>session,onFrame:()=>{},onOpen:()=>recovery.publishScenes([{id:'one',name:'One'}],'one')});
recovery.start();await tick();const waiting=sockets.at(-1);waiting.onopen();
waiting.onmessage({data:JSON.stringify({type:'error',code:'publisher_busy'})});
waiting.onmessage({data:JSON.stringify({type:'error',code:'stale_publisher'})});
assert.equal(waiting.sent.length,1,'An active host conflict must not cause registration retries');
waiting.onmessage({data:JSON.stringify({type:'error',code:'host_unavailable'})});
assert.equal(waiting.sent.length,2,'Register again when the former owner is gone');
waiting.onmessage({data:JSON.stringify({type:'error',code:'host_unavailable'})});
assert.equal(waiting.sent.length,2,'Repeated source errors must not flood registrations');
const clockNow=Date.now;Date.now=()=>clockNow()+5001;
waiting.onmessage({data:JSON.stringify({type:'error',code:'host_unavailable'})});
Date.now=clockNow;assert.equal(waiting.sent.length,3);
recovery.stop();assert.equal(timers.size,0);
console.log('PASS: owner disappearance triggers bounded re-registration; active host conflicts do not.');
