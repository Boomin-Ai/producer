import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness({enabled=true,deferredStart=false,deferredEnabled=false,stopFailures=0,deferredControls=false,hangFirstStop=false}={}){
 const calls=[],updates=[],revoked=[],timers=new Map();let next=1,failures=0,resolveStart,resolveEnabled,resolveControls;
 let phase='live',hasProgram=false,previewBytes=new ArrayBuffer(8),statusId='appearance-one',clock=0,statusFailure=false,stops=0;
 const status=()=>({appearanceId:statusId,phase,onStage:true,hasProgram,hasAudio:true,returnSourceId:'private-return',width:1280,height:720,fps:30});
 const exports={};
 const invoke=async(command,args)=>{
  calls.push({command,args});
  if(command==='live_appearance_enabled')return deferredEnabled?new Promise(resolve=>{resolveEnabled=resolve;}):enabled;
  if(command==='live_appearance_start')return deferredStart?new Promise(resolve=>{resolveStart=()=>resolve(status());}):status();
  if(command==='live_appearance_status'){if(statusFailure)throw Error('native status unavailable');return status();}
  if(command==='live_appearance_preview')return previewBytes;
  if(command==='live_appearance_controls')return deferredControls?new Promise(resolve=>{resolveControls=resolve;}):undefined;
  if(command==='live_appearance_stop'){stops++;if(hangFirstStop&&stops===1)return new Promise(()=>{});if(stopFailures-->0)throw Error('native stop unavailable');return;}
  throw Error('Unexpected native operation '+command);
 };
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/nativeAppearance.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{
  exports,require:name=>{assert.equal(name,'./nativeInvoke');return {invoke};},crypto:{randomUUID:()=>statusId},
  performance:{now:()=>clock},ArrayBuffer,Blob,URL:{createObjectURL:()=>`blob:preview-${next++}`,revokeObjectURL:url=>revoked.push(url)},
  window:{setTimeout(fn){const id=next++;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}},
 });
 const owner=new exports.NativeAppearance({localRoomId:'local-room',api:'https://api.boomin.ai/v1/connect',invite:'private-capability',participantId:'remote-guest',portrait:false,quality:720},
  (s,preview,playback)=>updates.push({status:s,preview,playback}),()=>{failures++;});
 return {owner,calls,updates,revoked,timers,get failures(){return failures;},setPhase:value=>{phase=value;},
  setHasProgram:value=>{hasProgram=value;},setBytes:value=>{previewBytes=value;},wrongOwner:()=>{statusId='replacement';},
  setStatusFailure:value=>{statusFailure=value;},
  resolveStart:()=>resolveStart(),resolveEnabled:value=>resolveEnabled(value),resolveControls:()=>resolveControls(),
  async tick(){clock+=600;const work=[...timers.values()];timers.clear();for(const fn of work)fn();await flush();},
 };
}

test('native candidate refuses disabled build without starting capture or falling back',async()=>{
 const h=harness({enabled:false});await assert.rejects(h.owner.start(),/unavailable/);
 assert.deepEqual(h.calls.map(c=>c.command),['live_appearance_enabled']);assert.equal(h.timers.size,0);
});
test('native initial publication receives waiting-room mute/camera controls atomically',async()=>{
 const h=harness();await h.owner.start(true,true);await flush();
 const start=h.calls.find(c=>c.command==='live_appearance_start');assert.deepEqual(JSON.parse(JSON.stringify(start.args.controls)),{muted:true,cameraOff:true,playback:false});
 assert.equal(start.args.quality,720);assert.equal(start.args.localRoomId,'local-room');
 assert.ok(h.calls.every(c=>!c.command.includes('virtual')&&!c.command.includes('audio_read')));
 await h.owner.close();assert.equal(h.timers.size,0);
});
test('leave during capability preflight cannot start a late native publisher',async()=>{
 const h=harness({deferredEnabled:true}),start=h.owner.start();await flush();const closing=h.owner.close();h.resolveEnabled(true);await start;await closing;
 assert.equal(h.calls.filter(c=>c.command==='live_appearance_start').length,0);assert.equal(h.updates.length,0);
});
test('leave during native startup fences late state and explicitly retires its owned ID',async()=>{
 const h=harness({deferredStart:true}),start=h.owner.start();await flush();let retired=false;const closing=h.owner.close().then(()=>{retired=true;});await flush();assert.equal(retired,false);h.resolveStart();await start;await closing;
 assert.equal(h.updates.length,0);assert.equal(h.timers.size,0);
 assert.ok(h.calls.filter(c=>c.command==='live_appearance_stop').every(c=>c.args.appearanceId==='appearance-one'));
});
test('native controls preserve order and playback requires its own explicit action',async()=>{
 const h=harness();await h.owner.start();await flush();
 assert.equal(h.calls.filter(c=>c.command==='live_appearance_controls').length,0);
 await Promise.all([h.owner.controls(true,false),h.owner.controls(false,true),h.owner.enableAudio()]);
 const controls=h.calls.filter(c=>c.command==='live_appearance_controls').map(c=>JSON.parse(JSON.stringify(c.args.controls)));
 assert.deepEqual(controls,[{muted:true,cameraOff:false,playback:false},{muted:false,cameraOff:true,playback:false},{muted:false,cameraOff:true,playback:true}]);
 await h.owner.close();
});
test('controls during startup wait for registration and retain requested monitoring across later mute',async()=>{
 const h=harness({deferredStart:true}),starting=h.owner.start();await flush();
 const audio=h.owner.enableAudio(),mute=h.owner.controls(true,true);await flush();
 assert.equal(h.calls.filter(c=>c.command==='live_appearance_controls').length,0);
 h.resolveStart();await Promise.all([starting,audio,mute]);
 const controls=h.calls.filter(c=>c.command==='live_appearance_controls').map(c=>JSON.parse(JSON.stringify(c.args.controls)));
 assert.deepEqual(controls,[{muted:false,cameraOff:false,playback:true},{muted:true,cameraOff:true,playback:true}]);
 await h.owner.close();
});
test('native return previews are bounded and revoked when freshness expires or owner leaves',async()=>{
 const h=harness();await h.owner.start();await flush();h.setHasProgram(true);await h.tick();
 assert.match(h.updates.at(-1).preview,/^blob:/);h.setHasProgram(false);await h.tick();assert.equal(h.updates.at(-1).preview,null);assert.equal(h.revoked.length,1);
 h.setHasProgram(true);await h.tick();await h.owner.close();assert.equal(h.revoked.length,2);assert.equal(h.timers.size,0);
});
test('wrong-owner responses or oversized previews terminate only the outgoing owner',async()=>{
 for(const problem of ['owner','size']){
  const h=harness();await h.owner.start();await flush();
  if(problem==='owner')h.wrongOwner();else{h.setHasProgram(true);h.setBytes(new ArrayBuffer(512*1024+1));}
  await h.tick();assert.equal(h.failures,1);assert.equal(h.timers.size,0);
  assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,1);
  assert.ok(h.calls.every(c=>!c.command.includes('restore')&&!c.command.includes('stop_live')));
 }
});
test('repeated close shares the retirement receipt and stops once',async()=>{
 const h=harness();await h.owner.start();await flush();const a=h.owner.close(),b=h.owner.close();assert.equal(a,b);await a;
 assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,1);
});
test('a rejected native stop can be explicitly retried for the same owned ID',async()=>{
 const h=harness({stopFailures:1});await h.owner.start();await flush();await assert.rejects(h.owner.close());
 await h.owner.close();assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,2);
 assert.ok(h.calls.filter(c=>c.command==='live_appearance_stop').every(c=>c.args.appearanceId==='appearance-one'));
 assert.equal(h.calls.filter(c=>c.command==='live_appearance_start').length,1);assert.equal(h.timers.size,0);
});
test('an unacknowledged control cannot block the exact native stop receipt',async()=>{
 const h=harness({deferredControls:true});await h.owner.start();await flush();const control=h.owner.enableAudio();await flush();
 await h.owner.close();assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,1);
 h.resolveControls();await control;assert.equal(h.timers.size,0);assert.equal(h.updates.at(-1).playback,false);
});
test('explicit retry sends the same exact native stop even if an earlier response never settles',async()=>{
 const h=harness({hangFirstStop:true});await h.owner.start();await flush();void h.owner.close();await flush();
 await h.owner.close(true);const stops=h.calls.filter(c=>c.command==='live_appearance_stop');assert.equal(stops.length,2);assert.ok(stops.every(c=>c.args.appearanceId==='appearance-one'));
 await h.owner.close();assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,2);
});
test('status failure plus stop rejection remains terminal and available for explicit stop retry',async()=>{
 const h=harness({stopFailures:1});await h.owner.start();await flush();h.setStatusFailure(true);await h.tick();await flush();
 assert.equal(h.failures,1);assert.equal(h.timers.size,0);await h.owner.close();assert.equal(h.calls.filter(c=>c.command==='live_appearance_stop').length,2);
});
