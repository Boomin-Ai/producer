import {invoke} from '../../lib/nativeInvoke';
import {ipc} from '../../lib/ipc';
import {activeEndpointId} from '../../lib/workspace';
import {moduleCall} from '../presentation/moduleConnections';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(label:string,read:()=>T|Promise<T>,timeout=60000):Promise<NonNullable<T>>{
 const end=performance.now()+timeout;
 while(performance.now()<end){const result=await read();if(result)return result as NonNullable<T>;await sleep(150);}
 throw Error('Timed out: '+label);
}
const button=(label:string,root:ParentNode=document)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));
function select(node:HTMLSelectElement,value:string){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('change',{bubbles:true}));}
type NativeStatus={renderedRevision:number;renderSerial:number;transitioning:boolean};

/** Explicit local-dev opt-in. Uses the complete app, actual UI and owned account.
 * No mocked IPC, provider credentials or public publishing. Leaves the dashboard
 * on output for visual review. Never enable while producing content. */
export async function threadsRoomProof(){
 if(!import.meta.env.DEV||await import('@tauri-apps/api/app').then(m=>m.getIdentifier())!=='ai.boomin.producer.sets-v2-dev')return;
 const checks:Record<string,unknown>[]=[];
 const report=(stage:string,extra:Record<string,unknown>={})=>invoke('live_set_v2_report',{result:{kind:'threads-native-room',stage,checks,at:new Date().toISOString(),...extra}});
 try{
  const engine=await ipc.liveEngineStatus();if(engine.session_state!=='idle'||document.querySelector('button[title="Stop recording"]'))throw Error('Stop recording and broadcasting before the native proof');
  await report('opening the complete room');
  if(!document.querySelector('.rm-canvas'))(await until('Atlantium room card',()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>(b.textContent??'').startsWith('Atlantium')&&/never live|last live|MAIN STAGE/.test(b.textContent??'')))).click();
  await until('native room canvas',()=>document.querySelector('.rm-canvas'));
  await until('room initialization finished',()=>!document.querySelector('.rm-veil'));
  const endpoint=activeEndpointId();if(!endpoint)throw Error('Choose the connected workspace first');
  const room=(await ipc.liveListRooms(endpoint)).find(r=>r.name==='Atlantium');if(!room)throw Error('Atlantium is not available in the active workspace');
  const serverRoom=JSON.parse(room.config||'{}').server_room_id;if(typeof serverRoom!=='string'||!serverRoom)throw Error('Atlantium has no connected server room');
  let editor=document.querySelector<HTMLDialogElement>('dialog[open]');
  if(!editor){document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));(await until('Set settings',()=>button('Set settings'))).click();editor=await until('Set editor',()=>document.querySelector<HTMLDialogElement>('dialog[open]'));}
  const picker=await until('Set picker',()=>editor!.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Choose set"]'));picker.click();
  (await until('Threads dashboard option',()=>[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(o=>o.textContent?.includes('Threads · Live Dashboard')))).click();
  await report('binding the owned Threads account');
  const account=await until('Threads connection',()=>{const s=editor!.querySelector<HTMLSelectElement>('select[aria-label="Threads account connection"]');return s&&[...s.options].some(o=>o.value.startsWith('social-'))?s:null;});
  select(account,[...account.options].find(o=>o.value.startsWith('social-'))!.value);
  const posts=await until('published post picker',()=>{const s=editor!.querySelector<HTMLSelectElement>('select[aria-label="Threads spotlight post"]');return s&&!s.disabled&&s.options.length>1?s:null;});
  const selected=[...posts.options].find(o=>/^Fellas,/i.test(o.text))??[...posts.options].find(o=>o.value);if(!selected)throw Error('No published post is available');select(posts,selected.value);
  const period=editor!.querySelector<HTMLSelectElement>('select[aria-label="Threads metrics period"]');if(!period)throw Error('Metrics period missing');select(period,'7');
  checks.push({check:'real account and published post selected in Data connections',postsLoaded:posts.options.length-1,rangeDays:7});
  const host=editor!.querySelector<HTMLSelectElement>('select[aria-label="Host camera source"]');if(!host)throw Error('Shared Host camera slot missing');
  const savedCamera=JSON.parse(room.config||'{}').sources?.extras?.find((s:{spec?:{kind?:string}})=>s.spec?.kind==='camera');
  const existing=savedCamera?await until('restored camera in source catalog',()=>[...host.options].find(o=>o.value===savedCamera.id&&!o.disabled),25000):[...host.options].find(o=>o.value&&/camera|webcam/i.test(o.text)&&!o.disabled);
  if(existing)select(host,existing.value);
  else{(await until('Add camera',()=>button('Add source here',editor!))).click();(await until('Create and assign camera',()=>button('Add and assign',editor!))).click();await until('assigned camera',()=>editor!.querySelector<HTMLSelectElement>('select[aria-label="Host camera source"]')?.value);}
  const cameraId=editor.querySelector<HTMLSelectElement>('select[aria-label="Host camera source"]')!.value;
  const camera=await until('actual camera capture dimensions',async()=>(await ipc.liveEngineStatus()).sources?.items?.find(s=>s.id===cameraId&&s.kind==='camera'&&s.has_frame&&s.src_w>0&&s.src_h>0),25000);
  checks.push({check:'shared Host camera has real capture frames',kind:camera.kind});
  await report('applying dashboard through the native editor');
  (await until('Show on output',()=>button('Show on output',editor!))).click();
  await until('native Set publication',()=>{const error=editor!.querySelector('.set-error');if(error?.textContent)throw Error(error.textContent);return editor!.querySelector('.set-editor-apply-status.applied');});
  button('Close editor',editor)!.click();
  await until('live Set controls',()=>document.querySelector('.set-controls[data-output-busy="false"]'));
  await report('waiting for real provider data on native output');
  const snapshot=await until('live social module',async()=>{const reply=await moduleCall(endpoint,serverRoom,'GET');return reply.snapshot&&Object.values(reply.snapshot.modules).some(m=>m.values.username&&m.values.postText&&!String(m.values.postText).startsWith('Choose a post'))?reply.snapshot:null;});
  const social=Object.values(snapshot.modules).find(m=>m.values.username)!;
  checks.push({check:'live owned social module delivered',hasProfileViews:social.values.account_views!=='—',hasSelectedPost:!!social.values.postText,replyCount:Number(social.values.replyCount),moduleConnection:'live'});
  (await until('Output settings',()=>button('Output settings'))).click();(await until('Both orientations',()=>button('Both'))).click();(await until('Close output settings',()=>button('Close output settings'))).click();
  const {generation}=await ipc.liveSetStatus();
  const statuses=()=>Promise.all(['program','portrait'].map(outputId=>invoke<NativeStatus>('live_set_v2',{request:{op:'status',generation,outputId}})));
  await until('paired native previews',async()=>{const s=await statuses();return s.every(o=>o.renderedRevision>0&&!o.transitioning)?s:null;});
  for(const label of ['Post spotlight','Live replies','Channel overview']){
   const before=await statuses();(await until(label,()=>button(label))).click();
   const after=await until(label+' native receipt',async()=>{const s=await statuses();return s.every((o,i)=>o.renderedRevision>before[i].renderedRevision&&!o.transitioning)?s:null;});
   checks.push({check:label+' presented in both orientations',revisions:after.map(o=>o.renderedRevision)});
  }
  await report('checking settled snapshot polling');
  let stable=false;
  for(let attempt=0;attempt<3&&!stable;attempt++){
   // Allow the final layout receipt and any in-flight provider refresh to settle.
   await sleep(2000);const runtimeBefore=await moduleCall(endpoint,serverRoom,'GET'),before=await statuses();
   await sleep(6500);const runtimeAfter=await moduleCall(endpoint,serverRoom,'GET'),after=await statuses();
   const unchangedData=runtimeBefore.snapshot?.revision===runtimeAfter.snapshot?.revision;
   const unchangedRevisions=after.every((s,i)=>s.renderedRevision===before[i].renderedRevision),renderingContinues=after.every((s,i)=>s.renderSerial>before[i].renderSerial);
   checks.push({check:'settled snapshot polling',attempt:attempt+1,unchangedData,unchangedRevisions,renderingContinues,before:before.map(s=>s.renderedRevision),after:after.map(s=>s.renderedRevision)});
   stable=unchangedData&&unchangedRevisions&&renderingContinues;
  }
  if(!stable)throw Error('A stable data snapshot did not retain its native output revisions');
  await report('ready for visual review',{ok:true,status:'passed',generation});
 }catch(error){await report('failed',{ok:false,status:'failed',error:String(error),alerts:[...document.querySelectorAll('[role="alert"],.set-error')].map(n=>n.textContent),controls:[...document.querySelectorAll('dialog[open] button,.set-controls button')].filter(n=>!(n as HTMLButtonElement).disabled).map(n=>n.getAttribute('aria-label')||n.textContent?.trim()).slice(0,50)});}
}
