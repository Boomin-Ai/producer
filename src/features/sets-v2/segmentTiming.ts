import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function wait<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<1200;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(25);}throw Error('Timing probe timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>!b.disabled&&(b.getAttribute('aria-label')===label||b.textContent?.trim()===label));
function select(el:HTMLSelectElement,value:string){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));}
/** Exercise Next on the real room panel; status receipts come from native render. */
export async function measureSegmentTiming(sourceId:string){
 const measurements:unknown[]=[];
 const settled=async()=>{await wait(()=>document.querySelector('.set-output-status')?.textContent==='On output','output idle');await sleep(200);await wait(()=>document.querySelector('.set-output-status')?.textContent==='On output','output idle confirmed');};
 let events:Array<Record<string,any>>=[];
 const receive=(e:Event)=>events.push((e as CustomEvent).detail);
 window.addEventListener('producer:set-render-timing',receive);
 const heartbeat=setInterval(()=>{void import('./preparedScenes').then(m=>invoke('live_set_v2_report',{result:{kind:'timing-heartbeat',debug:m.preparationDebug().map(s=>({...s,entries:s.entries.filter(e=>e.state.state!=='ready').slice(0,24)})),body:document.body.innerText.slice(-2000)}})).catch(()=>{});},5000);
 try{
  for(const name of ['Head to Head — The Arena','Producer — Make Your Show','Claude Code — Build, Review, Ship']){
   button('Set settings')!.click();const editor=await wait(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');
   button('Choose set',editor)!.click();(await wait(()=>Array.from(editor.querySelectorAll<HTMLButtonElement>('[role=option]')).find(o=>o.textContent?.includes(name)),name)).click();
   await wait(()=>editor.querySelector('[role=combobox][aria-label="Choose set"]')?.textContent?.includes(name),'selected title');
   for(const picker of editor.querySelectorAll<HTMLSelectElement>('.set-source-picker select'))select(picker,sourceId);
   await sleep(100);events=[];button('Show on output',editor)!.click();await wait(()=>events.find(e=>e.stage==='render-complete'),'initial render').catch(e=>{throw Error(String(e)+' '+JSON.stringify(events.slice(-12)));});button('Close editor',editor)!.click();
   await invoke('live_set_v2_report',{result:{ok:false,kind:'timing-progress',set:name,debug:(await import('./preparedScenes')).preparationDebug().map(s=>({...s,entries:s.entries.filter(e=>e.state.state!=='ready').slice(0,24)}))}});
   await wait(()=>{const p=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');return p&&Number(p.dataset.layoutsTotal)>0&&p.dataset.layoutsReady===p.dataset.layoutsTotal;},'entire set layouts ready');
   events=[];document.querySelector<HTMLButtonElement>('.set-mode-action')!.click();
   await sleep(500);await settled();await wait(()=>button('Next'),'next enabled');
   // Measure first visits, then repeat the same path after Restart.
   for(let pass=0;pass<2;pass++){
    if(pass){events=[];button('Restart show')!.click();await sleep(500);await settled();await wait(()=>button('Next'),'restart');}
    for(let step=0;step<3;step++){
     await settled();const next=await wait(()=>button('Next'),'next');const selector=document.querySelector<HTMLSelectElement>('.set-compact-segment')!;const target=selector.options[selector.selectedIndex+1].value;events=[];const clickAt=performance.now();next.click();
     const complete=await wait(()=>events.find(e=>e.phase===target&&(e.stage==='render-complete'||e.stage==='error')),'render receipt');
     if(complete.stage==='error')throw Error(String(complete.error));
     if(!events.some(e=>e.stage==='activate-request'&&e.phase===target))throw Error('Missing cached activation for '+target);
     measurements.push({name,target,pass:pass?'repeat':'first-visit',step:step+1,clickToCompleteMs:complete.at-clickAt,stages:events.map(e=>({...e,clickMs:e.at-clickAt}))});
     await sleep(200);
    }
   }
   button('Stop run')?.click();
  }
  const inventories=[];
  for(const name of ['Shader Lab — Aurora, Glow & Sweep','Combo Studio — Shader Duets']){
   button('Set settings')!.click();const editor=await wait(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'inventory editor');
   button('Choose set',editor)!.click();(await wait(()=>Array.from(editor.querySelectorAll<HTMLButtonElement>('[role=option]')).find(o=>o.textContent?.includes(name)),name)).click();
   await wait(()=>editor.querySelector('[role=combobox][aria-label="Choose set"]')?.textContent?.includes(name),'inventory selected');
   for(const picker of editor.querySelectorAll<HTMLSelectElement>('.set-source-picker select'))select(picker,sourceId);
   await sleep(150);events=[];button('Show on output',editor)!.click();await wait(()=>events.find(e=>e.stage==='render-complete'),'inventory initial frame');button('Close editor',editor)!.click();
   await wait(()=>{const p=document.querySelector<HTMLElement>('.set-controls[data-layouts-total]');return p&&p.dataset.layoutsTotal==='32'&&p.dataset.layoutsReady==='32';},'32 layouts ready '+name);
   const generation=(await invoke<{generation:number}>('live_set_status')).generation;
   const memory=[];for(const outputId of ['program','portrait'])memory.push(await invoke('live_set_v2',{request:{op:'status',generation,outputId}}));
   inventories.push({name,ready:32,memory});
  }
  return {measurement:'Next click to native render completion; transition-first-observed is status polling estimate, not display scanout',measurements,inventories};
 }finally{clearInterval(heartbeat);window.removeEventListener('producer:set-render-timing',receive);}
}
