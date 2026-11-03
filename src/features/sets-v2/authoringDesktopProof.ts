/** Explicit, isolated desktop acceptance. Never enabled in normal dev or release. */
import {invoke} from '@tauri-apps/api/core';
import {getVersion} from '@tauri-apps/api/app';
import {ipc,devices,listenLiveEvents,setSourceAudio} from '../../lib/ipc';
import {defaultConfig,type RoomConfig} from '../../lib/roomConfig';
import {parsePackage} from '../presentation/schema';

const camera='authoring-acceptance-camera',mic='authoring-acceptance-mic';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function bounded<T>(work:Promise<T>,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' did not settle within 25 seconds')),25000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
  for(let i=0;i<600;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(100);}
  throw Error('Timed out: '+label);
}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));
async function isolated(){
  if(!import.meta.env.DEV||import.meta.env.VITE_AUTHORING_DESKTOP_PROOF!=='1')throw Error('Desktop acceptance is opt-in');
  // This command is unavailable outside the isolated native development build.
  await invoke('live_set_v2_report',{result:{kind:'authoring-desktop',stage:'starting'}});
}
export async function authoringAcceptanceConfig():Promise<RoomConfig>{
  await isolated();
  const response=await fetch('/target/visual-acceptance/repaired.set.json');
  if(!response.ok)throw Error('Repaired acceptance fixture is missing');
  const pkg=parsePackage(await response.json());
  if(pkg.id!=='attention-is-currency-magazine'||!pkg.set.slots.some(s=>s.id==='host'))throw Error('Unexpected acceptance fixture');
  const config=defaultConfig();
  config.video={h:1080,f:30};
  config.sources.extras=[{id:camera,label:'Acceptance camera',spec:{kind:'camera'}},{id:mic,label:'Acceptance microphone',spec:{kind:'mic'}}];
  config.scenes=[{id:'acceptance',name:'Acceptance',look:{[mic]:{visible:true},[camera]:{visible:false}}}];
  config.active_scene='acceptance';
  config.presentation={package:pkg,bindings:{host:camera}};
  config.sizes={bottom:420};
  config.layout={top:[],left:['sources'],right:[],bottom:['setControls'],hidden:['scenes','guests','vote','mods','mixer','stats','dj','chat','channels','updates']};
  return config;
}
export async function authoringDesktopProof(roomId:string){
  let stage='startup',recordingAttempted=false,recordingStarted=false,recordingPath:string|undefined,stopEvents:(()=>void)|undefined;
  let audioSamples=0,maxMicPeak=0,sourceFrames=0;
  const selectedDevices:Record<string,string>={};
  const outputs:unknown[]=[];
  const runId=crypto.randomUUID();let reportTail:Promise<unknown>=Promise.resolve();
  const report=(extra:Record<string,unknown>)=>{
    const result=structuredClone({kind:'authoring-desktop',runId,stage,audioSamples,maxMicPeak,sourceFrames,selectedDevices,outputs,recordingPath,...extra});
    reportTail=reportTail.catch(()=>{}).then(()=>invoke('live_set_v2_report',{result}));return reportTail;
  };
  let progress:ReturnType<typeof setInterval>|undefined;
  try{
    // React remounts must not silently create a second recording in this page.
    // WebKit can restore sessionStorage across app launches; scope this guard
    // to the actual document instead so a fresh native launch can run a test.
    const page=window as typeof window&{__producerAuthoringDesktopStarted?:boolean};
    if(page.__producerAuthoringDesktopStarted)return;
    page.__producerAuthoringDesktopStarted=true;
    await isolated();
    if(await getVersion()!=='0.4.78')throw Error('Compatible 0.4.78 native build required');
    progress=setInterval(()=>void report({running:true}).catch(()=>{}),5000);
    stopEvents=await listenLiveEvents(event=>{
      if(event.type==='levels')for(const sample of event.extra_peaks)if(sample.id===mic){audioSamples++;maxMicPeak=Math.max(maxMicPeak,sample.peak);}
      if(event.type==='guest_thumbs')sourceFrames+=event.thumbs.filter(f=>f.id===camera&&f.jpeg).length;
    });
    await until(()=>button('Record'),'room ready');
    stage='permissions';await report({running:true});
    for(const kind of ['camera','mic'] as const)await ipc.liveRequestPermission(kind);
    for(const [kind,id,pattern] of [['camera',camera,/FaceTime HD Camera/i],['mic',mic,/MacBook Air Microphone/i]] as const){
      const device=(await devices.list(kind)).find(d=>!d.disabled&&pattern.test(d.name));
      if(!device)throw Error('Expected built-in '+kind+' unavailable; choose a physical device before continuing');
      await devices.set(id,device.id);selectedDevices[kind]=device.name;
    }
    sourceFrames=0;audioSamples=0;maxMicPeak=0;
    const dock=document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]');
    dock?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    (await until(()=>button('Set settings'),'Set settings')).click();
    await until(()=>document.querySelector('dialog[open]'),'Set editor');
    await setSourceAudio(mic,1,false);
    await ipc.liveApplyScene([{id:mic,patch:{visible:true},muted:false}]);
    stage='camera-ready';await report({running:true});
    await until(()=>sourceFrames>0,'physical camera preview');
    const apply=await until(()=>button('Show on output')??document.querySelector('.set-editor-apply-status.applied'),'apply');
    if(apply instanceof HTMLButtonElement)apply.click();
    await until(()=>document.querySelector('.set-editor-apply-status.applied'),'Set applied');
    button('Close editor')?.click();
    const generation=(await invoke<{generation:number}>('live_set_status')).generation;
    const ready=async(outputId:string)=>{
      const result=await until(async()=>{
        const status=await invoke<{renderedRevision:number;renderSerial:number;transitioning:boolean}>('live_set_v2',{request:{op:'status',generation,outputId}}).catch(error=>{
          if(outputId==='portrait'&&String(error).includes('Prepare the portrait set first'))return null;
          throw error;
        });
        if(!status)return null;
        return status.renderedRevision>0&&status.renderSerial>0&&!status.transitioning?status:null;
      },outputId+' output');outputs.push({outputId,...result});
    };
    stage='outputs';await ready('program');
    (await until(()=>button('Output settings'),'Output settings')).click();
    const views=await until(()=>document.querySelector('[aria-label="Room output view"]'),'output view');
    (await until(()=>button('Portrait',views),'portrait')).click();
    await ready('portrait');
    // Verify dimensions from the encoded files. The legacy portrait JPEG
    // diagnostic enables a continuous full-resolution CPU readback, which can
    // starve encoder startup in an unoptimized debug build.
    (await until(()=>button('Both',views),'both outputs')).click();
    await until(()=>button('Both',views)?.getAttribute('aria-pressed')==='true','both outputs selected');
    button('Close output settings')?.click();
    await ready('program');await ready('portrait');
    stage='recording';await report({running:true});
    recordingAttempted=true;
    recordingPath=await bounded(invoke<string>('live_start_recording',{stamp:'Authoring desktop acceptance',roomId,dual:true}),'Recording start');recordingStarted=true;
    await sleep(10000);
    await bounded(invoke('live_stop_recording'),'Recording stop');recordingStarted=false;
    stage='complete';
    if(progress)clearInterval(progress);
    await report({ok:true,physicalCameraFramesObserved:sourceFrames>0,microphoneSignalObserved:maxMicPeak>0,recordingInspection:'pending',completedAt:new Date().toISOString()});
  }catch(error){if(progress)clearInterval(progress);await report({ok:false,error:String(error),completedAt:new Date().toISOString()});}
  finally{if(recordingStarted||(recordingAttempted&&!recordingPath))await bounded(invoke('live_stop_recording'),'Recording cleanup').catch(()=>{});stopEvents?.();if(progress)clearInterval(progress);}
}
