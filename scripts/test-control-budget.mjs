import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';

const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/features/presentation/schema';export * from './src/features/presentation/controlBudget';export * from './src/features/presentation/authoring/service';export * from './src/features/presentation/authoring/catalog';export * from './src/features/presentation/authoring/brief';export * from './src/features/assistant/authoringTools';export * from './src/features/presentation/rehearsal';export * from './src/features/presentation/projection';`},bundle:true,platform:'node',format:'esm',write:false});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const classic=api.parsePackage(JSON.parse(readFileSync('docs/shows/classic.json','utf8')));
assert.equal(api.MAX_SET_CONTROLS,128);
assert.equal(api.presentationJsonSchema.properties.set.properties.controls.maxItems,api.MAX_SET_CONTROLS);
assert.equal(api.AUTHORING_CATALOG.limits.controls,api.MAX_SET_CONTROLS);
assert.deepEqual(api.setControlBudget(classic),{used:40,limit:128,remaining:88,counts:{button:21,text:16,number:3},scope:'All authored buttons, text fields and numeric controls share this limit. Registered operator components have a separate limit.'});
assert.equal(api.inspectAuthoredSet(classic).controlBudget.remaining,88);
assert.equal(JSON.parse(await api.designBrief(classic,'Add Pink')).controlBudget.remaining,88);

const target={catalogRevision:api.AUTHORING_CATALOG.revision,features:[...api.AUTHORING_CATALOG.features]};
const session=await api.createSetAuthoringSession(classic,target);
const worker={call:async(method)=>{const s=session.snapshot();if(method==='inspect')return {revision:s.revision,...api.inspectAuthoredSet(s.document)};throw Error(method);},edit:(baseRevision,command,label,operationId)=>session.edit({baseRevision,command,label,operationId})};
const pink={id:'pink',type:'button',label:'Pink accent',action:{type:'value.set',key:'glowColor',value:'#F4A6CD'}};
const before=session.snapshot();
const look=classic.set.controlArrangement.sections.findIndex(s=>s.id==='look');
const operations=[{op:'add',path:'/set/controls/-',value:pink},{op:'add',path:`/set/controlArrangement/sections/${look}/controls/-`,value:'set:pink'}];
const receipt=await api.executeSetTool(worker,{type:'function_call',name:'edit_set',call_id:'pink-once',arguments:JSON.stringify({baseRevision:before.revision,label:'Add Pink accent',command_json:JSON.stringify({type:'canonical',edit:{schema:'producer.set-edit/2',baseRevision:before.revision,operations}})})},()=>{},()=>true);
const result=session.snapshot();
assert.equal(receipt.controlBudget.used,41);assert.equal(receipt.controlBudget.remaining,87);
assert.equal((await worker.call('inspect')).controlBudget.used,41);
assert.deepEqual(result.document.set.controls.slice(0,40),classic.set.controls,'adding Pink preserves every existing control, including Mint and Silver');
assert.deepEqual(result.document.set.layouts,classic.set.layouts);
assert.deepEqual(result.document.set.values,classic.set.values);
assert.deepEqual(result.document.set.slots,classic.set.slots);
assert.deepEqual(result.document.set.operatorComponents,classic.set.operatorComponents);
const pinkSession=new api.RehearsalSession(result.document);
for(const theme of ['dark','light'])for(const layout of classic.set.layouts){
 pinkSession.send({type:'field',key:'theme',value:theme});pinkSession.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});
 pinkSession.send({type:'control',action:pink.action});assert.equal(pinkSession.snapshot().values.glowColor,'#F4A6CD');
 const state=pinkSession.snapshot();
 assert.deepEqual(api.outputProjection(result.document,state),api.outputProjection(classic,state),'the extra preset changes no render graph at the same color and animation clock');
}

const full=structuredClone(result.document);
while(full.set.controls.length<128)full.set.controls.push({...pink,id:'extra-'+full.set.controls.length,label:'Extra preset '+full.set.controls.length});
api.parsePackage(full);assert.equal(api.setControlBudget(full).remaining,0);
const fullSession=await api.createSetAuthoringSession(full,target),fullBefore=fullSession.snapshot();
await assert.rejects(fullSession.edit({operationId:'overflow',baseRevision:fullBefore.revision,label:'One too many',command:{type:'canonical',edit:{schema:'producer.set-edit/2',baseRevision:fullBefore.revision,operations:[{op:'add',path:'/set/controls/-',value:{...pink,id:'over-budget'}}]}}}),/Set control budget exceeded: 129\/128/);
assert.equal(fullSession.snapshot().revision,fullBefore.revision,'over-budget candidate cannot replace the draft');
assert.equal(fullSession.snapshot().checkpoints.length,fullBefore.checkpoints.length);
assert.equal((await session.moveHistory('undo',result.revision)).revision,before.revision);
assert.equal((await session.moveHistory('redo',before.revision)).revision,result.revision);
console.log('PASS control budget: 128 accepted/129 atomically rejected; shared catalog/schema; live Assistant capacity receipts; Pink added without removing Mint/Silver; identical render graphs in all 16 canvases and both themes; undo/redo.');
