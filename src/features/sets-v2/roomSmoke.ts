import { invoke } from "@tauri-apps/api/core";
import {listenLiveEvents} from "../../lib/ipc";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, label: string,attempts=600): Promise<NonNullable<T>> {
  for (let i=0;i<attempts;i++) { const result=await read(); if(result) return result as NonNullable<T>; await sleep(50); }
  throw Error(`Timed out: ${label}`);
}
const button = (label: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => (b.getAttribute('aria-label')===label || b.textContent?.trim()===label) && !b.disabled);
/** Private editor review by default; output verification is a separate opt-in. */
export async function openSetEditorReview(name:string,roomId?:string){
 if(!import.meta.env.DEV)return;
 try{
  const repairImage=import.meta.env.VITE_SET_EDITOR_REPAIR_HOST_IMAGE;
  const repairRun=import.meta.env.VITE_SET_EDITOR_VERIFY_OUTPUT;
  if(repairImage&&repairRun&&localStorage.getItem('producer-review-repair:'+repairRun)!=='complete'){
   await until(()=>button('Set settings'),'room host repair');
   const {ipc}=await import('../../lib/ipc');
   const room=(await ipc.liveListRooms()).find(r=>roomId?r.id===roomId:r.name==='Producer authoring acceptance');
   if(!room)throw Error('Acceptance room is unavailable');
   const config=JSON.parse(room.config||'{}');
   if(!config.presentation?.package?.set?.slots.some((s:{id:string})=>s.id==='host'))throw Error('Acceptance Set has no Host slot');
   const id='authoring-host-headshot';
   config.sources={...config.sources,extras:[...(config.sources?.extras??[]).filter((s:{id:string})=>s.id!==id),{id,label:'Kleveland headshot',spec:{kind:'image',path:repairImage}}]};
   config.presentation.bindings={...config.presentation.bindings,host:id};
   await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
   localStorage.setItem('producer-review-repair:'+repairRun,'complete');
   await invoke('live_set_v2_report',{result:{kind:'native-handoff-host-repaired',roomId:room.id,sourceId:id}});
   location.reload();return;
  }
  if(import.meta.env.VITE_SET_EDITOR_INSPECT_ONLY==='1'){
   await until(()=>button('Set settings'),'room handoff inspection');
   const {ipc,devices}=await import('../../lib/ipc');
   const permissions=await ipc.livePermissions();
   const engine=await ipc.liveEngineStatus();
   await invoke('live_set_v2_report',{result:{kind:'native-handoff-inspection',permissions,engine:{engine_ready:engine.engine_ready,sources:engine.sources},devices:permissions.camera==='granted'?await devices.list('camera'):[],rooms:(await ipc.liveListRooms()).filter(r=>r.name==='Producer authoring acceptance').map(r=>({id:r.id,name:r.name,sources:JSON.parse(r.config||'{}').sources,bindings:JSON.parse(r.config||'{}').presentation?.bindings}))}});
   return;
  }
  const dock=await until(()=>document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')||button('Set settings'),'Set controls');
  if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  if(!document.querySelector('dialog[open]'))(await until(()=>button('Set settings'),'Set settings')).click();
  const picker=await until(()=>document.querySelector<HTMLButtonElement>('dialog[open] [role="combobox"][aria-label="Choose set"]'),'Set picker');
  // The saved package may have changed while the room retained its older copy.
  // Select away first so a matching title cannot satisfy the load wait early.
  if(picker.textContent?.includes(name)){
   picker.click();
   (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o=>!o.textContent?.includes(name)),'alternate private Set')).click();
   await until(()=>!picker.textContent?.includes(name),'alternate private Set loaded');
  }
  picker.click();
  (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o=>o.textContent?.includes(name)),'saved Set '+name)).click();
  await until(()=>document.querySelector('dialog[open] [role="combobox"][aria-label="Choose set"]')?.textContent?.includes(name),'selected Set');
  const hostSource=import.meta.env.VITE_SET_EDITOR_REVIEW_HOST_SOURCE;
  if(hostSource){
   const source=await until(()=>Array.from(document.querySelectorAll<HTMLSelectElement>('dialog[open] .set-source-card select[aria-label$=" source"]')).find(s=>s.getAttribute('aria-label')?.startsWith('Host')&&Array.from(s.options).some(o=>o.value===hostSource)),'existing review host source');
   if(!source.value)select(source,hostSource);
  }
  const layout=import.meta.env.VITE_SET_EDITOR_REVIEW_LAYOUT;
  if(layout){
   const picker=await until(()=>{const s=document.querySelector<HTMLSelectElement>('dialog[open] select[aria-label="Edit layout"]');return s&&Array.from(s.options).some(o=>o.value===layout)?s:null;},'review layout');
   select(picker,layout);
   await until(()=>picker.value===layout,'review layout selected');
  }
  await invoke('live_set_v2_report',{result:{kind:'set-editor-review',ok:true,name,layout:document.querySelector<HTMLSelectElement>('dialog[open] select[aria-label="Edit layout"]')?.value,outputActionInvoked:false}});
  const verify=import.meta.env.VITE_SET_EDITOR_VERIFY_OUTPUT;
  if(verify&&localStorage.getItem('producer-review-take:'+verify)!=='complete'){
   localStorage.setItem('producer-review-take:'+verify,'started');
   const status=async()=>{const {generation}=await invoke<{generation:number}>('live_set_status');const read=(outputId:string)=>invoke<{renderedRevision:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation,outputId}});return {program:await read('program'),portrait:import.meta.env.VITE_SET_EDITOR_VERIFY_BOTH==='1'?await read('portrait'):{renderedRevision:0,transitioning:false}};};
   const deadline=Date.now()+120000;
   (await until(()=>button('Show on output')??document.querySelector('.set-editor-apply-status.applied'),'review take')).dispatchEvent(new MouseEvent('click',{bubbles:true}));
   await invoke('live_set_v2_report',{result:{kind:'set-output-verifying',name,stage:'take requested'}});
   await until(()=>{if(Date.now()>deadline)throw Error('Review take deadline exceeded');const error=document.querySelector('dialog[open] [role=alert]')?.textContent;if(error)throw Error(error);return document.querySelector('.set-editor-apply-status.applied');},'review taken',1800);
   button('Close editor')?.click();
   if(import.meta.env.VITE_SET_EDITOR_VERIFY_BOTH==='1'){
    (await until(()=>button('Output settings'),'handoff output settings')).click();
    const views=await until(()=>document.querySelector('[aria-label="Room output view"]'),'handoff output view');
    (await until(()=>button('Both',views),'handoff paired outputs')).click();
    await until(async()=>{const s=await status().catch(()=>null);return s&&s.program.renderedRevision>0&&s.portrait.renderedRevision>0&&!s.program.transitioning&&!s.portrait.transitioning?s:null;},'both handoff outputs',1800);
    button('Close output settings')?.click();
   }
   await invoke('live_set_v2_report',{result:{kind:'set-output-verifying',name,stage:'taken; waiting for all layouts'}});
   await until(()=>{if(Date.now()>deadline)throw Error('Layout readiness deadline exceeded');const panel=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');return panel&&Number(panel.dataset.layoutsTotal)>0&&panel.dataset.layoutsReady===panel.dataset.layoutsTotal;},'all room layouts ready',1800);
   const checks=[];
   const view=(label:string)=>label.replace(/ · (Landscape|Portrait)$/,'');
   const labels=Array.from(new Map(Array.from(document.querySelectorAll<HTMLButtonElement>('.set-layouts button')).map(b=>{const label=b.querySelector('span')?.textContent??'';return [view(label),label] as const;})).values());
   for(const label of [...labels,...labels.slice(0,1)]){
    const target=Array.from(document.querySelectorAll<HTMLButtonElement>('.set-layouts button')).find(b=>b.querySelector('span')?.textContent===label)!;
    const selected=document.querySelector('.set-layouts button[aria-pressed="true"] span')?.textContent??'';
    if(view(selected)===view(label)){checks.push({label,alreadySelected:true,...await status()});continue;}
    const before=await status();target.click();
    const receipt=await until(async()=>{if(Date.now()>deadline)throw Error('Layout switching deadline exceeded');const s=await status();return s.program.renderedRevision>before.program.renderedRevision&&!s.program.transitioning&&(import.meta.env.VITE_SET_EDITOR_VERIFY_BOTH!=='1'||s.portrait.renderedRevision>before.portrait.renderedRevision&&!s.portrait.transitioning)?s:null;},'room layout '+label,1800);
    checks.push({label,...receipt});
   }
   const {ipc}=await import('../../lib/ipc');
   const savedRoom=(await ipc.liveListRooms()).find(r=>roomId?r.id===roomId:r.name==='Producer authoring acceptance');
   const saved=JSON.parse(savedRoom?.config||'{}');
   const sourceChecks=await until(async()=>{
    const items=(await ipc.liveEngineStatus()).sources?.items??[];
    const checks=(saved.presentation?.package?.set?.slots??[]).map((slot:{id:string})=>{const id=saved.presentation?.bindings?.[slot.id];const source=items.find(s=>s.id===id);return {slot:slot.id,id,kind:source?.kind,width:source?.src_w??0,height:source?.src_h??0,hasFrame:source?.has_frame===true,persisted:saved.sources?.extras?.some((e:{id:string})=>e.id===id)===true};});
    return checks.every((c:{hasFrame:boolean;width:number;height:number;persisted:boolean})=>c.hasFrame&&c.width>0&&c.height>0&&c.persisted)?checks:null;
   },'persisted Host frames');
   const visibleErrors=Array.from(document.querySelectorAll('.set-error')).map(e=>e.textContent?.trim()).filter(Boolean);
   if(visibleErrors.length)throw Error('Handoff still shows an error: '+visibleErrors.join(' · '));
   const panel=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');
   const result={kind:'set-output-verified',ok:true,name,checks,sourceChecks,layoutsReady:Number(panel?.dataset.layoutsReady),layoutsTotal:Number(panel?.dataset.layoutsTotal),visibleErrors,completedAt:new Date().toISOString(),debug:(await import('./preparedScenes')).preparationDebug()};
   localStorage.setItem('producer-review-proof:'+verify,JSON.stringify(result));
   await invoke('live_set_v2_report',{result});
   localStorage.setItem('producer-review-take:'+verify,'complete');
   (await until(()=>button('Set settings'),'reopen checked Set')).click();
   return;
  }
  if(verify){const saved=localStorage.getItem('producer-review-proof:'+verify);if(saved)await invoke('live_set_v2_report',{result:JSON.parse(saved)});}
  if(import.meta.env.VITE_SET_EDITOR_DIAGNOSE==='1'){
   await sleep(15000);
   const engine=await invoke<{sources?:{items?:Array<{id:string;label:string;kind:string;has_frame?:boolean;src_w:number;src_h:number}>}}>('live_engine_status');
   await invoke('live_set_v2_report',{result:{kind:'set-editor-diagnostics',name,sources:engine.sources?.items?.map(({id,label,kind,has_frame,src_w,src_h})=>({id,label,kind,has_frame,src_w,src_h})),bindings:Array.from(document.querySelectorAll<HTMLSelectElement>('dialog[open] .set-source-card select[aria-label$=" source"]')).map(s=>({label:s.getAttribute('aria-label'),source:s.value})),debug:(await import('./preparedScenes')).preparationDebug()}});
  }
 }catch(error){await invoke('live_set_v2_report',{result:{kind:'set-editor-review',ok:false,name,error:String(error),debug:(await import('./preparedScenes')).preparationDebug(),alerts:Array.from(document.querySelectorAll('[role=alert], .set-error')).map(e=>e.textContent)}});}
}
function select(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(el,value);
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
/** Opt-in local automation exercises the product's actual picker/editor. */
export async function roomSmoke(timingOnly=false,resolutionOnly=false,showcaseOnly=false) {
 const events: unknown[]=[];
 try {
  const dock=await until(()=>document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')||button('Set settings'),'bottom row');
  if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>button('Set settings'),'normal room');
  await until(()=>button('Record'),'room configuration applied');
  if(resolutionOnly){await invoke('live_set_video',{height:720,fps:30});await until(async()=>(await invoke<{video_height:number}>('live_engine_status')).video_height===720,'720p starting canvas');await sleep(500);}
  async function choose(name: string) {
   if(!document.querySelector('dialog[open]'))button('Set settings')!.click();
   const picker=await until(()=>document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Choose set"]'),'set picker');
   picker.click();
   const option=await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o=>o.textContent?.includes(name)),'set option '+name);
   option.click(); await until(()=>document.querySelector('dialog[open] [role=combobox][aria-label="Choose set"]')?.textContent?.includes(name),'set loaded '+name); await sleep(100);
   return until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'set editor');
  }
  if(showcaseOnly){
   const editor=await choose('Head to Head — The Grand Arena');
   await invoke('live_set_video',{height:1080,fps:30});
   await until(async()=>(await invoke<{video_height:number}>('live_engine_status')).video_height===1080,'1080p showcase canvas');
   const bindings:Record<string,string>={};
   for(const [slot,label,color] of [['host','Grand Arena / Blue preview','#22587b'],['guest','Grand Arena / Amber preview','#88602e'],['evidence','Grand Arena / Evidence preview','#334659']]){
    const id='grand-arena-'+slot+'-'+crypto.randomUUID().slice(0,8);
    await invoke('live_set_source_create',{id,label,spec:{kind:'color',color}});bindings[slot]=id;
   }
   for(const picker of editor.querySelectorAll<HTMLSelectElement>('.set-source-card select[aria-label$=" source"]')){
    const label=picker.getAttribute('aria-label')??'';select(picker,label.includes('Blue')?bindings.host:label.includes('Amber')?bindings.guest:bindings.evidence);
   }
   (await until(()=>button('Show on output'),'showcase apply')).click();
   await until(()=>document.querySelector('.set-editor-apply-status.applied'),'showcase applied');button('Close editor')!.click();
   const timer=setInterval(()=>{void import('./preparedScenes').then(m=>invoke('live_set_v2_report',{result:{kind:'showcase-preparing',debug:m.preparationDebug().map(s=>({...s,entries:s.entries.filter(e=>e.state.state!=='ready')})),body:document.body.innerText.slice(-1800)}}));},5000);
   try{await until(()=>{const p=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');const failure=document.querySelector('.set-error')?.textContent;if(failure)throw Error(failure);return p?.dataset.layoutsTotal==='12'&&p.dataset.layoutsReady==='12';},'all 12 showcase layouts ready',2400);}finally{clearInterval(timer);}

   if(new URLSearchParams(location.search).has('roomColor')){
    button('Output settings')!.click();
    const views=await until(()=>document.querySelector('[aria-label="Room output view"]'),'output view');
    (await until(()=>button('Portrait',views),'portrait view')).click();
    const generation=(await invoke<{generation:number}>('live_set_status')).generation;
    await until(async()=>{const s=await invoke<{renderedRevision:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation,outputId:'portrait'}}).catch(()=>null);return s&&s.renderedRevision>0&&!s.transitioning?s:null;},'portrait native output');
    const sample=await until(async()=>{
     const frame=await invoke<string>('live_portrait_frame');if(!frame)return null;
     const img=new Image();img.src=frame.startsWith('data:')?frame:'data:image/jpeg;base64,'+frame;await img.decode();
     const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
     const actual=[...ctx.getImageData(Math.round(canvas.width*.5),Math.round(canvas.height*.71),1,1).data];
     return actual.slice(0,3).every((v,i)=>Math.abs(v-[136,96,46][i])<=6)?{actual,width:canvas.width,height:canvas.height}:null;
    },'portrait amber matches source RGB');
    button('Close output settings')?.click();
    await invoke('live_set_v2_report',{result:{ok:true,kind:'portrait-color',expected:[136,96,46],...sample,completedAt:new Date().toISOString()}});return;
   }
   const checks=[];const generation=(await invoke<{generation:number}>('live_set_status')).generation;
   document.querySelector<HTMLButtonElement>('.set-mode-action')!.click();
   for(let step=0;step<3;step++){
    await until(()=>document.querySelector('.set-output-status')?.textContent==='On output','showcase output idle');await sleep(800);
    const before=await invoke<{renderedRevision:number}>('live_set_v2',{request:{op:'status',generation}});
    (await until(()=>button('Next'),'showcase next')).click();
    const status=await until(async()=>{const s=await invoke<{renderedRevision:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation}});const failure=document.querySelector('.set-error')?.textContent;if(failure)throw Error(failure);return s.renderedRevision>before.renderedRevision&&!s.transitioning?s:null;},'showcase next rendered');checks.push(status);
   }
   button('Stop run')!.click();
   const picker=document.querySelector<HTMLSelectElement>('.set-compact-segment');if(picker)select(picker,'faceoff');
   await sleep(1200);button('Set settings')!.click();
   await invoke('live_set_v2_report',{result:{ok:true,kind:'grand-arena-showcase',layoutsReady:12,checks,syntheticSources:true,completedAt:new Date().toISOString()}});return;
  }
  const editor=await choose(resolutionOnly?'Head to Head — The Arena':'Head to Head');
  const card=await until(()=>editor.querySelector<HTMLElement>('.set-source-card'),'source card');
  const priorSource=card.querySelector<HTMLSelectElement>('select[aria-label$=" source"]')?.value;
  const thumbIds=new Set<string>();
  const stopThumbs=await listenLiveEvents(event=>{if(event.type==='guest_thumbs')for(const frame of event.thumbs)if(frame.jpeg)thumbIds.add(frame.id);});
  button('Add source here',card)!.click();
  const kind=await until(()=>card.querySelector<HTMLSelectElement>('select[aria-label$="new source type"]'),'inline source creator');
  select(kind,'color');await sleep(100);button('Add and assign',card)!.click();
  const assigned=await until(()=> {const s=card.querySelector<HTMLSelectElement>('select[aria-label$=" source"]');return s?.value&&s.value!==priorSource?s.value:undefined;},'source assignment');
  const snapshot=await invoke<{sources:{items:Array<{id:string;visible:boolean}>}}>('live_engine_status');
  const sources=snapshot.sources;
  if(sources.items.find(s=>s.id===assigned)?.visible!==false) throw Error('Inline source was not created hidden');
  await until(()=>thumbIds.has(assigned),'hidden source native preview frame');
  stopThumbs();
  events.push({inlineSourceCreatedAndAssigned:true,hiddenInRoom:true,nativeSourcePreviewFrame:true});
  for(const s of editor.querySelectorAll<HTMLSelectElement>('.set-source-card select[aria-label$=" source"]')) select(s,assigned);
  (await until(()=>button('Show on output',editor),'initial apply ready')).click();await sleep(150);button('Close editor',editor)!.click();
  let revision=0;
  async function rendered(outputId='program') {
   const generation=(await invoke<{generation:number}>('live_set_status')).generation;
   const status=await until(async()=>{
    const s=await invoke<{renderedRevision:number;ready:boolean;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation,outputId}}).catch(()=>null);
    if (!s) return null;
    return s.renderedRevision>revision&&!s.transitioning?s:null;
   },'native rendered '+outputId);
   revision=status.renderedRevision;events.push({outputId,...status});
  }
  await rendered();
  if(resolutionOnly){
   const changes=[];
   for(const height of [1080,720,1080]){
    await invoke('live_set_video',{height,fps:30});
    await until(async()=>(await invoke<{video_height:number}>('live_engine_status')).video_height===height,'engine '+height);
    await sleep(300);
    button('Set settings')!.click();await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'resize editor');
    const generation=(await invoke<{generation:number}>('live_set_status')).generation;
    // An active set restores automatically; make a private field edit to also
    // exercise explicit Show on output at the resized canvas.
    const field=await until(()=>document.querySelector<HTMLInputElement>('dialog[open] .set-controls-fields input[type=text]'),'resized content field');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'Resolution '+height+' / '+changes.length);
    field.dispatchEvent(new Event('input',{bubbles:true}));
    (await until(()=>button('Show on output',document.querySelector('dialog[open]')??document),'resize apply ready')).click();
    const status=await until(async()=>{
     const failure=document.querySelector('.set-error')?.textContent;
     if(failure)throw Error(failure);
     const s=await invoke<{generation:number;renderedRevision:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation}}).catch(()=>null);
     return s&&s.renderedRevision>0&&!s.transitioning?s:null;
    },'set applied after resize '+height);
    await until(()=>document.querySelector('dialog[open] .set-editor-apply-status.applied'),'resize applied state');
    button('Close editor')!.click();
    const layouts=await until(()=>{const panel=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');return panel&&Number(panel.dataset.layoutsTotal)>0&&panel.dataset.layoutsReady===panel.dataset.layoutsTotal?{ready:Number(panel.dataset.layoutsReady),total:Number(panel.dataset.layoutsTotal)}:undefined;},'all resized layouts ready '+height);
    changes.push({height,...status,layouts});
   }
   await invoke('live_set_v2_report',{result:{ok:true,kind:'resolution-change',events,changes,completedAt:new Date().toISOString()}});return;
  }
  if(timingOnly){
   const segmentTiming=await (await import('./segmentTiming')).measureSegmentTiming(assigned);
   await invoke('live_set_v2_report',{result:{ok:true,kind:'segment-timing',events,segmentTiming,completedAt:new Date().toISOString()}});return;
  }
  for(const name of ['Signal Desk','Atlanta Culture']) {
   const e=await choose(name);
   for(const s of e.querySelectorAll<HTMLSelectElement>('.set-source-card select[aria-label$=" source"]')) select(s,assigned);
   await sleep(100);button('Show on output',e)!.click();await sleep(150);button('Close editor',e)!.click();await rendered();
  }
  button('Output settings')!.click();
  await sleep(100);button('Portrait',document.querySelector('[aria-label="Room output view"]')!)!.click();
  revision=0;await rendered('portrait');button('Close output settings')?.click();
  const frame = await until(()=>invoke<string>('live_portrait_frame'),'portrait diagnostic frame');
  const img = new Image(); img.src=frame.startsWith('data:')?frame:'data:image/jpeg;base64,'+frame; await img.decode();
  const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;
  canvas.getContext('2d')!.drawImage(img,0,0,180,320);
  button('Output settings')!.click();await sleep(100);button('Landscape',document.querySelector('[aria-label="Room output view"]')!)!.click();await sleep(300);button('Close output settings')?.click();
  await invoke('live_set_v2_report',{result:{ok:true,kind:'normal-room',events,portraitFrame:canvas.toDataURL('image/jpeg',0.85),completedAt:new Date().toISOString()}});
 } catch(error) {
  await invoke('live_set_v2_report',{result:{ok:false,kind:'normal-room',error:String(error),debug:(await import('./preparedScenes')).preparationDebug().map(s=>({...s,entries:s.entries.filter(e=>e.state.state!=='ready').slice(0,24)})),events,body:document.body.innerText.slice(-6000),completedAt:new Date().toISOString()}});
 }
}

/** Explicit existing-room regression: preserves sources, checks saved-resolution startup. */
export async function roomApplyCheck() {
 const errors=()=>Array.from(document.querySelectorAll('.set-error, [role=alert]')).map(e=>e.textContent).filter(Boolean);
 try {
  await until(()=>button('Record'),'inspection room ready');
  const dock=document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]');
  dock?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  (await until(()=>button('Set settings'),'inspection set controls')).click();
  await until(()=>document.querySelector('dialog[open]'),'inspection editor');
  button('Choose set')!.click();
  (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(b=>b.textContent?.includes('Head to Head — The Grand Arena')),'inspection Grand Arena')).click();
  await sleep(400);
  const host=document.querySelector<HTMLSelectElement>('dialog[open] .set-source-card select[aria-label^="Blue"]');
  if(!host)throw Error('Grand Arena host slot missing');
  const camera=Array.from(host.options).find(o=>o.value&&/camera/i.test(o.text)&&!/color/i.test(o.text));
  if(!camera)throw Error('Existing room camera required for apply regression');
  select(host,camera.value);
  const apply=await until(()=>button('Show on output')??document.querySelector('.set-editor-apply-status.applied'),'inspection apply');
  if(apply instanceof HTMLButtonElement)apply.click();
  await until(()=>{if(errors().length)throw Error(errors().join('; '));return document.querySelector('.set-editor-apply-status.applied');},'inspection apply settled',2400);
  button('Close editor')!.click();
  await until(()=>{
   if(errors().length)throw Error(errors().join('; '));
   const p=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');
   return p?.dataset.layoutsTotal==='12'&&p.dataset.layoutsReady==='12';
  },'all twelve existing-camera layouts ready',2400);
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  const program=await invoke<{renderedRevision:number;renderSerial:number}>('live_set_v2',{request:{op:'status',generation}});
  if(!program.renderedRevision||!program.renderSerial)throw Error('Program has not rendered');
  button('Output settings')!.click();
  const views=await until(()=>document.querySelector('[aria-label="Room output view"]'),'output view');
  (await until(()=>button('Portrait',views),'portrait view')).click();
  const portrait=await until(async()=>{
   const s=await invoke<{renderedRevision:number;renderSerial:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation,outputId:'portrait'}}).catch(()=>null);
   return s&&s.renderedRevision>0&&s.renderSerial>0&&!s.transitioning?s:null;
  },'portrait rendered');
  const frame=await until(()=>invoke<string>('live_portrait_frame'),'portrait frame');
  const image=new Image();image.src=frame.startsWith('data:')?frame:'data:image/jpeg;base64,'+frame;await image.decode();
  const engine=await invoke<{video_height:number;video_fps:number}>('live_engine_status');
  if(image.naturalWidth!==engine.video_height||image.naturalHeight!==Math.round(engine.video_height*16/9))throw Error('Portrait frame does not match saved room resolution');
  button('Close output settings')?.click();
  await invoke('live_set_v2_report',{result:{ok:true,kind:'grand-arena-apply',videoHeight:engine.video_height,videoFps:engine.video_fps,cameraSource:camera.value,layoutsReady:12,program,portrait,portraitFrame:{width:image.naturalWidth,height:image.naturalHeight},errors:errors(),completedAt:new Date().toISOString()}});
 } catch(error) {
  await invoke('live_set_v2_report',{result:{ok:false,kind:'grand-arena-apply',error:String(error),errors:errors(),debug:(await import('./preparedScenes')).preparationDebug(),body:document.body.innerText.slice(-5000),completedAt:new Date().toISOString()}});
 }
}
