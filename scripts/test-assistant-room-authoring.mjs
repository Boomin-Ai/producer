import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:`export * from './src/features/assistant/roomTools';export * from './src/lib/soundboard';export * from './src/features/room-control/runtime';export * from './src/features/assistant/authoringTools';export * from './src/features/presentation/authoring/service';export * from './src/features/presentation/authoring/catalog';export * from './src/features/presentation/rehearsal';export * from './src/features/presentation/schema';export * from './src/features/presentation/layoutViews';export * from './src/features/assistant/attachments';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,define:{'import.meta.env.DEV':'false'}});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let calls=0,approvals=0,allowed=true,epoch='first';
const reports=[];
const studioDrafts=[];
const state={name:'Test room',host:true,ready:true,config:{layout:{left:['assistant']},sizes:{}},docks:{left:{open:true}},sources:{items:[{id:'camera',label:'Host camera',kind:'camera',visible:true,token:'secret'}]},scenes:[{id:'active',name:'On air',look:{camera:{visible:true}}},{id:'draft',name:'Prepared',look:{}}],activeScene:'active',presentation:{document:{id:'room-set',name:'Room Set',set:{slots:[{id:'host',label:'Host'}],layouts:[]}},bindings:{host:'camera'},currentPresented:true},output:{streaming:false,recording:false},chat:{messages:['private chat']}};
const surface=()=>({epoch,roomId:'room',snapshot:()=>state,commands:{'sounds.list':()=>api.soundCueCatalog({sounds:[
  {id:'0'.repeat(64),name:'Whoosh',path:'/private/sound.mp3',purpose:'transition',description:'A quick sweep',duration_ms:679},
  {id:'1'.repeat(64),name:'Winner',path:'/private/winner.mp3',purpose:'button'},
  {id:'2'.repeat(64),name:'Unconnected import',path:'/private/import.mp3'},
],board:{pads:[{id:'0'.repeat(64),name:'Whoosh',mode:'restart'}]}}),
'studio.inspect':()=>({revision:studioDrafts.length,availableTargets:['window','setControls'],durationMs:8000}),
'studio.author':args=>{assert.equal(args.revision,studioDrafts.length);studioDrafts.push(JSON.parse(args.motion_json));return {revision:studioDrafts.length,outputChanged:false};},
'bug.draft':args=>{reports.push(args.text);return {openedForReview:true};},...Object.fromEntries(['panel.move','dock.set','scene.create','scene.select','source.devices','source.add','scene.source','set.bind'].map(command=>[command,args=>{calls++;return {command,args,id:'new'};}]))}});
let dispose=api.registerRoomControl('room',surface());
const context={roomId:'room',authorized:()=>allowed,approve:async()=>{approvals++;return true;},receipts:new Map()};
const call=(name,args={},id=crypto.randomUUID())=>({type:'function_call',namespace:'room',name,arguments:JSON.stringify(args),call_id:id});
const inspected=await api.executeAssistantRoomTool(call('inspect_room'),context);
state.presentation.document.set.layouts=[
 {id:'wide',label:'Wide demo',width:1920,height:1080},
 {id:'tall',label:'Tall demo',width:1080,height:1920},
];
state.presentation.readiness={wide:{state:'ready'},tall:{state:'error',error:'First frame failed (/Users/test/private clip.mov) token=secret-test'}};
state.presentation.error='Native source unavailable at https://example.invalid/private';
const diagnostics=(await api.executeAssistantRoomTool(call('inspect_room'),context)).set.preparation;
assert.deepEqual(diagnostics.failedLayouts,[{id:'tall',label:'Tall demo',orientation:'portrait',error:'First frame failed ([private location]) token=[redacted]'}]);
assert.equal(diagnostics.outputError,'Native source unavailable at [private location]');
assert.equal(inspected.epoch,'first');assert.equal(JSON.stringify(inspected).includes('private chat'),false);assert.equal(JSON.stringify(inspected).includes('secret'),false);
const studio=await api.executeAssistantRoomTool(call('inspect_studio_motion'),context);
assert.deepEqual(studio.availableTargets,['window','setControls']);
const motion={clips:[{id:'sweep',target:'window',startMs:200,durationMs:3300,transitionMs:650,lift:.72,zoom:1.85,angle:-16,ending:'return'}]};
const studioCall=call('author_studio_motion',{roomEpoch:inspected.epoch,revision:studio.revision,motion_json:JSON.stringify(motion)});
const authored=await api.executeAssistantRoomTool(studioCall,context);
assert.equal(authored.outputChanged,false);assert.equal(authored.result.revision,1);assert.equal(approvals,0);
await api.executeAssistantRoomTool(studioCall,context);
assert.deepEqual(studioDrafts,[motion]);
await assert.rejects(api.executeAssistantRoomTool(call('author_studio_motion',{roomEpoch:'stale',revision:1,motion_json:JSON.stringify(motion)}),context),/The room changed/);
const soundId='0'.repeat(64);
const {pads}=await api.executeAssistantRoomTool(call('list_sounds'),context);
assert.equal(pads.length,2);
assert.equal(pads[0].purpose,'transition');
assert.equal(pads[0].durationMs,679);
assert.equal(pads[1].connected,false);
assert.doesNotMatch(JSON.stringify(pads),/private|path/);
const bug=call('draft_bug_report',{roomEpoch:'first',text:'Sound starts late after pressing a pad.'});
assert.equal((await api.executeAssistantRoomTool(bug,context)).result.openedForReview,true);
await api.executeAssistantRoomTool(bug,context);
assert.deepEqual(reports,['Sound starts late after pressing a pad.']);
await assert.rejects(api.executeAssistantRoomTool(call('draft_bug_report',{roomEpoch:'stale',text:'stale'}),context),/changed/);
await assert.rejects(api.executeAssistantRoomTool(call('send_bug_report'),context),/Unsupported/);
assert.equal(calls,0);assert.equal(approvals,0);
const move=call('move_panel',{roomEpoch:'first',panel:'scenes',dock:'right'},'same');
await api.executeAssistantRoomTool(move,context);await api.executeAssistantRoomTool(move,context);assert.equal(calls,1,'a replayed tool cannot repeat its room mutation');assert.equal(approvals,0,'workspace moves do not interrupt the host');
await api.executeAssistantRoomTool(call('move_panel',{dock:'right',panel:'scenes',roomEpoch:'first'},'same'),context);assert.equal(calls,1,'argument ordering does not repeat a completed operation');
await assert.rejects(api.executeAssistantRoomTool(call('move_panel',{roomEpoch:'first',panel:'scenes',dock:'left'},'same'),context),/reused/);assert.equal(calls,1);
await assert.rejects(api.executeAssistantRoomTool(call('add_source',{roomEpoch:'first',kind:'text',label:'Unsupported native text'}),context),/Invalid room argument/);
await assert.rejects(api.executeAssistantRoomTool(call('move_panel',{roomEpoch:'old',panel:'scenes',dock:'right'}),context),/changed/);
await assert.rejects(api.executeAssistantRoomTool(call('native.invoke'),context),/Unsupported/);
await api.executeAssistantRoomTool(call('assign_scene_source',{roomEpoch:'first',sceneId:'draft',sourceId:'camera',visible:true}),context);assert.equal(approvals,0);
await api.executeAssistantRoomTool(call('assign_scene_source',{roomEpoch:'first',sceneId:'active',sourceId:'camera',visible:false}),context);assert.equal(approvals,1);
await api.executeAssistantRoomTool(call('add_source',{roomEpoch:'first',kind:'camera',label:'Camera'}),context);assert.equal(approvals,2);
const previous=calls;
await api.executeAssistantRoomTool(call('select_scene',{roomEpoch:'first',id:'draft'}),{...context,approve:async()=>false});assert.equal(calls,previous,'declined output changes have no effect');
await assert.rejects(api.executeAssistantRoomTool(call('select_scene',{roomEpoch:'first',id:'draft'}),{...context,approve:async()=>{dispose();epoch='replacement';dispose=api.registerRoomControl('room',surface());return true;}}),/ownership changed/);assert.equal(calls,previous);
allowed=false;await assert.rejects(api.executeAssistantRoomTool(call('inspect_room'),context),/authorized/);allowed=true;
await assert.rejects(api.inspectAssistantRoom('another-room'),/original room/);dispose();

const target={catalogRevision:api.AUTHORING_CATALOG.revision,features:[...api.AUTHORING_CATALOG.features]};
const original=api.parsePackage(JSON.parse(await fs.readFile('src/features/presentation/fixtures/after-hours.json','utf8')));
original.set.controlArrangement={sections:[{id:'existing',label:'Existing panel',controls:['builtin:layout',...original.set.controls.map(control=>'set:'+control.id)]}],minimized:['builtin:layout']};
const session=await api.createSetAuthoringSession(original,target);
const worker={call:async(method)=>{const snapshot=session.snapshot();if(method==='snapshot')return snapshot;if(method==='inspect')return {revision:snapshot.revision,...api.inspectAuthoredSet(snapshot.document)};throw Error(method);},edit:(baseRevision,command,label,operationId)=>session.edit({baseRevision,command,label,operationId})};
const show={id:'test-show',version:'1',initialPhase:'opening',phases:[{id:'opening',label:'Opening',layoutId:original.set.layouts[0].id,next:'closing'},{id:'closing',label:'Closing',layoutId:original.set.layouts[1].id}],choices:[]};
const showCall={type:'function_call',namespace:'producer',name:'author_show',call_id:'show-once',arguments:JSON.stringify({baseRevision:session.snapshot().revision,label:'Build actual Show',show_json:JSON.stringify(show)})};
await api.executeSetTool(worker,showCall,()=>{},()=>true);
await api.executeSetTool(worker,showCall,()=>{},()=>true);assert.equal(session.exportJournal().entries.length,1,'Show retries reuse the same atomic authoring receipt');
const document=session.snapshot().document;assert.deepEqual(document.show,show);assert.deepEqual(document.set.layouts,original.set.layouts);assert.deepEqual(document.set.controlArrangement.sections.slice(0,original.set.controlArrangement.sections.length),original.set.controlArrangement.sections);
const runner=new api.RehearsalSession(document);runner.send({type:'control',action:{type:'show.start'}});assert.equal(runner.snapshot().layoutId,show.phases[0].layoutId);runner.send({type:'control',action:{type:'show.next'}});assert.equal(runner.snapshot().layoutId,show.phases[1].layoutId);
const revision=session.snapshot().revision;
await assert.rejects(session.edit({operationId:'bad-show',baseRevision:revision,label:'Bad rundown',command:{type:'show.author',show:{...show,phases:[{id:'wrong',label:'Wrong',layoutId:'missing'}]}}}));assert.equal(session.snapshot().revision,revision);
const buttonIndex=document.set.controls.findIndex(control=>control.type==='button');
const entry=document.set.layouts[1].id;
await api.executeSetTool(worker,{type:'function_call',name:'edit_set',call_id:'sound-cues',arguments:JSON.stringify({
  baseRevision:revision,label:'Add sound cues',command_json:JSON.stringify({type:'canonical',edit:{
    schema:'producer.set-edit/2',baseRevision:revision,operations:[
      {op:'add',path:`/set/controls/${buttonIndex}/soundId`,value:soundId},
      {op:'add',path:'/set/layouts/1/transitionSoundId',value:soundId},
    ],
  }}),
})},()=>{},()=>true);
const withCues=session.snapshot();
assert.equal(withCues.document.set.controls[buttonIndex].soundId,soundId);
assert.equal(api.layoutTransitionSound(withCues.document.set,document.set.layouts[0].id,entry),soundId);
assert.equal(api.layoutTransitionSound(withCues.document.set,entry,entry),undefined);
assert.equal(api.layoutTransitionSound(withCues.document.set,'',entry),undefined);
const paired=structuredClone(withCues.document.set);
paired.views={...paired.views,paired:{landscape:document.set.layouts[0].id,portrait:entry}};
assert.equal(api.layoutTransitionSound(paired,document.set.layouts[0].id,entry),undefined);
const malformed=structuredClone(withCues.document);
malformed.set.layouts[1].transitionSoundId='/tmp/sound.wav';
assert.throws(()=>api.parsePackage(malformed),/transitionSoundId/);
const localRunner=new api.RehearsalSession(withCues.document);
let cueCount=0;
assert.equal(localRunner.send({type:'control',action:{type:'layout.select',layoutId:'missing'}},()=>cueCount++),false);
assert.equal(localRunner.send({type:'control',action:{type:'layout.select',layoutId:entry}},()=>cueCount++),true);
assert.equal(cueCount,1);
const liveRunner=new api.RehearsalSession(withCues.document,undefined,'live');
let result={status:'rejected',revision:0,error:'Stale control'};
liveRunner.attachControlTransport(async()=>result,true);
const click=()=>liveRunner.send({type:'control',action:{type:'layout.select',layoutId:entry}},()=>cueCount++);
click();await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(cueCount,1);
result={status:'committed',revision:1,moduleEpoch:0};
click();await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(cueCount,2);
const asset={name:'test.png',mime:'image/png',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='};
await session.edit({operationId:'asset',baseRevision:withCues.revision,label:'Import production asset',command:{type:'asset.import',id:'approvedAsset',asset}});
const privateContext=api.inspectAuthoredSet(session.snapshot().document);assert.equal(JSON.stringify(privateContext).includes('base64,'),false);
await assert.rejects(api.executeSetTool(worker,{type:'function_call',name:'edit_set',call_id:'evil',arguments:JSON.stringify({baseRevision:session.snapshot().revision,label:'Fake asset',command_json:JSON.stringify({type:'asset.import',id:'injected',asset})})},()=>{},()=>true),/Unsupported model/);
const content=api.attachmentContent('Use the logo',[{id:'ref',name:'reference.png',mime:'image/png',purpose:'reference',image:asset.data},{id:'prod',name:'logo.png',mime:'image/png',purpose:'production',assetId:'approvedAsset'}]);
assert.equal(content.filter(part=>part.type==='input_image').length,1);assert.match(content[1].text,/Inspiration must not be placed/);assert.match(content.at(-1).text,/approvedAsset/);
console.log('PASS Assistant room authoring: production internal actions; redaction, room/epoch/cancel fences; replay protection; output/capture confirmation; real linked Show and runner cues; atomic invalid-Show rejection; authorized asset import and vision-purpose separation.');
