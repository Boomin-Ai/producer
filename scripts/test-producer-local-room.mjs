import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const model={};vm.runInNewContext(compile('../server/guest/src/participants.ts'),{exports:model,Set,Array,Object});
const accessModule={};vm.runInNewContext(compile('../src/lib/producerLocalAccess.ts'),{exports:accessModule,require:()=>model,DOMException,Error});
const {producerLocalAccess}=accessModule;
const hostAccess={available:true,access:{role:'host',via:'brand',can:{manage:true},grants:[{id:'local-grant'}]}};
const readSource=file=>readFileSync(new URL(file,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const home=readSource('../src/views/Home.tsx'),start=home.indexOf('  const startSeat = useCallback('),end=home.indexOf('  const hostedRoom=',start);
assert(start>0&&end>start);const code=ts.transpileModule(home.slice(start,end)+'\nexports.start=startSeat;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function harness({rooms,access,streaming=false,recording=false,native=false,retained=false,visible=false,ready=true,portrait=false,existingSeat}={}){
 const calls=[],appearances=[],exports={},room={id:'selected',endpoint_id:'local',config:'{}'};let active='local';
 const endpoint={id:'local',kind:'connected',base_url:'https://local.example/v1/app/producer'},context={exports,DOMException,Error,Promise,URL,producerLocalAccess,useCallback:fn=>fn,endpoints:[endpoint],activeEndpointId:()=>active,
  nativeAppearances:native,view:visible?{kind:'room',room}:{kind:'home'},retainedRoom:retained?{room}:null,outgoingSeat:existingSeat,outgoingSeatRef:{current:existingSeat},outgoingRuntimeRef:{current:null},outgoingOwners:{current:new Map()},retiringAppearance:{current:null},roomRuntimeRef:{current:retained||visible?{roomId:room.id,outputsActive:streaming||recording,programReady:ready,outputPortrait:portrait}:null},
  ipc:{liveListRooms:async()=>rooms??[room],liveEngineStatus:async()=>({session_state:streaming?'streaming':'idle'})},guests:{access:async()=>access??hostAccess},recording:{list:async()=>recording?[{status:'recording'}]:[]},roomMetadata:()=>({server_room_id:'server-room'}),isBoomin:()=>true,
  roomExit:{current:{cancel:()=>calls.push('cancelExit')}},markRoomClick:()=>{},setNetworkSheet:()=>{},setPendingSeat:()=>{},setOutgoingSeat:value=>appearances.push(value),setOutgoingRuntime:()=>{},setOutgoingState:()=>{},setAppearanceExit:()=>{},setView:value=>calls.push(value)};
 vm.runInNewContext(code,context);return {start:exports.start,calls,appearances,room,switchWorkspace:()=>active='other'};
}
const seat={endpointId:'local',videoSource:'program',localRoomId:'selected',apiBase:'https://api.boomin.ai/v1/app/producer'};
let h=harness();await h.start(seat,new AbortController().signal);assert.equal(h.calls[1].room.id,'selected');assert.equal(h.calls[1].access.endpointId,'local');assert.equal(h.calls[1].access.serverRoomId,'server-room');assert.equal(h.calls[1].access.endpointBaseUrl,'https://local.example/v1/app/producer');assert.equal(await h.calls[1].access.result,hostAccess);
const rooms=deferred(),abort=new AbortController();h=harness({rooms:rooms.promise});const pending=h.start(seat,abort.signal);abort.abort();rooms.resolve([h.room]);await assert.rejects(pending,{name:'AbortError'});assert.equal(h.calls.length,0);
const access=deferred(),close=new AbortController();h=harness({access:access.promise});const authorizing=h.start(seat,close.signal);await new Promise(r=>setTimeout(r,0));close.abort();access.resolve(hostAccess);await assert.rejects(authorizing,{name:'AbortError'});assert.equal(h.calls.length,0);
for(const options of [{rooms:[]},{access:{available:false}},{access:{available:true,denied:true}},{access:{available:true,access:{role:'viewer'}}},{access:{available:true,access:{role:'manager',can:{manage:true}}}},{access:{available:true,access:{role:'host',can:{manage:false}}}},{streaming:true},{recording:true}]){h=harness(options);await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);}
h=harness();h.switchWorkspace();await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);
h=harness({streaming:true,recording:true});await h.start({...seat,videoSource:'webcam'},new AbortController().signal);assert.equal(h.calls[1].room,undefined);
console.log('PASS local program admission: exact room, cancellation during reads/authorization, workspace fencing, missing room, unknown/viewer access, stream/record safety and lightweight webcam.');

for(const output of [{streaming:true},{recording:true},{streaming:true,recording:true}]){
 h=harness({...output,native:true,retained:true,portrait:true});await h.start(seat,new AbortController().signal);
 assert.equal(h.calls[1].kind,'room');assert.equal(h.calls[1].room,h.room,'attach preserves the existing controller document identity');
 assert.equal(h.appearances[0].nativeProgram,true);assert.equal(h.appearances[0].localRoomId,'selected');assert.equal(h.appearances[0].portrait,true);assert.equal(h.appearances[0].quality,720);
}
for(const options of [{native:true,streaming:true},{native:true,recording:true},{native:true,retained:true,streaming:true,ready:false},{native:true,retained:true,recording:true,rooms:[{id:'different',endpoint_id:'local'}]},{native:true,retained:true,streaming:true,existingSeat:seat}]){
 h=harness(options);await assert.rejects(h.start(options.rooms?{...seat,localRoomId:'different'}:seat,new AbortController().signal));assert.equal(h.calls.length,0);assert.equal(h.appearances.length,0);
}
h=harness({native:true});await h.start(seat,new AbortController().signal);assert.equal(h.calls[1].kind,'room');assert.equal(h.appearances[0].nativeProgram,true);assert.equal(h.appearances[0].portrait,false);
console.log('PASS native appearance attachment: running stream/recording uses the retained controller and selected portrait; unknown, wrong or unready controllers fail before mutation.');
for(const apiBase of ['https://owned.example/v1/app/producer','https://api.boomin.ai/other/v1','https://api.boomin.ai.evil.test/v1','https://name:secret@api.boomin.ai/v1']){
 h=harness({native:true});await h.start({...seat,apiBase},new AbortController().signal);assert.equal(h.calls[1].kind,'seat');assert.equal(h.appearances.length,0);
 h=harness({native:true,retained:true,streaming:true});await assert.rejects(h.start({...seat,apiBase},new AbortController().signal));assert.equal(h.calls.length,0);assert.equal(h.appearances.length,0);
}
console.log('PASS native issuer scope: independent and noncanonical servers keep compatibility transport and cannot bypass active-output protection.');
h=harness({native:true});await h.start(seat,new AbortController().signal);

// Execute the production seat bootstrap, not a facsimile: a cached access
// receipt must settle the actual restore flags without starting the host poll.
const live=readSource('../src/views/Live.tsx'),bootstrapStart=live.indexOf('  // A Producer appearance renders its own room'),bootstrapEnd=live.indexOf('  useEffect(() => {\n    refresh();',bootstrapStart);
assert(bootstrapStart>0&&bootstrapEnd>bootstrapStart);
const bootstrapCode=ts.transpileModule(live.slice(bootstrapStart,bootstrapEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function bootstrap({receipt,read=async()=>hostAccess}={}){
 const state={authorized:false,pending:false,refreshes:0,reads:0,grants:null,errors:[]},asked={current:false},role={current:'host'};let active=true,dispose;
 const context={Promise,Error,DOMException,producerLocalAccess,seat:{endpointId:'local',videoSource:'program'},room:{id:'selected'},savedRoomConfig:{server_room_id:'server-room'},activeEndpointId:()=>active?'local':'other',roomEngineRef:{current:{}},entryAccessRef:{current:receipt},boominRoomRef:{current:true},
  useEffect:fn=>{dispose=fn();},ensureEndpoint:async()=> 'local',guestsIpc:{access:async()=>{state.reads++;return read();}},accessAsked:asked,roomRoleRef:role,
  setProducerLocalAuthorized:v=>state.authorized=v,setAccessPending:v=>state.pending=v,setRoomRole:v=>state.role=v,setRoomAccess:v=>state.access=v,setRoomGrants:v=>state.grants=v,roomAccessFrom:model.roomAccessFrom,
  refresh:()=>{state.refreshes++;},notifyError:e=>state.errors.push(e.message)};
 vm.runInNewContext(bootstrapCode,context);return {state,asked,role,stop:()=>{dispose();},switchWorkspace:()=>active=false};
}
let boot=bootstrap({receipt:h.calls[1].access});await new Promise(r=>setTimeout(r,0));assert.equal(boot.state.authorized,true);assert.equal(boot.asked.current,true);assert.equal(boot.role.current,'host');assert.equal(boot.state.pending,false);assert.equal(boot.state.refreshes,1);
// Home's exact receipt is consumed without a second round-trip.
h=harness();await h.start(seat,new AbortController().signal);boot=bootstrap({receipt:h.calls[1].access});await new Promise(r=>setTimeout(r,0));assert.equal(boot.state.reads,0);assert.equal(boot.state.authorized,true);assert.equal(boot.state.grants[0].id,'local-grant');
// A mismatched receipt is ignored; the exact local room is checked afresh.
boot=bootstrap({receipt:{endpointId:'other',serverRoomId:'remote-venue',result:Promise.resolve(hostAccess)},read:async()=>({available:true,denied:true})});await new Promise(r=>setTimeout(r,0));assert.equal(boot.state.reads,1);assert.equal(boot.state.authorized,false);assert.equal(boot.role.current,'viewer');assert.equal(boot.state.errors.length,1);
const late=deferred();boot=bootstrap({read:()=>late.promise});await new Promise(r=>setTimeout(r,0));boot.stop();late.resolve(hostAccess);await new Promise(r=>setTimeout(r,0));assert.equal(boot.state.authorized,false);assert.equal(boot.state.refreshes,0);
const switched=deferred();boot=bootstrap({read:()=>switched.promise});await new Promise(r=>setTimeout(r,0));boot.switchWorkspace();switched.resolve(hostAccess);await new Promise(r=>setTimeout(r,0));assert.equal(boot.state.authorized,false);assert.equal(boot.state.refreshes,0);

// Execute each actual publisher effect with a seat. Referencing any host-only
// dependency would throw; no roster, RTC or local scene publisher may start.
const tree=ts.createSourceFile('Live.tsx',live,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),effects=[];
function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]&&ts.isArrowFunction(node.arguments[0])){const body=node.arguments[0].getText(tree);if(body.includes('new RoomControlLink')||body.includes('rosterPollRef.current!.generation')||body.includes('const config = boominStageConfig'))effects.push(body);}ts.forEachChild(node,visit);}visit(tree);assert.equal(effects.length,3);
for(const effect of effects)vm.runInNewContext(ts.transpileModule('('+effect+')();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{seat:{},room:{id:'selected'},cfg:{server_room_id:'local-room'}});
// The candidate attaches an outgoing seat to a real local host. Each actual
// host effect must pass its mode guard, independently of that remote seat.
for(const effect of effects){
 const reached=new Error('local host ownership reached'),owner=new Proxy({},{get(){throw reached;},set(){throw reached;}}),context={seat:undefined,outgoingSeat:{nativeProgram:true},room:{id:'selected'},cfg:{server_room_id:'local-room'},roomRole:'host',boominRoom:true,
  sceneOrderRef:owner,controlRef:owner,rosterPollRef:owner};
 assert.throws(()=>vm.runInNewContext(ts.transpileModule('('+effect+')();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context),error=>error===reached);
}
console.log('PASS local access bootstrap: exact raw receipt handoff, strict local authorization, cancellation, legacy guest isolation and native outgoing appearances preserving local roster/control/scene publishers.');
