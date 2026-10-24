import { invoke } from "@tauri-apps/api/core";
import {listenLiveEvents} from "../../lib/ipc";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  for (let i=0;i<600;i++) { const result=await read(); if(result) return result as NonNullable<T>; await sleep(50); }
  throw Error(`Timed out: ${label}`);
}
const button = (label: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b => (b.getAttribute('aria-label')===label || b.textContent?.trim()===label) && !b.disabled);
function select(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(el,value);
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
/** Opt-in local automation exercises the product's actual picker/editor. */
export async function roomSmoke() {
 const events: unknown[]=[];
 try {
  await until(()=>button('Set settings'),'normal room');
  await until(()=>button('Record'),'room configuration applied');
  async function choose(name: string) {
   if(!document.querySelector('dialog[open]'))button('Set settings')!.click();
   const picker=await until(()=>document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Choose set"]'),'set picker');
   picker.click();
   const option=await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o=>o.textContent?.includes(name)),'set option '+name);
   option.click(); await sleep(250);
   return until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'set editor');
  }
  const editor=await choose('Head to Head');
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
  button('Close preview',editor)!.click();
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
  for(const name of ['Signal Desk','Atlanta Culture']) {
   const e=await choose(name);
   for(const s of e.querySelectorAll<HTMLSelectElement>('.set-source-card select[aria-label$=" source"]')) select(s,assigned);
   await sleep(100);button('Close preview',e)!.click();await rendered();
  }
  button('Output settings')!.click();
  await sleep(100);button('Portrait',document.querySelector('[aria-label="Room output view"]')!)!.click();
  revision=0;await rendered('portrait');button('Close output settings')?.click();
  const frame = await until(()=>invoke<string>('live_portrait_frame'),'portrait diagnostic frame');
  const img = new Image(); img.src=frame.startsWith('data:')?frame:'data:image/jpeg;base64,'+frame; await img.decode();
  const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;
  canvas.getContext('2d')!.drawImage(img,0,0,180,320);
  await invoke('live_set_v2_report',{result:{ok:true,kind:'normal-room',events,portraitFrame:canvas.toDataURL('image/jpeg',0.85),completedAt:new Date().toISOString()}});
 } catch(error) {
  await invoke('live_set_v2_report',{result:{ok:false,kind:'normal-room',error:String(error),events,body:document.body.innerText.slice(-16000),completedAt:new Date().toISOString()}});
 }
}
