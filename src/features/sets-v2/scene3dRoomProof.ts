/** Opt-in dev harness only. Uses the existing native source and v2 plan APIs.
 * It deliberately does not add a public scene3d package capability yet. */
import {invoke} from '@tauri-apps/api/core';
import {extraSources,recording,type LiveSources} from '../../lib/ipc';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
type Manifest={recordProof?:boolean;background:string;foreground:string;report:string;control:string};
export async function scene3dRoomProof(manifest:Manifest){
 let closed=false,ready=false,generation=0,revision=0,recordingPath:string|undefined;
 const owned:string[]=[],run=crypto.randomUUID();
 const toolbar=document.createElement('div');toolbar.className='notice';toolbar.setAttribute('aria-label','3D development prototype');
 Object.assign(toolbar.style,{position:'fixed',top:'100px',left:'290px',zIndex:'10000',display:'flex',alignItems:'center',gap:'10px',padding:'10px',background:'var(--panel, #171e29)',border:'1px solid var(--border, #303846)',borderRadius:'10px'});
 const status=document.createElement('span');status.textContent='Preparing 3D GPU prototype…';toolbar.append(status);document.body.append(toolbar);
 const buttons:HTMLButtonElement[]=[];
 const button=(label:string,action:()=>Promise<unknown>)=>{const b=document.createElement('button');b.textContent=label;b.disabled=true;b.onclick=()=>{void action().catch(e=>{status.textContent=String(e);});};toolbar.append(b);buttons.push(b);return b;};
 const cue=async(action:string)=>{const response=await fetch(manifest.control,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});if(!response.ok)throw Error('3D cue failed');};
 button('Blue',()=>cue('blue'));button('Gold',()=>cue('gold'));button('Neutral',()=>cue('neutral'));button('Pause motion',()=>cue('pause'));button('Resume',()=>cue('resume'));
 const record=button('Record 10s',async()=>{record.disabled=true;try{recordingPath=await recording.start('Scene3D-GPU-proof');status.textContent='Recording native output…';await sleep(10000);const completed=await recording.stop()??recordingPath;recordingPath=undefined;status.textContent='Recording saved';if(completed)await recording.reveal(completed);}finally{record.disabled=false;}});
 const close=async()=>{if(closed)return;closed=true;if(recordingPath)await recording.stop().catch(()=>{});if(generation)await invoke('live_set_v2',{request:{op:'return',generation}}).catch(()=>{});for(const id of owned.reverse())await extraSources.remove(id).catch(()=>{});toolbar.remove();};
 const stop=button('Exit prototype',close);stop.disabled=false;
 try{
  for(let i=0;i<600&&!closed;i++){const engine=await invoke<{engine_ready:boolean}>('live_engine_status').catch(()=>null);if(engine?.engine_ready&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()==='Record'&&!b.disabled))break;await sleep(100);}
  if(closed)return close;
  await invoke('live_set_video',{height:1080,fps:30});
  status.textContent='Preparing native camera…';
  const before=(await invoke<{sources?:LiveSources}>('live_engine_status')).sources;
  const camera=before?.items?.find(s=>s.kind==='camera');
  let cameraId=camera?.id;
  if(!cameraId){cameraId='scene3d-camera-'+run.slice(0,8);await invoke('live_set_source_create',{id:cameraId,label:'3D prototype / native host camera',spec:{kind:'camera'}});owned.push(cameraId);}
  const back='scene3d-back-'+run.slice(0,8),front='scene3d-front-'+run.slice(0,8);
  status.textContent='Preparing native 3D sources…';
  for(const [id,url]of[[back,manifest.background],[front,manifest.foreground]]){await extraSources.add(id,'3D prototype / '+(id===back?'stage':'trim'),{kind:'overlay',url:url+'&run='+run});owned.push(id);}
  for(let i=0;i<300&&!closed;i++){
   const report=await(await fetch(manifest.report)).json();
   if(['background','foreground'].every(pass=>{const r=report.telemetry['landscape/'+pass];return r?.run===run&&r.ready&&r.webgl2&&!r.lost&&!r.error;})){ready=true;break;}await sleep(100);
  }
  if(!ready)throw Error('3D renderer did not become ready');if(closed)return close;
  status.textContent='Reading native set generation…';
  generation=(await invoke<{generation:number}>('live_set_status')).generation;
  status.textContent='Reading native output status…';
  const native=await invoke<{preparedRevision:number;renderedRevision:number}>('live_set_v2',{request:{op:'status',generation}}).catch(()=>({preparedRevision:0,renderedRevision:0}));
  revision=Math.max(native.preparedRevision,native.renderedRevision)+1;
  const bounds={x:0,y:0,width:1920,height:1080};
  const source=(id:string,resource:string,b= bounds)=>({id,kind:'source',bounds:b,properties:{},resource,fit:'cover',children:[]});
  const plan={definitionId:'scene3d-gpu-proof',definitionRevision:1,instanceId:'scene3d-gpu-proof',canvasId:'landscape',target:{id:'program',orientation:'landscape',width:1920,height:1080,scaling:'contain'},viewport:{scaleX:1,scaleY:1,offsetX:0,offsetY:0,clip:bounds},resources:[back,cameraId,front],root:{id:'scene3d-root',kind:'group',bounds,properties:{},children:[source('stage',back),source('host',cameraId,{x:105.6,y:324,width:768,height:432}),source('trim',front)]}};
  status.textContent='Preparing native composition…';
  await invoke('live_set_v2',{request:{op:'prepare',generation,revision,plan}});
  for(let i=0;i<300&&!closed;i++){const s=await invoke<{ready:boolean}>('live_set_v2',{request:{op:'status',generation}});if(s.ready)break;await sleep(50);}
  status.textContent='Taking native composition…';
  await invoke('live_set_v2',{request:{op:'take',generation,revision,durationMs:0,mode:'dissolve'}});
  status.textContent='3D GPU prototype · native camera';buttons.forEach(b=>b.disabled=false);
  for(let i=0;i<300;i++){const s=await invoke<{renderedRevision:number}>('live_set_v2',{request:{op:'status',generation}});if(s.renderedRevision===revision)break;if(i===299)throw Error('Native presentation timed out');await sleep(50);}
  let recordingProof:string|undefined;
  if(manifest.recordProof){status.textContent='Recording native 3D output test…';recordingPath=await recording.start('Scene3D-GPU-proof');await sleep(10000);recordingProof=await recording.stop()??recordingPath;recordingPath=undefined;status.textContent='3D GPU prototype · recording verified';}
  await invoke('live_set_v2_report',{result:{kind:'scene3d-room',ok:true,run,generation,revision,recordingProof,sourceCount:owned.length,scope:'Dev prototype; existing native compositing API, no package schema change.'}});
 }catch(e){status.textContent=status.textContent+' '+String(e);stop.disabled=false;await invoke('live_set_v2_report',{result:{kind:'scene3d-room',ok:false,error:status.textContent}}).catch(()=>{});}
 return close;
}
