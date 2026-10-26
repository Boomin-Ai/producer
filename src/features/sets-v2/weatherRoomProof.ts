import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<1200;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(50);}throw Error('Timed out: '+label);}
/** Opt-in native dev check. No paid providers; preserves current weather configuration. */
export async function weatherRoomProof(){
 try{
  const button=(name:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>(b.textContent?.trim()===name||b.getAttribute('aria-label')===name)&&!b.disabled);
  const dock=await until(()=>document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')||button('Set settings'),'bottom row');
  if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  // Exercise real Show transport without making an agent/provider request.
  (await until(()=>button('Set settings'),'show editor')).click();
  const showEditor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'show editor dialog');
  (await until(()=>showEditor.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Choose set"]'),'show picker')).click();
  (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(o=>o.textContent?.includes('Just Facts')),'Just Facts option')).click();
  await until(()=>showEditor.querySelector('[role=combobox][aria-label="Choose set"]')?.textContent?.includes('Just Facts'),'Just Facts loaded');await sleep(150);
  button('Show on output')?.click();await until(()=>showEditor.querySelector('.set-editor-apply-status.applied'),'applied Just Facts');button('Close editor')?.click();
  (await until(()=>button('Start show'),'enabled show start')).click();
  await until(()=>button('Stop run'),'running show');(await until(()=>button('Next'),'next segment')).click();
  await until(()=>document.querySelector('.set-run-current-label')?.textContent?.includes('02 / Question'),'next segment selected');
  button('Stop run')!.click();await until(()=>button('Start show'),'stopped show');
  (await until(()=>button('Set settings'),'set editor')).click();
  const editor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');
  (await until(()=>editor.querySelector<HTMLButtonElement>('[role=combobox][aria-label="Choose set"]'),'set picker')).click();
  (await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(o=>o.textContent?.includes('Atmosphere')),'Atmosphere option')).click();
  const binding=await until(()=>Array.from(editor.querySelectorAll<HTMLSelectElement>('select')).find(s=>Array.from(s.options).some(o=>o.value==='atlanta-weather')),'saved weather binding');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(binding,'atlanta-weather');binding.dispatchEvent(new Event('change',{bubbles:true}));await sleep(100);
  button('Show on output')?.click();await until(()=>editor.querySelector('.set-editor-apply-status.applied'),'applied Atmosphere');button('Close editor')?.click();
  await until(()=>document.querySelector('.set-controls[data-layouts-total="2"]'),'Atmosphere room');
  button('Output settings')?.click();(await until(()=>button('Both'),'both output selector')).click();button('Close output settings')?.click();
  await until(()=>document.querySelector('.set-controls[data-layouts-ready="2"]')&&!document.querySelector('.rm-portrait-error'),'both layouts ready');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  type Status={renderedRevision:number;renderSerial:number;transitioning:boolean;ready:boolean;warmed:boolean};
  const read=()=>Promise.all(['program','portrait'].map(outputId=>invoke<Status>('live_set_v2',{request:{op:'status',generation,...(outputId==='portrait'?{outputId}:{})}})));
  await until(async()=>{const pair=await read();return pair.every(s=>s.renderedRevision>0&&!s.transitioning&&s.ready&&s.warmed)?pair:null;},'presented output pair');
  await until(()=>Array.from(document.querySelectorAll('.module-operator-card')).some(el=>/· fresh\b/.test(el.textContent??'')),'live weather received');
  // Connection initialization includes a real weather update before the idle sample.
  await sleep(2500);const before=await read();await sleep(6200);const after=await read();
  if(after.some((s,i)=>s.renderedRevision!==before[i].renderedRevision))throw Error('Idle polling reactivated a native output: '+JSON.stringify({before,after}));
  if(after.some((s,i)=>s.renderSerial<=before[i].renderSerial))throw Error('Native rendering stopped during the sample');
  if(document.querySelector('.rm-portrait-error'))throw Error('Portrait asset error remained');
  await invoke('live_set_v2_report',{result:{kind:'weather-native-output-stability',showStarted:true,nextSegment:true,showStopped:true,queriedAgent:false,ok:true,status:'passed',generation,idleSampleMs:6200,before,after,layoutsReady:2,portraitError:false,at:new Date().toISOString()}});
 }catch(error){await invoke('live_set_v2_report',{result:{kind:'weather-native-output-stability',ok:false,status:'failed',error:String(error),at:new Date().toISOString()}});}
}
