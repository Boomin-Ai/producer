/** Opt-in local acceptance check through the normal editor and module panel. */
import {invoke} from '@tauri-apps/api/core';
import type {LiveSnapshot} from '../../lib/ipc';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,label:string,attempts=900):Promise<NonNullable<T>>{for(let i=0;i<attempts;i++){const v=await read();if(v)return v as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>(b.getAttribute('aria-label')===label||b.textContent?.trim()===label)&&!b.disabled);
function select(el:HTMLSelectElement,value:string){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));}
export async function studioRoomProof(){
 let stage='room';
 const progress=setInterval(()=>{void invoke('live_set_v2_report',{result:{kind:'studio-progress',stage,at:new Date().toISOString(),body:document.body.innerText.slice(-1200)}})},10000);
 try{
  await until(()=>button('Record'),'native room');
  await invoke('live_set_video',{height:1080,fps:30});
  const dock=document.querySelector('[aria-label="Show the bottom row"]');dock?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  (await until(()=>button('Set settings'),'Set editor')).click();
  const editor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');
  stage='sources';
  const ids:Record<string,string>={};
  const initialSources=(await invoke<LiveSnapshot>('live_engine_status')).sources;
  const cards=Array.from(editor.querySelectorAll<HTMLElement>('.set-source-card'));
  for(const [index,slot,kind]of [[0,'host','camera'],[1,'guest','color']] as const){
   const card=cards[index];if(!card)throw Error('Missing source card');
   const assigned=card.querySelector<HTMLSelectElement>('select[aria-label$=" source"]')?.value;
   if(assigned&&initialSources?.items?.some(i=>i.id===assigned&&i.kind===kind&&i.src_w>0)){ids[slot]=assigned;continue;}
   (await until(()=>button('Add source here',card),'source creation')).click();
   const type=await until(()=>card.querySelector<HTMLSelectElement>('select[aria-label$=" new source type"]'),'source type');select(type,kind);
   (await until(()=>button('Add and assign',card),'add source')).click();
   await until(()=>button('Add source here',card),'source saved');
   ids[slot]=card.querySelector<HTMLSelectElement>('select[aria-label$=" source"]')!.value;
  }
  await until(async()=>{const s=(await invoke<LiveSnapshot>('live_engine_status')).sources;return s?.items?.find(i=>i.id===ids.host&&i.src_w>0);},'camera frame');
  stage='apply';(await until(()=>button('Show on output',editor),'apply')).click();
  await until(()=>document.querySelector('dialog[open] .set-editor-apply-status.applied'),'native presentation');
  (await until(()=>button('Close editor'),'close editor')).click();
  await until(()=>document.querySelector<HTMLElement>('.set-controls[data-layouts-total="6"]')?.dataset.layoutsReady==='6','both output variants');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  const status=()=>invoke<{scene3dContexts:number;renderedRevision:number;renderSerial:number}>('live_set_v2',{request:{op:'status',generation}});
  button('Output settings')?.click();(await until(()=>button('Both'),'both outputs')).click();button('Close output settings')?.click();
  const portraitStatus=()=>invoke<{scene3dContexts:number;renderedRevision:number}>('live_set_v2',{request:{op:'status',generation,outputId:'portrait'}});
  await until(async()=>(await portraitStatus()).renderedRevision>0,'portrait presentation');
  const portraitBefore=await portraitStatus();
  const before=await status();
  stage='live module controls';
  const card=await until(()=>Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.textContent?.includes('Studio direction')),'studio module');
  if(!button('Host’s floor',card))button('Start',card)?.click();
  const takes=[];
  const transitionRecording=await invoke<string>('live_start_recording',{stamp:'Coordinated studio transition',roomId:null,dual:true});await sleep(300);
  for(const label of ['Host’s floor','Challenger’s floor','Stage push','Wide studio','Reveal emblem','Reveal emblem','Face-off']){
   const previous=(await status()).renderedRevision,portraitPrevious=(await portraitStatus()).renderedRevision;(await until(()=>button(label,card),label)).click();
   const presented=await until(async()=>{const s=await status();return s.renderedRevision>previous?s:null;},'presented '+label);
   const portraitPresented=await until(async()=>{const s=await portraitStatus();return s.renderedRevision>portraitPrevious?s:null;},'portrait presented '+label);
   takes.push({label,revision:presented.renderedRevision,portraitRevision:portraitPresented.renderedRevision,contexts:presented.scene3dContexts});await sleep(750);
  }
  await invoke('live_stop_recording');
  const after=await status();if(before.scene3dContexts!==after.scene3dContexts)throw Error('3D worlds were recreated by control changes');
  const portraitAfter=await portraitStatus();
  stage='recording collision regression';const paths=[];
  for(let i=0;i<2;i++){const path=await invoke<string>('live_start_recording',{stamp:'Studio recording regression',roomId:null,dual:true});await sleep(1800);await invoke('live_stop_recording');paths.push(path);}
  if(paths[0]===paths[1])throw Error('Recording paths collided');
  let performanceProof:unknown;
  if(import.meta.env.VITE_SCENE3D_STUDIO_BENCHMARK==='1'){
   const measure=async(label:string)=>{stage='measure '+label;await sleep(2500);const samples=[];for(let i=0;i<12;i++){const s=await invoke<LiveSnapshot>('live_engine_status');samples.push({fps:s.fps,renderTimeUs:s.render_time_us,skipped:s.skipped_frames,total:s.total_frames});await sleep(500);}return samples;};
   const original=await(await fetch('/docs/shows/grand-arena-3d-study.json')).json();
   const replace=async(doc:typeof original)=>{
    (await until(()=>button('Set settings'),'benchmark editor')).click();
    const dialog=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'benchmark dialog');
    const input=dialog.querySelector<HTMLInputElement>('input[aria-label="Import set package"]')!;
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(doc)],doc.id+'.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await until(()=>dialog.querySelector<HTMLButtonElement>('button[aria-label="Choose set"]')?.textContent?.includes(doc.name),'benchmark package');
    (await until(()=>button('Show on output',dialog),'benchmark apply')).click();
    await until(()=>document.querySelector('dialog[open] .set-editor-apply-status.applied'),'benchmark presentation');
    (await until(()=>button('Close editor'),'benchmark close')).click();
   };
   const studio=await measure('3d');const flat=structuredClone(original);flat.id='grand-arena-flat-benchmark';flat.name='3D Studio — flat benchmark';
   for(const layout of flat.set.layouts)layout.root.children=layout.root.children.filter((n:{type:string})=>n.type!=='scene3d');
   await replace(flat);const baseline=await measure('flat');await replace(original);const restored=await measure('3d restored');
   performanceProof={studio,baseline,restored,comparison:'Same camera slots, text, output dimensions and recording state; flat benchmark omits both 3D passes.'};
  }
  await invoke('live_set_v2_report',{result:{ok:true,kind:'managed-scene3d-studio',generation,before,after,portraitBefore,portraitAfter,takes,recordings:paths,transitionRecording,performance:performanceProof,capability:await invoke('live_set_v2_scene3d_enabled'),at:new Date().toISOString()}});
 }catch(e){await invoke('live_set_v2_report',{result:{ok:false,kind:'managed-scene3d-studio',stage,error:String(e),body:document.body.innerText.slice(-1700)}});}finally{clearInterval(progress);}
}
