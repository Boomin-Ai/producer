import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({entryPoints:['src/features/presentation/modulePush.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {modulePushPublisher,subscribeModulePush}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const updates=[],subscription=subscribeModulePush('endpoint','room',e=>updates.push(e));
const publisher=modulePushPublisher('endpoint','room');
publisher.frame({type:'subscribed',channel:'set:operator'});assert.equal(subscription.ready(),false);
publisher.frame({type:'set.runtime.ready',protocol:1});assert.equal(subscription.ready(),true);
const snapshot={setEpoch:1,revision:2,modules:{}};
publisher.frame({type:'set.runtime',deployment:'set-a',setEpoch:1,revision:2,snapshot});
assert.equal(updates.at(-1).snapshot,snapshot);
const count=updates.length;
modulePushPublisher('another-endpoint','room').frame({type:'set.runtime.ready',protocol:1});assert.equal(updates.length,count);
const replacement=modulePushPublisher('endpoint','room');assert.equal(subscription.ready(),false);
replacement.frame({type:'set.runtime.ready',protocol:1});publisher.offline();publisher.close();assert.equal(subscription.ready(),true,'stale cleanup cannot disable replacement');
publisher.frame({type:'set.runtime',deployment:'old',setEpoch:1,revision:3});assert.notEqual(updates.at(-1).deployment,'old');
replacement.frame({type:'set.runtime.unavailable'});assert.equal(subscription.ready(),false);
replacement.close();subscription.close();
console.log('PASS: push readiness, endpoint scoping, stale connection fencing and grant narrowing');

const effects=[];let installed=null,reads=0,pendingRead=null;
const base={setEpoch:1,revision:0,modules:{}};
globalThis.__pushTest={effects,call:async(_e,_r,method,_path,body)=>{
 if(method==='POST'&&body?.deployment){installed=body.deployment;return {deployment:installed,snapshot:base};}
 reads++;return pendingRead??{deployment:installed,snapshot:installed?base:null};
}};
const compiled=await build({stdin:{contents:"export * from './src/features/presentation/useSetModules';export * from './src/features/presentation/modulePush';export {RehearsalSession} from './src/features/presentation/rehearsal';export {AFTER_HOURS} from './src/features/presentation/fixtures';export {SetRuntime} from './shared/set-runtime/runtime';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,define:{'import.meta.env.DEV':'false'},plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^(react|\.\/moduleConnections|\.\.\/\.\.\/lib\/(ipc|dataIntegrations))$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='react'
 ? 'export const useRef=v=>({current:v});export const useEffect=fn=>globalThis.__pushTest.effects.push(fn);'
 : a.path.endsWith('moduleConnections')?'export const moduleCall=(...args)=>globalThis.__pushTest.call(...args);'
 : a.path.endsWith('dataIntegrations')?'export const dataIntegrations={list:async()=>({connections:[]})};'
 :'export const uiLog=()=>{};',loader:'js'}));
}}]});
const hook=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const real={setTimeout,clearTimeout,setInterval,clearInterval},timers=new Map(),intervals=new Map();let n=0;
globalThis.setTimeout=(fn,ms)=>{timers.set(++n,{fn,ms});return n;};globalThis.clearTimeout=id=>timers.delete(id);
globalThis.setInterval=(fn,ms)=>{intervals.set(++n,{fn,ms});return n;};globalThis.clearInterval=id=>intervals.delete(id);
const settle=async(predicate)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>real.setTimeout(r,5));}assert.fail('Hook did not settle');};
let local=base,connection='connecting',error='',cleanup=[];
const session={package:{id:'test',version:'1',runtime:{instances:[{id:'poll',definition:'poll'}],definitions:{poll:{behavior:{type:'vote'}}}}},
 moduleSnapshot:()=>local,snapshot:()=>({moduleConnection:connection}),
 receiveModuleSnapshot:s=>{if(s.setEpoch>local.setEpoch||s.setEpoch===local.setEpoch&&s.revision>local.revision)local=s;},
 attachControlTransport:()=>{},attachModuleLifecycle:()=>{},attachModuleTransport:(transport,message)=>{error=message??'';connection=message?'error':transport?'live':'connecting';}};
try {
 hook.useSetModules(session,'endpoint','room',true,'live',{});cleanup=effects.map(fn=>fn()).filter(Boolean);
 await settle(()=>timers.size>0);assert.ok([...timers.values()].some(t=>t.ms===1000));
 const pub=hook.modulePushPublisher('endpoint','room');pub.frame({type:'set.runtime.ready',protocol:1});
 await settle(()=>[...timers.values()].some(t=>t.ms===30000));
 const before=reads;pub.frame({type:'set.runtime',deployment:installed,setEpoch:1,revision:1,snapshot:{...base,revision:1}});
 assert.equal(local.revision,1);assert.equal(reads,before,'push must not fetch small snapshots');
 // A second invalidation during a GET must survive that GET's stale result.
 let releaseLarge;pendingRead=new Promise(resolve=>{releaseLarge=resolve;});
 pub.frame({type:'set.runtime',deployment:installed,setEpoch:1,revision:2});
 const duringRead=reads;
 pub.frame({type:'set.runtime',deployment:installed,setEpoch:1,revision:3});
 assert.equal(reads,duringRead,'in-flight invalidations must coalesce');
 pendingRead=Promise.resolve({deployment:installed,snapshot:{...base,revision:3}});
 releaseLarge({deployment:installed,snapshot:{...base,revision:2}});
 await settle(()=>local.revision===3);
 assert.equal(reads,duringRead+1,'invalidation must schedule one follow-up fetch');
 pendingRead=null;
 pub.offline();await settle(()=>[...timers.values()].some(t=>t.ms===1000));
 let release;pendingRead=new Promise(resolve=>{release=resolve;});
 pub.frame({type:'set.runtime.ready',protocol:1});
 pub.frame({type:'set.runtime',deployment:'replacement',setEpoch:2,revision:0});
 release({deployment:installed,snapshot:{...base,revision:99}});
 await new Promise(r=>real.setTimeout(r,10));
 assert.equal(local.revision,3,'stale GET cannot restore a replaced Set');
 assert.equal(connection,'error');assert.match(error,/replaced/);
 cleanup.forEach(fn=>fn());cleanup=[];pub.close();assert.equal(timers.size,0);assert.equal(intervals.size,0);
 console.log('PASS: actual hook push, coalesced invalidation, fallback, resync, replacement race and timer cleanup');
} finally {cleanup.forEach(fn=>fn());Object.assign(globalThis,real);delete globalThis.__pushTest;}

// Exercise real live-session adoption, including Sets with no modules.
effects.length=0;const doc=structuredClone(hook.AFTER_HOURS);delete doc.show;delete doc.set.viewController;delete doc.set.views;delete doc.set.initialView;
doc.set.controls=doc.set.controls.filter(c=>c.type!=='button'||!c.action.type.startsWith('show.'));
doc.runtime={schema:'producer.modules/1',definitions:{},instances:[]};
if(doc.set.layouts.length===1)doc.set.layouts.push({...structuredClone(doc.set.layouts[0]),id:'alternate'});
doc.set.initialLayout=doc.set.layouts[0].id;
let serverRuntime,serverDeployment;const requests=[];
globalThis.__pushTest={effects,call:async(_e,_r,method,path='',body)=>{
 requests.push({method,path,body});
 if(path==='/capabilities')return {controlProtocol:1,controlFieldsProtocol:1};
 if(method==='GET')return {deployment:serverDeployment??null,snapshot:serverRuntime?.operator()??null,serverNow:1000};
 if(!path){serverDeployment=body.deployment;serverRuntime=new hook.SetRuntime(body.definition,{epoch:1,domain:'live',capabilities:[],control:body.control});return {deployment:serverDeployment,snapshot:serverRuntime.operator(),serverNow:1000};}
 if(path==='/control')return {result:serverRuntime.control(body.command,{role:'operator',id:'host',modules:[]},1000),snapshot:serverRuntime.operator(),serverNow:1000};
 assert.fail('Unexpected live mutation '+path);
}};
const live=new hook.RehearsalSession(doc,'host','live');
try{
 hook.useSetModules(live,'endpoint','live-room',true,'live',{},true);cleanup=effects.map(fn=>fn()).filter(Boolean);
 await settle(()=>live.snapshot().moduleConnection==='live');assert.equal(live.hasRoomControl(),true);
 const next=doc.set.layouts[1].id;assert.equal(live.send({type:'control',action:{type:'layout.select',layoutId:next}}),true);
 assert.notEqual(live.snapshot().layoutId,next);await settle(()=>live.snapshot().layoutId===next&&!live.snapshot().controlPending);
 assert.equal(requests.some(r=>r.path==='/orchestrate'),false);
 assert.ok(requests.find(r=>r.method==='POST'&&!r.path).body.control);
 cleanup.forEach(fn=>fn());cleanup=[];effects.length=0;const count=requests.length;
 hook.useSetModules(live,'endpoint','live-room',true,'live',{},false);cleanup=effects.map(fn=>fn()).filter(Boolean);
 await new Promise(r=>real.setTimeout(r,10));assert.equal(requests.length,count,'moderator must not run host installation effect');
 console.log('PASS: actual hook negotiates control support, adopts zero-module Sets, waits for commit and excludes moderator installation');
}finally{cleanup.forEach(fn=>fn());delete globalThis.__pushTest;}
