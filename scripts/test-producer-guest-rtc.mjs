/** Actual transport owner + authority validator, isolated SDK/HTTP seams.
 * No devices, real provider credentials, live rooms or production traffic. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const root=process.env.PRODUCER_RTC_REPO??fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(root+'/package.json'),ts=require('typescript');
const ownerSource=readFileSync(process.env.PRODUCER_RTC_SOURCE??new URL('../src/lib/producerGuestRtc.ts',import.meta.url),'utf8');
const authoritySource=readFileSync(process.env.PRODUCER_RTC_AUTHORITY??root+'/src/lib/producerGuestAuthority.ts','utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const flush=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const id='123e4567-e89b-42d3-a456-426614174000',host='123e4567-e89b-42d3-a456-426614174001';
const runs={A:'123e4567-e89b-42d3-a456-426614174002',B:'123e4567-e89b-42d3-a456-426614174003'};
const endpoint='wss://synthetic.livekit.cloud';
function harness(t,{startupStatus=201}={}){
 let now=1_800_000_000_000,seq=0,phase='A',stateStatus=200,nextSessionStatus=0,nextRenewStatus=0,nextStartupStatus=0,deferredSession=null;
 const requests=[],rooms=[],states=[],timers=new Map(),tracks=[{kind:'video',readyState:'live',stops:0,stop(){this.stops++;}},{kind:'audio',readyState:'live',stops:0,stop(){this.stops++;}}];
 const authority=()=>({expected:{brand_id:id,room_id:id,run_id:runs[phase],participant_id:id,role:'guest',scope:'stage',private_participant_id:null,host_lease_epoch:1,control_revision:1,authorization_generation:1,endpoint,publish_sources:['camera','microphone'],can_subscribe:true},producer_identity:`producer-${host}-e1-g1`,on_stage:true});
 const session=()=>({...authority().expected,schema_version:1,transport:'livekit',provider_room:`b_${id}_r_${id}_run_${runs[phase]}_stage`,rtc_identity:`guest-${id}-e1-g1`,issued_at_ms:now,expires_at_ms:now+60000,join_token:'synthetic-credential-never-sent'});
 const auth={};vm.runInNewContext(compile(authoritySource),{exports:auth,require,Date:{now:()=>now},Set,JSON,RegExp,Error});
 class Room {
  constructor(){this.state='disconnected';this.remoteParticipants=new Map();this.connected=0;this.disconnected=0;this.published=[];this.events=new Map();this.localParticipant={identity:`guest-${id}-e1-g1`,trackPublications:new Map(),setTrackSubscriptionPermissions(){},publishTrack:async track=>{this.published.push(track);}};rooms.push(this);}
  async prepareConnection(){}on(event,fn){this.events.set(event,fn);return this;}removeAllListeners(){this.events.clear();}
  async connect(){this.connected++;this.state='connected';}async disconnect(stopTracks){assert.equal(stopTracks,false);this.disconnected++;this.state='disconnected';}async startAudio(){}
 }
 const sdk={Room,RoomEvent:{TrackPublished:'pub',TrackSubscribed:'sub',TrackUnsubscribed:'unsub',Reconnecting:'reconnecting',Reconnected:'reconnected',Disconnected:'disconnected'},Track:{Source:{Camera:'camera',Microphone:'microphone'},Kind:{Video:'video',Audio:'audio'}},ConnectionState:{Disconnected:'disconnected',Connected:'connected'},setLogLevel(){},LogLevel:{silent:0}};
 class Stream{constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}}
 const stream=new Stream(tracks),exports={};
 const response=(status,value={})=>new Response(JSON.stringify(value),{status});
 vm.runInNewContext(compile(ownerSource),{exports,require:name=>name==='livekit-client'?sdk:['./producerGuestAuthority','./guestRtcAuthority'].includes(name)?auth:require(name),AbortController,AbortSignal,TextDecoder,Uint8Array,JSON,Set,Map,Date:{now:()=>now},MediaStream:Stream,document:{body:{appendChild(){}}},
  setTimeout(fn,ms){const key=++seq;timers.set(key,{fn,ms});return key;},clearTimeout(key){timers.delete(key);},setInterval(fn,ms){const key=++seq;timers.set(key,{fn,ms});return key;},clearInterval(key){timers.delete(key);},
  fetch:async(url,options)=>{
   const path=url.split('/rtc/')[1],body=options.body?JSON.parse(options.body):null;requests.push({phase,path,ticket:body?.connection_ticket??null,options});
   if(stateStatus===404||stateStatus===410)return response(stateStatus);
   if(path==='state?stage_audio=1')return response(stateStatus,stateStatus===200?authority():{code:'rtc_guest_not_ready'});
   if(path==='startup'){
    const status=nextStartupStatus||startupStatus;nextStartupStatus=0;
    if(status!==201)return response(status);
    if(stateStatus!==200)return response(stateStatus);
    return response(201,{session_version:1,authority:authority(),connection_ticket:`ticket-${phase}`,session:session()});
   }
   if(path==='connection')return response(201,{connection_ticket:`ticket-${phase}`});
   if(path==='session'){
    if(deferredSession){const pending=deferredSession;deferredSession=null;return await pending.promise;}
    const status=nextSessionStatus||(body.connection_ticket===`ticket-${phase}`?200:409);nextSessionStatus=0;
    return response(status,status===200?session():{code:'rtc_connection_fenced'});
   }
   if(path==='connection/renew'){
    const status=nextRenewStatus||(body.connection_ticket===`ticket-${phase}`?200:409);nextRenewStatus=0;
    return response(status,status===200?{connection_ticket:`ticket-${phase}`}:{code:'rtc_connection_fenced'});
   }
   throw Error('Unexpected request');
  }});
 const Owner=exports.ProducerGuestRtc??exports.GuestRtcPilot;
 const owner=new Owner({api:'https://api.example/v1/connect',invite:'synthetic',participantId:id,endpoint,localStream:()=>stream,onState:value=>states.push(value),onProgram(){},onAudio(){}});
 t.after(async()=>{await owner.close();assert.ok(tracks.every(track=>track.stops===0),'transport never owns physical/caller capture');});
 return {owner,rooms,states,tracks,requests,timers,async start(){owner.start();await flush();},async tick(ms=1000){now+=ms;timers.delete(owner.timer);owner.timer=null;await owner.poll();await flush();},run(value){phase=value;},state(status){stateStatus=status;},session(status){nextSessionStatus=status;},renew(status){nextRenewStatus=status;},startup(status){nextStartupStatus=status;},expireRenewal(){owner.ticketRenewAt=now;},advance(ms){now+=ms;},deferSession(){let resolve;const promise=new Promise(r=>resolve=r);deferredSession={promise};return ()=>resolve(response(200,session()));},count(path){return requests.filter(r=>r.path===path).length;}};
}

test('host gap clears run-bound ticket, retires RTC, and rejoins unchanged valid invite with fresh startup',async t=>{
 const h=harness(t);await h.start();assert.equal(h.states.at(-1),'live');const first=h.owner.room;
 h.state(409);await h.tick();assert.equal(first.state,'disconnected');assert.equal(h.owner.ticket,null);assert.equal(h.owner.ticketRenewAt,0);assert.equal(h.states.at(-1),'waiting');
 h.run('B');h.state(200);await h.tick();assert.equal(h.states.at(-1),'live');assert.notEqual(h.owner.room,first);assert.equal(h.count('startup'),2);assert.equal(h.count('session'),0);assert.equal(h.owner.room.published.length,2);
});
test('missed host gap after authority retirement drops rejected old-run session ticket and recovers next poll',async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;await h.owner.retire();h.run('B');await h.tick();assert.equal(h.owner.ticket,null);assert.equal(h.owner.room,null);assert.equal(first.state,'disconnected');
 await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),2);assert.equal(h.requests.filter(r=>r.path==='session'&&r.ticket==='ticket-A').length,1);
});
for(const status of [401,409])test(`session ${status} requires fresh credentials and never publishes rejected media`,async t=>{
 const h=harness(t);await h.start();await h.owner.retire();h.session(status);await h.tick();assert.equal(h.owner.ticket,null);assert.equal(h.owner.room,null);assert.equal(h.rooms.reduce((n,r)=>n+r.connected,0),1);await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),2);
});
for(const status of [401,409])test(`renewal ${status} retires old RTC and renegotiates rather than remaining connected on a fenced ticket`,async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;h.expireRenewal();h.renew(status);await h.tick();assert.equal(h.owner.ticket,null);assert.equal(first.state,'disconnected');assert.equal(h.owner.room,null);await h.tick();assert.equal(h.states.at(-1),'live');assert.notEqual(h.owner.room,first);assert.equal(h.count('startup'),2);
});
for(const status of [404,410])test(`guest ${status} remains terminal with no credential retry or capture stop`,async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;h.state(status);await h.tick();assert.equal(h.states.at(-1),'gone');assert.equal(h.owner.stopRequested,true);assert.equal(h.owner.ticket,null);assert.equal(first.state,'disconnected');assert.equal(h.timers.size,0);const count=h.requests.length;await h.owner.close();assert.equal(h.requests.length,count);
});
test('transient authority 503 retires stale media but preserves caller capture and valid ticket for same-run recovery',async t=>{
 const h=harness(t);await h.start();const first=h.owner.room,ticket=h.owner.ticket;h.state(503);await h.tick(4000);assert.equal(first.state,'disconnected');assert.equal(h.owner.room,null);assert.equal(h.owner.ticket,ticket);assert.equal(h.states.at(-1),'reconnecting');h.state(200);await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),1);assert.equal(h.count('session'),1);
});
test('unsupported startup endpoint stays on split authority/session flow through host restart',async t=>{
 const h=harness(t,{startupStatus:405});await h.start();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),1);h.state(409);await h.tick();h.run('B');h.state(200);await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),1);assert.equal(h.count('connection'),2);assert.equal(h.count('session'),2);
});
test('temporary startup 503 is retried without treating a capability outage as unsupported',async t=>{
 const h=harness(t);h.startup(503);await h.start();assert.equal(h.states.at(-1),'reconnecting');assert.equal(h.rooms.reduce((n,r)=>n+r.connected,0),0);await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.count('startup'),2);
});
test('leaving while session is in flight cannot create a new SDK connection or stop capture after late success',async t=>{
 const h=harness(t);await h.start();await h.owner.retire();const release=h.deferSession();await h.tick();assert.ok(h.owner.joining);await h.owner.close();release();await flush();assert.equal(h.owner.room,null);assert.equal(h.rooms.reduce((n,r)=>n+r.connected,0),1);assert.equal(h.timers.size,0);
});
test('successful renewal keeps the SDK room and caller capture without renegotiation churn',async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;h.expireRenewal();await h.tick();assert.equal(h.states.at(-1),'live');assert.equal(h.owner.room,first);assert.equal(first.disconnected,0);assert.equal(h.count('startup'),1);assert.equal(h.count('connection/renew'),1);assert.equal(h.count('session'),0);
});
test('ordinary SDK disconnection rejoins same authority with its valid ticket instead of minting new connection identity',async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;first.state='disconnected';first.events.get('disconnected')?.();await h.tick();assert.equal(h.states.at(-1),'live');assert.notEqual(h.owner.room,first);assert.equal(h.count('startup'),1);assert.equal(h.count('connection'),0);assert.equal(h.count('session'),1);
});
test('authority permission denial fails closed when stale and never mints replacement credentials while denied',async t=>{
 const h=harness(t);await h.start();const first=h.owner.room;h.state(403);await h.tick(4000);assert.equal(h.owner.room,null);assert.equal(first.state,'disconnected');for(let i=0;i<3;i++)await h.tick();assert.equal(h.count('startup'),1);assert.equal(h.count('connection'),0);assert.equal(h.count('session'),0);assert.equal(h.states.at(-1),'reconnecting');
});
