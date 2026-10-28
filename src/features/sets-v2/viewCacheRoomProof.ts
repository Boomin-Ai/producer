/** Explicit dev-only timing proof; uses normal operator controls and receipts. */
import {invoke} from '@tauri-apps/api/core';
import {preparationDebug} from './preparedScenes';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<1200;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>{const dock=document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]');if(dock?.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));};
export async function viewCacheRoomProof(){
 const record=import.meta.env.VITE_VIEW_FLASH_PROOF==='1';let recording:string|undefined;let stage='opening';const samples:Record<string,unknown>[]=[],timings:Record<string,unknown>[]=[];
 const timing=(event:Event)=>timings.push((event as CustomEvent).detail);
 const report=(extra:Record<string,unknown>)=>invoke('live_set_v2_report',{result:{kind:'view-cache',stage,samples,...extra}});
 const progress=setInterval(()=>void report({running:true,preparation:preparationDebug(),controls:Array.from(document.querySelectorAll('.module-panel-heading')).map(e=>e.textContent),buttons:Array.from(document.querySelectorAll<HTMLButtonElement>('.module-operator-panel button')).filter(b=>['Now','Today','Hourly','7 day'].includes(b.textContent??'')).map(b=>({label:b.textContent,disabled:b.disabled,connected:b.isConnected,visible:!!b.getClientRects().length}))}),10000);
 window.addEventListener('producer:set-render-timing',timing);
 try{
  const dock=await until(()=>document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]'),'controls dock');if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>document.querySelector('.set-current-name')?.textContent?.includes('Atmosphere'),'Atmosphere room');
  stage='awaiting output';await until(()=>document.querySelector('.set-controls')?.textContent?.includes('On output'),'automatic room output');
  const sky=await until(()=>Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.querySelector('h3')?.textContent==='Weather desk'),'weather');(button('Start',sky)??button('Resume',sky))?.click();
  stage='latest weather';await until(()=>sky.textContent?.includes('Weather updated'),'weather');
  stage='warming views';await until(()=>{const banks=preparationDebug();return banks.length&&banks.every(b=>!b.working)&&banks.some(b=>b.entries.filter(e=>e.state.state==='ready').length>=8);},'all bounded variants');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  const read=()=>invoke<{renderedRevision:number;graphicsLayers:number;cachedKeys:string[];cachedBytes:number;scene3dContexts:number}>('live_set_v2',{request:{op:'status',generation}});
  if(record){recording=await invoke<string>('live_start_recording',{stamp:'Graphics continuity proof',roomId:null,dual:false});await sleep(800);}
  const labels=Array.from({length:record?8:2},()=>['Today','Hourly','7 day','Now']).flat();
  for(const label of labels){
   stage=label;await report({running:true});const before=await read(),start=performance.now(),offset=timings.length;
   (await until(()=>{const card=Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.querySelector('h3')?.textContent==='Weather desk');return card&&button(label,card);},label)).click();await sleep(20);
   // Confirm a newer presentation; never mistake command acceptance for a frame.
   const after=record?(await sleep(250),await read()):await until(async()=>{const s=await read();return s.renderedRevision>before.renderedRevision?s:null;},'presented '+label);
   samples.push({label,clickToPresentedMs:Math.round(performance.now()-start),graphicsBefore:before.graphicsLayers,graphicsAfter:after.graphicsLayers,cachedBytes:after.cachedBytes,scene3dContexts:after.scene3dContexts,timings:timings.slice(offset)});await report({running:true});
   if(!record&&after.graphicsLayers!==before.graphicsLayers)throw Error('Warm tab created a graphics renderer');
   await sleep(record?450:150);
  }
  if(recording){await sleep(600);await invoke('live_stop_recording');}
  stage='complete';await report({ok:true,recording,preparation:preparationDebug()});
 }catch(error){await report({ok:false,error:String(error),preparation:preparationDebug()});}
 finally{if(recording)await invoke('live_stop_recording').catch(()=>{});clearInterval(progress);window.removeEventListener('producer:set-render-timing',timing);}
}
