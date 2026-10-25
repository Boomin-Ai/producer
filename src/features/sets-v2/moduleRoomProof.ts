import {invoke} from '@tauri-apps/api/core';
import {guests} from '../../lib/ipc';
import {activeEndpointId} from '../../lib/workspace';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,label:string,attempts=2400):Promise<NonNullable<T>>{for(let i=0;i<attempts;i++){const result=await read();if(result)return result as NonNullable<T>;await sleep(50);}throw Error('Timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>(b.getAttribute('aria-label')===label||b.textContent?.trim()===label)&&!b.disabled);
/** Explicit native-dev opt-in only. Exercises the real operator UI and provider. */
export async function moduleRoomProof(serverRoomId:string){
 if(!import.meta.env.DEV||!await invoke<boolean>('live_set_v2_smoke_enabled'))return;
 const endpoint=activeEndpointId();if(endpoint){const response=await guests.request(endpoint,'GET',`/v1/app/live/rooms/${serverRoomId}/set-runtime`).catch(()=>null);const snapshot=(response?.body as {snapshot?:{modules?:{research?:{agent?:{status?:string;origin?:string}}}}}|undefined)?.snapshot;if(snapshot?.modules?.research?.agent?.status==='completed'&&snapshot.modules.research.agent.origin==='provider')return modulePresentationProof(serverRoomId);}
 const progress=async(stage:string)=>invoke('live_set_v2_report',{result:{kind:'just-facts-module-ui',status:'running',stage,at:new Date().toISOString()}});
 try{
  await progress('Opening the real set editor');
  const dock=await until(()=>document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')||button('Set settings'),'set panel');if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  (await until(()=>button('Set settings'),'set editor button')).click();
  const editor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');
  (await until(()=>editor.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Choose set"]'),'set picker')).click();
  (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(o=>o.textContent?.includes('Just Facts')),'Just Facts option')).click();
  await until(()=>editor.querySelector('[role=combobox][aria-label="Choose set"]')?.textContent?.includes('Just Facts'),'Just Facts loaded');
  const connection=await until(()=>Array.from(editor.querySelectorAll<HTMLSelectElement>('select')).find(s=>Array.from(s.options).some(o=>o.value==='claude-research')),'Claude binding');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(connection,'claude-research');connection.dispatchEvent(new Event('change',{bubbles:true}));await sleep(100);
  const apply=button('Show on output',editor);if(apply)apply.click();
  await until(()=>editor.querySelector('.set-editor-apply-status.applied'),'set applied');
  button('Close editor',editor)!.click();
  await progress('Requesting Claude through the room module controls');
  const question=await until(()=>{const el=document.querySelector<HTMLTextAreaElement>('.module-operator-panel textarea');return el&&!el.disabled?el:null;},'ready question control');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(question,"Is oxygen the most abundant gas in Earth's atmosphere? Answer using primary scientific evidence.");question.dispatchEvent(new Event('input',{bubbles:true}));
  (await until(()=>button('Ask agent'),'live agent connection')).click();
  await until(()=>button('Show response'),'completed researched response');
  const endpoint=activeEndpointId();if(!endpoint)throw Error('No active local workspace');
  const read=async()=>{const response=await guests.request(endpoint,'GET',`/v1/app/live/rooms/${serverRoomId}/set-runtime`);if(!response.available)throw Error('Module service unavailable');return response.body as {snapshot:{revision:number;setEpoch:number;modules:{research:{view:string;agent:{status:string;origin:string;response:string;displayedResponse:string;citations:unknown[]}}}}};};
  const before=(await read()).snapshot;if(before.modules.research.agent.status!=='completed'||before.modules.research.agent.displayedResponse)throw Error('Response was not held for operator approval');
  button('Show response')!.click();
  await until(()=>document.querySelector<HTMLSelectElement>('select[aria-label="Segment layout"]')?.value==='view1-landscape','authored evidence layout');
  const after=await until(async()=>{const snapshot=(await read()).snapshot;return snapshot.modules.research.agent.displayedResponse?snapshot:null;},'published response');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  const native=await until(async()=>{const status=await invoke<{renderedRevision:number;renderSerial:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation}});return status.renderedRevision>0&&!status.transitioning?status:null;},'native output presentation');
  await invoke('live_set_v2_report',{result:{kind:'just-facts-module-ui',ok:true,status:'passed',providerOrigin:after.modules.research.agent.origin,citations:after.modules.research.agent.citations.length,responseCharacters:after.modules.research.agent.response.length,heldBeforeShow:true,authoredEvidenceView:after.modules.research.view,committedRevision:after.revision,setEpoch:after.setEpoch,native,at:new Date().toISOString()}});
 }catch(error){await invoke('live_set_v2_report',{result:{kind:'just-facts-module-ui',ok:false,status:'failed',error:String(error),body:document.body.innerText.slice(-3000),at:new Date().toISOString()}});}
}

/** Reuses the completed provider result; this presentation check makes no LLM call. */
async function modulePresentationProof(room:string){
 const events:Array<{output:string;generation:number;nativeRevision:number;renderSerial:number;moduleCommit:{setEpoch:number;revision:number;domain:string}}> = [];
 const observe=(event:Event)=>events.push((event as CustomEvent).detail);window.addEventListener('producer:module-presented',observe);
 try{
  const endpoint=activeEndpointId();if(!endpoint)throw Error('Local workspace missing');
  const read=async()=>((await guests.request(endpoint,'GET',`/v1/app/live/rooms/${room}/set-runtime`)).body as {snapshot:{setEpoch:number;revision:number;modules:{research:{agent:{displayedResponse:string;origin:string;response:string;citations:unknown[]}}}}}).snapshot;
  await invoke('live_set_v2_report',{result:{kind:'just-facts-presentation-ui',status:'running',stage:'Checking exact output acknowledgements with the completed Claude response',at:new Date().toISOString()}});
  // The room dock may be minimized; the editor exposes the same live controls.
  const closedDock=document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]');
  if(closedDock)closedDock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  (await until(()=>button('Set settings'),'set editor access')).click();
  await until(()=>document.querySelector('dialog[open] .module-operator-panel'),'live editor controls');
  const current=await read();if(current.modules.research.agent.displayedResponse){(await until(()=>button('Clear response'),'clear response control')).click();const cleared=await until(async()=>{const s=await read();return !s.modules.research.agent.displayedResponse?s:null;},'clear commit');await until(()=>events.find(e=>e.output==='program'&&e.moduleCommit.setEpoch===cleared.setEpoch&&e.moduleCommit.revision>=cleared.revision),'cleared native frame');}
  (await until(()=>button('Show response'),'show stored Claude response')).click();
  const committed=await until(async()=>{const s=await read();return s.modules.research.agent.displayedResponse?s:null;},'show commit');
  const presented=await until(()=>events.find(e=>e.output==='program'&&e.moduleCommit.setEpoch===committed.setEpoch&&e.moduleCommit.revision===committed.revision),'matching native frame');
  const native=await invoke<{renderedRevision:number}>('live_set_v2',{request:{op:'status',generation:presented.generation}});if(native.renderedRevision!==presented.nativeRevision)throw Error('Native presentation receipt did not match');
  button('Close editor')?.click();
  await invoke('live_set_v2_report',{result:{kind:'just-facts-presentation-ui',status:'passed',ok:true,providerOrigin:committed.modules.research.agent.origin,citations:committed.modules.research.agent.citations.length,queriedProviderThisRun:false,reusedCompletedResponse:true,presented,native,at:new Date().toISOString()}});
 }catch(error){await invoke('live_set_v2_report',{result:{kind:'just-facts-presentation-ui',status:'failed',ok:false,error:String(error),events,at:new Date().toISOString()}});}finally{window.removeEventListener('producer:module-presented',observe);}
}
