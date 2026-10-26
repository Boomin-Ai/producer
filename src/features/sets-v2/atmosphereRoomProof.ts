import {preparationDebug} from './preparedScenes';
/** Opt-in native acceptance against a separate Atmosphere dev room. */
import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<600;i++){const v=await read();if(v)return v as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.getClientRects().length&&!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));
export async function atmosphereRoomProof(){
 let stage='room';const progress=setInterval(()=>void (async()=>{const st=await invoke<{generation:number}>('live_set_status');await invoke('live_set_v2_report',{result:{kind:'atmosphere-progress',stage,preparation:preparationDebug(),native:await invoke('live_set_v2',{request:{op:'status',generation:st.generation}}),engine:await invoke('live_engine_status'),body:document.body.innerText.slice(-1200)}});})(),10000);
 try{
  const dock=await until(()=>document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]'),'bottom controls');if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>document.querySelector('.set-current-name')?.textContent?.includes('Atmosphere'),'Atmosphere room');
  stage='apply output';(await until(()=>button('Set settings'),'set editor')).click();const editor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');const applyStarted=Date.now();(await until(()=>button('Show on output',editor),'apply')).click();await until(()=>editor.querySelector('.set-editor-apply-status.applied'),'first apply output');const applyMs=Date.now()-applyStarted;button('Close editor')?.click();
  const card=(name:string)=>Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.querySelector('h3')?.textContent===name);
  stage='weather module';const sky=await until(()=>card('Weather desk'),'weather controls');button('Start',sky)?.click();
  stage='camera module';const studio=await until(()=>card('Camera composition'),'camera controls');button('Start',studio)?.click();
  stage='weather data';await until(()=>sky.textContent?.includes('Weather updated'),'live forecast');
  stage='six layouts';await until(()=>document.querySelector('.set-controls[data-layouts-ready="6"]'),'all warmed layouts');
  button('Output settings')?.click();const locked=!!button('Stop virtual camera');if(!locked)button('Both')?.click();button('Close output settings')?.click();
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  type Status={renderedRevision:number;renderSerial:number;scene3dContexts:number;cachedBytes:number;cachedKeys:string[];transitioning:boolean;ready:boolean;warmed:boolean};
  const ids=locked?['program']:['program','portrait'];const read=()=>Promise.all(ids.map(outputId=>invoke<Status>('live_set_v2',{request:{op:'status',generation,...(outputId==='portrait'?{outputId}:{})}})));
  const samples=[];
  for(const pose of ['Hero','Split','Presenter']){stage=pose;const before=await read();(await until(()=>button(pose,studio),pose)).click();await sleep(1000);const after=await until(async()=>{const s=await read();return s.every((v,i)=>v.renderedRevision>=before[i].renderedRevision&&!v.transitioning)?s:null;},'presented '+pose);samples.push({pose,status:after});}
  for(const name of ['Today','Hourly','7 day','Now']){stage=name;(await until(()=>button(name,sky),name)).click();await sleep(500);}
  stage='city lookup';const search=sky.querySelector<HTMLInputElement>('input[type="search"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Denver');search.dispatchEvent(new Event('input',{bubbles:true}));await sleep(150);(await until(()=>button('Find city',sky),'find city')).click();(await until(()=>Array.from(sky.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes('Denver, Colorado, US')),'Denver result')).click();await until(()=>sky.textContent?.includes('Denver, Colorado, US')&&sky.textContent?.includes('Weather updated'),'Denver weather');
  stage='restore saved city';(await until(()=>button('Use saved city',sky),'saved city')).click();await until(()=>sky.textContent?.includes('Weather updated'),'saved city weather');button('Hero',studio)?.click();
  stage='stable outputs';await sleep(1200);const pair=await until(async()=>{const p=await read();return p.every(s=>s.ready&&s.warmed&&!s.transitioning)?p:null;},'stable output pair');if(pair.some(s=>s.scene3dContexts>2||s.cachedKeys.length>8))throw Error('Unbounded renderer retention');
  await invoke('live_set_v2_report',{result:{kind:'atmosphere-native',ok:true,applyMs,engine:await invoke('live_engine_status'),nativeOutputs:ids,samples,pair,citySwitched:true,forecastViews:4,layouts:6,virtualCameraPreserved:locked,at:new Date().toISOString()}});
 }catch(e){await invoke('live_set_v2_report',{result:{kind:'atmosphere-native',ok:false,stage,error:String(e),body:document.body.innerText.slice(-1800)}});}finally{clearInterval(progress);}
}
