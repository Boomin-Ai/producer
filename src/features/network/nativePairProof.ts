/** Explicit local developer proof through the real Home → invitation → local
 * room access → host admission flow. No direct join, media, mixer or native
 * source mutations. Installation never starts a proof or a background poll. */
import {getIdentifier} from '@tauri-apps/api/app';
import {ipc,recording,uiLog,type EndpointInfo,type LiveRoom,type LiveSnapshot,type LocalRecording} from '../../lib/ipc';
import {activeEndpointId,isBoomin,WORKSPACE_EVENT} from '../../lib/workspace';
import {activeGuestSeatDiagnosticSession,type GuestSeatDiagnosticSession} from '../../lib/guestSeat';
import type {NetworkDiagnosticsProof} from './networkDiagnosticsProof';

const MAC_DEV_APP='ai.boomin.producer.sets-v2-dev';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface NativePairFixture {
 version:1;
 workspace:{endpointId:string;brandSlug:string};
 /** Local SQLite room ID, not its server_room_id. */
 localRoomId:string;
 /** Remote Boomin room ID shown in the normal Network live strip. */
 remoteRoomId:string;
}
type Phase='idle'|'validating'|'knocking'|'choosing'|'joining'|'waiting_for_host'|'measuring'|'disposed';
type Reason='completed'|'invalid_fixture'|'workspace_mismatch'|'room_mismatch'|'output_active'|'context_changed'|
 'app_not_ready'|'ui_ambiguous'|'target_unavailable'|'join_timeout'|'join_rejected'|'admission_timeout'|
 'diagnostics_unavailable'|'diagnostics_incomplete'|'already_attempted'|'cancelled'|'disposed'|'failed';
type DiagnosticsReport=Awaited<ReturnType<NetworkDiagnosticsProof['run']>>;
export interface NativePairProofResult {
 kind:'producer-native-pair';version:1;reason:Reason;phase:Phase;elapsedMs:number;
 milestones:{name:'knock_clicked'|'invitation_visible'|'join_clicked'|'live_seat_observed'|'measurement_finished';elapsedMs:number}[];
 diagnostics:DiagnosticsReport|null;
 /** A decoded receiver is not proof of native ingestion, presentation or
  * speaker audibility. No tone or mute checks are performed by this driver. */
 coverage:'visible_ui_entry_and_passive_receiver_stats_only';
}
export interface NativePairProof {
 run(fixture:NativePairFixture):Promise<NativePairProofResult>;
 status():{phase:Phase;attempted:boolean};
 cancel():void;
 dispose():void;
}
type Dependencies={
 document:Document;window:Window&typeof globalThis;now:()=>number;
 setTimer:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;
 clearTimer:(timer:ReturnType<typeof setTimeout>)=>void;
 activeEndpoint:()=>string|null;endpoints:()=>Promise<EndpointInfo[]>;
 rooms:(endpointId:string)=>Promise<LiveRoom[]>;engine:()=>Promise<LiveSnapshot>;
 recordings:(endpointId:string)=>Promise<LocalRecording[]>;
 getSession:()=>GuestSeatDiagnosticSession|null;
 diagnostics:()=>NetworkDiagnosticsProof|undefined;log:(line:string)=>void;
};
class Refusal extends Error {constructor(readonly reason:Reason){super(reason);}}
function refuse(reason:Reason):never {throw new Refusal(reason);}

/** Copy only the bounded fixture fields. No URLs, invite codes, credentials,
 * commands or arbitrary selectors are accepted. */
export function validateNativePairFixture(value:unknown):NativePairFixture|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const f=value as Partial<NativePairFixture>,w=f.workspace;
 if(f.version!==1||!w||typeof w!=='object'||Array.isArray(w)||
  typeof w.endpointId!=='string'||!UUID.test(w.endpointId)||typeof w.brandSlug!=='string'||
  !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(w.brandSlug)||
  typeof f.localRoomId!=='string'||!UUID.test(f.localRoomId)||
  typeof f.remoteRoomId!=='string'||!UUID.test(f.remoteRoomId))return null;
 return {version:1,workspace:{endpointId:w.endpointId,brandSlug:w.brandSlug},localRoomId:f.localRoomId,remoteRoomId:f.remoteRoomId};
}
function visible(document:Document,node:Element):node is HTMLElement {
 const view=document.defaultView;
 if(!view||!node.isConnected||node.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
 for(let current:Element|null=node;current;current=current.parentElement){
  const style=view.getComputedStyle(current);
  if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;
 }
 const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0;
}
function elements<T extends HTMLElement>(document:Document,scope:ParentNode,selector:string):T[]{
 return Array.from(scope.querySelectorAll<T>(selector)).filter(node=>visible(document,node));
}
function one<T>(list:T[],missing:Reason):T {
 if(list.length>1)refuse('ui_ambiguous');
 if(list.length!==1)refuse(missing);
 return list[0];
}
function enabled(node:HTMLButtonElement|HTMLInputElement|HTMLSelectElement){
 if(node.disabled||node.matches(':disabled')||node.getAttribute('aria-disabled')==='true')refuse('app_not_ready');
}
function unobstructed(document:Document,node:HTMLElement){
 node.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
 const rect=node.getBoundingClientRect(),view=document.defaultView;
 if(!view||rect.left<0||rect.top<0||rect.right>view.innerWidth||rect.bottom>view.innerHeight)refuse('app_not_ready');
 const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
 if(!hit||!node.contains(hit))refuse('app_not_ready');
}

/** Dependency seam for isolated DOM/native-read tests. The installer is the
 * application entrypoint and separately enforces the exact runtime identity. */
export function createNativePairProof(deps:Dependencies):NativePairProof {
 let disposed=false,attempted=false,phase:Phase='idle';
 let operation:{promise:Promise<NativePairProofResult>;stop:(reason:Reason)=>void}|null=null;
 function run(input:NativePairFixture):Promise<NativePairProofResult>{
  if(operation)return operation.promise;
  const started=deps.now(),milestones:NativePairProofResult['milestones']=[];
  let reason:Reason|null=disposed?'disposed':attempted?'already_attempted':null,diagnostics:DiagnosticsReport|null=null;
  let fixture:NativePairFixture|null=null,ownedDiagnostics:NetworkDiagnosticsProof|undefined;
  const timers=new Set<ReturnType<typeof setTimeout>>();
  let interrupt:()=>void=()=>{};
  const interrupted=new Promise<null>(resolve=>{interrupt=()=>resolve(null);});
  let wake:()=>void=()=>{};
  const stop=(next:Reason)=>{if(reason)return;reason=next;wake();interrupt();ownedDiagnostics?.cancel();};
  function check(){
   if(reason)refuse(reason);
   if(deps.document.visibilityState!=='visible')refuse('context_changed');
   if(fixture&&deps.activeEndpoint()!==fixture.workspace.endpointId)refuse('workspace_mismatch');
  }
  function delay(ms:number){return new Promise<void>(resolve=>{
   if(reason){resolve();return;}
   let timer:ReturnType<typeof setTimeout>;
   const done=()=>{deps.clearTimer(timer);timers.delete(timer);if(wake===done)wake=()=>{};resolve();};
   timer=deps.setTimer(done,Math.max(0,ms));timers.add(timer);wake=done;
  });}
  async function bounded<T>(work:Promise<T>,ms:number):Promise<T>{
   let timer:ReturnType<typeof setTimeout>;
   const timeout=new Promise<never>((_,reject)=>{timer=deps.setTimer(()=>{timers.delete(timer);reject(new Refusal('app_not_ready'));},ms);timers.add(timer);});
   try{const result=await Promise.race([work,timeout,interrupted]);check();return result as T;}
   finally{deps.clearTimer(timer!);timers.delete(timer!);}
  }
  const mark=(name:NativePairProofResult['milestones'][number]['name'])=>milestones.push({name,elapsedMs:Math.max(0,deps.now()-started)});
  async function validateContext(){
   check();const f=fixture!;
   const endpoints=await bounded(deps.endpoints(),8000);check();
   const endpoint=one(endpoints.filter(ep=>ep.id===f.workspace.endpointId),'workspace_mismatch');
   if(endpoint.kind!=='connected'||!isBoomin(endpoint)||endpoint.brand_slug!==f.workspace.brandSlug)refuse('workspace_mismatch');
   // This proof is a Boomin-to-Boomin fixture, not an external-server probe.
   let official=false;try{const u=new URL(endpoint.base_url);official=u.origin==='https://api.boomin.ai'&&!u.username&&!u.password;}catch{/* Refuse below. */}
   if(!official)refuse('workspace_mismatch');
   const [rooms,engine,captures]=await bounded(Promise.all([
    deps.rooms(endpoint.id),deps.engine(),Promise.all(endpoints.map(ep=>deps.recordings(ep.id))),
   ]),8000);check();
   const room=one(rooms.filter(room=>room.id===f.localRoomId),'room_mismatch');
   if(room.endpoint_id!==endpoint.id)refuse('room_mismatch');
   if(engine.session_state!=='idle'||!Array.isArray(engine.destinations)||engine.destinations.some(d=>d.active||['connecting','live','reconnecting'].includes(d.phase))||
    captures.some(rows=>rows.some(row=>row.status==='recording')))refuse('output_active');
  }
  function sheet(){
   const all=elements<HTMLElement>(deps.document,deps.document,'.producer-network-sheet.join-sheet');
   if(all.length>1)refuse('ui_ambiguous');
   if(!all.length)return null;
   const node=all[0],f=fixture!;
   if(node.dataset.producerNetworkRoomId!==f.remoteRoomId||node.dataset.producerEndpointId!==f.workspace.endpointId)refuse('context_changed');
   one(elements(deps.document,node,'section.producer-join[aria-label="Join a Producer room"]'),'app_not_ready');
   return node;
  }
  async function waitFor<T>(read:()=>T|null,ms:number,timeoutReason:Reason):Promise<T>{
   const end=deps.now()+ms;
   for(;;){check();const value=read();if(value!==null)return value;if(deps.now()>=end)refuse(timeoutReason);await delay(Math.min(200,end-deps.now()));}
  }
  const workspaceChanged=()=>{if(fixture&&deps.activeEndpoint()!==fixture.workspace.endpointId)stop('workspace_mismatch');};
  const visibilityChanged=()=>{if(deps.document.visibilityState!=='visible')stop('context_changed');};
  const promise=(async()=>{
   try{
    check();fixture=validateNativePairFixture(input);if(!fixture)refuse('invalid_fixture');
    phase='validating';
    deps.window.addEventListener(WORKSPACE_EVENT,workspaceChanged);
    deps.document.addEventListener('visibilitychange',visibilityChanged);
    const observer=deps.diagnostics();
    if(!observer||observer.status().state!=='idle')refuse('diagnostics_unavailable');
    if(deps.getSession())refuse('app_not_ready');
    await validateContext();
    if(elements(deps.document,deps.document,'.producer-network-sheet,[role="dialog"],[aria-modal="true"]').length)refuse('app_not_ready');
    const f=fixture!;
    const target=one(elements<HTMLButtonElement>(deps.document,deps.document,
     `#sec-livenow button[data-producer-network-room-id="${f.remoteRoomId}"][data-producer-endpoint-id="${f.workspace.endpointId}"]`),'target_unavailable');
    enabled(target);unobstructed(deps.document,target);check();
    // This is the only network-knock action. No retry, refresh or alternate
    // target is attempted, even if the response or host admission is delayed.
    phase='knocking';attempted=true;target.click();mark('knock_clicked');
    const invitation=await waitFor(sheet,20000,'join_timeout');mark('invitation_visible');phase='choosing';
    const radios=elements<HTMLInputElement>(deps.document,invitation,'input[type="radio"][name="producer-video"]');
    if(radios.length!==2)refuse('ui_ambiguous');
    const program=one(radios.filter(radio=>radio.closest('label')?.querySelector('strong')?.textContent?.trim()==='My room and Set'),'app_not_ready');
    enabled(program);unobstructed(deps.document,program);program.click();
    const select=await waitFor(()=>{
     const current=sheet();if(!current)return null;
     const matches=elements<HTMLSelectElement>(deps.document,current,'select[aria-label="Room to send"]');
     if(matches.length>1)refuse('ui_ambiguous');return matches[0]??null;
    },1500,'app_not_ready');
    enabled(select);one(Array.from(select.options).filter(option=>option.value===f.localRoomId&&!option.disabled),'room_mismatch');
    const setter=Object.getOwnPropertyDescriptor(deps.window.HTMLSelectElement.prototype,'value')?.set;
    if(!setter)refuse('app_not_ready');setter.call(select,f.localRoomId);
    select.dispatchEvent(new deps.window.Event('change',{bubbles:true}));
    // Let the controlled React select commit before using the form's real
    // submit handler. A changed sheet, room or workspace always aborts.
    await delay(0);check();await validateContext();
    if(deps.getSession()||deps.diagnostics()!==observer||observer.status().state!=='idle')refuse('context_changed');
    const ready=sheet();if(!ready||!ready.contains(select)||select.value!==f.localRoomId||!program.checked)refuse('context_changed');
    const form=one(elements<HTMLFormElement>(deps.document,ready,'.producer-join form'),'app_not_ready');
    const join=one(elements<HTMLButtonElement>(deps.document,form,'button[type="submit"]'),'app_not_ready');
    if(join.textContent?.trim()!=='Join room')refuse('app_not_ready');enabled(join);unobstructed(deps.document,join);check();
    phase='joining';join.click();mark('join_clicked');phase='waiting_for_host';
    const session=await waitFor(()=>{
     const current=sheet();
     if(current&&elements(deps.document,current,'[role="alert"]').length)refuse('join_rejected');
     const session=deps.getSession();
     // Visible native seat readiness is required; a grant/knock alone never
     // counts as successful capture. Host admission remains entirely manual.
     return !current&&session?.current()?session:null;
    },45000,'admission_timeout');
    mark('live_seat_observed');await validateContext();
    if(!session.current()||deps.getSession()!==session||deps.diagnostics()!==observer||observer.status().state!=='idle')refuse('context_changed');
    phase='measuring';ownedDiagnostics=observer;
    diagnostics=await bounded(observer.run(),75000);check();mark('measurement_finished');
    reason=diagnostics.reason==='completed'?'completed':'diagnostics_incomplete';
   }catch(error){reason??=error instanceof Refusal?error.reason:'failed';}
   finally{
    if(ownedDiagnostics&&reason!=='completed')ownedDiagnostics.cancel();
    deps.window.removeEventListener(WORKSPACE_EVENT,workspaceChanged);
    deps.document.removeEventListener('visibilitychange',visibilityChanged);
    for(const timer of timers)deps.clearTimer(timer);timers.clear();
   }
   const result:NativePairProofResult={kind:'producer-native-pair',version:1,reason:reason??'failed',phase,elapsedMs:Math.max(0,deps.now()-started),milestones,diagnostics,
    coverage:'visible_ui_entry_and_passive_receiver_stats_only'};
   // No fixture IDs, native/provider exception text, display names, invite
   // URLs, credentials or media payloads enter these local progress receipts.
   try{deps.log('[native-pair-proof] '+JSON.stringify({...result,diagnostics:diagnostics?{reason:diagnostics.reason,sampleCount:diagnostics.sampleCount}:null}));}catch{/* Logging cannot affect the seat. */}
   phase=disposed?'disposed':'idle';return result;
  })().finally(()=>{if(operation?.promise===promise)operation=null;});
  operation={promise,stop};return promise;
 }
 return {run,status:()=>({phase,attempted}),cancel(){operation?.stop('cancelled');},dispose(){disposed=true;operation?.stop('disposed');phase='disposed';}};
}

declare global {interface Window {__producerNativePairProof?:NativePairProof;}}
let installed:NativePairProof|undefined,moduleDisposed=false,installAttempt=0;
export async function installNativePairProof():Promise<void>{
 if(!import.meta.env.DEV||import.meta.env.VITE_PRODUCER_NATIVE_PAIR_PROOF!=='1'||!('__TAURI_INTERNALS__' in window))return;
 const attempt=++installAttempt,id=await getIdentifier().catch(()=>null);
 if(moduleDisposed||attempt!==installAttempt||id!==MAC_DEV_APP)return;
 window.__producerNativePairProof?.dispose();
 installed=createNativePairProof({document,window,now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:timer=>clearTimeout(timer),
  activeEndpoint:activeEndpointId,endpoints:()=>ipc.listEndpoints(),rooms:id=>ipc.liveListRooms(id),engine:()=>ipc.liveEngineStatus(),recordings:id=>recording.list(id),
  getSession:activeGuestSeatDiagnosticSession,diagnostics:()=>window.__producerNetworkDiagnostics,log:uiLog});
 window.__producerNativePairProof=installed;
}
import.meta.hot?.dispose(()=>{moduleDisposed=true;installed?.dispose();if(window.__producerNativePairProof===installed)delete window.__producerNativePairProof;installed=undefined;});
