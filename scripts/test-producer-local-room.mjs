import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const home=readFileSync(new URL('../src/views/Home.tsx',import.meta.url),'utf8'),start=home.indexOf('  const startSeat = useCallback('),end=home.indexOf('  if (view.kind === "opening")',start);
assert(start>0&&end>start);const code=ts.transpileModule(home.slice(start,end)+'\nexports.start=startSeat;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function harness({rooms,access,streaming=false,recording=false}={}){
 const calls=[],exports={},room={id:'selected',endpoint_id:'local',config:'{}'};let active='local';
 const endpoint={id:'local',kind:'connected'},context={exports,DOMException,Error,useCallback:fn=>fn,endpoints:[endpoint],activeEndpointId:()=>active,
  ipc:{liveListRooms:async()=>rooms??[room],liveEngineStatus:async()=>({session_state:streaming?'live':'idle'})},recording:{list:async()=>recording?[{status:'recording'}]:[]},roomMetadata:()=>({server_room_id:'server-room'}),isBoomin:()=>true,myRoomAccess:async()=>access??{known:true,can:{manage:true}},
  roomExit:{current:{cancel:()=>calls.push('cancelExit')}},markRoomClick:()=>{},setNetworkSheet:()=>{},setPendingSeat:()=>{},setView:value=>calls.push(value)};
 vm.runInNewContext(code,context);return {start:exports.start,calls,room,switchWorkspace:()=>active='other'};
}
const seat={endpointId:'local',videoSource:'program',localRoomId:'selected'};
let h=harness();await h.start(seat,new AbortController().signal);assert.equal(h.calls[1].room.id,'selected');
const rooms=deferred(),abort=new AbortController();h=harness({rooms:rooms.promise});const pending=h.start(seat,abort.signal);abort.abort();rooms.resolve([h.room]);await assert.rejects(pending,{name:'AbortError'});assert.equal(h.calls.length,0);
const access=deferred(),close=new AbortController();h=harness({access:access.promise});const authorizing=h.start(seat,close.signal);await new Promise(r=>setTimeout(r,0));close.abort();access.resolve({known:true,can:{manage:true}});await assert.rejects(authorizing,{name:'AbortError'});assert.equal(h.calls.length,0);
for(const options of [{rooms:[]},{access:{known:false,can:{manage:true}}},{access:{known:true,can:{manage:false}}},{streaming:true},{recording:true}]){h=harness(options);await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);}
h=harness();h.switchWorkspace();await assert.rejects(h.start(seat,new AbortController().signal));assert.equal(h.calls.length,0);
h=harness({streaming:true,recording:true});await h.start({...seat,videoSource:'webcam'},new AbortController().signal);assert.equal(h.calls[1].room,undefined);
console.log('PASS local program admission: exact room, cancellation during reads/authorization, workspace fencing, missing room, unknown/viewer access, stream/record safety and lightweight webcam.');
