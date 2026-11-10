import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
// Execute the production adapter getter so a session emitter can change mode
// before React has rendered another context value.
const source=readFileSync('src/views/Live.tsx','utf8'),tree=ts.createSourceFile('Live.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const getters=[];
function visit(node){
 if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='setCameraBackground'){
  const find=child=>{if(ts.isPropertyAssignment(child)&&child.name.getText(tree)==='current')getters.push(child.initializer.getText(tree));ts.forEachChild(child,find);};find(node);
 }
 ts.forEachChild(node,visit);
}
visit(tree);assert.equal(getters.length,1,'Find the production camera-background authority getter');
const currentContext=new Function('cameraBackgroundContext','roomEngineRef',`return (${getters[0]})();`);
const bundle=await build({stdin:{contents:"export * from './src/lib/cameraBackground'; export * from './src/lib/roomSession'; export * from './src/lib/sourceFilters';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {cameraBackgroundControls,roomSession,withSourceFilters}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const initialMask=(settings={},enabled=true)=>({name:'My cutout',kind:'producer_person_mask',enabled,settings:{mode:'off',quality:'balanced',feather:0.3,edge_refine:0.6,...settings}});
function fixture(initial=[]){
 let chain=structuredClone(initial),gate,saveGate,rejectSave=false,room={sources:{extras:[{id:'camera-a',label:'Camera',spec:{type:'camera'}},{id:'camera-b',label:'Other',spec:{type:'camera'}}]},scenes:[]};
 const calls=[],saved=[],owner=roomSession();
 const session={workspaceMode:'live',snapshot(){return {workspaceMode:this.workspaceMode};}};
 const context={room:'room-a',owner,set:session,enabled:true,bindings:{host:'camera-a'},sources:{items:[{id:'camera-a',kind:'camera',device:'device-a'},{id:'camera-b',kind:'camera',device:'device-b'},{id:'screen',kind:'screen'}]}};
 const controls=cameraBackgroundControls({current:()=>currentContext({current:context},{current:context.owner}),filters:async(source,op)=>{
  calls.push({source,...op});if(gate){const pending=gate;gate=null;await pending.promise;}
  if(op.op==='add')chain.push({name:op.name,kind:op.kind,enabled:true,settings:{mode:'off',quality:'auto'}});
  if(op.op==='update')Object.assign(chain.find(item=>item.name===op.name).settings,op.settings);
  if(op.op==='enable')chain.find(item=>item.name===op.name).enabled=op.on;
  return structuredClone(chain);
 },persist:async(source,next)=>{saved.push({source,chain:structuredClone(next)});if(saveGate){const pending=saveGate;saveGate=null;await pending.promise;}if(rejectSave){rejectSave=false;throw Error('Room save failed');}room=withSourceFilters(room,source,next);}});
 return {context,session,controls,calls,saved,owner,get chain(){return chain;},get room(){return room;},gate(){return gate=defer();},saveGate(){return saveGate=defer();},rejectSave(){rejectSave=true;}};
}
let checks=0;
async function test(name,fn){await fn();console.log('PASS:',name);checks++;}
await test('Framed on an ordinary camera reads without adding a filter',async()=>{
 const f=fixture();assert.equal(await f.controls.set('host','camera-a','framed'),'framed');assert.deepEqual(f.calls,[{source:'camera-a',op:'list'}]);assert.equal(f.saved.length,0);
});
await test('Cutout and Framed reuse one filter and preserve the camera document',async()=>{
 const f=fixture([{name:'Cutout',kind:'color_filter_v2',enabled:true,settings:{brightness:0.12}}]);
 assert.equal(await f.controls.set('host','camera-a','cutout'),'cutout');
 assert.equal(await f.controls.set('host','camera-a','framed'),'framed');
 assert.equal(await f.controls.set('host','camera-a','cutout'),'cutout');
 assert.equal(f.calls.filter(c=>c.op==='add').length,1);assert.equal(f.chain[1].name,'Cutout 2');
 assert.deepEqual(f.chain[0],{name:'Cutout',kind:'color_filter_v2',enabled:true,settings:{brightness:0.12}});
 assert.equal(f.room.sources.extras.length,2);assert.deepEqual(f.room.sources.extras[0].filters,f.chain);assert.equal(f.room.sources.extras[1].filters,undefined);
});
await test('Existing disabled filter keeps quality, edge settings and chain order',async()=>{
 const f=fixture([{name:'Color',kind:'color_filter_v2',enabled:true,settings:{contrast:0.2}},initialMask({},false)]);
 assert.equal(await f.controls.set('host','camera-a','cutout'),'cutout');assert.equal(f.calls.filter(c=>c.op==='add').length,0);
 assert.deepEqual(f.chain[1],initialMask({mode:'cut'},true));assert.equal(f.chain[0].name,'Color');
});
await test('Rapid opposite toggles serialize native edits and persistence in click order',async()=>{
 const f=fixture([initialMask()]),gate=f.saveGate();
 const first=f.controls.set('host','camera-a','cutout'),second=f.controls.set('host','camera-a','framed');
 await tick();assert.equal(f.calls.filter(c=>c.op==='update').length,1);assert.equal(f.calls.filter(c=>c.op==='list').length,1);
 gate.resolve();assert.deepEqual(await Promise.all([first,second]),['cutout','framed']);assert.equal(f.chain[0].settings.mode,'off');
 assert.deepEqual(f.saved.map(save=>save.chain[0].settings.mode),['cut','off']);
});
await test('Retry after save failure persists the already-changed native mode',async()=>{
 const f=fixture([initialMask()]);f.rejectSave();await assert.rejects(f.controls.set('host','camera-a','cutout'),/Room save failed/);
 assert.equal(f.chain[0].settings.mode,'cut');assert.equal(f.room.sources.extras[0].filters,undefined);
 assert.equal(await f.controls.set('host','camera-a','cutout'),'cutout');assert.equal(f.calls.filter(call=>call.op==='update').length,1);
 assert.equal(f.saved.length,2);assert.equal(f.room.sources.extras[0].filters[0].settings.mode,'cut');
});
await test('A queued toggle cannot write a camera after its slot was rebound',async()=>{
 const f=fixture([initialMask()]),hold=defer();const blocker=f.owner.run(()=>hold.promise);
 const pending=f.controls.set('host','camera-a','cutout');f.context.bindings.host='camera-b';hold.resolve();await blocker;
 await assert.rejects(pending,/assignment or room changed/);assert.equal(f.calls.length,0);
});
await test('Reassignment during native read fences mutation and completion',async()=>{
 const f=fixture([initialMask()]),gate=f.gate(),pending=f.controls.set('host','camera-a','cutout');await tick();
 f.context.bindings.host='camera-b';gate.resolve();await assert.rejects(pending,/assignment or room changed/);assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);
});
await test('Prepare/rehearsal mode changes fence delayed reads and queued mutations before React rerenders',async()=>{
 for(const workspaceMode of ['prepare','rehearsal']){
  const f=fixture([initialMask()]),gate=f.gate(),pending=f.controls.set('host','camera-a','cutout');await tick();
  f.session.workspaceMode=workspaceMode;gate.resolve();await assert.rejects(pending,/assignment or room changed/);
  assert.equal(f.context.enabled,true,'The last rendered context still says enabled');assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);
  await assert.rejects(f.controls.read('host','camera-a'));assert.equal(f.calls.length,1,'New private-mode reads are refused');
  const queued=fixture(),hold=defer(),blocker=queued.owner.run(()=>hold.promise),write=queued.controls.set('host','camera-a','cutout');
  queued.session.workspaceMode=workspaceMode;hold.resolve();await blocker;await assert.rejects(write);assert.equal(queued.calls.length,0);
 }
});
await test('Native mutation receipts persist only the original source, never a successor claim',async()=>{
 const f=fixture([initialMask()]),gate=f.saveGate(),pending=f.controls.set('host','camera-a','cutout');await tick();
 f.context.bindings.host='camera-b';gate.resolve();await assert.rejects(pending,/assignment or room changed/);
 assert.equal(f.saved.length,1);assert.equal(f.saved[0].source,'camera-a');assert.equal(f.room.sources.extras[0].filters[0].settings.mode,'cut');assert.equal(f.room.sources.extras[1].filters,undefined);
});
await test('Room exit waits for persistence and fences a queued old-owner toggle',async()=>{
 const f=fixture([initialMask()]),gate=f.saveGate(),first=f.controls.set('host','camera-a','cutout');await tick();
 const second=f.controls.set('host','camera-a','framed');let released=false;const closed=f.owner.close(async()=>{released=true;});
 f.context.owner=null;gate.resolve();await assert.rejects(first,/assignment or room changed/);await assert.rejects(second,/assignment or room changed/);await closed;
 assert.equal(released,true);assert.equal(f.calls.filter(c=>c.op==='update').length,1);
});
await test('Host authority, active output, source kind, Set and device identity remain fenced',async()=>{
 for(const mutate of [f=>f.context.enabled=false,f=>f.context.bindings.host='screen']){
  const f=fixture();mutate(f);await assert.rejects(f.controls.set('host',f.context.bindings.host,'cutout'));assert.equal(f.calls.length,0);
 }
 for(const mutate of [f=>f.context.set={snapshot:()=>({workspaceMode:'live'})},f=>f.context.sources.items[0].device='replacement']){
  const f=fixture(),gate=f.gate(),pending=f.controls.set('host','camera-a','cutout');await tick();mutate(f);gate.resolve();await assert.rejects(pending);assert.equal(f.calls.length,1);
 }
});
await test('Ambiguous and native-failed Cutout chains report errors without false confirmation',async()=>{
 const f=fixture([initialMask(),{...initialMask(),name:'Second'}]);await assert.rejects(f.controls.set('host','camera-a','cutout'),/multiple Cutout/);assert.equal(f.calls.length,1);
 const bad=fixture([{...initialMask({mode:'cut'}),error:'Cutout unavailable'}]);await assert.rejects(bad.controls.read('host','camera-a'),/Cutout unavailable/);
 assert.equal(await fixture([initialMask({mode:'soft'})]).controls.read('host','camera-a'),'soft');
});
console.log(`${checks} camera-background ownership/transaction checks passed`);
