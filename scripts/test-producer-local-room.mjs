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
const home=readSource('../src/views/Home.tsx'),start=home.indexOf('  const startSeat = useCallback('),end=home.indexOf('  if (view.kind === "opening")',start);
assert(start>0&&end>start);const code=ts.transpileModule(home.slice(start,end)+'\nexports.start=startSeat;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function harness({rooms,access,streaming=false,recording=false}={}){
 const calls=[],exports={},room={id:'selected',endpoint_id:'local',config:'{}'};let active='local';
 const endpoint={id:'local',kind:'connected',base_url:'https://local.example/v1/app/producer'},context={exports,DOMException,Error,Promise,producerLocalAccess,useCallback:fn=>fn,endpoints:[endpoint],activeEndpointId:()=>active,
  ipc:{liveListRooms:async()=>rooms??[room],liveEngineStatus:async()=>({session_state:streaming?'streaming':'idle'})},guests:{access:async()=>access??hostAccess},recording:{list:async()=>recording?[{status:'recording'}]:[]},roomMetadata:()=>({server_room_id:'server-room'}),isBoomin:()=>true,
  roomExit:{current:{cancel:()=>calls.push('cancelExit')}},markRoomClick:()=>{},setNetworkSheet:()=>{},setPendingSeat:()=>{},setView:value=>calls.push(value)};
 vm.runInNewContext(code,context);return {start:exports.start,calls,room,switchWorkspace:()=>active='other'};
}
const seat={endpointId:'local',videoSource:'program',localRoomId:'selected'};
let h=harness();await h.start(seat,new AbortController().signal);assert.equal(h.calls[1].room.id,'selected');assert.equal(h.calls[1].access.endpointId,'local');assert.equal(h.calls[1].access.serverRoomId,'server-room');assert.equal(h.calls[1].access.endpointBaseUrl,'https://local.example/v1/app/producer');assert.equal(await h.calls[1].access.result,hostAccess);
const rooms=deferred(),abort=new AbortController();h=harness({rooms:rooms.promise});const pending=h.start(seat,abort.signal);abort.abort();rooms.resolve([h.room]);await assert.rejects(pending,{name:'AbortError'});assert.equal(h.calls.length,0);
const access=deferred(),close=new AbortController();h=harness({access:access.promise});const authorizing=h.start(seat,close.signal);await new Promise(r=>setTimeout(r,0));close.abort();access.resolve(hostAccess);await assert.rejects(authorizing,{name:'AbortError'});assert.equal(h.calls.length,0);
for(const options of [{rooms:[]},{access:{available:false}},{access:{available:true,denied:true}},{access:{available:true,access:{role:'viewer'}}},{access:{available:true,access:{role:'manager',can:{manage:true}}}},{access:{available:true,access:{role:'host',can:{manage:false}}}},{streaming:true},{recording:true}]){h=harness(options);await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);}
h=harness();h.switchWorkspace();await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);
h=harness({streaming:true,recording:true});await h.start({...seat,videoSource:'webcam'},new AbortController().signal);assert.equal(h.calls[1].room,undefined);
console.log('PASS local program admission: exact room, cancellation during reads/authorization, workspace fencing, missing room, unknown/viewer access, stream/record safety and lightweight webcam.');

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
console.log('PASS local access bootstrap: exact raw receipt handoff, no duplicate fetch, strict host authorization, wrong-room receipt rejection, unmount/workspace cancellation and no host roster/control publisher during appearances.');
