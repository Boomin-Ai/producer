import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {test} from 'node:test';

const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function harness({transport='legacy',status='accepted',programError=false,deferredLease=false,grants,traceEnabled=false,traceThrows=false}={}){
 const traceEvents=[];let traceEpoch=1;const ended=new WeakSet();
 let now=10000,nextTimer=1,activeStatus=status;const timers=new Map(),requests=[],captures=[],links=[],conversations=[],nativeOwners=[],leases=[];let releaseLease;
 class Track {
  constructor(kind){this.kind=kind;this.enabled=true;this.readyState='live';this.muted=false;this.stops=0;}
  clone(){return new Track(this.kind);}
  stop(){this.stops++;this.readyState='ended';}
  addEventListener(){}
 }
 class Stream {
  constructor(tracks=[]){this.tracks=tracks;}
  getTracks(){return this.tracks;}
  getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
  getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
 }
 class Link {
  constructor(options){this.options=options;this.closed=false;links.push(this);}
  close(){this.closed=true;}
  async replaceLocalTracks(stream){this.replaced=stream;}
 }
 class Conversation {
  constructor(options){this.options=options;this.stopped=false;conversations.push(this);}
  start(){this.started=true;}stop(){this.stopped=true;}suspend(){this.suspended=true;}
  async resumeAudio(){this.resumed=true;}
  setMicrophoneEnabled(enabled){this.enabled=enabled;}applyStage(stage){this.stage=stage;}
 }
 class Native {
  constructor(options){this.options=options;this.closed=false;nativeOwners.push(this);}
  start(){this.started=true;}
  async close(){this.closed=true;}
  async replaceLocalTracks(){this.replaced=true;}
  async resumeAudio(){this.resumed=true;}
 }
 const program={video:new Track('video'),audio:new Track('audio'),releases:0,onVideo(fn){this.listener=fn;},release(){this.releases++;}};
 const traceBackend={
  snapshotTraceContext:()=>({roomVisit:7}),
  startTraceSpan(name,fields,context){if(traceThrows)throw Error('diagnostics unavailable');if(!traceEnabled)return;const span={name,startedAt:now,epoch:traceEpoch};traceEvents.push({kind:'start',name,fields,context});return span;},
  endTraceSpan(span,status,fields){if(traceThrows)throw Error('diagnostics unavailable');if(!traceEnabled||!span||span.epoch!==traceEpoch||ended.has(span))return;ended.add(span);traceEvents.push({kind:'end',name:span.name,status,fields,durationMs:now-span.startedAt});},
  recordTraceEvent(name,fields,kind,context){if(traceThrows)throw Error('diagnostics unavailable');if(traceEnabled)traceEvents.push({kind,name,fields,context});},
 };
 const traceExports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/guestSeatTrace.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:traceExports,require:()=>traceBackend,Map,Promise});
 const modules={
  './guestSeatTrace':traceExports,
  '../../server/guest/src/hostLink':{HostLink:Link,signalingWsUrl:(api,s)=>new URL(s.signaling_url,api).href.replace(/^https:/,'wss:').replace(/^http:/,'ws:')},
  '../../server/guest/src/guestConversation':{GuestConversation:Conversation},
  '../../server/guest/src/participants':{resolveGrants:g=>new Set(g.grants??['media.camera','media.mic','media.return_feed'])},
  './programCapture':{sharedProgramCapture:{async resumeAudio(){program.resumed=true;},async acquire(bus,label){leases.push({bus,label});if(programError)throw Error('no camera');if(deferredLease)return new Promise(resolve=>{releaseLease=()=>resolve(program);});return program;}}},
  './producerGuestRtc':{ProducerGuestRtc:Native},
 };
 const exports={};const source=readFileSync(new URL('../src/lib/guestSeat.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const clock={setTimeout(fn,delay){const id=nextTimer++;timers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){timers.delete(id);}};
 vm.runInNewContext(compiled,{exports,require:name=>{if(!modules[name])throw Error('Unexpected module '+name);return modules[name];},URL,MediaStream:Stream,AbortController,AbortSignal,TextDecoder,Uint8Array,console,Date:{now:()=>now},window:clock,
  navigator:{mediaDevices:{async getUserMedia(constraints){captures.push(constraints);return new Stream([...(constraints.video?[new Track('video')]:[]),...(constraints.audio?[new Track('audio')]:[])]);}}},
  fetch:async(url,options)=>{requests.push({url,options});if(url.endsWith('/session'))return new Response(JSON.stringify({signaling_ticket:'secret',signaling_url:'/v1/connect/signal/ticket',ice_servers:[]}));if(url.endsWith('/accept')){activeStatus='accepted';return new Response('{}');}return new Response(JSON.stringify({transport,guest:{id:'guest-one',status:activeStatus,...(grants===undefined?{}:{grants})}}));}
 });
 return {GuestSeat:exports.GuestSeat,exports,traceEvents,setTraceConsent(enabled){traceEnabled=enabled;traceEpoch++;},program,links,conversations,nativeOwners,leases,captures,requests,timers,Stream,Track,
  resolveLease(){releaseLease();},status(value){activeStatus=value;},
  async advance(ms){await flush();const end=now+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();await flush();}now=end;await flush();},
  seat(extra={}){return new exports.GuestSeat({joinUrl:'https://guest.example/connect/guest/gi_saved',apiBase:'https://api.example/prefix/v1/app/producer',hostName:'Host',title:'Set appearance',producerCam:false,endpointId:'local-engine',...extra});}
 };
}

test('waiting seat opens neither camera, program capture nor media transport before admission',async()=>{
 const h=harness({status:'waiting'}),s=h.seat({videoSource:'program'});await s.start();assert.equal(s.snapshot().phase,'waiting');assert.equal(h.captures.length,0);assert.equal(h.leases.length,0);assert.equal(h.links.length,0);
 h.status('accepted');await h.advance(2500);assert.equal(h.leases.length,1);assert.equal(h.links.length,1);s.leave();
});
test('program mode uses processed mix-minus and owns clones; mute and leave cannot stop the shared bus',async()=>{
 const h=harness(),s=h.seat({videoSource:'program'});await s.start();assert.equal(h.captures.length,0);assert.equal(h.leases[0].bus,1);assert.equal(s.snapshot().mediaMode,'program');assert.equal(s.snapshot().producerCam,true);
 const local=s.localStream();assert.notEqual(local.getVideoTracks()[0],h.program.video);assert.notEqual(local.getAudioTracks()[0],h.program.audio);
 s.toggleMute();assert.equal(local.getAudioTracks()[0].enabled,false);assert.equal(h.program.audio.enabled,true);assert.equal(h.conversations[0].enabled,false);
 await s.resumeAudio();assert.equal(h.program.resumed,true);assert.equal(h.conversations[0].resumed,true);
 s.leave();assert.equal(h.program.releases,1);assert.equal(h.program.video.readyState,'live');assert.equal(h.program.audio.readyState,'live');assert.ok(local.getTracks().every(t=>t.readyState==='ended'));assert.equal(h.timers.size,0);
});
test('mute and camera-off selected in the waiting room are honored before publication',async()=>{
 const h=harness({status:'waiting'}),s=h.seat({videoSource:'program'});await s.start();s.toggleMute();s.toggleCamera();assert.equal(s.snapshot().muted,true);assert.equal(s.snapshot().cameraOff,true);assert.equal(h.leases.length,0);
 h.status('accepted');await h.advance(2500);assert.ok(s.localStream().getTracks().every(track=>!track.enabled));assert.equal(h.program.video.enabled,true);assert.equal(h.program.audio.enabled,true);assert.equal(h.conversations[0].enabled,false);s.leave();
});
test('unavailable program never silently captures a webcam',async()=>{
 const h=harness({programError:true}),s=h.seat({videoSource:'program'});await s.start();assert.equal(s.snapshot().phase,'error');assert.match(s.snapshot().message,/program output is unavailable/);assert.equal(h.captures.length,0);assert.equal(h.links.length,0);assert.equal(h.timers.size,0);s.leave();
});
test('local program ownership starts only after admission and releases once on failure or leave',async()=>{
 const h=harness({status:'waiting',programError:true});let prepared=0,released=0;
 const s=h.seat({videoSource:'program',prepareProgram:async()=>{prepared++;},releaseProgram:()=>{released++;}});await s.start();assert.equal(prepared,0);h.status('accepted');await h.advance(2500);assert.equal(prepared,1);assert.equal(released,1);s.leave();assert.equal(released,1);
});
test('leaving during program acquisition releases a late lease without creating transport',async()=>{
 const h=harness({deferredLease:true}),s=h.seat({videoSource:'program'}),starting=s.start();await flush();s.leave();h.resolveLease();await starting;assert.equal(h.program.releases,1);assert.equal(h.links.length,0);assert.equal(h.nativeOwners.length,0);assert.equal(h.timers.size,0);
});
test('modern guest metadata selects the existing authority-fenced SDK owner exclusively',async()=>{
 const h=harness({transport:'livekit'}),s=h.seat({videoSource:'program'});await s.start();assert.equal(h.nativeOwners.length,1);assert.equal(h.links.length,0);assert.equal(h.conversations.length,0);const owner=h.nativeOwners[0];
 assert.equal(owner.options.participantId,'guest-one');assert.equal(owner.options.api,'https://api.example/prefix/v1/connect');assert.equal(owner.options.localStream(),s.localStream());assert.equal(s.snapshot().transport,'livekit');
 owner.options.onState('live');owner.options.onStage(true);assert.equal(s.snapshot().onStage,true);s.leave();assert.equal(owner.closed,true);owner.options.onState('live');assert.equal(h.timers.size,0);
});
test('legacy transport uses maintained signaling renewal and stage-aware conversation',async()=>{
 const h=harness(),s=h.seat({videoSource:'webcam'});await s.start();assert.equal(h.captures.length,1);assert.equal(h.captures[0].video.frameRate.max,30);const {options}=h.links[0];assert.equal(options.returnFeed,true);const renewed=await options.refreshSession();assert.match(renewed.wsUrl,/^wss:\/\/api.example/);
 options.onData({kind:'stage',on_stage:['guest-one'],audible:['guest-one'],version:1});assert.equal(s.snapshot().onStage,true);assert.equal(h.conversations[0].stage.version,1);
 options.onMainState('disconnected');assert.equal(h.conversations[0].suspended,true);await h.advance(10000);assert.equal(h.links.length,2);assert.equal(h.captures.length,1);assert.equal(h.links[0].closed,true);s.leave();
});
test('revoke stops all owned tracks and ignores stale media callbacks',async()=>{
 const h=harness(),s=h.seat();await s.start();const local=s.localStream();h.status('revoked');await h.advance(2500);assert.equal(s.snapshot().phase,'gone');assert.equal(h.links[0].closed,true);assert.ok(local.getTracks().every(t=>t.readyState==='ended'));h.links[0].options.onMainState('connected');assert.equal(s.snapshot().phase,'gone');assert.equal(h.timers.size,0);s.leave();
});
test('an explicit empty grant bundle captures no media, including program sources',async()=>{
 const h=harness({grants:[]}),s=h.seat({videoSource:'program'});await s.start();assert.equal(h.captures.length,0);assert.equal(h.leases.length,0);assert.equal(s.localStream().getTracks().length,0);assert.equal(h.links[0].options.returnFeed,false);s.leave();
});
test('unknown transport fails closed rather than probing legacy or activating devices',async()=>{
 const h=harness({transport:'unknown'}),s=h.seat();await s.start();assert.equal(s.snapshot().phase,'error');assert.equal(h.captures.length,0);assert.equal(h.links.length,0);s.leave();
});
test('self-hosted URL prefixes survive while URL credentials and malformed invite codes are rejected',()=>{
 const h=harness();assert.equal(h.exports.connectApiBase('https://self.example/proxy/v1/app/producer'),'https://self.example/proxy/v1/connect');assert.equal(h.exports.connectApiBase('http://localhost:8787'),'http://localhost:8787/v1/connect');assert.equal(h.exports.connectApiBase('https://self.example/proxy/v1'),'https://self.example/proxy/v1/connect');assert.equal(h.exports.connectApiBase('https://self.example/api/'),'https://self.example/api/v1/connect');assert.equal(h.exports.inviteCodeFromJoinUrl('https://self.example/connect/guest/gi_saved/'),'gi_saved');assert.equal(h.exports.inviteCodeFromJoinUrl('https://self.example/connect/guest/bad%2Fcode'),null);assert.throws(()=>h.exports.connectApiBase('https://user:secret@self.example'));
});

test('authority validator rejects wrong participant, scope, provider, stale or mismatched sessions',()=>{
 const source=readFileSync(new URL('../src/lib/producerGuestAuthority.ts',import.meta.url),'utf8'),exports={},require=createRequire(import.meta.url);
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require,Date,Set,JSON,RegExp,Error});
 const id='123e4567-e89b-42d3-a456-426614174000',host='123e4567-e89b-42d3-a456-426614174001',endpoint='wss://test.livekit.cloud',expected={brand_id:id,room_id:id,run_id:id,participant_id:id,role:'guest',scope:'stage',private_participant_id:null,host_lease_epoch:1,control_revision:1,authorization_generation:1,endpoint,publish_sources:['camera','microphone'],can_subscribe:true};
 const raw={expected,producer_identity:`producer-${host}-e1-g1`,on_stage:true},a=exports.readGuestRtcAuthority(raw,id,endpoint),now=Date.now(),session={...expected,schema_version:1,transport:'livekit',provider_room:`b_${id}_r_${id}_run_${id}_stage`,rtc_identity:`guest-${id}-e1-g1`,issued_at_ms:now,expires_at_ms:now+60000,join_token:'private-credential'};
 assert.equal(exports.validateGuestRtcSession(session,a,now).rtc_identity,session.rtc_identity);assert.throws(()=>exports.readGuestRtcAuthority(raw,host,endpoint));assert.throws(()=>exports.readGuestRtcAuthority({...raw,expected:{...expected,scope:'private'}},id,endpoint));assert.throws(()=>exports.readGuestRtcAuthority(raw,id,'wss://other.livekit.cloud'));assert.throws(()=>exports.validateGuestRtcSession({...session,expires_at_ms:now-1},a,now));assert.throws(()=>exports.validateGuestRtcSession({...session,authorization_generation:2},a,now));
});

test('opt-in guest stages distinguish admission, capture, SDK connect/publication and reconnect without private data',async()=>{
 const h=harness({transport:'livekit',status:'waiting',traceEnabled:true}),s=h.seat({videoSource:'program',prepareProgram:async()=>{}});await s.start();await h.advance(25);h.status('accepted');await h.advance(2500);
 const owner=h.nativeOwners[0];owner.options.onDiagnostic('connect_start');await h.advance(10);owner.options.onDiagnostic('connect_end');owner.options.onDiagnostic('publish_start');owner.options.onDiagnostic('publish_end');owner.options.onState('live');
 owner.options.onState('reconnecting');await h.advance(50);owner.options.onState('live');
 const before=h.traceEvents.length;for(let i=0;i<100;i++){owner.options.onDiagnostic('poll');owner.options.onDiagnostic('poll_failed');}assert.equal(h.traceEvents.length,before,'idle polling never creates telemetry pressure');
 s.leave();await flush();
 for(const name of ['peer.attempt','peer.admission_wait','peer.capture.program','peer.program.prepare','peer.sdk.load','peer.rtc.connect','peer.rtc.publish','peer.reconnect','peer.leave'])assert.ok(h.traceEvents.some(e=>e.kind==='end'&&e.name===name&&e.status==='ok'),name);
 assert.equal(h.traceEvents.filter(e=>e.kind==='end'&&e.name==='peer.attempt').length,1);
 for(const event of h.traceEvents)for(const value of Object.values(event.fields??{}))assert.ok(typeof value==='boolean'||typeof value==='number');
 assert.doesNotMatch(JSON.stringify(h.traceEvents),/gi_saved|api.example|guest-one|Synthetic|local-engine|Host|secret/);
 assert.ok(!h.traceEvents.some(e=>e.name.includes('first_video')),'track availability must never claim decoded presentation');
});
test('disabled diagnostics and telemetry exceptions cannot change guest capture or transport',async()=>{
 for(const options of [{traceEnabled:false},{traceEnabled:true,traceThrows:true}]){
  const h=harness({transport:'livekit',...options}),s=h.seat({videoSource:'program'});await s.start();h.nativeOwners[0].options.onDiagnostic('connect_start');h.nativeOwners[0].options.onDiagnostic('connect_end');h.nativeOwners[0].options.onState('live');s.leave();await flush();assert.equal(h.leases.length,1);assert.equal(h.nativeOwners.length,1);assert.equal(h.program.releases,1);assert.equal(h.traceEvents.length,0);
 }
});
test('late capture after cancellation and repeated leave cannot double-close guest spans',async()=>{
 const h=harness({traceEnabled:true,deferredLease:true}),s=h.seat({videoSource:'program'}),starting=s.start();await flush();s.leave();s.leave();h.resolveLease();await starting;await flush();
 assert.equal(h.traceEvents.filter(e=>e.kind==='end'&&e.name==='peer.attempt'&&e.status==='cancelled').length,1);assert.equal(h.traceEvents.filter(e=>e.kind==='end'&&e.name==='peer.capture.program'&&e.status==='cancelled').length,1);assert.equal(h.traceEvents.filter(e=>e.kind==='end'&&e.name==='peer.leave').length,1);
});
test('turning tracing off during a join discards its late diagnostic completion',async()=>{
 const h=harness({traceEnabled:true,deferredLease:true}),s=h.seat({videoSource:'program'}),starting=s.start();await flush();h.setTraceConsent(false);const before=h.traceEvents.length;h.resolveLease();await starting;s.leave();await flush();assert.equal(h.traceEvents.length,before);
});
