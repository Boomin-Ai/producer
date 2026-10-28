/** Opt-in acceptance for authored Atmosphere motion; never runs in normal Dev. */
import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<900;i++){const v=await read();if(v)return v as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);}
export async function atmosphereDesignProof(){
 let stage='opening',recording:string|undefined;const samples:unknown[]=[],timings:Array<{stage:string;transitionMs?:number}>=[];
 const timing=(event:Event)=>timings.push((event as CustomEvent).detail);
 const report=(extra:Record<string,unknown>)=>invoke('live_set_v2_report',{result:{kind:'atmosphere-design',stage,samples,...extra}});
 const progress=setInterval(()=>void report({running:true,body:document.body.innerText.slice(-900)}),10000);
 window.addEventListener('producer:set-render-timing',timing);
 try{
  const dock=await until(()=>document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]'),'dock');if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  const click=async(label:string)=>{const b=await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.module-operator-card button')).find(b=>b.textContent?.trim()===label&&!b.disabled&&b.getClientRects().length),label);b.click();};
  await until(()=>{const handle=document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]');if(handle?.getAttribute('aria-label')==='Show the bottom row')handle.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return document.querySelector('.module-operator-card');},'expanded module controls');
  await until(()=>document.querySelector('.set-controls')?.textContent?.includes('On output'),'output');
  for(const card of document.querySelectorAll<HTMLElement>('.module-operator-card'))Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()==='Start'&&!b.disabled)?.click();
  await until(()=>document.body.innerText.includes('Weather updated'),'weather');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  type Status={renderedRevision:number;transitioning:boolean;ready:boolean;warmed:boolean;cachedBytes:number;scene3dContexts:number;graphicsLayers:number};
  const read=()=>invoke<Status>('live_set_v2',{request:{op:'status',generation}});
  await until(async()=>{const s=await read();return s.ready&&s.warmed&&!s.transitioning?s:null;},'ready frame');
  await sleep(3000);
  recording=await invoke<string>('live_start_recording',{stamp:'Atmosphere design motion',roomId:null,dual:false});
  for(const label of ['Split','Presenter','Hero','Today','Hourly','7 day','Now']){
   stage=label;const before=await read(),start=performance.now(),offset=timings.length;await click(label);
   const after=await until(async()=>{const s=await read();return s.renderedRevision>before.renderedRevision&&!s.transitioning?s:null;},'completed '+label);
   const events=timings.slice(offset),take=events.find(e=>e.stage==='take-request');
   if(['Today','Hourly','7 day','Now'].includes(label)&&take?.transitionMs!==260)throw Error('Expected authored 260ms content dissolve: '+JSON.stringify(take));
   if(['Split','Presenter','Hero'].includes(label)&&take?.transitionMs!==0)throw Error('Composition must use geometry morph');
   if(after.scene3dContexts>2||after.cachedBytes>768*1024*1024)throw Error('Renderer budget exceeded');
   samples.push({label,elapsedMs:Math.round(performance.now()-start),after,events});await report({running:true});await sleep(1100);
  }
  await invoke('live_stop_recording');stage='complete';await report({ok:true,recording});
 }catch(error){await report({ok:false,error:String(error)});}finally{if(recording)await invoke('live_stop_recording').catch(()=>{});clearInterval(progress);window.removeEventListener('producer:set-render-timing',timing);}
}
